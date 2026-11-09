#!/usr/bin/env bash
# Private Postgres 16 cluster for local development and tests.
# Usage: scripts/dev-db.sh start|stop|url
# Data lives in .data/pg (gitignored), port 54329. Works as root (runs as the
# `postgres` OS user) or as a normal user.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="$ROOT/.data/pg"
PORT=54329
BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
RUN_DIR="$ROOT/.data"

if [ ! -x "$BIN/initdb" ]; then
  echo "Postgres 16 binaries not found at $BIN." >&2
  echo "Install Postgres 16, set PG_BIN, or use: docker compose up -d db" >&2
  exit 1
fi

# initdb/pg_ctl refuse to run as root: drop to the postgres user.
if [ "$(id -u)" -eq 0 ]; then
  as_pg() { runuser -u postgres -- "$@"; }
  mkdir -p "$RUN_DIR"
  chown postgres "$RUN_DIR"
  [ -d "$DATA" ] && chown -R postgres "$DATA"
  # the postgres user must be able to traverse the repo path
  d="$ROOT"; while [ "$d" != "/" ]; do chmod o+x "$d" 2>/dev/null || true; d="$(dirname "$d")"; done
else
  as_pg() { "$@"; }
  mkdir -p "$RUN_DIR"
fi

url() { echo "postgres://postgres@localhost:$PORT/$1"; }

psql_() { as_pg "$BIN/psql" -h localhost -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -tA "$@"; }

case "${1:-}" in
  start)
    if [ ! -f "$DATA/PG_VERSION" ]; then
      as_pg "$BIN/initdb" -D "$DATA" -U postgres --auth=trust -E UTF8 >/dev/null
    fi
    if ! as_pg "$BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      as_pg "$BIN/pg_ctl" -D "$DATA" -l "$RUN_DIR/pg.log" -w \
        -o "-p $PORT -k /tmp -c listen_addresses=localhost" start >/dev/null
    fi
    for db in kitchenquest kitchenquest_test; do
      if [ -z "$(psql_ -d postgres -c "select 1 from pg_database where datname='$db'")" ]; then
        psql_ -d postgres -c "create database $db" >/dev/null
      fi
    done
    echo "DATABASE_URL=$(url kitchenquest)"
    echo "TEST_DATABASE_URL=$(url kitchenquest_test)"
    ;;
  stop)
    as_pg "$BIN/pg_ctl" -D "$DATA" -m fast stop 2>/dev/null || true
    ;;
  url)
    echo "DATABASE_URL=$(url kitchenquest)"
    echo "TEST_DATABASE_URL=$(url kitchenquest_test)"
    ;;
  *)
    echo "usage: $0 start|stop|url" >&2; exit 2 ;;
esac
