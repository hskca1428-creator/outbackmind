#!/bin/sh
# Daily PostgreSQL backup for OutbackMind. Keeps 14 days in ~/outbackmind/db-backups.
set -eu
DIR="$HOME/outbackmind/db-backups"
TS=$(date -u +%Y-%m-%d_%H%M)
OUT="$DIR/outbackmind_$TS.sql.gz"
umask 077
mkdir -p "$DIR"
docker exec outbackmind_postgres sh -c "pg_dump -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" --no-owner --clean --if-exists" | gzip -9 > "$OUT.tmp"
gzip -t "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
find "$DIR" -name "outbackmind_*.sql.gz" -mtime +13 -delete
echo "$(date -u +%FT%TZ) backup ok $OUT $(stat -c %s "$OUT") bytes"
