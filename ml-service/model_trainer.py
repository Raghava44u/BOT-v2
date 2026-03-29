"""
Ensemble Model Trainer
- Trains ONLY on first 75% of data (time-ordered)
- Keeps last 25% as unseen test set for backtesting
- Real-time training progress events via callback
- LightGBM + XGBoost + RandomForest with isotonic calibration
- Saves feature_cols, scaler, and train/test split boundary to disk
"""
import os, json, logging, joblib, time
from datetime import datetime
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.calibration import CalibratedClassifierCV
from sklearn.metrics import roc_auc_score, accuracy_score, log_loss
from sklearn.preprocessing import StandardScaler
import warnings
warnings.filterwarnings('ignore')

try:
    import lightgbm as lgb
    HAS_LGB = True
except ImportError:
    HAS_LGB = False
    logging.warning("LightGBM not available — install: pip install lightgbm")

try:
    import xgboost as xgb
    HAS_XGB = True
except ImportError:
    HAS_XGB = False
    logging.warning("XGBoost not available — install: pip install xgboost")

logger = logging.getLogger(__name__)

MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'models')
os.makedirs(MODEL_DIR, exist_ok=True)

# Progress broadcast (injected from main.py)
_train_cb = None
def set_train_callback(fn): global _train_cb; _train_cb = fn
def _emit(event, data):
    if _train_cb: _train_cb(event, data)

