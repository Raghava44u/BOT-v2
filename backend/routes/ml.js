'use strict';
const express = require('express');
const router  = express.Router();
const MLClient = require('../services/MLClient');

router.get('/health',       async (req, res) => { try { res.json(await MLClient.healthCheck()); } catch { res.json({ status: 'offline' }); }});
router.get('/model-health', async (req, res) => { try { res.json(await MLClient.getModelHealth()); } catch { res.json({ status: 'offline' }); }});
router.get('/status',       async (req, res) => { try { res.json(await MLClient.getStatus()); } catch { res.json({ status: 'offline' }); }});

router.post('/train', async (req, res) => {
  try { res.json(await MLClient.trainModels()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/backtest', async (req, res) => {
  try { res.json(await MLClient.startBacktest()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/backtest/result', async (req, res) => {
  try { res.json(await MLClient.getBacktestResult()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
