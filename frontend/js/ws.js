/* ws.js — WebSocket manager with auto-reconnect */
'use strict';

const WS = (() => {
  let ws = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  const MAX_DELAY = 30000;
  const listeners = {};

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/ws`;

    try {
      ws = new WebSocket(url);
    } catch (e) {
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      reconnectDelay = 1000;
      setWSStatus('connected');
      emit('ws:open');
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        emit(msg.type, msg.data);
        emit('*', msg);
      } catch (e) {
        console.warn('WS parse error:', e);
      }
    };

    ws.onerror = () => {
      setWSStatus('error');
    };

    ws.onclose = () => {
      setWSStatus('disconnected');
      emit('ws:close');
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_DELAY);
      connect();
    }, reconnectDelay);
  }

  function setWSStatus(status) {
    const el = document.getElementById('ws-status');
    if (!el) return;
    const dot = el.querySelector('.dot');
    const labels = { connected: 'LIVE', disconnected: 'DISCONNECTED', error: 'ERROR' };
    const dotClass = { connected: 'dot dot-ok', disconnected: 'dot', error: 'dot dot-error' };
    el.querySelector('.dot').className = dotClass[status] || 'dot';
    el.innerHTML = `<span class="${dotClass[status] || 'dot'}"></span>${labels[status] || status.toUpperCase()}`;
    el.className = `status-pill ${status === 'connected' ? 'connected' : ''}`;
  }

  function on(type, fn) {
    if (!listeners[type]) listeners[type] = [];
    listeners[type].push(fn);
  }

  function off(type, fn) {
    if (listeners[type]) listeners[type] = listeners[type].filter(f => f !== fn);
  }

  function emit(type, data) {
    (listeners[type] || []).forEach(fn => { try { fn(data); } catch(e) { console.error(`WS handler error [${type}]:`, e); } });
  }

  function send(type, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, data }));
    }
  }

  // Initialize
  connect();

  return { on, off, send, connect, emit };
})();

window.WS = WS;
