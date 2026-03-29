'use strict';
const express  = require('express');
const http     = require('http');
const WebSocket = require('ws');
const cors     = require('cors');
const path     = require('path');
const cron     = require('node-cron');
const axios    = require('axios');

const config          = require('../config/config.json');
const StateManager    = require('./services/StateManager');
const RiskEngine      = require('./services/RiskEngine');
const ExecutionEngine = require('./services/ExecutionEngine');
const SignalEngine    = require('./services/SignalEngine');
const MLClient        = require('./services/MLClient');
const logger          = require('./utils/logger');

const tradeRoutes   = require('./routes/trades');
const systemRoutes  = require('./routes/system');
const mlRoutes      = require('./routes/ml');
const perfRoutes    = require('./routes/performance');

const app    = express();
const server = http.createServer(app);

// ── WebSocket broadcast ────────────────────────────────────────────────────
const wss      = new WebSocket.Server({ server, path: '/ws' });
const wsClients = new Set();

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wsClients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}
global.broadcast = broadcast;

wss.on('connection', ws => {
  wsClients.add(ws);
  logger.info(`WS client connected (${wsClients.size} total)`);
  ws.send(JSON.stringify({ type: 'INIT', data: StateManager.getSnapshot(), ts: Date.now() }));
  ws.on('close', () => { wsClients.delete(ws); });
  ws.on('error', err => logger.error(`WS: ${err.message}`));
});

// ── SSE proxy from ML service → WebSocket ─────────────────────────────────
let sseStream = null;

async function connectSSE() {
  const ML_SSE = `http://localhost:${config.ports.ml_service}/events`;
  try {
    const res = await axios.get(ML_SSE, {
      responseType: 'stream', timeout: 0,
      headers: { Accept: 'text/event-stream' }
    });
    sseStream = res.data;
    logger.info('ML SSE stream connected');

    let buf = '';
    res.data.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === ':heartbeat') continue;
        try {
          const payload = JSON.parse(raw);
          if (payload.event) {
            broadcast('ML_EVENT', payload);
            handleMLEvent(payload.event, payload.data);
          }
        } catch {}
      }
    });

    res.data.on('error', () => { setTimeout(connectSSE, 3000); });
    res.data.on('end',   () => { setTimeout(connectSSE, 3000); });
  } catch {
    setTimeout(connectSSE, 5000);
  }
}

function handleMLEvent(event, data) {
  switch (event) {
    case 'download_progress':
      broadcast('DOWNLOAD_PROGRESS', data); break;
    case 'download_complete':
      broadcast('DOWNLOAD_DONE', data);
      logger.info(`Download done: ${data.tickers_ok} succeeded`); break;
    case 'download_error':
      broadcast('DOWNLOAD_ERROR', data);
      logger.error(`Download error: ${data.msg}`); break;
    case 'merge_done':
      broadcast('MERGE_DONE', data); break;
    case 'train_start':
    case 'train_progress':
      broadcast('TRAIN_PROGRESS', data); break;
    case 'train_complete':
      broadcast('MODEL_TRAINED', data);
      StateManager.setMLStatus('connected');
      logger.info('Models trained'); break;
    case 'train_error':
      broadcast('TRAIN_ERROR', data);
      logger.error(`Train error: ${data.msg}`); break;
    case 'backtest_start':
    case 'backtest_progress':
      broadcast('BACKTEST_PROGRESS', data); break;
    case 'backtest_complete':
      broadcast('BACKTEST_DONE', data);
      logger.info(`Backtest done: ${data.trades?.length || 0} trades`); break;
    case 'backtest_error':
      broadcast('BACKTEST_ERROR', data);
      logger.error(`Backtest error: ${data.msg}`); break;
    default:
      broadcast('ML_EVENT', { event, data }); break;
  }
}

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../frontend')));

app.use('/api/trades',      tradeRoutes);
app.use('/api/system',      systemRoutes);
app.use('/api/ml',          mlRoutes);
app.use('/api/performance', perfRoutes);

app.get('/',       (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime(), ts: new Date().toISOString() }));

// ── Cron jobs ──────────────────────────────────────────────────────────────
cron.schedule('*/5 * * * *', async () => {
  const state = StateManager.getState();
  if (!state.trading_active || state.circuit_breaker_active) return;
  try {
    const signals = await SignalEngine.scan();
    if (signals.length) broadcast('SIGNALS', signals);
  } catch (err) { logger.error(`Signal scan: ${err.message}`); }
});

cron.schedule('* * * * *', async () => {
  try {
    await ExecutionEngine.updatePositions();
    const risk = RiskEngine.evaluate();
    if (risk.circuit_breaker) { StateManager.activateCircuitBreaker(risk.reason); broadcast('CIRCUIT_BREAKER', risk); }
    broadcast('POSITION_UPDATE', { positions: StateManager.getPositions(), risk, pnl: StateManager.getDailyPnL() });
  } catch (err) { logger.error(`Position update: ${err.message}`); }
});

cron.schedule('*/30 * * * * *', () => {
  try { StateManager.saveState(); broadcast('PERFORMANCE', StateManager.getPerformanceMetrics()); }
  catch (err) { logger.error(`State save: ${err.message}`); }
});

// ── Startup ────────────────────────────────────────────────────────────────
async function startup() {
  logger.info('=== APEX Trading System v2.0 Starting ===');
  StateManager.initialize();

  const PORT = config.ports.backend;
  server.listen(PORT, () => {
    logger.info(`Backend → http://localhost:${PORT}`);
  });

  // Wait up to 60s for ML service
  logger.info('Waiting for ML service…');
  const ready = await MLClient.waitForML(60000);
  if (ready) {
    StateManager.setMLStatus('connected');
    broadcast('ML_CONNECTED', { ts: Date.now() });
    connectSSE();  // start SSE proxy
  } else {
    StateManager.setMLStatus('offline');
    logger.warn('ML service not available — heuristic mode active');
    // Keep retrying SSE in background
    setTimeout(connectSSE, 10000);
  }

  // Periodic ML health check
  setInterval(async () => {
    try {
      const h = await MLClient.healthCheck();
      if (h.status === 'ok') {
        if (StateManager.getState().ml_status !== 'connected') {
          StateManager.setMLStatus('connected');
          broadcast('ML_CONNECTED', { ts: Date.now() });
        }
      }
    } catch {
      if (StateManager.getState().ml_status === 'connected') {
        StateManager.setMLStatus('offline');
        broadcast('ML_DISCONNECTED', { ts: Date.now() });
        logger.warn('ML service became unreachable');
      }
    }
  }, 15000);
}

startup().catch(err => { logger.error(`Startup: ${err.message}`); process.exit(1); });
process.on('uncaughtException',  err => logger.error(`Uncaught: ${err.message}`));
process.on('unhandledRejection', r   => logger.error(`Unhandled: ${r}`));