class ModelTrainer:
    def __init__(self, config):
        self.config      = config
        self.ml_cfg      = config["ml"]
        self.models      = {}
        self.scalers     = {}
        self.feature_cols = []
        self.metrics     = {}
        self.train_meta  = {}   # stores split info, dates, etc.
        self._trained    = False
        self._load_models()

    # ── Persistence ───────────────────────────────────────────────────────────
    def _load_models(self):
        try:
            meta_path = os.path.join(MODEL_DIR, 'meta.json')
            if not os.path.exists(meta_path): return
            with open(meta_path) as f:
                meta = json.load(f)
            self.feature_cols = meta.get('feature_cols', [])
            self.metrics      = meta.get('metrics', {})
            self.train_meta   = meta.get('train_meta', {})
            for name in ['lgb', 'xgb', 'rf']:
                path = os.path.join(MODEL_DIR, f'{name}.pkl')
                if os.path.exists(path):
                    self.models[name] = joblib.load(path)
            scaler_path = os.path.join(MODEL_DIR, 'scaler.pkl')
            if os.path.exists(scaler_path):
                self.scalers['main'] = joblib.load(scaler_path)
            if self.models:
                self._trained = True
                logger.info(f"Loaded {len(self.models)} models, {len(self.feature_cols)} features")
        except Exception as e:
            logger.warning(f"Model load failed: {e}")

    def _save_models(self):
        for name, model in self.models.items():
            joblib.dump(model, os.path.join(MODEL_DIR, f'{name}.pkl'))
        if 'main' in self.scalers:
            joblib.dump(self.scalers['main'], os.path.join(MODEL_DIR, 'scaler.pkl'))
        with open(os.path.join(MODEL_DIR, 'meta.json'), 'w') as f:
            json.dump({
                'feature_cols': self.feature_cols,
                'metrics':      self.metrics,
                'train_meta':   self.train_meta,
                'trained_at':   datetime.utcnow().isoformat()
            }, f, indent=2)
        logger.info("Models saved to disk")

    def is_trained(self): return self._trained and len(self.models) > 0

    # ── Main training entry point ─────────────────────────────────────────────
    def train(self, ingestion, feature_eng, train_split=0.75):
        """
        1. Load merged dataset
        2. Build features + labels
        3. Split: first 75% = train, last 25% = unseen test
        4. Train RF / LGB / XGB
        5. Evaluate on TRAIN split only (test split reserved for backtest)
        6. Save everything
        """
        _emit('train_start', {'step': 'loading_data'})
        logger.info("=== Training pipeline start ===")

        # ── Step 1: Load merged data ──────────────────────────────────────────
        merged_df, tickers = ingestion.load_merged()
        if merged_df is None or merged_df.empty:
            _emit('train_error', {'msg': 'No merged dataset found. Run Download first.'})
            return {'error': 'No merged dataset. Download data first.'}

        logger.info(f"Merged dataset: {merged_df.shape}")
        _emit('train_progress', {'step': 'feature_engineering', 'pct': 10})

        # ── Step 2: Build features + labels per ticker ────────────────────────
        all_X, all_y, all_ts = [], [], []
        ticker_samples = {}

        for ticker in tickers:
            try:
                close_col = f"{ticker}_Close"
                if close_col not in merged_df.columns:
                    continue
                # Extract single-ticker OHLCV
                cols_avail = [c for c in [f"{ticker}_Open",f"{ticker}_High",f"{ticker}_Low",
                                           f"{ticker}_Close",f"{ticker}_Volume"] if c in merged_df.columns]
                sub = merged_df[cols_avail].dropna(subset=[close_col]).copy()
                sub.columns = [c.replace(f"{ticker}_",'') for c in sub.columns]
                if len(sub) < 200:
                    logger.warning(f"  Skip {ticker}: only {len(sub)} rows")
                    continue

                df_feat    = feature_eng.compute_all(sub)
                df_labeled = feature_eng.create_labels(df_feat,
                    tp_mult=self.ml_cfg["label_tp_multiplier"],
                    sl_mult=self.ml_cfg["label_sl_multiplier"],
                    horizon=self.ml_cfg["label_horizon_candles"])
                feat_cols  = feature_eng.get_feature_cols(df_labeled)
                if not self.feature_cols:
                    self.feature_cols = feat_cols

                X  = df_labeled[feat_cols].values.astype(np.float32)
                y  = df_labeled['label'].values.astype(np.float32)
                ts = df_labeled.index.astype(np.int64).values  # keep timestamps for split

                all_X.append(X); all_y.append(y); all_ts.append(ts)
                ticker_samples[ticker] = len(X)
                logger.info(f"  {ticker}: {len(X)} samples, {y.mean():.1%} positive")
            except Exception as e:
                logger.warning(f"  Skip {ticker}: {e}")

        if not all_X:
            _emit('train_error', {'msg': 'No feature data built from any ticker'})
            return {'error': 'Feature engineering produced no data'}

        # Stack and sort by timestamp (critical: no leakage)
        X   = np.vstack(all_X)
        y   = np.concatenate(all_y)
        ts  = np.concatenate(all_ts)
        order = np.argsort(ts)
        X, y, ts = X[order], y[order], ts[order]

        logger.info(f"Total samples: {len(X)}, positive rate: {y.mean():.1%}")
        _emit('train_progress', {'step': 'splitting', 'pct': 20,
                                  'total_samples': int(len(X)), 'positive_rate': float(y.mean())})

        # ── Step 3: Time-ordered split — NO RANDOM SHUFFLE ────────────────────
        split_idx = int(len(X) * train_split)
        X_train, X_test = X[:split_idx], X[split_idx:]
        y_train, y_test = y[:split_idx], y[split_idx:]

        # Save split boundary info for backtester
        split_ts = ts[split_idx] if split_idx < len(ts) else ts[-1]
        self.train_meta = {
            'total_samples':  int(len(X)),
            'train_samples':  int(len(X_train)),
            'test_samples':   int(len(X_test)),
            'train_split_pct': train_split,
            'split_timestamp': int(split_ts),
            'split_date':      pd.Timestamp(split_ts).isoformat() if split_ts else None,
            'ticker_samples':  ticker_samples
        }

        logger.info(f"Train: {len(X_train)} | Test (unseen): {len(X_test)}")
        _emit('train_progress', {'step': 'scaling', 'pct': 25,
                                  'train_samples': int(len(X_train)),
                                  'test_samples':  int(len(X_test))})

        # ── Step 4: Scale (fit ONLY on train) ─────────────────────────────────
        scaler = StandardScaler()
        X_train_s = scaler.fit_transform(X_train)
        # Test set scaling is done in backtester using same scaler
        self.scalers['main'] = scaler

        results = {}
        model_count = (1 + int(HAS_LGB) + int(HAS_XGB))
        model_idx   = 0

        # ── Step 5a: RandomForest ─────────────────────────────────────────────
        model_idx += 1
        pct_base = 30
        _emit('train_progress', {'step': 'training_rf', 'pct': pct_base,
                                  'model': 'RandomForest', 'model_idx': model_idx, 'model_count': model_count})
        logger.info("Training RandomForest…")
        t0 = time.time()
        rf = RandomForestClassifier(
            n_estimators=200, max_depth=self.ml_cfg["max_tree_depth"],
            min_samples_leaf=self.ml_cfg["min_leaf_samples"],
            random_state=42, n_jobs=-1
        )
        rf_cal = CalibratedClassifierCV(rf, method='isotonic', cv=3)
        rf_cal.fit(X_train_s, y_train)
        rf_train_pred = rf_cal.predict_proba(X_train_s)[:,1]
        train_auc = float(roc_auc_score(y_train, rf_train_pred))
        train_acc = float(accuracy_score(y_train, rf_train_pred > 0.5))
        elapsed   = round(time.time()-t0, 1)
        results['rf'] = {'train_auc': train_auc, 'train_acc': train_acc, 'time_s': elapsed}
        self.models['rf'] = rf_cal
        logger.info(f"  RF train AUC={train_auc:.4f} acc={train_acc:.4f} [{elapsed}s]")
        _emit('train_progress', {'step': 'rf_done', 'pct': pct_base+20,
                                  'model': 'RandomForest', 'train_auc': train_auc,
                                  'train_acc': train_acc, 'time_s': elapsed})

        # ── Step 5b: LightGBM ─────────────────────────────────────────────────
        if HAS_LGB:
            model_idx += 1
            _emit('train_progress', {'step': 'training_lgb', 'pct': 55,
                                      'model': 'LightGBM', 'model_idx': model_idx, 'model_count': model_count})
            logger.info("Training LightGBM…")
            t0 = time.time()
            lgb_m = lgb.LGBMClassifier(
                n_estimators=500, max_depth=self.ml_cfg["max_tree_depth"],
                min_child_samples=self.ml_cfg["min_leaf_samples"],
                learning_rate=0.05, reg_alpha=0.1, reg_lambda=0.1,
                random_state=42, verbose=-1, n_jobs=-1
            )
            lgb_cal = CalibratedClassifierCV(lgb_m, method='isotonic', cv=3)
            lgb_cal.fit(X_train_s, y_train)
            lgb_tr_pred = lgb_cal.predict_proba(X_train_s)[:,1]
            tr_auc = float(roc_auc_score(y_train, lgb_tr_pred))
            tr_acc = float(accuracy_score(y_train, lgb_tr_pred > 0.5))
            elapsed = round(time.time()-t0, 1)
            results['lgb'] = {'train_auc': tr_auc, 'train_acc': tr_acc, 'time_s': elapsed}
            self.models['lgb'] = lgb_cal
            logger.info(f"  LGB train AUC={tr_auc:.4f} acc={tr_acc:.4f} [{elapsed}s]")
            _emit('train_progress', {'step': 'lgb_done', 'pct': 75,
                                      'model': 'LightGBM', 'train_auc': tr_auc,
                                      'train_acc': tr_acc, 'time_s': elapsed})

        # ── Step 5c: XGBoost ──────────────────────────────────────────────────
        if HAS_XGB:
            model_idx += 1
            _emit('train_progress', {'step': 'training_xgb', 'pct': 78,
                                      'model': 'XGBoost', 'model_idx': model_idx, 'model_count': model_count})
            logger.info("Training XGBoost…")
            t0 = time.time()
            xgb_m = xgb.XGBClassifier(
                n_estimators=500, max_depth=self.ml_cfg["max_tree_depth"],
                min_child_weight=max(1, self.ml_cfg["min_leaf_samples"]//10),
                learning_rate=0.05, reg_alpha=0.1, reg_lambda=0.1,
                random_state=42, eval_metric='logloss', verbosity=0, n_jobs=-1
            )
            xgb_cal = CalibratedClassifierCV(xgb_m, method='isotonic', cv=3)
            xgb_cal.fit(X_train_s, y_train)
            xgb_tr_pred = xgb_cal.predict_proba(X_train_s)[:,1]
            tr_auc = float(roc_auc_score(y_train, xgb_tr_pred))
            tr_acc = float(accuracy_score(y_train, xgb_tr_pred > 0.5))
            elapsed = round(time.time()-t0, 1)
            results['xgb'] = {'train_auc': tr_auc, 'train_acc': tr_acc, 'time_s': elapsed}
            self.models['xgb'] = xgb_cal
            logger.info(f"  XGB train AUC={tr_auc:.4f} acc={tr_acc:.4f} [{elapsed}s]")
            _emit('train_progress', {'step': 'xgb_done', 'pct': 92,
                                      'model': 'XGBoost', 'train_auc': tr_auc,
                                      'train_acc': tr_acc, 'time_s': elapsed})

        self.metrics  = results
        self._trained = True
        self._save_models()
        _emit('train_done', {'metrics': results, 'train_meta': self.train_meta})
        logger.info("=== Training complete ===")
        return {'metrics': results, 'train_meta': self.train_meta}

    # ── Prediction helpers ────────────────────────────────────────────────────
    def predict_single(self, ticker, features_dict):
        if not self.is_trained():
            return {'probability': 0.5, 'confidence': 0.5, 'ensemble_agreement': False}
        try:
            X = np.array([[features_dict.get(c, 0.0) for c in self.feature_cols]], dtype=np.float32)
            if 'main' in self.scalers:
                X = self.scalers['main'].transform(X)
            preds = [float(m.predict_proba(X)[0][1]) for m in self.models.values()]
            mean_p = float(np.mean(preds))
            std_p  = float(np.std(preds))
            agree  = sum(1 for p in preds if p >= 0.5) >= self.config["ml"]["ensemble_agreement_min"]
            return {'probability': mean_p, 'confidence': 1.0-std_p*2,
                    'ensemble_agreement': agree,
                    'individual': {k: float(p) for k,p in zip(self.models.keys(), preds)}}
        except Exception as e:
            logger.error(f"predict_single: {e}")
            return {'probability': 0.5, 'confidence': 0.5, 'ensemble_agreement': False}

    def predict_batch(self, X_raw):
        if not self.is_trained() or len(X_raw) == 0:
            return np.full(len(X_raw), 0.5)
        X = self.scalers['main'].transform(X_raw) if 'main' in self.scalers else X_raw
        preds = np.stack([m.predict_proba(X)[:,1] for m in self.models.values()], axis=1)
        return preds.mean(axis=1)

    def get_test_data(self, ingestion, feature_eng):
        """
        Return (X_test_scaled, y_test, test_df_info) using the saved split boundary.
        Called by backtester so it NEVER sees training data.
        """
        if not self.is_trained() or not self.train_meta:
            return None, None, None
        split_ts = self.train_meta.get('split_timestamp')
        if not split_ts:
            return None, None, None

        merged_df, tickers = ingestion.load_merged()
        if merged_df is None:
            return None, None, None

        all_X, all_y, all_info = [], [], []
        for ticker in tickers:
            try:
                close_col = f"{ticker}_Close"
                if close_col not in merged_df.columns: continue
                cols_avail = [c for c in [f"{ticker}_Open",f"{ticker}_High",f"{ticker}_Low",
                                           f"{ticker}_Close",f"{ticker}_Volume"] if c in merged_df.columns]
                sub = merged_df[cols_avail].dropna(subset=[close_col]).copy()
                sub.columns = [c.replace(f"{ticker}_",'') for c in sub.columns]
                if len(sub) < 100: continue
                df_feat    = feature_eng.compute_all(sub)
                df_labeled = feature_eng.create_labels(df_feat,
                    tp_mult=self.ml_cfg["label_tp_multiplier"],
                    sl_mult=self.ml_cfg["label_sl_multiplier"],
                    horizon=self.ml_cfg["label_horizon_candles"])
                # Keep only rows AFTER split boundary (unseen test data)
                idx_ts = df_labeled.index.astype(np.int64)
                mask   = idx_ts >= split_ts
                df_test = df_labeled[mask]
                if len(df_test) < 10: continue
                feat_cols = feature_eng.get_feature_cols(df_test)
                X = df_test[feat_cols].values.astype(np.float32)
                y = df_test['label'].values.astype(np.float32)
                info = [{'ticker': ticker,
                         'ts':     str(t),
                         'close':  float(df_test.iloc[i].get('Close', 0)
                                         if 'Close' in df_test.columns else 0),
                         'atr':    float(df_test.iloc[i].get('atr', 0.01)
                                         if 'atr' in df_test.columns else 0.01)}
                        for i, t in enumerate(df_test.index)]
                all_X.append(X); all_y.append(y); all_info.extend(info)
            except Exception as e:
                logger.warning(f"  get_test_data skip {ticker}: {e}")

        if not all_X:
            return None, None, None

        X_all = np.vstack(all_X)
        y_all = np.concatenate(all_y)
        X_scaled = self.scalers['main'].transform(X_all) if 'main' in self.scalers else X_all
        return X_scaled, y_all, all_info

    def get_health_metrics(self):
        return {
            'trained':        self._trained,
            'models':         list(self.models.keys()),
            'feature_count':  len(self.feature_cols),
            'metrics':        self.metrics,
            'train_meta':     self.train_meta,
            'status':         'healthy' if self._trained else 'untrained'
        }
