do shell script "cd \"$HOME/Library/Application Support/romana\" && (curl -s -o /dev/null --max-time 1 http://127.0.0.1:8778/ || (nohup python3 tools/serve.py > /tmp/romana_server.log 2>&1 & sleep 1))"
delay 0.4
do shell script "open http://127.0.0.1:8778/"
