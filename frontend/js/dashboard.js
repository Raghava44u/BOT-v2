/* dashboard.js — Main UI Controller */
'use strict';

// ─── API Helper ──────────────────────────────────────────────────────────────
const API = {
  base: '/api',
  async get(path) {
    const r = await fetch(this.base + path);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  },
  async post(path, body = {}) {
    const r = await fetch(this.base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
};

// ─── State ────────────────────────────────────────────────────────────────────
const State = {
  trading: false,
  equity: 100000,
  dailyPnL: 0,
  positions: [],
  signals: [],
  performance: {},
  alerts: [],
  auditLog: [],
  equityCurve: [100000],
  equityTimes: [Date.now()],
  selectedSignal: null,
  tradesToday: 0,
  circuitBreaker: false
};

// ─── Audit Log ────────────────────────────────────────────────────────────────
function auditLog(msg, type = 'info') {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const typeMap = { info: 'SYS', trade: 'TRADE', skip: 'SKIP', risk: 'RISK', warn: 'WARN' };
  const entry = { ts, type, msg };
  State.auditLog.unshift(entry);
  if (State.auditLog.length > 200) State.auditLog.pop();

  const log = document.getElementById('audit-log');
  if (!log) return;
  const el = document.createElement('div');
  el.className = `al-item ${type} fade-in`;
  el.innerHTML = `<span class="al-ts">${ts}</span><span class="al-type ${type}">${typeMap[type] || 'SYS'}</span><span class="al-msg">${msg}</span>`;
  log.prepend(el);
  while (log.children.length > 100) log.removeChild(log.lastChild);
}

// ─── Alert System ─────────────────────────────────────────────────────────────
function addAlert(msg, severity = 'warn') {
  const list = document.getElementById('alerts-list');
  if (!list) return;

  // Remove empty state
  const empty = list.querySelector('.empty-state');
  if (empty) empty.remove();

  const el = document.createElement('div');
  el.className = `al-entry ${severity} fade-in`;
  el.innerHTML = `<span class="al-dot"></span>${msg}`;
  list.prepend(el);
  while (list.children.length > 15) list.removeChild(list.lastChild);

  const badge = document.getElementById('alert-count');
  if (badge) { badge.textContent = list.children.length; badge.classList.remove('hidden'); }
}

function clearAlerts() {
  const list = document.getElementById('alerts-list');
  if (list) list.innerHTML = '<div class="al-entry ok"><span class="al-dot"></span>All systems nominal</div>';
  const badge = document.getElementById('alert-count');
  if (badge) badge.classList.add('hidden');
}

// ─── Number Formatters ────────────────────────────────────────────────────────
const fmt = {
  dollar: v => v >= 0 ? `+$${Math.abs(v).toLocaleString('en',{minimumFractionDigits:2,maximumFractionDigits:2})}` : `-$${Math.abs(v).toLocaleString('en',{minimumFractionDigits:2,maximumFractionDigits:2})}`,
  pct: v => `${(v*100).toFixed(2)}%`,
  num: (v, dec=2) => typeof v === 'number' ? v.toFixed(dec) : '—',
  price: v => typeof v === 'number' ? `$${v.toLocaleString('en',{minimumFractionDigits:2,maximumFractionDigits:2})}` : '—'
};

function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function setHTML(id, val) { const el = document.getElementById(id); if (el) el.innerHTML = val; }

// ─── Metrics Bar Update ───────────────────────────────────────────────────────
function updateMetrics(data = {}) {
  const equity = data.equity || State.equity;
  const dailyPnL = data.daily_pnl || State.dailyPnL;
  const perf = data.performance || State.performance;

  setText('m-equity', `$${equity.toLocaleString('en',{maximumFractionDigits:0})}`);

  const pnlEl = document.getElementById('m-daily-pnl');
  if (pnlEl) {
    pnlEl.textContent = `${dailyPnL >= 0 ? '+' : ''}${fmt.dollar(dailyPnL)} today`;
    pnlEl.className = `metric-delta ${dailyPnL >= 0 ? 'green' : 'red'}`;
  }

  if (perf.win_rate != null) setText('m-win-rate', fmt.pct(perf.win_rate));
  if (perf.rolling_30?.win_rate != null) setText('m-rolling-wr', `rolling 30: ${fmt.pct(perf.rolling_30.win_rate)}`);
  if (perf.sharpe != null) setText('m-sharpe', fmt.num(perf.sharpe, 3));

  const drawdown = data.drawdown || 0;
  const ddEl = document.getElementById('m-drawdown');
  if (ddEl) { ddEl.textContent = fmt.pct(drawdown); ddEl.className = `metric-value ${drawdown > 0.05 ? 'red' : ''}`; }

  const todayTrades = State.tradesToday;
  setText('m-trades-today', `${todayTrades} `);
  const tt = document.getElementById('m-trades-today');
  if (tt) tt.innerHTML = `${todayTrades} <span class="target">/ 20</span>`;

  setText('m-open-pos', `${State.positions.length} positions open`);

  if (perf.profit_factor != null) setText('m-profit-factor', fmt.num(perf.profit_factor, 3));
  if (perf.expectancy != null) setText('m-expectancy', `expectancy ${fmt.dollar(perf.expectancy)}`);

  // Stats panel
  setText('sg-total', perf.total_trades || 0);
  setText('sg-wins', perf.wins || 0);
  setText('sg-losses', perf.losses || 0);
  setText('sg-avg-win', perf.avg_win ? fmt.dollar(perf.avg_win) : '—');
  setText('sg-avg-loss', perf.avg_loss ? `-$${(perf.avg_loss).toFixed(2)}` : '—');
  setText('sg-exp', perf.expectancy ? fmt.dollar(perf.expectancy) : '—');
  setText('sg-sortino', fmt.num(perf.sortino || 0, 3));
  setText('sg-maxdd', fmt.pct(perf.max_drawdown || 0));

  // Daily profit target
  updateDailyTarget(dailyPnL, State.equity);

  // Risk gauges
  updateRiskGauges(data);
}

function updateDailyTarget(pnl, capital) {
  const pct = capital > 0 ? pnl / capital : 0;
  const pctPct = Math.max(0, Math.min(100, pct * 100 / 1.0 * 100)); // 0–100% where 100% = +1%

  const fill = document.getElementById('pl-fill');
  const pctEl = document.getElementById('pl-pct');
  if (fill) {
    fill.style.width = pctPct + '%';
    fill.className = `pl-fill ${pct >= 0.01 ? 'locked' : pct >= 0.005 ? 'protect' : ''}`;
  }
  if (pctEl) pctEl.textContent = `${(pct * 100).toFixed(2)}%`;

  const modeEl = document.getElementById('m-profit-mode');
  const modeCard = document.getElementById('mode-card');
  const progEl = document.getElementById('m-daily-progress');

  if (pct >= 0.01) {
    setText('m-profit-mode', '🔒 LOCKED');
    if (modeCard) modeCard.className = 'metric-card mode-card locked';
  } else if (pct >= 0.005) {
    setText('m-profit-mode', '🛡 PROTECT');
    if (modeCard) modeCard.className = 'metric-card mode-card protect';
  } else {
    setText('m-profit-mode', 'NORMAL');
    if (modeCard) modeCard.className = 'metric-card mode-card';
  }
  if (progEl) progEl.textContent = `${(pct / 0.01 * 100).toFixed(0)}% of daily target`;
}

function updateRiskGauges(data = {}) {
  const setGauge = (id, valId, pct, label) => {
    const el = document.getElementById(id);
    if (el) { el.style.width = Math.min(100, pct * 100) + '%'; el.className = `rg-fill ${pct > 0.7 ? 'danger' : pct > 0.4 ? 'warn' : ''}`; }
    if (valId) setText(valId, label);
  };

  const dailyLossPct = data.daily_pnl < 0 ? Math.abs(data.daily_pnl) / (data.equity || 100000) : 0;
  setGauge('rg-daily', 'rg-daily-val', dailyLossPct / 0.03, `${fmt.pct(dailyLossPct)} / 3%`);

  const openRisk = State.positions.length * 0.0025;
  setGauge('rg-risk', 'rg-risk-val', openRisk / 0.02, `${fmt.pct(openRisk)} / 2%`);

  const dd = data.drawdown || 0;
  setGauge('rg-dd', 'rg-dd-val', dd / 0.10, `${fmt.pct(dd)} / 10%`);

  const streak = data.state?.consecutive_losses || 0;
  setGauge('rg-losses', 'rg-losses-val', streak / 5, `${streak} / 5`);
}

// ─── Positions Table ──────────────────────────────────────────────────────────
function renderPositions(positions = []) {
  State.positions = positions;
  const tbody = document.getElementById('positions-tbody');
  const countEl = document.getElementById('pos-count');
  if (countEl) countEl.textContent = `${positions.length} / 8`;

  if (!tbody) return;
  if (positions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty-row">No open positions</td></tr>';
    return;
  }

  tbody.innerHTML = positions.map(p => {
    const currentPrice = p.entry_price * (1 + (Math.random() - 0.5) * 0.005);
    const pnl = p.direction === 'long' ? (currentPrice - p.entry_price) * p.size : (p.entry_price - currentPrice) * p.size;
    const pnlColor = pnl >= 0 ? 'green' : 'red';
    return `<tr class="fade-in">
      <td><strong>${p.ticker}</strong></td>
      <td><span class="dir-badge ${p.direction}">${p.direction.toUpperCase()}</span></td>
      <td><span style="color:var(--text-muted);font-size:10px">${p.strategy || 'scalp'}</span></td>
      <td style="font-family:var(--mono)">${fmt.price(p.entry_price)}</td>
      <td style="font-family:var(--mono);color:var(--red)">${fmt.price(p.stop_loss)}</td>
      <td style="font-family:var(--mono);color:var(--green)">${fmt.price(p.take_profit_1)}</td>
      <td style="font-family:var(--mono)">${p.size?.toFixed(2) || '—'}</td>
      <td style="font-family:var(--mono);color:var(--${pnlColor})">${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}</td>
      <td style="font-family:var(--mono);color:var(--accent)">${(p.overall_score || 0).toFixed(3)}</td>
      <td class="tier-badge">${p.tier1_taken ? 'T2→' : 'T1'}</td>
      <td><button class="close-btn" onclick="closePosition('${p.id}')">✕</button></td>
    </tr>`;
  }).join('');
}

async function closePosition(id) {
  try {
    await API.post(`/trades/close/${id}`);
    auditLog(`Manual close: position ${id.substring(0,8)}…`, 'warn');
  } catch (err) {
    auditLog(`Close failed: ${err.message}`, 'risk');
  }
}
window.closePosition = closePosition;

// ─── Opportunities Panel ──────────────────────────────────────────────────────
function renderSignals(signals = []) {
  State.signals = signals;
  const list = document.getElementById('opp-list');
  const countEl = document.getElementById('opp-count');
  if (countEl) countEl.textContent = `${signals.length} signals`;

  if (!list) return;
  if (signals.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="es-icon">⚡</div><div>No opportunities meeting threshold</div></div>`;
    return;
  }

  list.innerHTML = signals.slice(0, 12).map((s, i) => {
    const scorePct = Math.round(s.overall_score * 100);
    const scoreColor = s.overall_score >= 0.80 ? 'var(--green)' : s.overall_score >= 0.70 ? 'var(--accent)' : 'var(--yellow)';
    return `<div class="opp-card ${s.direction} fade-in" onclick="selectSignal(${i})" style="animation-delay:${i*30}ms">
      <div class="opp-top">
        <span class="opp-ticker">${s.ticker}</span>
        <span class="opp-dir ${s.direction}">${s.direction.toUpperCase()}</span>
      </div>
      <div class="opp-score-row">
        <div class="opp-score-bar"><div class="opp-score-fill" style="width:${scorePct}%;background:${scoreColor}"></div></div>
        <span class="opp-score-val" style="color:${scoreColor}">${s.overall_score.toFixed(3)}</span>
      </div>
      <div class="opp-meta">
        <span class="opp-tag regime">${s.regime}</span>
        <span class="opp-tag strategy">${s.strategy}</span>
        ${s.bb_squeeze ? '<span class="opp-tag squeeze">⚡ SQUEEZE</span>' : ''}
        <span class="opp-tag">RSI ${s.rsi?.toFixed(0) || '—'}</span>
        ${s.volume_spike ? '<span class="opp-tag" style="color:var(--green)">📈 VOL SURGE</span>' : ''}
      </div>
      <button class="opp-btn" onclick="event.stopPropagation();executeSignal(${i})">EXECUTE</button>
    </div>`;
  }).join('');
}

function selectSignal(idx) {
  const sig = State.signals[idx];
  if (!sig) return;
  State.selectedSignal = sig;

  setText('explain-ticker', sig.ticker);

  const grid = document.getElementById('explain-grid');
  if (grid) {
    const scoreItems = [
      { label: 'MOMENTUM', key: 'momentum', color: 'var(--accent)' },
      { label: 'VOLUME', key: 'volume', color: 'var(--green)' },
      { label: 'SENTIMENT', key: 'sentiment', color: 'var(--blue)' },
      { label: 'MACRO', key: 'macro', color: 'var(--purple)' },
      { label: 'EXECUTION', key: 'execution_quality', color: 'var(--yellow)' },
      { label: 'MULTI-TF', key: 'multi_timeframe', color: 'var(--accent)' },
    ];
    grid.innerHTML = scoreItems.map(item => {
      const val = sig.scores?.[item.key] || 0;
      const pct = Math.round(val * 100);
      return `<div class="eg-item fade-in">
        <div class="eg-label">${item.label}</div>
        <div class="eg-bar-wrap"><div class="eg-bar" style="width:${pct}%;background:${item.color}"></div></div>
        <div class="eg-val" style="color:${item.color}">${val.toFixed(3)}</div>
      </div>`;
    }).join('');
  }

  // Update gauge
  const prob = sig.probability || 0;
  const arc = document.getElementById('gauge-arc');
  const pctEl = document.getElementById('gauge-pct');
  if (arc) {
    const totalLen = 267;
    arc.style.strokeDashoffset = totalLen * (1 - prob);
  }
  if (pctEl) pctEl.textContent = `${Math.round(prob * 100)}%`;

  const ensVal = document.getElementById('ensemble-val');
  if (ensVal) {
    ensVal.textContent = sig.ensemble_agreement ? '✓ AGREE (2/3+)' : '✗ SPLIT';
    ensVal.className = `er-val ${sig.ensemble_agreement ? 'agree' : 'disagree'}`;
  }

  auditLog(`Inspected signal: ${sig.ticker} ${sig.direction.toUpperCase()} score=${sig.overall_score.toFixed(3)} prob=${sig.probability.toFixed(3)}`, 'info');
}
window.selectSignal = selectSignal;

async function executeSignal(idx) {
  const sig = State.signals[idx];
  if (!sig) return;
  if (!State.trading) {
    auditLog(`SKIP ${sig.ticker}: trading not active`, 'skip');
    addAlert('Enable trading first', 'warn');
    return;
  }
  auditLog(`TRADE ${sig.direction.toUpperCase()} ${sig.ticker} @ ${sig.entry_price} score=${sig.overall_score.toFixed(3)}`, 'trade');
}
window.executeSignal = executeSignal;

// ─── Equity Chart ─────────────────────────────────────────────────────────────
let equityCanvas = null;
let equityCtx = null;

function initEquityChart() {
  const canvas = document.getElementById('equity-chart');
  if (!canvas) return;
  equityCanvas = canvas;
  equityCtx = canvas.getContext('2d');
  drawEquityChart();
}

function drawEquityChart() {
  if (!equityCtx || !equityCanvas) return;
  const data = State.equityCurve;
  const W = equityCanvas.offsetWidth || 400;
  const H = equityCanvas.offsetHeight || 140;
  equityCanvas.width = W;
  equityCanvas.height = H;

  const ctx = equityCtx;
  ctx.clearRect(0, 0, W, H);

  if (data.length < 2) {
    ctx.fillStyle = '#484f58';
    ctx.font = '12px Space Mono';
    ctx.fillText('No trade history yet', W/2 - 80, H/2);
    return;
  }

  const min = Math.min(...data) * 0.999;
  const max = Math.max(...data) * 1.001;
  const range = max - min || 1;

  const toX = i => (i / (data.length - 1)) * (W - 20) + 10;
  const toY = v => H - 20 - ((v - min) / range) * (H - 30);

  // Grid
  ctx.strokeStyle = '#21262d';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const y = 10 + (g / 4) * (H - 30);
    ctx.beginPath(); ctx.moveTo(10, y); ctx.lineTo(W - 10, y); ctx.stroke();
    const val = max - (g / 4) * range;
    ctx.fillStyle = '#484f58';
    ctx.font = '9px Space Mono';
    ctx.fillText(`$${val.toLocaleString('en',{maximumFractionDigits:0})}`, 12, y - 2);
  }

  // Gradient fill
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  const isProfit = data[data.length-1] >= data[0];
  grad.addColorStop(0, isProfit ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');

  ctx.beginPath();
  ctx.moveTo(toX(0), toY(data[0]));
  for (let i = 1; i < data.length; i++) ctx.lineTo(toX(i), toY(data[i]));
  ctx.lineTo(toX(data.length - 1), H);
  ctx.lineTo(toX(0), H);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.strokeStyle = isProfit ? '#22c55e' : '#ef4444';
  ctx.lineWidth = 2;
  ctx.moveTo(toX(0), toY(data[0]));
  for (let i = 1; i < data.length; i++) ctx.lineTo(toX(i), toY(data[i]));
  ctx.stroke();

  // Moving average
  if (data.length >= 10) {
    const maData = data.map((_, i) => {
      const window = data.slice(Math.max(0, i - 9), i + 1);
      return window.reduce((a, b) => a + b, 0) / window.length;
    });
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(0,212,170,0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.moveTo(toX(0), toY(maData[0]));
    for (let i = 1; i < maData.length; i++) ctx.lineTo(toX(i), toY(maData[i]));
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// ─── Trades Table ─────────────────────────────────────────────────────────────
function renderTrades(trades = []) {
  const tbody = document.getElementById('trades-tbody');
  if (!tbody) return;
  const recent = [...trades].reverse().slice(0, 30);
  if (recent.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-row">No completed trades</td></tr>';
    return;
  }
  tbody.innerHTML = recent.map(t => {
    const pnl = t.pnl || 0;
    const ts = t.exit_time ? new Date(t.exit_time).toLocaleTimeString('en-US', { hour12: false }) : '—';
    return `<tr>
      <td style="font-family:var(--mono);color:var(--text-muted)">${ts}</td>
      <td><strong>${t.ticker || '—'}</strong></td>
      <td><span class="dir-badge ${t.direction || ''}">${(t.direction || '').toUpperCase()}</span></td>
      <td style="color:var(--text-muted);font-size:10px">${t.strategy || '—'}</td>
      <td style="font-family:var(--mono)">${fmt.price(t.entry_price)}</td>
      <td style="font-family:var(--mono)">${fmt.price(t.exit_price)}</td>
      <td style="font-family:var(--mono);color:var(--${pnl >= 0 ? 'green' : 'red'});font-weight:700">${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}</td>
      <td style="font-size:10px;color:var(--text-muted)">${t.exit_reason || '—'}</td>
    </tr>`;
  }).join('');
}

// ─── WebSocket Handlers ───────────────────────────────────────────────────────
WS.on('INIT', (data) => {
  if (!data) return;
  if (data.state) {
    State.equity = data.state.capital || 100000;
    State.trading = data.state.trading_active || false;
    State.tradesToday = data.state.daily_trades || 0;
    State.circuitBreaker = data.state.circuit_breaker_active || false;

    // Update ML status pill
    const mlPill = document.getElementById('ml-status');
    if (mlPill) {
      const ml = data.state.ml_status;
      mlPill.innerHTML = `<span class="dot ${ml === 'connected' ? 'dot-ok' : 'dot-warn'}"></span>ML ${ml === 'connected' ? 'ONLINE' : 'OFFLINE'}`;
      mlPill.className = `status-pill ${ml === 'connected' ? 'ml-online' : ''}`;
    }

    // Trading button
    updateTradingButton(State.trading);

    if (data.state.circuit_breaker_active) {
      showCircuitBreaker(data.state.circuit_breaker_reason || 'Trading halted');
    }
  }
  if (data.positions) renderPositions(data.positions);
  if (data.performance) {
    State.performance = data.performance;
    updateMetrics({ performance: data.performance, equity: State.equity });
  }
  if (data.recent_trades) renderTrades(data.recent_trades);
  auditLog('Connected to APEX backend', 'info');
});

WS.on('POSITION_UPDATE', (data) => {
  if (data.positions) renderPositions(data.positions);
  if (data.pnl != null) {
    State.dailyPnL = data.pnl;
    updateMetrics({ daily_pnl: data.pnl, equity: State.equity, drawdown: data.risk?.drawdown || 0 });
  }
  if (data.risk?.circuit_breaker) {
    showCircuitBreaker(data.risk.reason);
  }
  if (data.risk?.warnings?.length > 0) {
    data.risk.warnings.forEach(w => addAlert(w, 'warn'));
  }
});

WS.on('PERFORMANCE', (data) => {
  if (!data) return;
  State.performance = data;
  updateMetrics({ performance: data, equity: data.equity || State.equity, daily_pnl: data.daily_pnl, drawdown: data.drawdown });
  if (data.equity) {
    State.equityCurve.push(data.equity);
    if (State.equityCurve.length > 300) State.equityCurve.shift();
    drawEquityChart();
  }
  // Update streak displays
  const state = data.state;
  if (state) {
    setText('st-wins', state.consecutive_wins || 0);
    setText('st-losses', state.consecutive_losses || 0);
    setText('st-today', fmt.dollar(data.daily_pnl || 0));
  }
});

WS.on('SIGNALS', (signals) => {
  if (!Array.isArray(signals)) return;
  renderSignals(signals);
  auditLog(`${signals.length} new signals received`, 'info');
});

WS.on('TRADE_OPENED', (data) => {
  if (!data) return;
  State.tradesToday++;
  auditLog(`TRADE ${data.direction?.toUpperCase()} ${data.ticker} score=${data.overall_score?.toFixed(3)} size=${data.size?.toFixed(2)}`, 'trade');
  if (data.entry_time && data.direction) ChartModule.addTradeMarker(data.entry_time, data.direction, data.entry_price);
  if (data.positions) renderPositions(data.positions);
});

WS.on('TRADE_CLOSED', (data) => {
  if (!data) return;
  const pnl = data.pnl || 0;
  auditLog(`CLOSED ${data.ticker} ${data.exit_reason} PnL=${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`, pnl >= 0 ? 'trade' : 'risk');
  State.equityCurve.push((State.equityCurve[State.equityCurve.length - 1] || 100000) + pnl);
  drawEquityChart();
});

WS.on('TIER1_HIT', (data) => {
  auditLog(`TIER 1 TP hit: ${data.ticker} — 50% locked, stop → breakeven`, 'trade');
});

WS.on('CIRCUIT_BREAKER', (data) => {
  showCircuitBreaker(data.reason || 'Limit reached');
  auditLog(`⚡ CIRCUIT BREAKER: ${data.reason}`, 'risk');
});

WS.on('CIRCUIT_BREAKER_RESET', () => {
  hideCircuitBreaker();
  auditLog('Circuit breaker reset — trading can resume', 'info');
});

WS.on('TRADING_STARTED', () => {
  State.trading = true;
  updateTradingButton(true);
  auditLog('Trading STARTED', 'trade');
});

WS.on('TRADING_STOPPED', () => {
  State.trading = false;
  updateTradingButton(false);
  auditLog('Trading STOPPED', 'warn');
});

WS.on('MODEL_TRAINED', (data) => {
  auditLog(`Models retrained successfully`, 'info');
  loadModelHealth();
});

WS.on('DATA_DOWNLOADED', (data) => {
  hideProgress();
  auditLog(`Data download complete`, 'info');
  setText('last-download', new Date().toLocaleTimeString());
});

WS.on('DATA_DOWNLOAD_ERROR', (data) => {
  hideProgress();
  auditLog(`Data download error: ${data.error}`, 'risk');
});

// ─── Circuit Breaker ──────────────────────────────────────────────────────────
function showCircuitBreaker(reason) {
  State.circuitBreaker = true;
  const banner = document.getElementById('circuit-banner');
  const el = document.getElementById('circuit-reason');
  if (banner) banner.classList.remove('hidden');
  if (el) el.textContent = reason;
  updateTradingButton(false);
}

function hideCircuitBreaker() {
  State.circuitBreaker = false;
  const banner = document.getElementById('circuit-banner');
  if (banner) banner.classList.add('hidden');
}

// ─── Trading Button ───────────────────────────────────────────────────────────
function updateTradingButton(active) {
  const btn = document.getElementById('btn-toggle-trading');
  if (!btn) return;
  if (active) {
    btn.textContent = '⏹ STOP TRADING';
    btn.className = 'btn-primary active';
  } else {
    btn.textContent = '▶ START TRADING';
    btn.className = 'btn-primary';
  }
}

// ─── Progress Bar ─────────────────────────────────────────────────────────────
function showProgress(label, pct = 0) {
  const wrap = document.getElementById('global-progress');
  const bar = document.getElementById('gp-bar');
  const lbl = document.getElementById('gp-label');
  if (wrap) wrap.classList.remove('hidden');
  if (bar) bar.style.width = pct + '%';
  if (lbl) lbl.textContent = label;
}

function updateProgress(pct, label) {
  const bar = document.getElementById('gp-bar');
  const lbl = document.getElementById('gp-label');
  if (bar) bar.style.width = pct + '%';
  if (lbl && label) lbl.textContent = label;
}

function hideProgress() {
  setTimeout(() => {
    const wrap = document.getElementById('global-progress');
    if (wrap) wrap.classList.add('hidden');
  }, 500);
}

// ─── Model Health ─────────────────────────────────────────────────────────────
async function loadModelHealth() {
  try {
    const data = await API.get('/ml/model-health');
    setText('model-status', data.trained ? 'HEALTHY' : 'UNTRAINED');
    setText('model-count', (data.models || []).join(', ') || '—');
    setText('model-features', data.feature_count || '—');
    setText('model-last-train', data.metrics ? 'Trained' : 'Never');

    const ms = document.getElementById('model-status');
    if (ms) ms.style.color = data.trained ? 'var(--green)' : 'var(--red)';

    if (data.metrics) {
      setText('auc-lgb', data.metrics.lgb?.auc?.toFixed(4) || '—');
      setText('auc-xgb', data.metrics.xgb?.auc?.toFixed(4) || '—');
      setText('auc-rf', data.metrics.rf?.auc?.toFixed(4) || '—');
    }
  } catch {
    setText('model-status', 'OFFLINE');
    const ms = document.getElementById('model-status');
    if (ms) ms.style.color = 'var(--red)';
  }
}

// ─── Control Event Listeners ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Set init timestamp
  const tsEl = document.getElementById('init-ts');
  if (tsEl) tsEl.textContent = new Date().toLocaleTimeString('en-US', { hour12: false });

  // Initialize equity chart
  initEquityChart();

  // Window resize → redraw
  window.addEventListener('resize', drawEquityChart);

  // Start/stop trading
  document.getElementById('btn-toggle-trading')?.addEventListener('click', async () => {
    try {
      if (State.trading) {
        await API.post('/system/stop');
      } else {
        await API.post('/system/start');
      }
    } catch (err) {
      auditLog(`Toggle error: ${err.message}`, 'risk');
    }
  });

  // Close all positions
  document.getElementById('btn-close-all')?.addEventListener('click', async () => {
    if (!confirm('Close ALL open positions?')) return;
    try {
      const r = await API.post('/trades/close-all');
      auditLog(`Force closed ${r.closed} positions`, 'warn');
    } catch (err) {
      auditLog(`Close all error: ${err.message}`, 'risk');
    }
  });

  // Download data
  document.getElementById('btn-download')?.addEventListener('click', async () => {
    showProgress('Initiating data download…', 10);
    auditLog('Data download initiated for all tickers', 'info');
    try {
      const r = await API.post('/system/download-data');
      showProgress(`Downloading ${r.tickers} tickers…`, 20);
      auditLog(`Downloading ${r.tickers} tickers across 4 timeframes`, 'info');
      // Simulate progress
      let p = 20;
      const iv = setInterval(() => {
        p = Math.min(95, p + Math.random() * 5);
        updateProgress(p, `Downloading… ${p.toFixed(0)}%`);
        if (p >= 95) clearInterval(iv);
      }, 800);
    } catch (err) {
      hideProgress();
      auditLog(`Download error: ${err.message}`, 'risk');
    }
  });

  // Retrain
  document.getElementById('btn-train')?.addEventListener('click', async () => {
    showProgress('Starting model training…', 5);
    auditLog('Model retraining initiated', 'info');
    try {
      await API.post('/ml/train');
    } catch (err) {
      hideProgress();
      auditLog(`Training error: ${err.message}`, 'risk');
    }
  });

  // Backtest
  document.getElementById('btn-backtest')?.addEventListener('click', async () => {
    showProgress('Running backtest…', 10);
    auditLog('Backtest initiated', 'info');
    try {
      const r = await API.get('/ml/backtest');
      hideProgress();
      if (r.metrics) {
        showModal(`
          <h2 style="font-family:var(--mono);color:var(--accent);margin-bottom:16px">📊 BACKTEST RESULTS</h2>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            ${Object.entries(r.metrics).filter(([k]) => k !== 'equity_curve').map(([k,v]) =>
              `<div style="background:var(--surface-2);border:1px solid var(--border);padding:10px;border-radius:4px">
                <div style="font-size:9px;color:var(--text-muted);font-family:var(--mono);margin-bottom:4px">${k.toUpperCase()}</div>
                <div style="font-family:var(--mono);font-size:14px;color:var(--accent)">${typeof v === 'number' ? v.toFixed(4) : v}</div>
              </div>`).join('')}
          </div>
          ${r.monte_carlo ? `
          <h3 style="font-family:var(--mono);color:var(--text-secondary);margin:16px 0 8px;font-size:11px">MONTE CARLO (${r.monte_carlo.simulations} sims)</h3>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">
            <div style="background:var(--surface-2);padding:8px;border-radius:4px;border:1px solid var(--border)">
              <div style="font-size:9px;color:var(--text-muted);margin-bottom:3px">P5 EQUITY</div>
              <div style="font-family:var(--mono);color:var(--red)">$${r.monte_carlo.final_equity_p5?.toLocaleString()}</div>
            </div>
            <div style="background:var(--surface-2);padding:8px;border-radius:4px;border:1px solid var(--border)">
              <div style="font-size:9px;color:var(--text-muted);margin-bottom:3px">MEDIAN EQUITY</div>
              <div style="font-family:var(--mono);color:var(--accent)">$${r.monte_carlo.final_equity_p50?.toLocaleString()}</div>
            </div>
            <div style="background:var(--surface-2);padding:8px;border-radius:4px;border:1px solid var(--border)">
              <div style="font-size:9px;color:var(--text-muted);margin-bottom:3px">PROB PROFIT</div>
              <div style="font-family:var(--mono);color:var(--green)">${(r.monte_carlo.prob_profit * 100).toFixed(1)}%</div>
            </div>
          </div>` : ''}
        `);
      }
    } catch (err) {
      hideProgress();
      auditLog(`Backtest error: ${err.message}`, 'risk');
    }
  });

  // Reset circuit breaker
  document.getElementById('btn-reset-cb')?.addEventListener('click', async () => {
    try {
      await API.post('/system/reset-circuit-breaker');
    } catch (err) {
      auditLog(`Reset error: ${err.message}`, 'risk');
    }
  });

  // Refresh signals
  document.getElementById('btn-refresh-signals')?.addEventListener('click', () => {
    auditLog('Manual signal scan triggered', 'info');
    renderSignals(generateDemoSignals());
  });

  // Clear log
  document.getElementById('btn-clear-log')?.addEventListener('click', () => {
    const log = document.getElementById('audit-log');
    if (log) log.innerHTML = '<div class="al-item info"><span class="al-ts">--:--:--</span><span class="al-type sys">SYS</span><span class="al-msg">Log cleared</span></div>';
  });

  // Export trades
  document.getElementById('btn-export-trades')?.addEventListener('click', async () => {
    try {
      window.open('/api/trades/export', '_blank');
    } catch (err) {
      auditLog(`Export error: ${err.message}`, 'risk');
    }
  });

  // Export audit log
  document.getElementById('btn-export-log')?.addEventListener('click', () => {
    const rows = ['timestamp,type,message'];
    State.auditLog.forEach(e => rows.push(`${e.ts},${e.type},"${e.msg.replace(/"/g,'""')}"`));
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'audit_log.csv';
    a.click();
  });

  // Risk sliders
  document.getElementById('sl-rpt')?.addEventListener('input', e => setText('dc-rpt', `${(e.target.value/100).toFixed(2)}%`));
  document.getElementById('sl-score')?.addEventListener('input', e => setText('dc-score', `${(e.target.value/100).toFixed(2)}`));
  document.getElementById('sl-maxpos')?.addEventListener('input', e => setText('dc-maxpos', e.target.value));

  // Modal close
  document.getElementById('modal-close')?.addEventListener('click', hideModal);
  document.getElementById('modal')?.addEventListener('click', e => { if (e.target === e.currentTarget) hideModal(); });

  // Load initial data
  loadModelHealth();

  // Demo signals for visual testing
  setTimeout(() => {
    renderSignals(generateDemoSignals());
    renderTrades(generateDemoTrades());
    // Build demo equity curve
    let eq = 100000;
    for (let i = 0; i < 80; i++) {
      eq += (Math.random() - 0.45) * 150;
      State.equityCurve.push(eq);
    }
    State.equity = eq;
    drawEquityChart();
    updateMetrics({
      equity: eq,
      daily_pnl: eq - 100000,
      drawdown: Math.max(0, (Math.max(...State.equityCurve) - eq) / Math.max(...State.equityCurve)),
      performance: {
        win_rate: 0.73, total_trades: 47, wins: 34, losses: 13,
        avg_win: 185.40, avg_loss: 82.15, profit_factor: 2.18,
        expectancy: 80.35, sharpe: 1.84, sortino: 2.41, max_drawdown: 0.034,
        rolling_30: { win_rate: 0.77 }
      }
    });
  }, 500);
});

