#!/usr/bin/env bash
# Private Postgres 16 cluster for local development and tests.
# Usage: scripts/dev-db.sh start|stop|url
# Data: .data/pg (gitignored), or as root /var/lib/kitchenquest-pg (KQ_PGDATA) owned by postgres. Port 54329. Works as root (runs as the postgres user) or as a normal user.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=54329
BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"

# initdb/pg_ctl refuse to run as root: as root the cluster lives outside the
# repo, owned by the postgres user (override with KQ_PGDATA); otherwise .data/pg.
if [ "$(id -u)" -eq 0 ]; then
  DATA="${KQ_PGDATA:-/var/lib/kitchenquest-pg}"
  as_pg() { runuser -u postgres -- "$@"; }
else
  DATA="$ROOT/.data/pg"
  as_pg() { "$@"; }
fi
LOG="$(dirname "$DATA")/kitchenquest-pg.log"
[ "$(id -u)" -eq 0 ] || LOG="$ROOT/.data/pg.log"

url() { echo "postgres://postgres@localhost:$PORT/$1"; }

psql_() { as_pg "$BIN/psql" -h localhost -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -tA "$@"; }

case "${1:-}" in
  start)
    if [ ! -x "$BIN/initdb" ]; then
      echo "Postgres 16 binaries not found at $BIN." >&2
      echo "Install Postgres 16, set PG_BIN, or use: docker compose up -d db" >&2
      exit 1
    fi
    if [ "$(id -u)" -eq 0 ]; then
      install -d -o postgres -g postgres -m 700 "$DATA"
      install -d -o postgres -g postgres "$(dirname "$LOG")"
    else
      mkdir -p "$ROOT/.data"
    fi
    if [ ! -f "$DATA/PG_VERSION" ]; then
      as_pg "$BIN/initdb" -D "$DATA" -U postgres --auth=trust -E UTF8 >/dev/null
    fi
    if ! as_pg "$BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      as_pg "$BIN/pg_ctl" -D "$DATA" -l "$LOG" -w \
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
