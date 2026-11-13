#!/usr/bin/env bash
set -euo pipefail
# Dedicated disposable DB only; never loads .env or uses operational DATABASE_URL.
container="olos-admin-reports-test-$(date +%s)-$$"
trap 'docker rm -fv "$container" >/dev/null 2>&1 || true' EXIT
docker run --detach --name "$container" --label olos-http.disposable-test=true \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=olos_admin_reports_test \
  -p 127.0.0.1::5432 postgres:16-bookworm >/dev/null
ready=false
for i in $(seq 1 30); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -d olos_admin_reports_test >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [ "$ready" != true ]; then exit 1; fi
port=$(docker port "$container" 5432/tcp | sed 's/.*://')
export TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:${port}/olos_admin_reports_test"
if [ "${REPORT_SNAPSHOT_PERF:-0}" = 1 ]; then
  export REPORT_PERF_CONTAINER="$container"
  node --import tsx --test test/admin-report-snapshots.performance.ts
elif [ "${REPORT_PERF:-0}" = 1 ]; then
  export REPORT_PERF_CONTAINER="$container"
  node --import tsx --test test/admin-reports.performance.ts
elif [ "${REPORT_SNAPSHOTS:-0}" = 1 ]; then
  node --import tsx --test test/admin-report-snapshots.database.ts
else
  node --import tsx --test test/admin-reports.database.ts
  node --import tsx --test test/admin-report-snapshots.database.ts
fi