// ─── Modal ────────────────────────────────────────────────────────────────────
function showModal(html) {
  const modal = document.getElementById('modal');
  const content = document.getElementById('modal-content');
  if (modal) modal.classList.remove('hidden');
  if (content) content.innerHTML = html;
}
function hideModal() {
  const modal = document.getElementById('modal');
  if (modal) modal.classList.add('hidden');
}

// ─── Demo Data Generators ─────────────────────────────────────────────────────
function generateDemoSignals() {
  const tickers = ['NVDA','AAPL','TSLA','SPY','QQQ','BTC-USD','META','MSFT','AMD','ETH-USD','AMZN','JPM'];
  const strategies = ['momentum','scalp','mean_reversion'];
  const regimes = ['trending','ranging','neutral'];
  return tickers.map(ticker => {
    const prob = 0.60 + Math.random() * 0.32;
    const scores = { momentum: 0.5+Math.random()*0.5, volume: 0.5+Math.random()*0.5, sentiment: 0.4+Math.random()*0.5, macro: 0.5+Math.random()*0.4, execution_quality: 0.6+Math.random()*0.4, multi_timeframe: 0.4+Math.random()*0.6, model_confidence: prob };
    const w = { momentum:0.30, volume:0.10, sentiment:0.15, macro:0.10, execution_quality:0.10, multi_timeframe:0.15, model_confidence:0.10 };
    const overall = Object.entries(scores).reduce((s,[k,v])=>s+v*(w[k]||0), 0);
    return { ticker, direction: Math.random() > 0.45 ? 'long' : 'short', strategy: strategies[Math.floor(Math.random()*3)], regime: regimes[Math.floor(Math.random()*3)], entry_price: 50+Math.random()*500, atr: 1+Math.random()*5, adx: 15+Math.random()*35, scores, overall_score: overall, probability: prob, ensemble_agreement: prob > 0.78, bb_squeeze: Math.random() > 0.7 ? 1 : 0, rsi: 25+Math.random()*50, volume_spike: Math.random() > 0.6 ? 1 : 0, timestamp: new Date().toISOString() };
  }).filter(s => s.overall_score >= 0.68).sort((a,b)=>b.overall_score-a.overall_score);
}

