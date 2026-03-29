/* chart.js — Candlestick chart with indicators */
'use strict';

const ChartModule = (() => {
  let mainChart = null;
  let rsiChart = null;
  let candleSeries = null;
  let emaSeries = {};
  let bbSeries = {};
  let rsiSeries = null;
  let markerData = [];
  let currentTicker = 'AAPL';
  let currentTF = '5m';
  let showEMA = true;
  let showBB = false;
  let showSignals = true;

  const COLORS = {
    up: '#22c55e', down: '#ef4444',
    ema9: '#00d4aa', ema20: '#3b82f6', ema50: '#a855f7', ema200: '#f59e0b',
    bbUpper: 'rgba(59,130,246,0.4)', bbLower: 'rgba(59,130,246,0.4)', bbMid: 'rgba(59,130,246,0.2)',
    rsi: '#f59e0b', rsiOB: 'rgba(239,68,68,0.1)', rsiOS: 'rgba(34,197,94,0.1)',
    bg: '#0d1117', grid: '#21262d', text: '#8b949e'
  };

  const CHART_OPTS = {
    layout: { background: { type: 'solid', color: COLORS.bg }, textColor: COLORS.text },
    grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
    crosshair: { mode: 1 },
    rightPriceScale: { borderColor: COLORS.grid },
    timeScale: { borderColor: COLORS.grid, timeVisible: true, secondsVisible: false }
  };

  function init() {
    const container = document.getElementById('chart-container');
    const rsiContainer = document.getElementById('rsi-container');
    if (!container || typeof LightweightCharts === 'undefined') return;

    mainChart = LightweightCharts.createChart(container, {
      ...CHART_OPTS,
      height: container.clientHeight || 250,
      width: container.clientWidth || 600
    });

    candleSeries = mainChart.addCandlestickSeries({
      upColor: COLORS.up, downColor: COLORS.down,
      borderUpColor: COLORS.up, borderDownColor: COLORS.down,
      wickUpColor: COLORS.up, wickDownColor: COLORS.down
    });

    // EMA series
    const emaCfg = { ema_9: COLORS.ema9, ema_20: COLORS.ema20, ema_50: COLORS.ema50, ema_200: COLORS.ema200 };
    for (const [key, color] of Object.entries(emaCfg)) {
      emaSeries[key] = mainChart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    }

    // BB series
    bbSeries.upper = mainChart.addLineSeries({ color: COLORS.bbUpper, lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
    bbSeries.lower = mainChart.addLineSeries({ color: COLORS.bbLower, lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });

    // RSI pane
    if (rsiContainer) {
      rsiChart = LightweightCharts.createChart(rsiContainer, {
        ...CHART_OPTS,
        height: rsiContainer.clientHeight || 70,
        width: rsiContainer.clientWidth || 600,
      });
      rsiSeries = rsiChart.addLineSeries({ color: COLORS.rsi, lineWidth: 1, priceLineVisible: false, lastValueVisible: true, priceFormat: { type: 'custom', minMove: 0.01, formatter: v => v.toFixed(1) } });
      rsiChart.priceScale('right').applyOptions({ autoScale: false, scaleMargins: { top: 0.05, bottom: 0.05 } });
      rsiChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
        if (mainChart) mainChart.timeScale().setVisibleLogicalRange(range);
      });
      mainChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
        if (rsiChart && range) rsiChart.timeScale().setVisibleLogicalRange(range);
      });
    }

    // Resize observer
    const ro = new ResizeObserver(() => {
      if (mainChart && container) mainChart.resize(container.clientWidth, container.clientHeight || 250);
      if (rsiChart && rsiContainer) rsiChart.resize(rsiContainer.clientWidth, rsiContainer.clientHeight || 70);
    });
    ro.observe(container);
    if (rsiContainer) ro.observe(rsiContainer);

    loadDemoData();
  }

  function loadDemoData(ticker = currentTicker, tf = currentTF) {
    currentTicker = ticker;
    currentTF = tf;
    const data = generateOHLCV(ticker, tf);
    updateChart(data);
  }

  function generateOHLCV(ticker, tf) {
    const n = { '5m': 288, '15m': 200, '1h': 120, '1d': 365 }[tf] || 200;
    const msPerBar = { '5m': 300, '15m': 900, '1h': 3600, '1d': 86400 }[tf] * 1000;
    const basePrice = { AAPL: 185, MSFT: 415, NVDA: 500, TSLA: 200, AMZN: 185, META: 525, SPY: 510, QQQ: 430, IWM: 210, 'BTC-USD': 65000, 'ETH-USD': 3400 }[ticker] || 150;
    const now = Math.floor(Date.now() / msPerBar) * msPerBar;
    const candles = [], emaVals = { ema_9: [], ema_20: [], ema_50: [], ema_200: [] }, rsiVals = [], bbVals = [];
    let price = basePrice;
    const closes = [];
    const multipliers = { ema_9: 2/10, ema_20: 2/21, ema_50: 2/51, ema_200: 2/201 };
    const emaCur = { ema_9: basePrice, ema_20: basePrice, ema_50: basePrice, ema_200: basePrice };

    for (let i = n - 1; i >= 0; i--) {
      const t = Math.floor((now - i * msPerBar) / 1000);
      const vol = (Math.random() - 0.48) * 0.02;
      price = Math.max(price * (1 + vol), 1);
      const range = price * (0.003 + Math.random() * 0.008);
      const open = price;
      const close = price * (1 + (Math.random() - 0.5) * 0.004);
      const high = Math.max(open, close) + range * Math.random();
      const low = Math.min(open, close) - range * Math.random();
      price = close;
      closes.push(close);
      candles.push({ time: t, open: +open.toFixed(2), high: +high.toFixed(2), low: +low.toFixed(2), close: +close.toFixed(2) });

      for (const k in emaCur) {
        emaCur[k] = emaCur[k] * (1 - multipliers[k]) + close * multipliers[k];
        emaVals[k].push({ time: t, value: +emaCur[k].toFixed(2) });
      }

      // RSI
      if (closes.length > 14) {
        const period = closes.slice(-15);
        let gains = 0, losses = 0;
        for (let j = 1; j < period.length; j++) {
          const d = period[j] - period[j-1];
          if (d > 0) gains += d; else losses += Math.abs(d);
        }
        const rs = gains / (losses + 1e-8);
        rsiVals.push({ time: t, value: +(100 - 100/(1+rs)).toFixed(2) });
      }

      // BB
      if (closes.length >= 20) {
        const slice = closes.slice(-20);
        const mean = slice.reduce((a,b)=>a+b,0)/20;
        const std = Math.sqrt(slice.reduce((s,v)=>s+Math.pow(v-mean,2),0)/20);
        bbVals.push({ time: t, upper: +(mean+2*std).toFixed(2), lower: +(mean-2*std).toFixed(2) });
      }
    }

    return { candles, emas: emaVals, rsi: rsiVals, bb: bbVals };
  }

  function updateChart(data) {
    if (!candleSeries || !data) return;
    candleSeries.setData(data.candles);

    const showEMANow = showEMA && document.getElementById('show-ema')?.checked !== false;
    const showBBNow = showBB || document.getElementById('show-bb')?.checked === true;

    for (const [k, series] of Object.entries(emaSeries)) {
      series.setData(showEMANow ? (data.emas[k] || []) : []);
    }

    if (bbSeries.upper) {
      bbSeries.upper.setData(showBBNow ? (data.bb?.map(b => ({ time: b.time, value: b.upper })) || []) : []);
      bbSeries.lower.setData(showBBNow ? (data.bb?.map(b => ({ time: b.time, value: b.lower })) || []) : []);
    }

    if (rsiSeries && data.rsi) rsiSeries.setData(data.rsi);

    if (mainChart) mainChart.timeScale().fitContent();
  }

  function addTradeMarker(time, direction, price) {
    markerData.push({
      time: Math.floor(time / 1000),
      position: direction === 'long' ? 'belowBar' : 'aboveBar',
      color: direction === 'long' ? '#22c55e' : '#ef4444',
      shape: direction === 'long' ? 'arrowUp' : 'arrowDown',
      text: direction.toUpperCase()
    });
    if (candleSeries) candleSeries.setMarkers(markerData);
  }

  // Wire up controls
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(init, 100);

    document.getElementById('chart-ticker')?.addEventListener('change', e => loadDemoData(e.target.value, currentTF));

    document.querySelectorAll('.tf-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        loadDemoData(currentTicker, btn.dataset.tf);
      });
    });

    document.getElementById('show-ema')?.addEventListener('change', () => loadDemoData(currentTicker, currentTF));
    document.getElementById('show-bb')?.addEventListener('change', () => { showBB = document.getElementById('show-bb').checked; loadDemoData(currentTicker, currentTF); });
  });

  return { init, loadDemoData, updateChart, addTradeMarker };
})();

window.ChartModule = ChartModule;
