#!/usr/bin/env bash
# VansRouter start script.
#
# Behaviour:
#   1. git pull --ff-only (best effort).
#   2. Rebuild whenever the working tree differs from the last successful
#      build. The comparison is against a build stamp (HEAD sha + dirty tree),
#      NOT against "did the pull above change HEAD" — so a manual `git pull`
#      run before this script still triggers a rebuild of the new code.
#   3. If a working Docker daemon exists: bring the stack up with docker compose.
#      The `vansrouter` service is built locally from the repo Dockerfile
#      (docker-compose.yml `build: .`); the `headroom` sidecar runs from its
#      published image. Containers are managed by compose.
#   4. If Docker is missing/broken: fall back to a native build + run with the
#      same port (20128). This path never silently dies when Docker is down.
#
# Data: Docker keeps the named volume `9router-data` (declared in
# docker-compose.yml). The native fallback uses $DATA_DIR from .env, else the
# app default ~/.9router. A .env that was written for Docker sets
# DATA_DIR=/app/data — native cannot write there, so it is redirected to
# ~/.9router (warned below).

# POSIX sh (dash) compatible: `sh start.sh` must work, so pipefail is optional
# (bash-only). `set -e` keeps failures fatal; `-u` catches unset vars.
set -eu
set -o pipefail 2>/dev/null || true
cd "$(dirname "$0")"

APP_NAME=9router
LOG_DIR=logs
NATIVE_LOG="$LOG_DIR/start.log"
NATIVE_PID="$LOG_DIR/9router.pid"

# Stamp lives OUTSIDE the repo: a file under the working tree would always
# show up in `git status --porcelain` (logs/* is ignored, not logs/) and force
# a rebuild every run. Cache dir is per-checkout so different clones don't
# share stamps.
STAMP_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/9router-start"
STAMP_FILE="$STAMP_DIR/$(pwd | cksum | awk '{print $1}').stamp"

log() { printf '[start.sh] %s\n' "$*"; }

mkdir -p "$LOG_DIR" "$STAMP_DIR"

# ------------------------------------------------- source change detection
# should_build=1 unless the current tree provably equals the tree of the last
# successful build (stamp file). A dirty tree always forces a rebuild.
should_build=1
if [ -d .git ]; then
  log "git pull --ff-only ..."
  git pull --ff-only -q 2>/dev/null \
    || log "git pull failed (offline / local edits) — using current tree"
fi

save_stamp() {
  if [ -d .git ]; then
    { git rev-parse HEAD 2>/dev/null; git status --porcelain 2>/dev/null; } \
      >"$STAMP_FILE"
    log "build stamp saved"
  fi
}

if [ -d .git ] && [ -f "$STAMP_FILE" ]; then
  stamp_tmp="$STAMP_FILE.$$"
  git rev-parse HEAD 2>/dev/null >"$stamp_tmp"
  git status --porcelain 2>/dev/null >>"$stamp_tmp"
  if cmp -s "$stamp_tmp" "$STAMP_FILE"; then
    log "source unchanged since last build — skip rebuild"
    should_build=0
  else
    log "source changed since last build (new commits or local edits) — rebuild"
  fi
  rm -f "$stamp_tmp"
elif [ -d .git ]; then
  log "no previous build stamp — rebuild"
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
  if [ ! -f .env ]; then
    log "WARN: .env missing — container runs with Dockerfile defaults only (INITIAL_PASSWORD=123456, etc.)"
  fi

  # Local image name from docker-compose.yml. Build only when the source changed
  # or the image is missing; compose skips the rebuild when the image exists.
  IMG_NAME=vansrouter:local
  if [ "$should_build" = 1 ] || ! docker image inspect "$IMG_NAME" >/dev/null 2>&1; then
    log "docker compose up -d --build (vansrouter built from local Dockerfile, headroom sidecar image)"
    docker compose up -d --build
    save_stamp
  else
    log "source unchanged — docker compose up -d"
    docker compose up -d
  fi

  log "done. Follow logs with: docker compose logs -f vansrouter"
  exit 0
fi

# ================================================================ NATIVE path
log "Docker not available — falling back to native build + run"

if [ "$should_build" = 1 ] || [ ! -f .next/standalone/server.js ]; then
  log "npm run build"
  npm run build
  save_stamp
else
  log "standalone build present and source unchanged, skipping rebuild"
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
