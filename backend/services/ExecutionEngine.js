'use strict';
const config = require('../../config/config.json');
const StateManager = require('./StateManager');
const logger = require('../utils/logger');

function simulatePrice(pos) {
  // Simulate market movement for paper trading
  const drift = (Math.random() - 0.48) * pos.entry_price * 0.001;
  return pos.entry_price + drift;
}

const EE = {
  async updatePositions() {
    const positions = StateManager.getPositions();
    const closed = [];

    for (const pos of positions) {
      const currentPrice = simulatePrice(pos);
      const sl = pos.stop_loss;
      const tp1 = pos.take_profit_1;
      const tp2 = pos.take_profit_2;
      const isLong = pos.direction === 'long';

      // Check stop loss
      const slHit = isLong ? currentPrice <= sl : currentPrice >= sl;
      if (slHit) {
        const trade = StateManager.closePosition(pos.id, sl, 'stop_loss');
        closed.push(trade);
        logger.info(`SL hit: ${pos.ticker} @ ${sl}`);
        if (global.broadcast) global.broadcast('TRADE_CLOSED', trade);
        continue;
      }

      // Tier 1 TP
      const tp1Hit = isLong ? currentPrice >= tp1 : currentPrice <= tp1;
      if (tp1Hit && !pos.tier1_taken) {
        StateManager.updatePosition(pos.id, {
          tier1_taken: true,
          stop_loss: pos.entry_price, // move to breakeven
          size: pos.size * 0.5
        });
        logger.info(`Tier1 TP: ${pos.ticker} — 50% closed, BE stop set`);
        if (global.broadcast) global.broadcast('TIER1_HIT', { id: pos.id, ticker: pos.ticker, price: currentPrice });
        continue;
      }

      // Tier 2 TP (full close)
      const tp2Hit = isLong ? currentPrice >= tp2 : currentPrice <= tp2;
      if (tp2Hit && pos.tier1_taken) {
        const trade = StateManager.closePosition(pos.id, currentPrice, 'take_profit_2');
        closed.push(trade);
        logger.info(`TP2 hit: ${pos.ticker} @ ${currentPrice}`);
        if (global.broadcast) global.broadcast('TRADE_CLOSED', trade);
        continue;
      }

      // Time-based exit: close if held > N candles (12 * 5min = 60 min)
      const maxHoldMs = config.ml.label_horizon_candles * 5 * 60 * 1000;
      if (Date.now() - pos.opened_at > maxHoldMs) {
        const trade = StateManager.closePosition(pos.id, currentPrice, 'time_exit');
        closed.push(trade);
        logger.info(`Time exit: ${pos.ticker}`);
        if (global.broadcast) global.broadcast('TRADE_CLOSED', trade);
      }
    }

    return closed;
  },

  async flattenIntraday() {
    const positions = StateManager.getPositions();
    for (const pos of positions) {
      if (pos.hold_overnight) continue;
      const price = simulatePrice(pos);
      const trade = StateManager.closePosition(pos.id, price, 'eod_flatten');
      if (global.broadcast) global.broadcast('TRADE_CLOSED', trade);
    }
    logger.info(`EOD flatten: ${positions.length} positions closed`);
  },

  async rebalancePositions() {
    const positions = StateManager.getPositions();
    logger.info(`Rebalancing ${positions.length} open positions`);
    // In a real system: re-score and close if score < 0.40
    // Simplified: log and broadcast
    if (global.broadcast) global.broadcast('REBALANCE_DONE', { positions: positions.length, ts: Date.now() });
  }
};

module.exports = EE;
