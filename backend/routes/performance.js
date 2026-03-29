'use strict';
const express = require('express');
const router = express.Router();
const StateManager = require('../services/StateManager');

router.get('/', (req, res) => res.json(StateManager.getPerformanceMetrics()));
router.get('/trades', (req, res) => res.json(StateManager.getTrades(parseInt(req.query.limit) || 200)));
router.get('/equity-curve', (req, res) => {
  const trades = StateManager.getAllTrades().filter(t => t.status === 'closed');
  let equity = 100000;
  const curve = trades.map(t => { equity += t.pnl || 0; return { ts: t.exit_time, equity }; });
  res.json(curve);
});

module.exports = router;
