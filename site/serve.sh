#!/usr/bin/env bash
# Launch the local study site with file-backed progress. Requires only Python 3.
cd "$(dirname "$0")"
PORT="${1:-8000}"
python3 server.py "$PORT"
