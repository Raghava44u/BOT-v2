#!/bin/bash
if [ -f .pids ]; then
  read BE_PID ML_PID < .pids
  kill $BE_PID $ML_PID 2>/dev/null
  rm .pids
  echo "APEX Trading System stopped"
else
  pkill -f "node server.js" 2>/dev/null
  pkill -f "python main.py" 2>/dev/null
  echo "Killed all APEX processes"
fi
