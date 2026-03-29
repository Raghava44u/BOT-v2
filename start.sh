#!/bin/bash
set -e

CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

echo -e "${CYAN}"
echo "  ▲ APEX AI TRADING SYSTEM v1.0"
echo "  ================================${NC}"

ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$ROOT/backend"
ML="$ROOT/ml-service"

# ── 1. Python ML Service ───────────────────────────────────────────
echo -e "\n${YELLOW}[1/3] Starting ML Service…${NC}"
cd "$ML"

if [ ! -d "venv" ]; then
  echo "Creating Python virtualenv…"
  python3 -m venv venv
fi

source venv/bin/activate
echo "Installing Python dependencies…"
pip install -q -r requirements.txt

echo -e "${GREEN}✓ Python env ready${NC}"
nohup python main.py > "$ROOT/logs/ml-service.log" 2>&1 &
ML_PID=$!
echo "ML Service PID: $ML_PID"

# ── 2. Backend ─────────────────────────────────────────────────────
echo -e "\n${YELLOW}[2/3] Starting Node.js Backend…${NC}"
cd "$BACKEND"

if [ ! -d "node_modules" ]; then
  echo "Installing Node.js dependencies…"
  npm install --silent
fi

nohup node server.js > "$ROOT/logs/backend.log" 2>&1 &
BE_PID=$!
echo "Backend PID: $BE_PID"

# ── 3. Wait & Open ─────────────────────────────────────────────────
echo -e "\n${YELLOW}[3/3] Waiting for services to start…${NC}"
sleep 4

PORT=$(node -e "const c=require('./backend/../config/config.json');console.log(c.ports.backend)" 2>/dev/null || echo "3001")

echo -e "\n${GREEN}═══════════════════════════════════════════"
echo "  ▲ APEX TRADING SYSTEM IS RUNNING"
echo "═══════════════════════════════════════════"
echo ""
echo "  Dashboard:  http://localhost:${PORT}"
echo "  ML API:     http://localhost:8001"
echo "  Health:     http://localhost:${PORT}/health"
echo ""
echo "  Backend logs:  logs/backend.log"
echo "  ML logs:       logs/ml-service.log"
echo ""
echo "  PIDs: Backend=$BE_PID  ML=$ML_PID"
echo -e "═══════════════════════════════════════════${NC}"

# Save PIDs
echo "$BE_PID $ML_PID" > "$ROOT/.pids"

# Open browser
if command -v xdg-open &>/dev/null; then xdg-open "http://localhost:$PORT" &
elif command -v open &>/dev/null; then open "http://localhost:$PORT" &
fi

wait $BE_PID $ML_PID
