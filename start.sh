#!/usr/bin/env bash
# 9Router start script.
#
# Behaviour:
#   1. git pull --ff-only. If the pull reports HEAD unchanged (nothing new),
#      the rebuild is skipped. On any failure (offline, local edits, dirty
#      tree) it rebuilds — i.e. rebuild-on-every-run unless proven unchanged.
#   2. If a working Docker daemon exists: docker build (unless skipped) and
#      recreate the `9router` container exactly like the original script.
#   3. If Docker is missing/broken: fall back to a native build + run with the
#      same port (20128). This path never silently dies when Docker is down.
#
# Data: Docker keeps the named volume `9router-data`. The native fallback uses
# $DATA_DIR from .env, else the app default ~/.9router. A .env that was written
# for Docker sets DATA_DIR=/app/data — native cannot write there, so it is
# redirected to ~/.9router (warned below).

# POSIX sh (dash) compatible: `sh start.sh` must work, so pipefail is optional
# (bash-only). `set -e` keeps failures fatal; `-u` catches unset vars.
set -eu
set -o pipefail 2>/dev/null || true
cd "$(dirname "$0")"

APP_NAME=9router
LOG_DIR=logs
NATIVE_LOG="$LOG_DIR/start.log"
NATIVE_PID="$LOG_DIR/9router.pid"

log() { printf '[start.sh] %s\n' "$*"; }

# ---------------------------------------------------------------- git update
# should_build=1 unless the pull provably brought nothing new.
should_build=1
if [ -d .git ]; then
  before="$(git rev-parse HEAD 2>/dev/null || true)"
  log "git pull --ff-only ..."
  if git pull --ff-only -q 2>/dev/null; then
    after="$(git rev-parse HEAD 2>/dev/null || echo "$before")"
    dirty="$(git status --porcelain 2>/dev/null || true)"
    if [ -n "$before" ] && [ "$before" = "$after" ] && [ -z "$dirty" ]; then
      log "no changes (HEAD unchanged, clean tree) — skip rebuild"
      should_build=0
    else
      log "new commits or local changes present — rebuild"
    fi
  else
    log "git pull failed (offline / uncommitted local changes) — rebuild anyway"
  fi
else
  log "not a git repository — rebuild on every run"
fi

# ------------------------------------------------------------- docker usable?
docker_ok=0
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  docker_ok=1
fi

# ================================================================ DOCKER path
if [ "$docker_ok" = 1 ]; then
  if [ "$should_build" = 1 ] || ! docker image inspect "$APP_NAME" >/dev/null 2>&1; then
    log "docker build -t $APP_NAME ."
    docker build -t "$APP_NAME" .
  else
    log "image up to date, skipping docker build"
  fi

  docker stop "$APP_NAME" >/dev/null 2>&1 || true
  docker rm "$APP_NAME" >/dev/null 2>&1 || true

  if [ -f .env ]; then
    log "docker run -d --name $APP_NAME ... (http://localhost:20128)"
    docker run -d --name "$APP_NAME" \
      -p 20128:20128 \
      --env-file .env \
      -v 9router-data:/app/data \
      "$APP_NAME"
  else
    log "WARN: .env missing — container runs with Dockerfile defaults only (INITIAL_PASSWORD=123456, etc.)"
    log "docker run -d --name $APP_NAME ... (http://localhost:20128)"
    docker run -d --name "$APP_NAME" \
      -p 20128:20128 \
      -v 9router-data:/app/data \
      "$APP_NAME"
  fi

  log "done. Follow logs with: docker logs -f $APP_NAME"
  exit 0
fi

# ================================================================ NATIVE path
log "Docker not available — falling back to native build + run"

if [ "$should_build" = 1 ] || [ ! -f .next/standalone/server.js ]; then
  log "npm run build"
  npm run build
else
  log "standalone build present and HEAD unchanged, skipping rebuild"
fi

# Load .env (KEY=VALUE scalars only — no shell metacharacters), then override
# the container-only values that are meaningless natively.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# Docker-oriented .env files set DATA_DIR=/app/data (the container mount path);
# native cannot write there, so fall back to the host data dir.
if [ "${DATA_DIR:-}" = /app/data ]; then
  log "WARN: .env DATA_DIR=/app/data is Docker-only; native run uses ~/.9router"
  DATA_DIR="$HOME/.9router"
fi
export DATA_DIR="${DATA_DIR:-$HOME/.9router}"
export PORT="${PORT:-20128}"
export HOSTNAME="${HOSTNAME:-0.0.0.0}"
export NODE_ENV="${NODE_ENV:-production}"

# Stop any previous native instance (pidfile, then orphaned processes).
stop_native() {
  if [ -f "$NATIVE_PID" ]; then
    pid="$(cat "$NATIVE_PID" 2>/dev/null || true)"
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      log "stopping previous instance (pid $pid)"
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$NATIVE_PID"
  fi
  # Recover a run that died without cleaning its pidfile.
  pkill -f "node custom-server.js" 2>/dev/null || true
  sleep 1
}

mkdir -p "$LOG_DIR"
stop_native

log "starting native server on port ${PORT} (pid log: $NATIVE_LOG)"
nohup node custom-server.js >>"$NATIVE_LOG" 2>&1 &
echo $! >"$NATIVE_PID"

# Small wait so immediate boot failures surface instead of a silent dead daemon.
sleep 3
pid="$(cat "$NATIVE_PID")"
if kill -0 "$pid" 2>/dev/null; then
  log "running (pid $pid) → http://localhost:${PORT}   logs: tail -f $NATIVE_LOG"
else
  log "ERROR: process exited during startup — last lines of $NATIVE_LOG:"
  tail -n 20 "$NATIVE_LOG" 2>/dev/null || true
  exit 1
fi
