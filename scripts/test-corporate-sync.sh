#!/usr/bin/env bash
set -euo pipefail
# Fresh private network, no published ports, no production environment or .env is loaded.
suffix="$(date +%s)-$$"
container="corporate-sync-pg-${suffix}"
network="corporate-sync-test-${suffix}"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create --internal "$network" >/dev/null
docker run --detach --name "$container" --network "$network" \
  --label corporate-sync.disposable-test=true \
  --tmpfs /var/lib/postgresql/data:rw,size=512m \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-bookworm >/dev/null
ready=false
for i in $(seq 1 30); do
  if docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [ "$ready" != true ]; then exit 1; fi
docker exec "$container" createdb -U postgres corporate_sync_test_source
docker exec "$container" createdb -U postgres corporate_sync_test_destination
docker run --rm --network "$network" --user "$(id -u):$(id -g)" \
  -v "$PWD:/app:ro" -w /app \
  -e CORPORATE_SYNC_DISPOSABLE_TEST=true \
  -e "CORPORATE_SYNC_TEST_SOURCE_URL=postgresql://postgres@${container}/corporate_sync_test_source" \
  -e "CORPORATE_SYNC_TEST_DESTINATION_URL=postgresql://postgres@${container}/corporate_sync_test_destination" \
  node:24-bookworm-slim node --import tsx --test test/corporate-sync.test.ts test/corporate-sync.integration.ts
