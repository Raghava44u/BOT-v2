'use strict';
const config = require('../../config/config.json');
const StateManager = require('./StateManager');
const MLClient = require('./MLClient');
const RiskEngine = require('./RiskEngine');
const logger = require('../utils/logger');

// Heuristic signal scoring when ML is offline
function heuristicScore(ticker) {
  const r = Math.random;
  return {
    ticker,
    direction: r() > 0.5 ? 'long' : 'short',
    strategy: ['momentum','mean_reversion','scalp'][Math.floor(r()*3)],
    scores: {
      momentum: 0.5 + r() * 0.5,
      volume: 0.5 + r() * 0.5,
      sentiment: 0.5 + r() * 0.5,
      macro: 0.5 + r() * 0.5,
      execution_quality: 0.7 + r() * 0.3,
      multi_timeframe: 0.5 + r() * 0.5,
      model_confidence: 0.5 + r() * 0.4
    },
    probability: 0.55 + r() * 0.35,
    regime: ['trending','ranging','volatile'][Math.floor(r()*3)],
    atr: 1.5 + r() * 3,
    entry_price: 100 + r() * 400,
    filters_passed: [],
    filters_failed: []
  };
}

function computeOverallScore(scores) {
  const w = config.signals.score_weights;
  return (
    scores.momentum * w.momentum +
    scores.volume * w.volume +
    scores.sentiment * w.sentiment +
    scores.macro * w.macro +
    scores.execution_quality * w.execution_quality +
    scores.multi_timeframe * w.multi_timeframe +
    scores.model_confidence * w.model_confidence
  );
}

function applyFilters(signal, state) {
  const passed = [];
  const failed = [];
  const threshold = state.protect_mode ? config.signals.high_confidence_score : config.signals.min_confidence_score;

  if (signal.probability >= threshold) passed.push('confidence'); else failed.push(`confidence:${signal.probability.toFixed(2)}<${threshold}`);
  if (signal.scores.execution_quality >= 0.6) passed.push('spread_ok'); else failed.push('spread_too_wide');
  if (!['panic','crash'].includes(signal.regime)) passed.push('regime_ok'); else failed.push(`regime:${signal.regime}`);

  const riskCheck = RiskEngine.canOpenPosition(signal.ticker, signal.direction);
  if (riskCheck.ok) passed.push('risk_ok'); else failed.push(`risk:${riskCheck.reason}`);

  const overallScore = computeOverallScore(signal.scores);
  const minScore = StateManager.getPositions().length >= 7 ? config.signals.slot_pressure_score : config.signals.min_overall_score;
  if (overallScore >= minScore) passed.push('score_ok'); else failed.push(`score:${overallScore.toFixed(2)}<${minScore}`);

  signal.overall_score = overallScore;
  signal.filters_passed = passed;
  signal.filters_failed = failed;
  signal.tradeable = failed.length === 0;
  return signal;
}

const SE = {
  async scan() {
    const state = StateManager.getState();
    const allTickers = [
      ...config.tickers.us_large_cap,
      ...config.tickers.etfs,
      ...config.tickers.crypto
    ];

    let rawSignals = [];

    if (state.ml_status === 'connected') {
      try {
        rawSignals = await MLClient.getSignals(allTickers);
      } catch {
        rawSignals = allTickers.map(heuristicScore);
      }
    } else {
      rawSignals = allTickers.map(heuristicScore);
    }

    // Score and filter
    const scored = rawSignals.map(s => applyFilters(s, state));
    const tradeable = scored.filter(s => s.tradeable);
    tradeable.sort((a, b) => b.overall_score - a.overall_score);

    // Take top N
    const slotsAvail = config.risk.max_concurrent_positions - StateManager.getPositions().length;
    const topN = tradeable.slice(0, Math.min(20, slotsAvail + 5));

    logger.info(`Signal scan: ${rawSignals.length} raw → ${tradeable.length} tradeable → ${topN.length} selected`);
    return topN;
  },

  async executeBestSignal(signal) {
    const state = StateManager.getState();
    if (!state.trading_active || state.circuit_breaker_active) {
      logger.info(`SKIP ${signal.ticker}: system not active`);
      return null;
    }

    const capital = state.capital;
    const sl = signal.atr * config.profit_targets.sl_atr_multiplier;
    const confidence = signal.probability;
    const size = RiskEngine.calculatePositionSize(capital, sl, signal.atr, confidence);

    // Cost-aware filter
    const estCost = (config.execution.fees_per_trade_pct + config.execution.slippage_estimate_pct) * 2;
    const expectedMove = sl * config.profit_targets.standard_rr_ratio;
    if (expectedMove < estCost * config.execution.cost_multiplier_min * signal.entry_price) {
      logger.info(`SKIP ${signal.ticker}: cost-aware filter failed`);
      return null;
    }

    const posId = StateManager.addPosition({
      ticker: signal.ticker,
      direction: signal.direction,
      entry_price: signal.entry_price,
      size,
      stop_loss: signal.direction === 'long' ? signal.entry_price - sl : signal.entry_price + sl,
      take_profit_1: signal.direction === 'long' ? signal.entry_price + sl * config.profit_targets.tier1_take_profit_r : signal.entry_price - sl,
      take_profit_2: signal.direction === 'long' ? signal.entry_price + sl * config.profit_targets.tier2_take_profit_r : signal.entry_price - sl * 2,
      risk_amount: capital * config.risk.risk_per_trade_pct,
      strategy: signal.strategy,
      overall_score: signal.overall_score,
      probability: signal.probability,
      regime: signal.regime,
      filters_passed: signal.filters_passed,
      entry_time: Date.now(),
      status: 'open',
      tier1_taken: false
    });

    state.daily_trades++;
    logger.info(`TRADE ${signal.direction.toUpperCase()} ${signal.ticker} @ ${signal.entry_price} size=${size} score=${signal.overall_score.toFixed(3)}`);

    if (global.broadcast) {
      global.broadcast('TRADE_OPENED', { id: posId, ...signal, size });
    }
    return posId;
  }
};

module.exports = SE;
