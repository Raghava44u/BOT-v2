"""
APEX ML Microservice — FastAPI
- Stable startup with health endpoint ready immediately
- SSE (Server-Sent Events) for real-time training/download progress
- Proper port from config
- All background tasks push events via SSE queue
"""
import json, os, logging, asyncio, time
from datetime import datetime
from typing import List
from fastapi import FastAPI, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import queue

from data_ingestion import DataIngestion, set_progress_callback
from feature_engineering import FeatureEngineering
from model_trainer import ModelTrainer, set_train_callback
from signal_generator import SignalGenerator
from backtester import Backtester, set_backtest_callback

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s'
)
logger = logging.getLogger(__name__)

# ── Load config ───────────────────────────────────────────────────────────────
_cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'config', 'config.json')
with open(_cfg_path) as f:
    config = json.load(f)

# ── FastAPI app ───────────────────────────────────────────────────────────────
app = FastAPI(title="APEX ML Service", version="2.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ── Global instances ──────────────────────────────────────────────────────────
ingestion   = DataIngestion(config)
feature_eng = FeatureEngineering(config)
trainer     = ModelTrainer(config)
signal_gen  = SignalGenerator(config, feature_eng, trainer)
backtester  = Backtester(config)

# ── SSE event queue (for real-time frontend streaming) ────────────────────────
_event_queue: queue.Queue = queue.Queue(maxsize=500)

def _push_event(event: str, data: dict):
    """Push to SSE queue + broadcast via Node WebSocket (injected at runtime)."""
    try:
        payload = {'event': event, 'data': data, 'ts': datetime.utcnow().isoformat()}
        _event_queue.put_nowait(payload)
        # Also call Node.js broadcast if available
        if _node_broadcast_cb:
            _node_broadcast_cb(event, data)
    except queue.Full:
        pass  # Drop oldest event if queue full

_node_broadcast_cb = None
def set_node_broadcast(fn): global _node_broadcast_cb; _node_broadcast_cb = fn

# Wire up callbacks
set_progress_callback(lambda e, d: _push_event(e, d))
set_train_callback(lambda e, d: _push_event(e, d))
set_backtest_callback(lambda e, d: _push_event(e, d))

# ── ML state ──────────────────────────────────────────────────────────────────
ml_state = {
    "status":          "ready",
    "last_train":      None,
    "last_download":   None,
    "last_backtest":   None,
    "download_results": {},
    "backtest_result":  None,
}

# ── Models ────────────────────────────────────────────────────────────────────
class TickersRequest(BaseModel):
    tickers: List[str]
    force:   bool = False

class PredictRequest(BaseModel):
    ticker:   str
    features: dict

# ═══ ENDPOINTS ════════════════════════════════════════════════════════════════

@app.get("/health")
def health():
    """Always responds immediately — backend polls this."""
    return {
        "status":        "ok",
        "ml_status":     ml_state["status"],
        "models_loaded": trainer.is_trained(),
        "models":        list(trainer.models.keys()),
        "last_train":    ml_state["last_train"],
        "last_download": ml_state["last_download"],
        "timestamp":     datetime.utcnow().isoformat()
    }

@app.get("/model-health")
def model_health():
    return trainer.get_health_metrics()

# ── SSE stream ────────────────────────────────────────────────────────────────
@app.get("/events")
async def sse_events():
    """Server-Sent Events stream for real-time progress."""
    async def generate():
        yield "data: {\"event\":\"connected\"}\n\n"
        while True:
            try:
                payload = _event_queue.get_nowait()
                yield f"data: {json.dumps(payload)}\n\n"
            except queue.Empty:
                await asyncio.sleep(0.1)
                yield ": heartbeat\n\n"
    return StreamingResponse(generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

# ── Download ──────────────────────────────────────────────────────────────────
@app.post("/download")
async def download_data(req: TickersRequest, background_tasks: BackgroundTasks):
    if ml_state["status"] in ("downloading", "training"):
        return {"ok": False, "message": f"Already {ml_state['status']}"}
    ml_state["status"] = "downloading"
    background_tasks.add_task(_download_task, req.tickers, req.force)
    return {"ok": True, "tickers": len(req.tickers), "message": "Sequential download started"}

async def _download_task(tickers, force):
    try:
        logger.info(f"Starting download: {len(tickers)} tickers")
        results = ingestion.download_all(tickers, force=force)

        # Merge after download
        _push_event('merge_start', {'msg': 'Merging CSVs into final_dataset.csv'})
        _, loaded = ingestion.merge_to_dataset(tickers, interval='1d')

        ml_state["last_download"]   = datetime.utcnow().isoformat()
        ml_state["download_results"] = results
        ml_state["status"]           = "ready"
        _push_event('download_complete', {
            'tickers_ok': sum(1 for t in results.values() for s in t.values() if s=='ok'),
            'loaded':     loaded,
            'timestamp':  ml_state["last_download"]
        })
    except Exception as e:
        logger.error(f"Download task error: {e}")
        ml_state["status"] = "ready"
        _push_event('download_error', {'msg': str(e)})

# ── Train ─────────────────────────────────────────────────────────────────────
@app.post("/train")
async def train_models(background_tasks: BackgroundTasks):
    if ml_state["status"] in ("downloading", "training"):
        return {"ok": False, "message": f"Already {ml_state['status']}"}
    ml_state["status"] = "training"
    background_tasks.add_task(_train_task)
    return {"ok": True, "message": "Training started on merged dataset"}

async def _train_task():
    try:
        logger.info("Starting training pipeline")
        result = trainer.train(ingestion, feature_eng)
        ml_state["last_train"] = datetime.utcnow().isoformat()
        ml_state["status"]     = "ready"
        if "error" in result:
            _push_event('train_error', {'msg': result["error"]})
        else:
            _push_event('train_complete', {
                'metrics':    result.get('metrics', {}),
                'train_meta': result.get('train_meta', {}),
                'timestamp':  ml_state["last_train"]
            })
    except Exception as e:
        logger.error(f"Train task error: {e}")
        ml_state["status"] = "ready"
        _push_event('train_error', {'msg': str(e)})

# ── Backtest ──────────────────────────────────────────────────────────────────
@app.get("/backtest")
async def run_backtest(background_tasks: BackgroundTasks):
    if ml_state["status"] == "backtesting":
        return {"ok": False, "message": "Already backtesting"}
    if not trainer.is_trained():
        return {"error": "Train models first"}
    ml_state["status"] = "backtesting"
    background_tasks.add_task(_backtest_task)
    return {"ok": True, "message": "Backtest started on unseen test data"}

async def _backtest_task():
    try:
        result = backtester.run(ingestion, feature_eng, trainer)
        ml_state["last_backtest"]  = datetime.utcnow().isoformat()
        ml_state["backtest_result"] = result
        ml_state["status"]          = "ready"
        if "error" in result:
            _push_event('backtest_error', {'msg': result["error"]})
        else:
            _push_event('backtest_complete', result)
    except Exception as e:
        logger.error(f"Backtest task error: {e}")
        ml_state["status"] = "ready"
        _push_event('backtest_error', {'msg': str(e)})

@app.get("/backtest/result")
def backtest_result():
    """Return cached backtest result."""
    r = ml_state.get("backtest_result")
    if not r:
        return {"error": "No backtest result yet. Run /backtest first."}
    return r

# ── Signals ───────────────────────────────────────────────────────────────────
@app.post("/signals")
def get_signals(req: TickersRequest):
    try:
        return signal_gen.generate(req.tickers)
    except Exception as e:
        logger.error(f"Signal error: {e}")
        return []

@app.post("/predict")
def predict(req: PredictRequest):
    try:
        return trainer.predict_single(req.ticker, req.features)
    except Exception as e:
        logger.error(f"Predict error: {e}")
        return {"probability": 0.5, "confidence": 0.5, "ensemble_agreement": False}

@app.get("/status")
def status():
    return ml_state

if __name__ == "__main__":
    import uvicorn
    port = config["ports"]["ml_service"]
    logger.info(f"Starting APEX ML Service on port {port}")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info", timeout_keep_alive=300)
