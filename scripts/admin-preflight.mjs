// Run on stdin inside the existing worker/image, using ONLY its operational environment.
// No OLOS imports, advisory locks, migrations, seeds or writes.
import pg from 'pg';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { config } = await import(pathToFileURL(resolve('dist/config.js')).href);
const { assertSchema } = await import(pathToFileURL(resolve('dist/schema.js')).href);
const cfg = config();
const db = new pg.Client({ connectionString: cfg.databaseUrl, connectionTimeoutMillis: 10000, statement_timeout: 10000,
  application_name: 'olos-admin-readonly-preflight' });
const expected = {
  worker_settings: 'source_key:text:NO,enabled:bool:NO,interval_ms:int4:NO,desired_state:text:NO,runtime_state:text:NO,last_error:text:YES,updated_at:timestamptz:NO,updated_by:text:NO',
  admin_credentials: 'source_key:text:NO,revision:int4:NO,encrypted_payload:text:NO,updated_at:timestamptz:NO,updated_by:text:NO,last_test_at:timestamptz:YES,last_test_ok:bool:YES,last_test_code:text:YES,last_test_ms:int4:YES',
  admin_audit: 'id:int8:NO,source_key:text:NO,actor:text:NO,action:text:NO,occurred_at:timestamptz:NO,metadata:jsonb:NO',
};
const expectedConstraints = {
  worker_settings: ["CHECK (((interval_ms >= 60000) AND (interval_ms <= 3600000)))", "CHECK ((desired_state = ANY (ARRAY['RUNNING'::text, 'PAUSED'::text, 'STOPPED'::text])))", "CHECK ((runtime_state = ANY (ARRAY['RUNNING'::text, 'PAUSING'::text, 'PAUSED'::text, 'STOPPING'::text, 'STOPPED'::text, 'ERROR'::text])))", "CHECK ((enabled = (desired_state = 'RUNNING'::text)))", 'PRIMARY KEY (source_key)'],
  admin_credentials: ['CHECK ((revision > 0))', 'PRIMARY KEY (source_key)', 'FOREIGN KEY (source_key) REFERENCES olos_http.worker_settings(source_key)'],
  admin_audit: ['PRIMARY KEY (id)'],
};
try {
  await db.connect();
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const destination = await assertSchema(db, cfg.schema, cfg.table);
  // Contract used by Store; LIMIT 0 validates shape without reading business payloads.
  await db.query('SELECT id,source_key,state,response_body,received_count,processed_count,request_ms,error_code,started_at,finished_at FROM olos_http.reads LIMIT 0');
  await db.query('SELECT source_key,source_id,target_id FROM olos_http.records LIMIT 0');
  const markerConstraints = (await db.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='olos_http.records'::regclass")).rows.map(r=>r.definition);
  if (!markerConstraints.includes('PRIMARY KEY (source_key, source_id)') || !markerConstraints.includes('UNIQUE (target_table, target_id)')) throw {code:'DEDUPLICATION_CONSTRAINT_REVIEW_REQUIRED'};
  const binding = await db.query('SELECT 1 FROM olos_http.reads WHERE source_key=$1 AND target_table<>$2 LIMIT 1',[cfg.sourceKey,destination.relation]);
  if(binding.rowCount) throw {code:'SOURCE_DESTINATION_MISMATCH'};
  const pending = (await db.query("SELECT state,count(*)::int AS count FROM olos_http.reads WHERE source_key=$1 AND state IN ('reading','received') GROUP BY state", [cfg.sourceKey])).rows;
  const database = (await db.query('SELECT current_database() AS name')).rows[0].name;
  const tables = {};
  for (const [table, signature] of Object.entries(expected)) {
    const relation = `olos_http.${table}`;
    const columns = (await db.query('SELECT column_name,udt_name,is_nullable,is_identity,column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position', ['olos_http',table])).rows;
    if (!columns.length) { tables[table] = { status: 'MISSING' }; continue; }
    const constraints = (await db.query('SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=to_regclass($1)', [relation])).rows.map(r=>r.definition).sort();
    const metadata = (await db.query("SELECT relrowsecurity, (SELECT count(*)::int FROM pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal) AS triggers FROM pg_class c WHERE c.oid=to_regclass($1)",[relation])).rows[0];
    const privileges = [];
    for (const privilege of table === 'admin_audit' ? ['SELECT','INSERT'] : ['SELECT','INSERT','UPDATE']) {
      if (!(await db.query('SELECT has_table_privilege($1,$2) AS ok',[relation,privilege])).rows[0].ok) privileges.push(privilege);
    }
    const defaults = table === 'worker_settings' ? ['enabled','desired_state','runtime_state','updated_at'] : table === 'admin_credentials' ? ['updated_at'] : ['occurred_at','metadata'];
    const defaultsOk = defaults.every(name=>columns.find(c=>c.column_name===name)?.column_default != null);
    const shapeOk = columns.map(c=>`${c.column_name}:${c.udt_name}:${c.is_nullable}`).join(',') === signature;
    const constraintsOk = JSON.stringify(constraints) === JSON.stringify([...expectedConstraints[table]].sort());
    let auditOk = true;
    if (table === 'admin_audit') {
      const seq = (await db.query("SELECT pg_get_serial_sequence($1,'id') AS name",[relation])).rows[0].name;
      const indexes = (await db.query('SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename=$2',['olos_http',table])).rows;
      auditOk = columns[0].is_identity === 'YES' && !!seq && (await db.query("SELECT has_sequence_privilege($1,'USAGE') AS ok",[seq])).rows[0].ok && indexes.some(r=>r.indexdef.endsWith('(source_key, occurred_at DESC)'));
    }
    tables[table] = { status: shapeOk && constraintsOk && defaultsOk && auditOk && !metadata.relrowsecurity && metadata.triggers===0 && !privileges.length ? 'COMPATIBLE' : 'REVIEW_REQUIRED', missing_privileges: privileges };
  }
  const settings = tables.worker_settings.status === 'COMPATIBLE' ? (await db.query('SELECT enabled,interval_ms,desired_state,runtime_state,last_error FROM olos_http.worker_settings WHERE source_key=$1',[cfg.sourceKey])).rows[0] ?? null : null;
  const credentialOverride = tables.admin_credentials.status === 'COMPATIBLE' ? !!(await db.query('SELECT 1 FROM olos_http.admin_credentials WHERE source_key=$1',[cfg.sourceKey])).rowCount : null;
  const schemaCompatible = Object.values(tables).every(t=>t.status==='COMPATIBLE');
  console.log(JSON.stringify({ at:new Date().toISOString(),database,source:cfg.sourceKey,destination:destination.relation,destination_schema_valid:true,
    pending,admin_tables:tables,saved_settings:settings,encrypted_credentials_present:credentialOverride,
    environment_interval_ms:cfg.pollMs,olos_config_complete:[cfg.baseUrl,cfg.username,cfg.password,cfg.clientId,cfg.clientSecret].every(Boolean),
    olos_tls_verify:cfg.tlsVerify,admin_security_configured:Object.fromEntries(['ADMIN_ORIGIN','ADMIN_ENCRYPTION_KEY','ADMIN_OLOS_USERS_JSON'].map(k=>[k,!!process.env[k]])),
    migration_required:Object.values(tables).some(t=>t.status==='MISSING'),schema_compatible:schemaCompatible }));
  await db.query('ROLLBACK');
  if (!schemaCompatible || (process.argv.includes('--idle') && pending.length)) process.exitCode=2;
} catch (error) {
  // No arbitrary messages, database details, URLs, or credential values.
  console.error(JSON.stringify({event:'admin_preflight_failed',code:typeof error?.code==='string'&&/^[A-Z0-9_]+$/.test(error.code)?error.code:'PREFLIGHT_FAILED'}));
  process.exitCode=1;
} finally { await db.end(); }
