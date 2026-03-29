'use strict';
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('../../config/config.json');
const logger = require('../utils/logger');

const DATA_DIR = path.join(__dirname, '../../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const STATE_FILE = path.join(DATA_DIR, 'state.json');
const TRADES_FILE = path.join(DATA_DIR, 'trades.json');
const PERF_FILE = path.join(DATA_DIR, 'performance.json');

let state = {
  trading_active: false,
  circuit_breaker_active: false,
  circuit_breaker_reason: null,
  ml_status: 'offline',
  mode: config.system.mode,
  capital: config.capital.initial,
  peak_capital: config.capital.initial,
  daily_start_capital: config.capital.initial,
  week_start_capital: config.capital.initial,
  positions: {},
  daily_pnl: 0,
  weekly_pnl: 0,
  daily_trades: 0,
  consecutive_losses: 0,
  consecutive_wins: 0,
  equity_curve: [],
  last_data_download: null,
  drawdown_recovery_phase: null,
  protect_mode: false,
  trading_locked: false,
  strategy_allocations: { momentum: 0.40, mean_reversion: 0.30, scalp: 0.30 },
  last_updated: Date.now()
};

let trades = [];
let performance = {
  total_trades: 0, wins: 0, losses: 0, win_rate: 0,
  total_pnl: 0, sharpe: 0, sortino: 0, max_drawdown: 0,
  profit_factor: 0, expectancy: 0, avg_win: 0, avg_loss: 0,
  benchmark_pnl: 0, alpha: 0, beta: 0,
  strategy_metrics: {
    momentum: { trades: 0, wins: 0, pnl: 0, sharpe: 0 },
    mean_reversion: { trades: 0, wins: 0, pnl: 0, sharpe: 0 },
    scalp: { trades: 0, wins: 0, pnl: 0, sharpe: 0 }
  },
  rolling_30: { wins: 0, losses: 0, win_rate: 0 },
  hourly_perf: {},
  ticker_perf: {}
};

function loadFromDisk() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      state = { ...state, ...saved };
      logger.info('State loaded from disk');
    }
    if (fs.existsSync(TRADES_FILE)) {
      trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
      logger.info(`Loaded ${trades.length} historical trades`);
    }
    if (fs.existsSync(PERF_FILE)) {
      performance = { ...performance, ...JSON.parse(fs.readFileSync(PERF_FILE, 'utf8')) };
    }
  } catch (err) {
    logger.error(`State load error: ${err.message}`);
  }
}

function saveToDisk() {
  try {
    state.last_updated = Date.now();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    fs.writeFileSync(TRADES_FILE, JSON.stringify(trades.slice(-5000), null, 2)); // keep last 5000
    fs.writeFileSync(PERF_FILE, JSON.stringify(performance, null, 2));
  } catch (err) {
    logger.error(`State save error: ${err.message}`);
  }
}

function computePerformance() {
  if (trades.length === 0) return;
  const closed = trades.filter(t => t.status === 'closed');
  if (closed.length === 0) return;

  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl <= 0);

  performance.total_trades = closed.length;
  performance.wins = wins.length;
  performance.losses = losses.length;
  performance.win_rate = closed.length > 0 ? wins.length / closed.length : 0;
  performance.total_pnl = closed.reduce((s, t) => s + t.pnl, 0);

  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 1;
  performance.avg_win = avgWin;
  performance.avg_loss = avgLoss;
  performance.profit_factor = avgLoss > 0 ? (wins.reduce((s, t) => s + t.pnl, 0)) / Math.max(Math.abs(losses.reduce((s, t) => s + t.pnl, 0)), 1) : 0;
  performance.expectancy = (performance.win_rate * avgWin) - ((1 - performance.win_rate) * avgLoss);

  // Rolling 30
  const recent = closed.slice(-30);
  const rWins = recent.filter(t => t.pnl > 0).length;
  performance.rolling_30 = { wins: rWins, losses: recent.length - rWins, win_rate: recent.length > 0 ? rWins / recent.length : 0 };

  // Sharpe (simplified)
  if (closed.length > 5) {
    const returns = closed.map(t => t.pnl / state.capital);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length;
    const std = Math.sqrt(variance);
    performance.sharpe = std > 0 ? (mean / std) * Math.sqrt(252 * 78) : 0; // annualized for 5m bars
  }

  // Max drawdown
  let peak = config.capital.initial, maxDD = 0, running = config.capital.initial;
  for (const t of closed) {
    running += t.pnl;
    if (running > peak) peak = running;
    const dd = (peak - running) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  performance.max_drawdown = maxDD;

  // Per ticker and hourly metrics
  for (const t of closed) {
    const ticker = t.ticker;
    if (!performance.ticker_perf[ticker]) performance.ticker_perf[ticker] = { trades: 0, wins: 0, pnl: 0 };
    performance.ticker_perf[ticker].trades++;
    if (t.pnl > 0) performance.ticker_perf[ticker].wins++;
    performance.ticker_perf[ticker].pnl += t.pnl;

    if (t.entry_time) {
      const hour = new Date(t.entry_time).getHours();
      if (!performance.hourly_perf[hour]) performance.hourly_perf[hour] = { trades: 0, wins: 0, pnl: 0 };
      performance.hourly_perf[hour].trades++;
      if (t.pnl > 0) performance.hourly_perf[hour].wins++;
      performance.hourly_perf[hour].pnl += t.pnl;
    }
  }
}

