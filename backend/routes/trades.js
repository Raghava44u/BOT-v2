'use strict';
const express = require('express');
const router = express.Router();
const StateManager = require('../services/StateManager');
const SignalEngine = require('../services/SignalEngine');

router.get('/', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(StateManager.getTrades(limit));
});

router.get('/positions', (req, res) => {
  res.json(StateManager.getPositions());
});

router.post('/close/:id', (req, res) => {
  const pos = StateManager.getPositions().find(p => p.id === req.params.id);
  if (!pos) return res.status(404).json({ error: 'Position not found' });
  const trade = StateManager.closePosition(pos.id, pos.entry_price * (1 + (Math.random()-0.5)*0.01), 'manual');
  if (global.broadcast) global.broadcast('TRADE_CLOSED', trade);
  res.json(trade);
});

router.post('/close-all', async (req, res) => {
  const positions = StateManager.getPositions();
  const closed = [];
  for (const pos of positions) {
    const price = pos.entry_price * (1 + (Math.random()-0.5)*0.005);
    const trade = StateManager.closePosition(pos.id, price, 'force_close');
    if (trade) closed.push(trade);
  }
  if (global.broadcast) global.broadcast('ALL_CLOSED', { count: closed.length });
  res.json({ closed: closed.length });
});

router.get('/export', (req, res) => {
  const trades = StateManager.getAllTrades();
  const csv = ['id,ticker,direction,strategy,entry_price,exit_price,size,pnl,entry_time,exit_time,exit_reason']
    .concat(trades.map(t => `${t.id},${t.ticker},${t.direction},${t.strategy||''},${t.entry_price},${t.exit_price||''},${t.size},${(t.pnl||0).toFixed(2)},${t.entry_time||''},${t.exit_time||''},${t.exit_reason||''}`))
    .join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=trades.csv');
  res.send(csv);
});

module.exports = router;
