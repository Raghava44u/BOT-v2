"""
Backtester — strictly on UNSEEN test data only
- Gets X_test from trainer.get_test_data() (post-split boundary)
- Simulates T+1 entry execution
- Full trade-by-trade log with entry/exit/pnl
- Monte Carlo (1000 sims)
- Returns everything needed for dashboard charts
"""
import logging
import numpy as np
import pandas as pd
from datetime import datetime

logger = logging.getLogger(__name__)

_bt_cb = None
def set_backtest_callback(fn): global _bt_cb; _bt_cb = fn
def _emit(event, data):
    if _bt_cb: _bt_cb(event, data)

class Backtester:
    def __init__(self, config):
        self.config   = config
        self.ml       = config["ml"]
        self.risk     = config["risk"]
        self.exec_cfg = config["execution"]
        self.pt       = config["profit_targets"]

    def run(self, ingestion, feature_eng, trainer):
        """
        Full backtest on unseen test data.
        Returns a rich result dict consumed by the dashboard.
        """
        _emit('backtest_start', {'step': 'loading_test_data'})
        logger.info("=== Backtesting on UNSEEN test data ===")

        if not trainer.is_trained():
            return {'error': 'Model not trained yet. Train first.', 'trades': [], 'metrics': {}}

        # ── Load unseen test set ───────────────────────────────────────────────
        X_test, y_test, info = trainer.get_test_data(ingestion, feature_eng)
        if X_test is None or len(X_test) == 0:
            _emit('backtest_error', {'msg': 'No test data available'})
            return {'error': 'No test data available', 'trades': [], 'metrics': {}}

        logger.info(f"Test set: {len(X_test)} samples, {y_test.mean():.1%} positive")
        _emit('backtest_progress', {'step': 'predicting', 'pct': 20,
                                     'test_samples': int(len(X_test))})

        # ── Predict probabilities on test set ─────────────────────────────────
        probs = trainer.predict_batch(X_test)

        _emit('backtest_progress', {'step': 'simulating_trades', 'pct': 40})

        # ── Simulate trades ───────────────────────────────────────────────────
        trades     = []
        capital    = float(self.config["capital"]["initial"])
        fees       = self.exec_cfg["fees_per_trade_pct"]
        slippage   = self.exec_cfg["slippage_estimate_pct"]
        min_conf   = self.config["signals"]["min_confidence_score"]

        for i in range(len(X_test) - 1):   # -1 for T+1 entry
            prob = float(probs[i])
            if prob < min_conf:
                continue

            meta   = info[i]
            ticker = meta['ticker']
            ts     = meta['ts']
            atr    = float(meta.get('atr', 0.01))
            entry_raw = float(meta.get('close', 100.0))
            if entry_raw <= 0: continue

            # T+1 execution price
            next_close = float(info[i+1].get('close', entry_raw)) if i+1 < len(info) else entry_raw
            entry = next_close * (1 + slippage)

            sl_dist  = max(atr * self.pt["sl_atr_multiplier"], entry * 0.001)
            tp1_dist = sl_dist * self.pt["tier1_take_profit_r"]
            tp2_dist = sl_dist * self.pt["tier2_take_profit_r"]

            risk_amt = capital * self.risk["risk_per_trade_pct"]
            size     = risk_amt / sl_dist if sl_dist > 0 else 0
            if size <= 0: continue

            cost    = (fees * 2 + slippage) * entry * size
            outcome = float(y_test[i])

            if outcome == 1.0:
                # Multi-tier: 50% at TP1, 50% at TP2
                gross = tp1_dist * size * 0.5 + tp2_dist * size * 0.5
                pnl   = gross - cost
                exit_price = entry + tp2_dist
            else:
                pnl        = -sl_dist * size - cost
                exit_price = entry - sl_dist

            capital += pnl

            trades.append({
                'ticker':      ticker,
                'timestamp':   ts,
                'entry_price': round(entry, 4),
                'exit_price':  round(exit_price, 4),
                'size':        round(size, 4),
                'pnl':         round(pnl, 4),
                'pnl_pct':     round(pnl / (entry * size + 1e-8) * 100, 3),
                'win':         outcome == 1.0,
                'probability': round(prob, 4),
                'equity':      round(capital, 2)
            })

        if not trades:
            _emit('backtest_error', {'msg': 'No trades generated. Check confidence threshold.'})
            return {'error': 'No trades passed confidence threshold', 'trades': [], 'metrics': {}}

        _emit('backtest_progress', {'step': 'computing_metrics', 'pct': 80,
                                     'trades_found': len(trades)})
        metrics = self._compute_metrics(trades)
        mc      = self._monte_carlo(trades)

        _emit('backtest_done', {
            'trades_count': len(trades),
            'metrics': metrics,
            'monte_carlo': mc
        })
        logger.info(f"=== Backtest done: {len(trades)} trades, WR={metrics['win_rate']:.1%}, PnL=${metrics['total_pnl']:.2f} ===")

        return {
            'trades':       trades,         # full trade-by-trade list
            'metrics':      metrics,
            'monte_carlo':  mc,
            'train_meta':   trainer.train_meta,
            'timestamp':    datetime.utcnow().isoformat()
        }

    def _compute_metrics(self, trades):
        pnls   = [t['pnl'] for t in trades]
        wins   = [t for t in trades if t['win']]
        losses = [t for t in trades if not t['win']]

        win_rate = len(wins) / len(trades)
        avg_win  = float(np.mean([t['pnl'] for t in wins]))   if wins   else 0.0
        avg_loss = float(np.mean([abs(t['pnl']) for t in losses])) if losses else 0.001

        gross_win  = sum(t['pnl'] for t in wins)
        gross_loss = abs(sum(t['pnl'] for t in losses))
        pf         = gross_win / gross_loss if gross_loss > 0 else float('inf')
        expectancy = win_rate * avg_win - (1 - win_rate) * avg_loss

        # Equity curve (from trade list, already tracked)
        equity_curve = [t['equity'] for t in trades]
        initial      = float(self.config["capital"]["initial"])

        # Drawdown
        peak = initial; max_dd = 0.0
        for eq in equity_curve:
            if eq > peak: peak = eq
            dd = (peak - eq) / peak
            if dd > max_dd: max_dd = dd

        # Returns
        returns = np.array(pnls) / initial
        sharpe  = float(returns.mean() / (returns.std()+1e-8) * np.sqrt(252)) if len(returns)>1 else 0.0
        neg     = returns[returns < 0]
        sortino = float(returns.mean() / (neg.std()+1e-8) * np.sqrt(252)) if len(neg)>0 else 0.0
        total_pnl = sum(pnls)
        calmar  = float(total_pnl / (max_dd * initial + 1))

        return {
            'total_trades':  len(trades),
            'winning_trades': len(wins),
            'losing_trades':  len(losses),
            'win_rate':      round(win_rate, 4),
            'avg_win':       round(avg_win,  2),
            'avg_loss':      round(avg_loss, 2),
            'profit_factor': round(pf, 3),
            'expectancy':    round(expectancy, 2),
            'sharpe':        round(sharpe, 3),
            'sortino':       round(sortino, 3),
            'calmar':        round(calmar,  3),
            'max_drawdown':  round(max_dd,  4),
            'total_pnl':     round(total_pnl, 2),
            'initial_equity': initial,
            'final_equity':  round(initial + total_pnl, 2),
            'equity_curve':  [round(e,2) for e in equity_curve],
        }

    def _monte_carlo(self, trades, n_sims=1000):
        if not trades: return {}
        pnls    = np.array([t['pnl'] for t in trades])
        initial = float(self.config["capital"]["initial"])
        fe_arr  = []; md_arr = []

        for _ in range(n_sims):
            sim  = pnls * np.random.uniform(0.5, 1.5, len(pnls))
            np.random.shuffle(sim)
            eq   = initial; pk = initial; md = 0.0
            for p in sim:
                eq += p
                if eq > pk: pk = eq
                d = (pk-eq)/pk
                if d > md: md = d
            fe_arr.append(eq); md_arr.append(md)

        fe = np.array(fe_arr); md = np.array(md_arr)
        return {
            'simulations':       n_sims,
            'final_equity_p5':   round(float(np.percentile(fe, 5)),  2),
            'final_equity_p50':  round(float(np.percentile(fe,50)),  2),
            'final_equity_p95':  round(float(np.percentile(fe,95)),  2),
            'max_drawdown_p5':   round(float(np.percentile(md, 5)),  4),
            'max_drawdown_p50':  round(float(np.percentile(md,50)),  4),
            'max_drawdown_p95':  round(float(np.percentile(md,95)),  4),
            'prob_profit':       round(float(np.mean(fe > initial)), 4),
            'worst_case_equity': round(float(np.min(fe)), 2)
        }
