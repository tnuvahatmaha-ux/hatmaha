#!/usr/bin/env bash
# מרים Postgres מקומי לפיתוח, בתוך הפרויקט (.local/pgdata, מוחרג מ-Git).
# בהרצה ראשונה: יוצר את המסד, מריץ את כל המיגרציות וטוען נתוני דמו.
# בהרצות הבאות: רק מפעיל.
#
#   ./scripts/dev-db.sh           הפעלה
#   ./scripts/dev-db.sh --reset   מחיקת המסד ויצירתו מחדש עם נתוני דמו טריים
set -euo pipefail
export LC_ALL=C LANG=C

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/.local/pgdata"
SOCK=/tmp/hpg          # נתיב קצר: ל-socket של Unix יש מגבלה של 103 תווים
PORT=54999
DB=hatmaha
PSQL=(psql -h "$SOCK" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)

RESET=false
[ "${1:-}" = "--reset" ] && RESET=true

mkdir -p "$SOCK"

if [ ! -f "$DATA/PG_VERSION" ]; then
  echo "→ יוצר אשכול Postgres חדש ב-.local/pgdata"
  mkdir -p "$DATA"
  initdb -D "$DATA" -U postgres --encoding=UTF8 --locale=C >/dev/null
fi

if pg_ctl -D "$DATA" status >/dev/null 2>&1; then
  echo "✓ Postgres כבר רץ"
else
  pg_ctl -D "$DATA" -o "-p $PORT -k $SOCK -c listen_addresses=''" -l "$DATA/server.log" -w start >/dev/null
  echo "✓ Postgres הופעל בפורט $PORT"
fi

if $RESET; then
  echo "→ מוחק את מסד $DB"
  "${PSQL[@]}" -d postgres -c "drop database if exists $DB with (force);"
fi

if [ "$("${PSQL[@]}" -d postgres -tAc "select 1 from pg_database where datname='$DB'")" != "1" ]; then
  echo "→ יוצר מסד $DB ומריץ מיגרציות"
  "${PSQL[@]}" -d postgres -c "create database $DB;"
  "${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/tests/00_local_auth_stub.sql"
  for f in "$ROOT"/supabase/migrations/*.sql; do
    "${PSQL[@]}" -d "$DB" -f "$f" >/dev/null 2>&1
    printf '  ✓ %s\n' "$(basename "$f")"
  done
  echo "→ טוען נתוני דמו"
  "${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/dev/seed_demo.sql" 2>&1 | grep -o 'נתוני הדמו נטענו.*' || true
fi

echo "✓ מסד $DB מוכן"
