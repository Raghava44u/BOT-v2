'use strict';
const config = require('../../config/config.json');
const StateManager = require('./StateManager');
const logger = require('../utils/logger');

const RE = {
  evaluate() {
    const state = StateManager.getState();
    const positions = StateManager.getPositions();
    const capital = state.capital;
    const dailyPnL = StateManager.getDailyPnL();
    const drawdown = StateManager.getDrawdown();
    const result = { circuit_breaker: false, reason: null, warnings: [], reduce_size: false, reduce_factor: 1.0 };

    // Max daily loss
    const dailyLossPct = dailyPnL / state.daily_start_capital;
    if (dailyLossPct <= -config.risk.max_daily_loss_pct) {
      result.circuit_breaker = true; result.reason = `Daily loss limit: ${(dailyLossPct*100).toFixed(2)}%`; return result;
    }

    // Max drawdown
    if (drawdown >= config.risk.max_drawdown_pct) {
      result.circuit_breaker = true; result.reason = `Max drawdown: ${(drawdown*100).toFixed(2)}%`; return result;
    }

    // Consecutive losses
    if (state.consecutive_losses >= 7) {
      result.circuit_breaker = true; result.reason = `7 consecutive losses`; return result;
    }
    if (state.consecutive_losses >= 5) {
      result.warnings.push(`${state.consecutive_losses} consecutive losses — pausing 30 min`);
      result.reduce_size = true; result.reduce_factor = 0.5;
    } else if (state.consecutive_losses >= 3) {
      result.reduce_size = true; result.reduce_factor = 0.5;
    }

    // Max trades per day
    if (state.daily_trades >= config.risk.max_trades_per_day) {
      result.circuit_breaker = true; result.reason = 'Max daily trades reached'; return result;
    }

    // Aggregate open risk
    let openRisk = 0;
    for (const p of positions) openRisk += (p.risk_amount || 0);
    const openRiskPct = openRisk / capital;
    if (openRiskPct >= config.risk.aggregate_risk_cap_pct) {
      result.warnings.push(`Open risk at ${(openRiskPct*100).toFixed(2)}% — near cap`);
      result.reduce_size = true; result.reduce_factor = Math.min(result.reduce_factor, 0.5);
    }

    // Protect mode check
    const dailyGainPct = dailyPnL / state.daily_start_capital;
    if (dailyGainPct >= config.profit_targets.daily_stretch_target_pct) {
      result.circuit_breaker = true; result.reason = `Daily stretch target hit: +${(dailyGainPct*100).toFixed(2)}% — locking gains`;
      return result;
    }
    if (dailyGainPct >= config.profit_targets.daily_protect_mode_pct) {
      result.warnings.push('Protect mode: +0.5% daily target reached'); result.reduce_size = true; result.reduce_factor = 0.5;
    }

    return result;
  },

  calculatePositionSize(capital, stopLossDist, atr, confidence) {
    const riskAmount = capital * config.risk.risk_per_trade_pct;
    let size = stopLossDist > 0 ? riskAmount / stopLossDist : 0;

    // ATR-based volatility adjustment
    if (atr && atr > 0) {
      const normalATR = atr / (capital / 100); // normalize
      if (normalATR > 2) size *= 0.75; // high vol
      if (normalATR > 3) size *= 0.5;  // very high vol
    }

    // Kelly adjustment
    const f = config.risk.kelly_fraction;
    const p = confidence || 0.75;
    const q = 1 - p;
    const b = config.profit_targets.standard_rr_ratio;
    const kelly = (p * b - q) / b;
    const kellyAdj = Math.max(0.1, Math.min(1, kelly * f));
    size *= kellyAdj;

    return Math.max(0, Math.floor(size * 100) / 100);
  },

  isCorrelated(newTicker, positions) {
    // Simplified: check sector overlap
    const sectors = {
      'AAPL': 'tech', 'MSFT': 'tech', 'GOOGL': 'tech', 'AMZN': 'tech', 'NVDA': 'tech', 'META': 'tech', 'CRM': 'tech', 'AMD': 'tech',
      'JPM': 'finance', 'V': 'finance', 'MA': 'finance', 'PYPL': 'finance',
      'JNJ': 'health', 'UNH': 'health',
      'WMT': 'consumer', 'PG': 'consumer', 'HD': 'consumer', 'DIS': 'consumer', 'NFLX': 'consumer',
      'XLF': 'finance', 'XLE': 'energy', 'XLK': 'tech',
      'BTC-USD': 'crypto', 'ETH-USD': 'crypto', 'SOL-USD': 'crypto', 'BNB-USD': 'crypto', 'XRP-USD': 'crypto', 'ADA-USD': 'crypto'
    };
    const newSector = sectors[newTicker] || 'other';
    const sectorCount = positions.filter(p => (sectors[p.ticker] || 'other') === newSector).length;
    return sectorCount >= config.risk.sector_max_concurrent;
  },

  canOpenPosition(ticker, direction) {
    const positions = StateManager.getPositions();
    const state = StateManager.getState();
    if (positions.length >= config.risk.max_concurrent_positions) return { ok: false, reason: 'Max positions reached' };
    if (this.isCorrelated(ticker, positions)) return { ok: false, reason: 'Sector concentration limit' };
    const riskCheck = this.evaluate();
    if (riskCheck.circuit_breaker) return { ok: false, reason: riskCheck.reason };
    return { ok: true };
  }
};

module.exports = RE;