function generateDemoTrades() {
  const tickers = ['AAPL','NVDA','TSLA','SPY','BTC-USD','META','MSFT'];
  const strategies = ['momentum','scalp','mean_reversion'];
  const reasons = ['take_profit_2','stop_loss','time_exit','tier1+trailing'];
  return Array.from({ length: 20 }, (_, i) => {
    const entry = 50 + Math.random() * 400;
    const win = Math.random() > 0.28;
    const pnl = win ? (10 + Math.random() * 300) : -(10 + Math.random() * 120);
    return { id: `demo-${i}`, ticker: tickers[Math.floor(Math.random()*tickers.length)], direction: Math.random()>0.45?'long':'short', strategy: strategies[Math.floor(Math.random()*3)], entry_price: entry, exit_price: entry + (pnl/10), pnl, size: 1+Math.random()*10, exit_reason: reasons[Math.floor(Math.random()*reasons.length)], status: 'closed', exit_time: Date.now() - i * 300000 };
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// REAL ML EVENT HANDLERS — wired to actual ML service via WebSocket proxy
// ═══════════════════════════════════════════════════════════════════════════════

// ── Download events ────────────────────────────────────────────────────────────
WS.on('DOWNLOAD_PROGRESS', (data) => {
  if (!data) return;
  const pct = data.pct || 0;
  showProgress(`Downloading ${data.ticker} [${data.interval}] — ${data.done}/${data.total} (${pct}%)`, pct);
  auditLog(`↓ ${data.ticker} ${data.interval} (${pct}%)`, 'info');
  // Update ticker download grid if visible
  updateDownloadGrid(data.ticker, data.interval, 'downloading');
});

WS.on('DOWNLOAD_DONE', (data) => {
  if (!data) return;
  updateProgress(100, `Download complete — ${data.tickers_ok} tickers succeeded`);
  setTimeout(hideProgress, 2000);
  auditLog(`✓ Download complete: ${data.tickers_ok} tickers loaded`, 'trade');
  setText('last-download', new Date().toLocaleTimeString());
  addAlert(`Download complete: ${data.tickers_ok} tickers ready for training`, 'ok');
});

WS.on('MERGE_DONE', (data) => {
  auditLog(`Merged dataset: ${data.rows} rows × ${data.cols} columns`, 'info');
  showProgress('Merged all CSVs into final_dataset.csv', 100);
  setTimeout(hideProgress, 1500);
});

WS.on('DOWNLOAD_ERROR', (data) => {
  hideProgress();
  auditLog(`✗ Download error: ${data.msg}`, 'risk');
  addAlert(`Download failed: ${data.msg}`, 'danger');
});

// ── Training events ────────────────────────────────────────────────────────────
WS.on('TRAIN_PROGRESS', (data) => {
  if (!data) return;
  const pct = data.pct || 0;
  const model = data.model || data.step || 'training';
  showProgress(`Training ${model} — ${pct}%`, pct);

  // Update training panel in real-time
  updateTrainingPanel(data);

  if (data.train_auc) {
    const modelKey = data.model?.toLowerCase().replace(' ','');
    auditLog(`  ${data.model} AUC=${data.train_auc.toFixed(4)} ACC=${data.train_acc?.toFixed(4)} [${data.time_s}s]`, 'info');
    // Update model health AUC cells
    if (modelKey?.includes('random')) setText('auc-rf', data.train_auc.toFixed(4));
    if (modelKey?.includes('light'))  setText('auc-lgb', data.train_auc.toFixed(4));
    if (modelKey?.includes('xgb'))    setText('auc-xgb', data.train_auc.toFixed(4));
  }
});

WS.on('MODEL_TRAINED', (data) => {
  updateProgress(100, 'Training complete!');
  setTimeout(hideProgress, 2000);
  auditLog('✓ All models trained and saved to disk', 'trade');
  if (data) {
    const meta = data.train_meta || {};
    auditLog(`  Train: ${meta.train_samples} samples | Test: ${meta.test_samples} samples (${Math.round((1-meta.train_split_pct)*100)}% held out)`, 'info');
    if (data.metrics) {
      Object.entries(data.metrics).forEach(([k,v]) => {
        auditLog(`  ${k.toUpperCase()} → train_AUC=${v.train_auc?.toFixed(4)} acc=${v.train_acc?.toFixed(4)}`, 'info');
      });
    }
  }
  loadModelHealth();
  addAlert('Models trained! Click BACKTEST to evaluate on unseen data.', 'ok');
});

WS.on('TRAIN_ERROR', (data) => {
  hideProgress();
  auditLog(`✗ Training error: ${data.msg}`, 'risk');
  addAlert(`Training failed: ${data.msg}`, 'danger');
});

// ── Backtest events ────────────────────────────────────────────────────────────
WS.on('BACKTEST_PROGRESS', (data) => {
  if (!data) return;
  const pct = data.pct || 0;
  showProgress(`Backtesting on unseen data — ${pct}%`, pct);
  auditLog(`Backtest: ${data.step} (${pct}%)`, 'info');
});

WS.on('BACKTEST_DONE', (data) => {
  updateProgress(100, 'Backtest complete!');
  setTimeout(hideProgress, 1500);
  if (!data || data.error) {
    auditLog(`✗ Backtest error: ${data?.error || 'unknown'}`, 'risk');
    return;
  }
  const m = data.metrics || {};
  auditLog(`✓ Backtest complete: ${m.total_trades} trades, WR=${(m.win_rate*100).toFixed(1)}%, PnL=$${m.total_pnl?.toFixed(2)}`, 'trade');
  // Show backtest dashboard
  showBacktestDashboard(data);
});

WS.on('BACKTEST_ERROR', (data) => {
  hideProgress();
  auditLog(`✗ Backtest error: ${data.msg}`, 'risk');
  addAlert(`Backtest failed: ${data.msg}`, 'danger');
});

WS.on('ML_CONNECTED', () => {
  const pill = document.getElementById('ml-status');
  if (pill) { pill.innerHTML = '<span class="dot dot-ok"></span>ML ONLINE'; pill.className = 'status-pill ml-online'; }
  auditLog('ML service connected', 'info');
});

WS.on('ML_DISCONNECTED', () => {
  const pill = document.getElementById('ml-status');
  if (pill) { pill.innerHTML = '<span class="dot dot-warn"></span>ML OFFLINE'; pill.className = 'status-pill'; }
  auditLog('ML service disconnected — retrying…', 'warn');
  addAlert('ML service offline — retry in progress', 'warn');
});

// ── Override backtest button to use new flow ───────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Override btn-backtest click from original listener
  const oldBtn = document.getElementById('btn-backtest');
  if (oldBtn) {
    const newBtn = oldBtn.cloneNode(true);
    oldBtn.replaceWith(newBtn);
    newBtn.addEventListener('click', async () => {
      showProgress('Starting backtest on unseen data…', 5);
      auditLog('Backtest initiated on unseen test split', 'info');
      try {
        const r = await API.post('/system/backtest');
        auditLog(`Backtest running: ${r.message}`, 'info');
      } catch (err) {
        hideProgress();
        auditLog(`Backtest start error: ${err.message}`, 'risk');
      }
    });
  }

  // Override btn-train
  const oldTrain = document.getElementById('btn-train');
  if (oldTrain) {
    const newTrain = oldTrain.cloneNode(true);
    oldTrain.replaceWith(newTrain);
    newTrain.addEventListener('click', async () => {
      showProgress('Starting model training on merged dataset…', 3);
      auditLog('Training initiated', 'info');
      try {
        const r = await API.post('/system/train');
        auditLog(`Training started: ${r.message}`, 'info');
      } catch (err) {
        hideProgress();
        auditLog(`Train start error: ${err.message}`, 'risk');
      }
    });
  }

  // Override btn-download
  const oldDl = document.getElementById('btn-download');
  if (oldDl) {
    const newDl = oldDl.cloneNode(true);
    oldDl.replaceWith(newDl);
    newDl.addEventListener('click', async () => {
      showProgress('Starting sequential data download…', 2);
      auditLog('Data download initiated (ticker-by-ticker with retry)', 'info');
      try {
        const r = await API.post('/system/download-data');
        auditLog(`Download started: ${r.tickers} tickers × 2 intervals`, 'info');
      } catch (err) {
        hideProgress();
        auditLog(`Download error: ${err.message}`, 'risk');
      }
    });
  }
});

// ── Download grid helper ───────────────────────────────────────────────────────
const _dlStatus = {};
function updateDownloadGrid(ticker, interval, status) {
  _dlStatus[`${ticker}_${interval}`] = status;
  // Update last-download info
  setText('data-cache-status', `${Object.keys(_dlStatus).length} files`);
}

// ── Training panel live update ─────────────────────────────────────────────────
function updateTrainingPanel(data) {
  const el = document.getElementById('training-live');
  if (!el) return;
  el.classList.remove('hidden');

  const rows = [
    data.model ? `<div class="tp-row"><span>Model</span><strong style="color:var(--accent)">${data.model}</strong></div>` : '',
    data.pct   ? `<div class="tp-row"><span>Progress</span><strong>${data.pct}%</strong></div>` : '',
    data.train_auc ? `<div class="tp-row"><span>Train AUC</span><strong style="color:var(--green)">${data.train_auc.toFixed(4)}</strong></div>` : '',
    data.train_acc ? `<div class="tp-row"><span>Train ACC</span><strong>${(data.train_acc*100).toFixed(2)}%</strong></div>` : '',
    data.time_s    ? `<div class="tp-row"><span>Time</span><strong>${data.time_s}s</strong></div>` : '',
    data.train_samples ? `<div class="tp-row"><span>Train samples</span><strong>${data.train_samples.toLocaleString()}</strong></div>` : '',
    data.test_samples  ? `<div class="tp-row"><span>Test samples (held out)</span><strong style="color:var(--yellow)">${data.test_samples.toLocaleString()}</strong></div>` : '',
  ].filter(Boolean).join('');

  el.innerHTML = rows || el.innerHTML;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BACKTEST DASHBOARD — full real-data driven panel
// ═══════════════════════════════════════════════════════════════════════════════

function showBacktestDashboard(data) {
  if (!data || !data.metrics) return;
  const m   = data.metrics;
  const mc  = data.monte_carlo || {};
  const trades = data.trades || [];

  const html = `
    <div style="font-family:var(--mono)">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
        <span style="font-size:20px">📊</span>
        <h2 style="color:var(--accent);font-size:16px;letter-spacing:2px">BACKTEST RESULTS — UNSEEN TEST DATA</h2>
        <span style="margin-left:auto;font-size:10px;color:var(--text-muted)">${data.timestamp ? new Date(data.timestamp).toLocaleString() : ''}</span>
      </div>

      ${data.train_meta ? `
      <div style="background:rgba(0,212,170,0.06);border:1px solid var(--accent-dim);border-radius:6px;padding:10px 14px;margin-bottom:16px;font-size:10px">
        <span style="color:var(--accent)">DATA SPLIT:</span>
        Train: <strong>${(data.train_meta.train_samples||0).toLocaleString()}</strong> samples →
        Unseen Test: <strong style="color:var(--yellow)">${(data.train_meta.test_samples||0).toLocaleString()}</strong> samples
        (${Math.round((1-(data.train_meta.train_split_pct||0.75))*100)}% held out)
        Split date: <strong>${data.train_meta.split_date ? new Date(data.train_meta.split_date).toLocaleDateString() : '—'}</strong>
      </div>` : ''}

      <!-- Key metrics grid -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px">
        ${[
          ['TOTAL TRADES',    m.total_trades,            '', '#e6edf3'],
          ['WIN RATE',        `${(m.win_rate*100).toFixed(1)}%`, '', m.win_rate>=0.6?'#22c55e':m.win_rate>=0.5?'#f59e0b':'#ef4444'],
          ['WINNING',         m.winning_trades,          '✓','#22c55e'],
          ['LOSING',          m.losing_trades,           '✗','#ef4444'],
          ['TOTAL PnL',       `$${m.total_pnl?.toFixed(2)}`, '', m.total_pnl>=0?'#22c55e':'#ef4444'],
          ['FINAL EQUITY',    `$${m.final_equity?.toFixed(2)}`, '', '#e6edf3'],
          ['PROFIT FACTOR',   m.profit_factor?.toFixed(3), '', m.profit_factor>=1.5?'#22c55e':'#f59e0b'],
          ['EXPECTANCY',      `$${m.expectancy?.toFixed(2)}`, '', m.expectancy>=0?'#22c55e':'#ef4444'],
          ['SHARPE RATIO',    m.sharpe?.toFixed(3),      '', m.sharpe>=1?'#22c55e':m.sharpe>=0?'#f59e0b':'#ef4444'],
          ['SORTINO',         m.sortino?.toFixed(3),     '', '#e6edf3'],
          ['MAX DRAWDOWN',    `${(m.max_drawdown*100).toFixed(2)}%`, '', m.max_drawdown<=0.1?'#22c55e':'#ef4444'],
          ['CALMAR',          m.calmar?.toFixed(3),      '', '#e6edf3'],
        ].map(([label, val, icon, color]) => `
          <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:5px;padding:10px">
            <div style="font-size:9px;color:var(--text-muted);letter-spacing:0.8px;margin-bottom:4px">${label}</div>
            <div style="font-size:16px;font-weight:700;color:${color}">${icon}${val ?? '—'}</div>
          </div>`).join('')}
      </div>

      <!-- Equity Curve -->
      <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:12px;margin-bottom:12px">
        <div style="font-size:10px;color:var(--text-muted);letter-spacing:1px;margin-bottom:8px">EQUITY CURVE — UNSEEN DATA</div>
        <canvas id="bt-equity-canvas" height="160" style="width:100%"></canvas>
      </div>

      <!-- Monte Carlo -->
      ${mc.simulations ? `
      <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:12px;margin-bottom:12px">
        <div style="font-size:10px;color:var(--text-muted);letter-spacing:1px;margin-bottom:8px">MONTE CARLO — ${mc.simulations} SIMULATIONS</div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">
          <div><div style="font-size:9px;color:var(--text-muted)">P5 (Worst)</div><div style="color:#ef4444;font-size:13px;font-weight:700">$${mc.final_equity_p5?.toLocaleString()}</div></div>
          <div><div style="font-size:9px;color:var(--text-muted)">P50 (Median)</div><div style="color:var(--accent);font-size:13px;font-weight:700">$${mc.final_equity_p50?.toLocaleString()}</div></div>
          <div><div style="font-size:9px;color:var(--text-muted)">P95 (Best)</div><div style="color:#22c55e;font-size:13px;font-weight:700">$${mc.final_equity_p95?.toLocaleString()}</div></div>
          <div><div style="font-size:9px;color:var(--text-muted)">Prob Profit</div><div style="color:#22c55e;font-size:13px;font-weight:700">${(mc.prob_profit*100).toFixed(1)}%</div></div>
        </div>
      </div>` : ''}

      <!-- Trade-by-trade table (last 50) -->
      <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:6px;overflow:hidden">
        <div style="padding:10px 12px;border-bottom:1px solid var(--border);font-size:10px;color:var(--text-muted);letter-spacing:1px">
          TRADE LOG — ${trades.length} TRADES (showing last 50)
        </div>
        <div style="max-height:240px;overflow-y:auto">
          <table style="width:100%;border-collapse:collapse;font-size:11px">
            <thead><tr style="background:var(--surface-3)">
              <th style="padding:6px 10px;text-align:left;color:var(--text-muted);font-size:9px">TICKER</th>
              <th style="padding:6px 10px;text-align:right;color:var(--text-muted);font-size:9px">ENTRY</th>
              <th style="padding:6px 10px;text-align:right;color:var(--text-muted);font-size:9px">EXIT</th>
              <th style="padding:6px 10px;text-align:right;color:var(--text-muted);font-size:9px">SIZE</th>
              <th style="padding:6px 10px;text-align:right;color:var(--text-muted);font-size:9px">PnL</th>
              <th style="padding:6px 10px;text-align:right;color:var(--text-muted);font-size:9px">PnL%</th>
              <th style="padding:6px 10px;text-align:right;color:var(--text-muted);font-size:9px">PROB</th>
              <th style="padding:6px 10px;text-align:right;color:var(--text-muted);font-size:9px">EQUITY</th>
            </tr></thead>
            <tbody>
              ${trades.slice(-50).map(t => `
                <tr style="border-top:1px solid var(--border)">
                  <td style="padding:5px 10px;color:${t.win?'#22c55e':'#ef4444'};font-weight:700">${t.ticker}</td>
                  <td style="padding:5px 10px;text-align:right">$${t.entry_price?.toFixed(3)}</td>
                  <td style="padding:5px 10px;text-align:right">$${t.exit_price?.toFixed(3)}</td>
                  <td style="padding:5px 10px;text-align:right">${t.size?.toFixed(2)}</td>
                  <td style="padding:5px 10px;text-align:right;color:${t.pnl>=0?'#22c55e':'#ef4444'};font-weight:700">${t.pnl>=0?'+':''}$${t.pnl?.toFixed(2)}</td>
                  <td style="padding:5px 10px;text-align:right;color:${t.pnl_pct>=0?'#22c55e':'#ef4444'}">${t.pnl_pct?.toFixed(2)}%</td>
                  <td style="padding:5px 10px;text-align:right;color:var(--accent)">${(t.probability*100).toFixed(0)}%</td>
                  <td style="padding:5px 10px;text-align:right;color:var(--text-muted)">$${t.equity?.toFixed(0)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

  showModal(html);

  // Draw equity curve after modal renders
  setTimeout(() => {
    const canvas = document.getElementById('bt-equity-canvas');
    if (!canvas || !m.equity_curve) return;
    drawBacktestChart(canvas, m.equity_curve, m.initial_equity || 100000);
  }, 100);
}

function drawBacktestChart(canvas, curve, initial) {
  const W = canvas.offsetWidth || 560;
  const H = 160;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  if (!curve || curve.length < 2) return;

  const mn  = Math.min(...curve, initial) * 0.998;
  const mx  = Math.max(...curve, initial) * 1.002;
  const rng = mx - mn || 1;
  const toX = i => 8 + (i / (curve.length-1)) * (W-16);
  const toY = v => H - 8 - ((v-mn)/rng)*(H-16);

  // Grid lines
  ctx.strokeStyle = '#21262d'; ctx.lineWidth = 1;
  for (let g=0;g<4;g++){const y=8+(g/3)*(H-16);ctx.beginPath();ctx.moveTo(8,y);ctx.lineTo(W-8,y);ctx.stroke();}

  // Initial equity line
  const iy = toY(initial);
  ctx.strokeStyle='rgba(255,255,255,0.1)';ctx.setLineDash([4,4]);
  ctx.beginPath();ctx.moveTo(8,iy);ctx.lineTo(W-8,iy);ctx.stroke();
  ctx.setLineDash([]);

  // Gradient fill
  const isProfit = curve[curve.length-1] >= initial;
  const grad = ctx.createLinearGradient(0,0,0,H);
  grad.addColorStop(0, isProfit?'rgba(34,197,94,0.25)':'rgba(239,68,68,0.25)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.beginPath();
  ctx.moveTo(toX(0),toY(curve[0]));
  for(let i=1;i<curve.length;i++) ctx.lineTo(toX(i),toY(curve[i]));
  ctx.lineTo(toX(curve.length-1),H); ctx.lineTo(toX(0),H);
  ctx.closePath(); ctx.fillStyle=grad; ctx.fill();

  // Main line
  ctx.beginPath(); ctx.strokeStyle=isProfit?'#22c55e':'#ef4444'; ctx.lineWidth=2;
  ctx.moveTo(toX(0),toY(curve[0]));
  for(let i=1;i<curve.length;i++) ctx.lineTo(toX(i),toY(curve[i]));
  ctx.stroke();

  // Labels
  ctx.fillStyle='#484f58'; ctx.font='9px Space Mono';
  ctx.fillText(`$${mx.toLocaleString('en',{maximumFractionDigits:0})}`,10,16);
  ctx.fillText(`$${mn.toLocaleString('en',{maximumFractionDigits:0})}`,10,H-2);
  ctx.fillStyle=isProfit?'#22c55e':'#ef4444';
  ctx.font='bold 11px Space Mono';
  const last = curve[curve.length-1];
  ctx.fillText(`$${last.toLocaleString('en',{maximumFractionDigits:0})}`,W-70,16);
}
