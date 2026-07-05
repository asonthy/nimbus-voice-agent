#!/usr/bin/env bash
# Restarts the backend (FastAPI/uvicorn on :8000) and the static frontend server (:8080).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_PORT=8000
FRONTEND_PORT=8080
LOG_DIR="$ROOT/.logs"
mkdir -p "$LOG_DIR"

kill_port() {
  local port="$1"
  local pids
  pids="$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "Killing process(es) on port $port: $pids"
    kill $pids 2>/dev/null || true
    sleep 1
    kill -9 $pids 2>/dev/null || true
  fi
}

kill_port "$BACKEND_PORT"
kill_port "$FRONTEND_PORT"

echo "Starting backend on :$BACKEND_PORT ..."
cd "$ROOT"
nohup "$ROOT/backend/.venv/bin/python" -m uvicorn backend.main:app \
  --host 0.0.0.0 --port "$BACKEND_PORT" --reload \
  > "$LOG_DIR/backend.log" 2>&1 &

echo "Starting static frontend server on :$FRONTEND_PORT ..."
nohup python3 -m http.server "$FRONTEND_PORT" --directory "$ROOT" \
  > "$LOG_DIR/frontend.log" 2>&1 &

sleep 1
echo "Backend log:  $LOG_DIR/backend.log"
echo "Frontend log: $LOG_DIR/frontend.log"
echo "Backend:  http://localhost:$BACKEND_PORT/api/health"
echo "Frontend: http://localhost:$FRONTEND_PORT/playground/playground.html"
