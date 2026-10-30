#!/usr/bin/env bash
set -euo pipefail
# Discardable PostgreSQL only. No real environment, passwords or existing DB containers are reused.
suffix="$(date +%s)-$$"
container="olos-direct-test-${suffix}"
network="olos-direct-test-${suffix}"
certs=$(mktemp -d)
cleanup() {
  docker rm -fv "$container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$certs"
}
trap cleanup EXIT
printf 'DISPOSABLE_RESOURCES container=%s network=%s certs=%s\n' "$container" "$network" "$certs"
docker network create --internal "$network" >/dev/null
docker run --detach --name "$container" --network "$network" \
  --label olos-direct.disposable-test=true --tmpfs /var/lib/postgresql/data:rw,size=768m \
  -e POSTGRES_HOST_AUTH_METHOD=trust --entrypoint bash postgres:16-bookworm -c '
    openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/test.key -out /tmp/test.crt -days 1 -subj /CN=localhost -addext subjectAltName=DNS:localhost >/dev/null 2>&1
    chown postgres:postgres /tmp/test.key /tmp/test.crt
    chmod 600 /tmp/test.key
    exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/test.crt -c ssl_key_file=/tmp/test.key
  ' >/dev/null
ready=false
for i in $(seq 1 30); do
  if docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [ "$ready" != true ]; then exit 1; fi
# Fail closed before creating databases or applying fixture migrations.
test "$(docker network inspect --format '{{.Internal}}' "$network")" = true
test "$(docker inspect --format '{{len .HostConfig.PortBindings}}' "$container")" = 0
test "$(docker inspect --format '{{index .Config.Labels "olos-direct.disposable-test"}}' "$container")" = true
test "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$container")" = "$network"
printf 'ISOLATION_VERIFIED internal_network=true published_ports=0 temporary_postgres=true\n'
docker exec "$container" createdb -U postgres olos_direct_test
docker exec "$container" createdb -U postgres madm
docker exec "$container" createdb -U postgres olos_admin_homolog
docker cp "$container:/tmp/test.crt" "$certs/ca.crt" >/dev/null
chmod 755 "$certs"
chmod 644 "$certs/ca.crt"
# Node shares only this disposable database's network namespace; no public port is published.
docker run --rm --network "container:$container" --user "$(id -u):$(id -g)" \
  -v "$PWD:/app:ro" -v "$certs:/certs:ro" -w /app \
  -e OLOS_DIRECT_DISPOSABLE_TEST=true \
  -e OLOS_DIRECT_TEST_SOURCE_URL=postgresql://postgres@127.0.0.1:5432/olos_direct_test \
  -e OLOS_DIRECT_TEST_DESTINATION_URL=postgresql://postgres@localhost:5432/madm \
  -e OLOS_DIRECT_TEST_CA_FILE=/certs/ca.crt \
  -e TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/olos_admin_homolog \
  node:24-bookworm-slim node --import tsx --test --test-concurrency=1 \
  test/admin.database.ts test/store.integration.ts test/corporate-delivery.integration.ts
