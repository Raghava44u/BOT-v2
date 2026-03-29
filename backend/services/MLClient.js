'use strict';
const axios = require('axios');
const config = require('../../config/config.json');
const logger = require('../utils/logger');

const ML_BASE = `http://localhost:${config.ports.ml_service}`;

// ── Retry wrapper ──────────────────────────────────────────────────────────────
async function withRetry(fn, maxAttempts = 3, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === maxAttempts;
      logger.warn(`ML request attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
      if (isLast) throw err;
      await new Promise(r => setTimeout(r, delayMs * attempt));
    }
  }
}

// ── Wait for ML service to become ready ───────────────────────────────────────
async function waitForML(maxWaitMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await axios.get(`${ML_BASE}/health`, { timeout: 3000 });
      if (res.data && res.data.status === 'ok') {
        logger.info('ML service ready');
        return true;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  logger.error(`ML service not ready after ${maxWaitMs}ms`);
  return false;
}

const MLClient = {
  waitForML,

  async healthCheck() {
    return withRetry(async () => {
      const res = await axios.get(`${ML_BASE}/health`, { timeout: 5000 });
      return res.data;
    }, 3, 1000);
  },

  async getStatus() {
    try {
      const res = await axios.get(`${ML_BASE}/status`, { timeout: 5000 });
      return res.data;
    } catch { return { status: 'offline' }; }
  },

  async getSignals(tickers) {
    try {
      const res = await axios.post(`${ML_BASE}/signals`, { tickers }, { timeout: 30000 });
      return res.data;
    } catch (err) { logger.error(`ML signals: ${err.message}`); return []; }
  },

  async getPrediction(ticker, features) {
    try {
      const res = await axios.post(`${ML_BASE}/predict`, { ticker, features }, { timeout: 10000 });
      return res.data;
    } catch { return { probability: 0.5, confidence: 0.5, ensemble_agreement: false }; }
  },

  async downloadData(tickers, force = false) {
    // Returns immediately (background task), progress via SSE
    const res = await axios.post(`${ML_BASE}/download`, { tickers, force }, { timeout: 15000 });
    return res.data;
  },

  async trainModels() {
    // Returns immediately (background task), progress via SSE
    const res = await axios.post(`${ML_BASE}/train`, {}, { timeout: 15000 });
    return res.data;
  },

  async startBacktest() {
    const res = await axios.get(`${ML_BASE}/backtest`, { timeout: 15000 });
    return res.data;
  },

  async getBacktestResult() {
    try {
      const res = await axios.get(`${ML_BASE}/backtest/result`, { timeout: 10000 });
      return res.data;
    } catch (err) { throw err; }
  },

  async getModelHealth() {
    try {
      const res = await axios.get(`${ML_BASE}/model-health`, { timeout: 10000 });
      return res.data;
    } catch { return { status: 'offline' }; }
  }
};

module.exports = MLClient;
