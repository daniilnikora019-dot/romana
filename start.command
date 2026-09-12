#!/bin/zsh
cd "$(dirname "$0")"
if ! curl -s -o /dev/null --max-time 1 "http://127.0.0.1:8778/"; then
  nohup python3 tools/serve.py > /tmp/romana_server.log 2>&1 &
  sleep 1
fi
open "http://127.0.0.1:8778/"
