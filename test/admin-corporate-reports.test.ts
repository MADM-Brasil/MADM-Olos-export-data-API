import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import type { Config } from '../src/config.js';
import { reportRuntime } from '../src/admin/report-runtime.js';
import { corporateReportFormat,reportRowProof } from '../src/admin/corporate-reports.js';
import { columns, type Row } from '../src/corporate-sync/mapping.js';

test('report runtime defaults to v2 and never falls back to local analytics when corporate configuration is absent',async()=>{
  const cfg={corporateDelivery:undefined} as unknown as Config;
  const runtime=reportRuntime(cfg,{});assert.equal(runtime.format.version,2);assert.equal(runtime.pool,undefined);
  await assert.rejects(runtime.format.collect!({} as never,'source',{schema:'raw',table:'olos_calls'}),/REPORT_CORPORATE_CONFIGURATION_REQUIRED/);
  assert.equal(reportRuntime(cfg,{ADMIN_REPORT_CONTRACT_VERSION:'1'}).format.version,1);
  for(const value of ['0','3','v2'])assert.throws(()=>reportRuntime(cfg,{ADMIN_REPORT_CONTRACT_VERSION:value}),/REPORT_CONTRACT_CONFIGURATION_INVALID/);
  for(const value of ['postgresql://user@host/local','http://host/madm','postgresql://user@host/madm?sslmode=disable'])assert.throws(()=>reportRuntime(cfg,{ADMIN_REPORT_CORPORATE_DATABASE_URL:value}),/REPORT_CORPORATE_CONFIGURATION_INVALID/);
});
test('report-only fingerprints distinguish NULL, empty strings, separators and Unicode without changing payloads',()=>{
  const row=Object.fromEntries(columns.map(c=>[c,null])) as Row;
  const original=JSON.stringify(row),hash=reportRowProof(row);assert.equal(JSON.stringify(row),original);
  const variants=[{...row,cpf:''},{...row,cpf:'N'},{...row,cpf:'2:é'},{...row,nome_agente:'名 \n "é"'},{...row,cpf:'a',email:'bc'},{...row,cpf:'ab',email:'c'}];
  const hashes=variants.map(reportRowProof);assert.equal(new Set([hash,...hashes]).size,hashes.length+1);
});
test('corporate formats stay bound to their source and version, including HTTP readers without a corporate connection',()=>{
  const format=corporateReportFormat(undefined,'source');assert.equal(format.version,2);assert.equal(format.name,'olos-admin-reports/v2');
  for(const data of [null,{},[],{days:[],cpf:'PRIVATE'}])assert.throws(()=>format.validate(data),/REPORT_SNAPSHOT_INVALID/);
  assert.equal(corporateReportFormat({} as Pool,'other').version,2);
});

test('dedicated report pool always verifies TLS, defaults to read only and uses existing corporate endpoint when override is empty',async()=>{
  const cfg={corporateDelivery:{connection:{destinationUrl:'postgresql://readonly@corporate.invalid/madm',timestampConfirmed:false,timestampZone:'America/Sao_Paulo'}}} as unknown as Config;
  const runtime=reportRuntime(cfg,{ADMIN_REPORT_CORPORATE_DATABASE_URL:''});
  try{assert(runtime.pool);assert.equal(runtime.format.version,2);assert.equal(runtime.pool.options.max,1);assert.match(runtime.pool.options.options!,/default_transaction_read_only=on/);assert.equal((runtime.pool.options.ssl as {rejectUnauthorized:boolean}).rejectUnauthorized,true);}
  finally{await runtime.pool?.end();}
});
