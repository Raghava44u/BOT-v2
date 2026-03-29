# ▲ APEX AI Trading System v1.0

> Production-grade AI trading system with ensemble ML, 50+ tickers, multi-strategy portfolio, and real-time dashboard.

---

## 🚀 Quick Start

```bash
git clone <your-repo>
cd ai-trading-system
./start.sh
# Open http://localhost:3001
```

---

## 📁 Folder Structure

```
ai-trading-system/
├── config/
│   └── config.json          ← All tunable parameters
├── backend/                 ← Node.js Express API + WebSocket
│   ├── server.js
│   ├── routes/
│   │   ├── trades.js
│   │   ├── system.js
│   │   ├── ml.js
│   │   └── performance.js
│   ├── services/
│   │   ├── StateManager.js  ← In-memory + JSON persistence
│   │   ├── RiskEngine.js    ← Position sizing + circuit breakers
│   │   ├── SignalEngine.js  ← Signal scoring + filtering
│   │   ├── ExecutionEngine.js ← Order simulation + tier exits
│   │   └── MLClient.js      ← FastAPI proxy client
│   └── utils/logger.js
├── ml-service/              ← Python FastAPI ML pipeline
│   ├── main.py              ← FastAPI app + endpoints
│   ├── data_ingestion.py    ← yfinance auto-download + caching
│   ├── feature_engineering.py ← 30+ technical + structure features
│   ├── model_trainer.py     ← LightGBM + XGBoost + RandomForest
│   ├── signal_generator.py  ← Multi-ticker signal scoring
│   ├── backtester.py        ← Walk-forward + Monte Carlo
│   ├── requirements.txt
│   ├── models/              ← Trained model artifacts (auto-created)
│   └── data/cache/          ← yfinance CSV cache (auto-created)
├── frontend/                ← HTML/CSS/JS dashboard
│   ├── index.html           ← 12-panel dashboard
│   ├── css/dashboard.css    ← Dark terminal theme
│   └── js/
│       ├── ws.js            ← WebSocket client + auto-reconnect
│       ├── chart.js         ← Candlestick chart (lightweight-charts)
│       └── dashboard.js     ← All UI logic + API calls
├── data/                    ← JSON state files (auto-created)
│   ├── state.json           ← System state
│   ├── trades.json          ← Trade history
│   └── performance.json     ← Rolling metrics
├── logs/                    ← Log files (auto-created)
├── start.sh                 ← One-command startup
└── stop.sh                  ← Graceful shutdown
```

---

## ⚙️ Configuration (config.json)

All system parameters are in `config/config.json`. Key settings:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `risk.risk_per_trade_pct` | 0.25% | Capital at risk per trade |
| `risk.max_concurrent_positions` | 8 | Max open positions |
| `risk.max_daily_loss_pct` | 3% | Daily loss circuit breaker |
| `risk.max_drawdown_pct` | 10% | Max drawdown halt |
| `signals.min_confidence_score` | 0.75 | ML probability threshold |
| `profit_targets.daily_protect_mode_pct` | 0.5% | Activate protect mode |
| `profit_targets.daily_stretch_target_pct` | 1.0% | Lock in daily gains |
| `ml.retrain_interval_days` | 14 | Auto-retrain frequency |

---

## 🌐 API Reference

### System
- `GET /health` — System status
- `POST /api/system/start` — Start trading
- `POST /api/system/stop` — Stop trading
- `POST /api/system/download-data` — Trigger yfinance download
- `POST /api/system/reset-circuit-breaker` — Reset halt

### Trades
- `GET /api/trades` — Trade history
- `GET /api/trades/positions` — Open positions
- `POST /api/trades/close/:id` — Close specific position
- `POST /api/trades/close-all` — Emergency close all
- `GET /api/trades/export` — CSV export

### ML
- `GET /api/ml/health` — ML service status
- `GET /api/ml/model-health` — Model metrics
- `POST /api/ml/train` — Trigger retraining
- `GET /api/ml/backtest` — Run backtest

### Performance
- `GET /api/performance` — All metrics
- `GET /api/performance/equity-curve` — Equity data

---

## 🧠 ML Pipeline

1. **Data**: yfinance → 5m, 15m, 1H, 1D candles → 2 years
2. **Features**: 40+ indicators (EMA, RSI, MACD, ATR, BB, ADX, VWAP, market structure)
3. **Labels**: TP/SL outcome within 12 candles (T+1 execution)
4. **Models**: LightGBM + XGBoost + RandomForest ensemble
5. **Calibration**: Isotonic regression for accurate probabilities
6. **Validation**: Walk-forward + purged CV + 3-month holdout
7. **Signals**: 200+ raw → filtered to top 20 by composite score

---

## 📊 Dashboard Panels

| Panel | Description |
|-------|-------------|
| Metrics Bar | Real-time equity, win rate, Sharpe, drawdown |
| Price Chart | Candlestick + EMA/BB/RSI (lightweight-charts) |
| Opportunities | Top 12 signals with score bars + one-click execute |
| Open Positions | Multi-tier exit tracking (T1/T2/trailing) |
| Equity Curve | PnL chart with moving average |
| Strategy Allocation | Momentum/Mean-Rev/Scalp allocation + Sharpe |
| Model Health | AUC per model + drift monitor |
| Risk Monitor | 4 gauge bars + live alert feed |
| Signal Breakdown | Per-component score + confidence gauge |
| Audit Log | Every TRADE/SKIP decision with reasons |
| Statistics | Full performance stats + streak tracking |
| Recent Trades | Last 30 closed trades table |

---

## 🛡️ Risk Management

- **Per-trade**: 0.25% capital risk, ATR-based stop, Kelly-fractional sizing
- **Portfolio**: Max 8 positions, 2% aggregate open risk, sector cap (3)
- **Correlation**: r > 0.7 treated as one position
- **Daily**: 3% loss → halt, +1% gain → lock profits
- **Circuit breakers**: 5 consecutive losses → 30 min pause, 10% drawdown → full halt
- **Drawdown recovery**: Paper trade → reduced size → validate → restore

---

## ⚠️ Disclaimer

This is an educational/research system. Not financial advice. Trading involves substantial risk of loss. Past backtest performance does not guarantee future results. Always test with paper trading before using real capital.

---

## 🔧 Requirements

**Backend**: Node.js ≥ 18, npm ≥ 9  
**ML Service**: Python ≥ 3.9, pip  
**Dependencies**: Auto-installed by `./start.sh`
