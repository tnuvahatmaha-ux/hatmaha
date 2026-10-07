#!/usr/bin/env bash
# מריץ את כל המיגרציות מול Postgres מקומי נקי, לצורך אימות.
# שימוש:  ./supabase/tests/run_local.sh [SOCKET_DIR] [PORT] [DBNAME]
set -euo pipefail
export LC_ALL=C LANG=C
SOCK="${1:-/tmp/hpg}"; PORT="${2:-54999}"; DB="${3:-hatmaha}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ADMIN=(psql -h "$SOCK" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)

"${ADMIN[@]}" -c "drop database if exists \"$DB\" with (force);" -c "create database \"$DB\";"
PSQL=(psql -h "$SOCK" -p "$PORT" -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q)

"${PSQL[@]}" -f "$HERE/00_local_auth_stub.sql"
for f in "$HERE"/../migrations/*.sql; do
  printf '  → %s\n' "$(basename "$f")"
  "${PSQL[@]}" -f "$f" >/dev/null
done
echo "✓ כל המיגרציות עברו על מסד נקי"

echo "  → rls.test.sql"
"${PSQL[@]}" -f "$HERE/rls.test.sql" 2>&1 | grep -E "NOTICE|ERROR|✓" | sed 's/^psql:[^ ]* //'

