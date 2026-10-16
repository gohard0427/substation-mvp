#!/bin/sh
set -eu
# Persistent disks may be mounted root-owned. Drop root before running the app.
if [ "$(id -u)" = 0 ]; then
  mkdir -p "${DATA_DIR:-/var/data}"
  chown app:app "${DATA_DIR:-/var/data}"
  exec gosu app python -m uvicorn asgi:app --host 0.0.0.0 --port "${PORT:-8000}" --workers 1 --limit-concurrency 24 --timeout-graceful-shutdown 110 --no-access-log
fi
exec python -m uvicorn asgi:app --host 0.0.0.0 --port "${PORT:-8000}" --workers 1 --limit-concurrency 24 --timeout-graceful-shutdown 110 --no-access-log
