#!/bin/bash
# JP株OS — HTTPサーバー起動スクリプト
# launchdから呼ばれる

PROJECT_DIR="/Users/ryo/Downloads/Claude"
PYTHON="/Library/Developer/CommandLineTools/usr/bin/python3"
LOG="$PROJECT_DIR/logs/http.log"

cd "$PROJECT_DIR"
exec "$PYTHON" -m http.server 8080 --bind 0.0.0.0 >> "$LOG" 2>&1