function getDailyPnL() {
  return state.capital - state.daily_start_capital;
}

function getDrawdown() {
  return state.peak_capital > 0 ? (state.peak_capital - state.capital) / state.peak_capital : 0;
}

const SM = {
  initialize() { loadFromDisk(); },
  saveState() { saveToDisk(); },
  getState() { return state; },
  getSnapshot() {
    return {
      state: { ...state },
      performance: { ...performance },
      recent_trades: trades.slice(-50),
      positions: Object.values(state.positions)
    };
  },
  getPositions() { return Object.values(state.positions); },
  getDailyPnL,
  getDrawdown,
  getPerformanceMetrics() { return { ...performance, daily_pnl: getDailyPnL(), drawdown: getDrawdown(), equity: state.capital }; },
  getSystemStatus() { return { trading_active: state.trading_active, mode: state.mode, ml_status: state.ml_status, circuit_breaker: state.circuit_breaker_active }; },
  setMLStatus(s) { state.ml_status = s; },
  setTradingActive(v) { state.trading_active = v; },
  activateCircuitBreaker(reason) {
    state.circuit_breaker_active = true;
    state.circuit_breaker_reason = reason;
    state.trading_active = false;
    logger.warn(`Circuit breaker: ${reason}`);
    saveToDisk();
  },
  resetCircuitBreaker() {
    state.circuit_breaker_active = false;
    state.circuit_breaker_reason = null;
    saveToDisk();
  },
  addPosition(pos) {
    const id = uuidv4();
    state.positions[id] = { ...pos, id, opened_at: Date.now() };
    return id;
  },
  updatePosition(id, updates) {
    if (state.positions[id]) state.positions[id] = { ...state.positions[id], ...updates };
  },
  closePosition(id, exitPrice, reason) {
    const pos = state.positions[id];
    if (!pos) return null;
    const pnl = pos.direction === 'long'
      ? (exitPrice - pos.entry_price) * pos.size
      : (pos.entry_price - exitPrice) * pos.size;
    const trade = { ...pos, exit_price: exitPrice, pnl, exit_reason: reason, status: 'closed', exit_time: Date.now() };
    trades.push(trade);
    delete state.positions[id];

    state.capital += pnl;
    state.daily_pnl = getDailyPnL();
    if (state.capital > state.peak_capital) state.peak_capital = state.capital;

    if (pnl > 0) { state.consecutive_wins++; state.consecutive_losses = 0; }
    else { state.consecutive_losses++; state.consecutive_wins = 0; }

    computePerformance();
    saveToDisk();
    return trade;
  },
  recordTrade(trade) { trades.push(trade); computePerformance(); },
  getTrades(limit = 100) { return trades.slice(-limit); },
  getAllTrades() { return trades; },
  setLastDownload(ts) { state.last_data_download = ts; },
  setProtectMode(v) { state.protect_mode = v; },
  setTradingLocked(v) { state.trading_locked = v; },
  updateStrategyAllocation(allocs) { state.strategy_allocations = allocs; },
  resetDaily() {
    state.daily_start_capital = state.capital;
    state.daily_trades = 0;
    state.protect_mode = false;
    state.trading_locked = false;
    saveToDisk();
  }
};

module.exports = SM;
