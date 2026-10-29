#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
dc=(docker compose --env-file local/.env -f local/compose.yaml)
"${dc[@]}" up -d --wait postgres
# This database is exclusively a fixture, inside the new isolated PostgreSQL container.
"${dc[@]}" exec -T postgres psql -X -U local_admin -d postgres -v ON_ERROR_STOP=1 <<'SQL'
SELECT 'CREATE DATABASE olos_http_local_test OWNER olos_local'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname='olos_http_local_test') \gexec
SQL
"${dc[@]}" run --rm --no-deps lab node local/scripts/run-tests.mjs
