#!/usr/bin/env bash
set -euo pipefail
# Always creates a disposable PostgreSQL. Never uses DATABASE_URL or an existing container.
container="olos-http-test-$(date +%s)-$$"
trap 'docker rm -fv "$container" >/dev/null 2>&1 || true' EXIT
printf 'DISPOSABLE_RESOURCES container=%s\n' "$container"
docker run --detach --name "$container" --label olos-http.disposable-test=true \
  --tmpfs /var/lib/postgresql/data:rw,size=512m \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=olos_admin_homolog \
  -p 127.0.0.1::5432 postgres:16-bookworm >/dev/null
ready=false
for i in $(seq 1 30); do
  if docker exec "$container" pg_isready -U postgres -d olos_admin_homolog >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [ "$ready" != true ]; then exit 1; fi
port=$(docker port "$container" 5432/tcp | sed 's/.*://')
export TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:${port}/olos_admin_homolog"
npm run build
npm run test:integration
