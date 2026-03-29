"""Signal Generator — Multi-ticker, multi-timeframe signal scoring"""
import logging
import numpy as np
import pandas as pd
from datetime import datetime

logger = logging.getLogger(__name__)

class SignalGenerator:
    def __init__(self, config, feature_eng, trainer):
        self.config = config
        self.fe = feature_eng
        self.trainer = trainer
        self.w = config["signals"]["score_weights"]
        self.strategies = config["strategies"]

    def generate(self, tickers):
        """Generate scored signals for all tickers"""
        signals = []
        for ticker in tickers:
            try:
                sig = self._score_ticker(ticker)
                if sig:
                    signals.append(sig)
            except Exception as e:
                logger.debug(f"Signal skip {ticker}: {e}")
        signals.sort(key=lambda x: x["overall_score"], reverse=True)
        return signals[:30]

    def _score_ticker(self, ticker):
        from data_ingestion import DataIngestion
        import json
        with open('../config/config.json') as f:
            cfg = json.load(f)
        ing = DataIngestion(cfg)
        df_5m = ing.load(ticker, '5m')
        df_15m = ing.load(ticker, '15m')
        df_1h = ing.load(ticker, '1h')
        df_1d = ing.load(ticker, '1d')

        if df_5m is None or len(df_5m) < 100:
            return None

        feat_5m = self.fe.compute_all(df_5m, warmup=False)
        if len(feat_5m) == 0:
            return None

        latest = feat_5m.iloc[-1]
        close = float(latest['Close']) if 'Close' in feat_5m.columns else 100.0
        atr = float(latest.get('atr', close * 0.01))

        # Determine regime
        adx = float(latest.get('adx', 20))
        if adx > self.config["regime"]["trending_adx"]:
            regime = 'trending'
            strategy = 'momentum'
        elif adx < self.config["regime"]["ranging_adx"]:
            regime = 'ranging'
            strategy = 'mean_reversion'
        else:
            regime = 'neutral'
            strategy = 'scalp'

        # Direction
        ema9 = float(latest.get('ema_9', close))
        ema20 = float(latest.get('ema_20', close))
        direction = 'long' if ema9 > ema20 else 'short'

        # Score components
        momentum_score = self._momentum_score(latest, direction)
        volume_score = self._volume_score(latest)
        sentiment_score = self._sentiment_score(ticker)
        macro_score = self._macro_score()
        execution_score = self._execution_score(latest)
        mtf_score = self._mtf_score(df_15m, df_1h, df_1d, direction)

        # ML confidence
        feat_dict = {col: float(val) for col, val in latest.items()
                     if not isinstance(val, str) and not np.isnan(float(val)) if hasattr(val, '__float__') else False}
        pred = self.trainer.predict_single(ticker, feat_dict)
        model_conf = pred.get('probability', 0.5)

        scores = {
            'momentum': momentum_score,
            'volume': volume_score,
            'sentiment': sentiment_score,
            'macro': macro_score,
            'execution_quality': execution_score,
            'multi_timeframe': mtf_score,
            'model_confidence': model_conf
        }

        overall = sum(scores[k] * self.w[k] for k in scores)

        return {
            'ticker': ticker,
            'direction': direction,
            'strategy': strategy,
            'regime': regime,
            'entry_price': round(close, 4),
            'atr': round(atr, 4),
            'adx': round(adx, 2),
            'scores': {k: round(v, 4) for k, v in scores.items()},
            'overall_score': round(overall, 4),
            'probability': round(model_conf, 4),
            'ensemble_agreement': pred.get('ensemble_agreement', False),
            'bb_squeeze': int(latest.get('bb_squeeze', 0)),
            'rsi': round(float(latest.get('rsi', 50)), 2),
            'volume_spike': int(latest.get('volume_spike', 0)),
            'timestamp': datetime.utcnow().isoformat()
        }

    def _momentum_score(self, row, direction):
        score = 0.5
        rsi = float(row.get('rsi', 50))
        macd_hist = float(row.get('macd_hist', 0))
        ema_cross = float(row.get('ema_9_20_cross', 0))
        z_ret = float(row.get('z_return', 0))

        if direction == 'long':
            if 40 < rsi < 70: score += 0.1
            if macd_hist > 0: score += 0.15
            if ema_cross > 0: score += 0.15
            if z_ret > 0: score += 0.1
        else:
            if 30 < rsi < 60: score += 0.1
            if macd_hist < 0: score += 0.15
            if ema_cross < 0: score += 0.15
            if z_ret < 0: score += 0.1

        return min(1.0, max(0.0, score))

    def _volume_score(self, row):
        vol_ratio = float(row.get('volume_ratio', 1.0))
        if vol_ratio > 3: return 1.0
        if vol_ratio > 2: return 0.85
        if vol_ratio > 1.5: return 0.70
        if vol_ratio > 1.0: return 0.55
        return 0.35

    def _sentiment_score(self, ticker):
        # Simplified: would call sentiment API in production
        return 0.55 + np.random.uniform(-0.1, 0.2)

    def _macro_score(self):
        # In production: pull VIX, bond yields, DXY
        return 0.60 + np.random.uniform(-0.1, 0.15)

    def _execution_score(self, row):
        # Proxy: lower volatility = better execution
        atr_pct = float(row.get('atr_pct', 0.01))
        if atr_pct < 0.005: return 0.90
        if atr_pct < 0.01: return 0.75
        if atr_pct < 0.02: return 0.60
        return 0.40

    def _mtf_score(self, df_15m, df_1h, df_1d, direction):
        score = 0.0
        aligned = 0
        total = 0

        for df in [df_15m, df_1h, df_1d]:
            if df is None or len(df) < 20:
                continue
            total += 1
            feat = self.fe.compute_all(df, warmup=False)
            if len(feat) == 0:
                continue
            latest = feat.iloc[-1]
            ema9 = float(latest.get('ema_9', 0))
            ema20 = float(latest.get('ema_20', 0))
            tf_dir = 'long' if ema9 > ema20 else 'short'
            if tf_dir == direction:
                aligned += 1

        if total == 0:
            return 0.5
        return aligned / total
