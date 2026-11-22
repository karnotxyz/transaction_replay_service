#!/bin/sh
set -eu
tmux kill-session -t local-c1-producer 2>/dev/null || true
tmux kill-session -t local-c2-replay 2>/dev/null || true
docker stop local-replay-c1 local-replay-c2 local-committed-mongo
