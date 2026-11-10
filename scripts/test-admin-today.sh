#!/usr/bin/env bash
set -euo pipefail
# Local disposable fixtures only. No migration, .env or operational DATABASE_URL.
container="olos-manual-today-test-$(date +%s)-$$"
trap 'docker rm -fv "$container" >/dev/null 2>&1 || true' EXIT
docker run --detach --name "$container" --label olos-http.disposable-test=true \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=olos_admin_reports_test \
  -p 127.0.0.1::5432 postgres:16-bookworm >/dev/null
ready=false
for i in $(seq 1 30); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -d olos_admin_reports_test >/dev/null 2>&1; then ready=true;break;fi
  sleep 1
done
test "$ready" = true
port=$(docker port "$container" 5432/tcp | sed 's/.*://')
export TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:${port}/olos_admin_reports_test"
export OLOS_TODAY_DISPOSABLE_TEST=true
node --import tsx --test test/admin-today.database.ts
