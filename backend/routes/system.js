'use strict';
const express = require('express');
const router  = express.Router();
const StateManager = require('../services/StateManager');
const MLClient     = require('../services/MLClient');
const config       = require('../../config/config.json');

router.get('/status',   (req, res) => res.json(StateManager.getSystemStatus()));
router.get('/state',    (req, res) => res.json(StateManager.getState()));
router.get('/snapshot', (req, res) => res.json(StateManager.getSnapshot()));
router.get('/config',   (req, res) => res.json(config));

router.post('/start', (req, res) => {
  StateManager.setTradingActive(true);
  if (global.broadcast) global.broadcast('TRADING_STARTED', { ts: Date.now() });
  res.json({ ok: true });
});

router.post('/stop', (req, res) => {
  StateManager.setTradingActive(false);
  if (global.broadcast) global.broadcast('TRADING_STOPPED', { ts: Date.now() });
  res.json({ ok: true });
});

router.post('/reset-circuit-breaker', (req, res) => {
  StateManager.resetCircuitBreaker();
  if (global.broadcast) global.broadcast('CIRCUIT_BREAKER_RESET', { ts: Date.now() });
  res.json({ ok: true });
});

// ── Download: non-blocking, progress via WebSocket ─────────────────────────
router.post('/download-data', async (req, res) => {
  try {
    const force   = req.body.force || false;
    const tickers = [
      ...config.tickers.us_large_cap,
      ...config.tickers.etfs,
      ...config.tickers.crypto
    ];
    // Kick off background download — returns immediately
    const r = await MLClient.downloadData(tickers, force);
    StateManager.setLastDownload(Date.now());
    res.json({ ok: true, message: r.message || 'Download started', tickers: tickers.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Train: non-blocking ─────────────────────────────────────────────────────
router.post('/train', async (req, res) => {
  try {
    const r = await MLClient.trainModels();
    res.json({ ok: true, message: r.message || 'Training started' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Backtest: non-blocking ──────────────────────────────────────────────────
router.post('/backtest', async (req, res) => {
  try {
    const r = await MLClient.startBacktest();
    res.json({ ok: true, message: r.message || 'Backtest started' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Get cached backtest result ──────────────────────────────────────────────
router.get('/backtest-result', async (req, res) => {
  try {
    const r = await MLClient.getBacktestResult();
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ML health ───────────────────────────────────────────────────────────────
router.get('/ml-health', async (req, res) => {
  try { res.json(await MLClient.getModelHealth()); }
  catch { res.json({ status: 'offline' }); }
});

module.exports = router;
