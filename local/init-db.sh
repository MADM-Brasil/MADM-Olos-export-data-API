#!/bin/sh
set -eu
# Executed once, only inside this new isolated PostgreSQL volume.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv local_app_password LOCAL_APP_PASSWORD
CREATE ROLE olos_local LOGIN PASSWORD :'local_app_password';
GRANT CONNECT, CREATE ON DATABASE olos_http_local TO olos_local;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO olos_local;
SQL
