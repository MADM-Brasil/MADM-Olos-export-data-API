#!/usr/bin/env bash
set -euo pipefail
# Only disposable containers and an internal network; no corporate endpoints or published ports.
prefix="olos-http-smoke-$(date +%s)-$$"
image="${TEST_WORKER_IMAGE:-olos-http-worker:local-validation}"
cleanup() {
  docker rm -f "${prefix}-worker" "${prefix}-mock" "${prefix}-pg" >/dev/null 2>&1 || true
  docker network rm "$prefix" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create --internal "$prefix" >/dev/null
docker run -d --name "${prefix}-pg" --network "$prefix" --network-alias pg \
  -e POSTGRES_DB=olos_http_test -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-bookworm >/dev/null
ready=false
for i in $(seq 1 30); do
  if docker exec "${prefix}-pg" pg_isready -U postgres -d olos_http_test >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [ "$ready" != true ]; then exit 1; fi
docker exec -i "${prefix}-pg" psql -X -U postgres -d olos_http_test -v ON_ERROR_STOP=1 < test/fixture.sql >/dev/null
docker exec -i "${prefix}-pg" psql -X -U postgres -d olos_http_test -v ON_ERROR_STOP=1 < migrations/001_ingestion.sql >/dev/null
docker exec -i "${prefix}-pg" psql -X -U postgres -d olos_http_test -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE ROLE worker LOGIN;
GRANT USAGE ON SCHEMA raw,olos_http TO worker;
GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA raw,olos_http TO worker;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA raw TO worker;
SQL
docker run -d --name "${prefix}-mock" --network "$prefix" --read-only \
  -v "$PWD/test/mock-server.mjs:/fixtures/mock.mjs:ro" "$image" node /fixtures/mock.mjs >/dev/null
sleep 1
docker run -d --name "${prefix}-worker" --network "container:${prefix}-mock" --read-only \
  --cap-drop ALL --security-opt no-new-privileges --memory 512m \
  -e DATABASE_URL=postgresql://worker@pg:5432/olos_http_test -e OLOS_SOURCE_KEY=fixture \
  -e OLOS_BASE_URL=http://127.0.0.1:8080/WebApiExportData -e OLOS_USERNAME=fixture -e OLOS_PASSWORD=fixture \
  -e OLOS_CLIENT_ID=fixture -e OLOS_CLIENT_SECRET=fixture -e SOURCE_ID_UNIQUENESS_CONFIRMED=true \
  -e POLL_INTERVAL_MS=100 "$image" >/dev/null
sleep 4
docker stop --time 15 "${prefix}-worker" >/dev/null
code=$(docker inspect --format '{{.State.ExitCode}}' "${prefix}-worker")
if [ "$code" != 0 ]; then docker logs "${prefix}-worker"; exit 1; fi
docker exec "${prefix}-mock" node --input-type=module -e '
const stats=await (await fetch("http://127.0.0.1:8080/stats")).json();
if(stats.passwordGrants!==1 || stats.refreshGrants<3 || stats.reads<5)throw Error("token/poll smoke failed");
console.log(JSON.stringify(stats));'
result=$(docker exec "${prefix}-pg" psql -X -U postgres -d olos_http_test -Atc "SELECT count(*) FROM raw.olos_calls WHERE nome_agente='Fixture agent' AND nome_campanha_olos='Fixture campaign' AND nome_tabulacao_olos='Fixture disposition'")
if [ "$result" != 1 ]; then exit 1; fi
if docker logs "${prefix}-worker" 2>&1 | rg -q 'DO_NOT_STORE_OR_LOG|001100000000|Bearer'; then exit 1; fi
printf 'Docker smoke passed: non-root runtime, restricted PostgreSQL role, rotating tokens, dedup, reference names, shutdown.\n'
