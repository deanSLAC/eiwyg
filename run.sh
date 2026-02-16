#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

HOST="${EIWYG_HOST:-0.0.0.0}"
PORT="${EIWYG_PORT:-8080}"

# Create venv if it doesn't exist
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

source venv/bin/activate

# Install/upgrade deps
pip install -q -r requirements.txt

echo "Starting EIWYG on http://${HOST}:${PORT}"
exec uvicorn backend.main:app --host "$HOST" --port "$PORT"
