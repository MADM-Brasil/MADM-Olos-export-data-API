import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,chmod,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { authorization,fingerprint,loadRecoveryManifest,recoveryBinding,recoveryManifest,type RecoveryManifest,type ProgressiveRecoveryManifest } from '../src/read-recovery.js';

const log='[{"TableName":"AttemptsRawData","PKColumnName":"AttemptsRawDataID","DateExport":"2026-11-12T00:00:00",'+
  '"PKIDStart":9007199254740993,"PKIDEnd":9007199254740995,"Quantity":2,"DateRead":"2026-11-12T10:00:00.123"}]';
const manifest=():RecoveryManifest=>({version:1,sourceKey:'synthetic',targetTable:'"raw"."olos_calls"',parentId:'2523225a-a46d-407a-ad5a-d1ff771e576e',
  parentStartedAt:'2026-11-12T13:00:00.000Z',date:'2026-11-12',evidenceRef:'SYNTHETIC-OLOS-TICKET',evidenceSha256:fingerprint(log),
  remoteOperationComplete:true,rereadCursorSafe:true,exactIdsConfirmed:true,
  operation:{start:'9007199254740993',end:'9007199254740995',quantity:'2',dateRead:'2026-11-12T10:00:00.123'},
  ranges:[{start:'9007199254740993',end:'9007199254740995',expectedIds:['9007199254740993','9007199254740995']}]});
test('recovery manifest preserves exact BigInt IDs, sparse membership and stable jsonb authorization',()=>{
  const parsed=recoveryManifest(manifest());assert.deepEqual(parsed,manifest());
  assert.equal(fingerprint(JSON.stringify(parsed)),fingerprint(JSON.stringify(manifest()))); // Preserve the pre-v2 authorization hash domain.
  const cfg=config({DATABASE_URL:'postgresql://unused@localhost/local',OLOS_SOURCE_KEY:'synthetic'});
  const approved={manifest:parsed,hash:fingerprint(JSON.stringify(parsed)),binding:recoveryBinding(cfg)};
  const reorder=(value:unknown):unknown=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'
    ?Object.fromEntries(Object.entries(value).reverse().map(([key,v])=>[key,reorder(v)])):value;
  assert.deepEqual(authorization(reorder(approved),cfg),approved);
  assert.throws(()=>authorization(approved,{...cfg,sourceKey:'other'}),/AUTHORIZATION_CHANGED/);
  assert.throws(()=>authorization(approved,{...cfg,baseUrl:'https://other.invalid'}),/AUTHORIZATION_CHANGED/);
  assert.throws(()=>authorization({...approved,hash:'b'.repeat(64)},cfg),/AUTHORIZATION_CHANGED/);
});
test('recovery rejects missing evidence, invented counts, overlapping ranges and unbounded or malformed IDs',()=>{
  for(const mutate of [
    (m:RecoveryManifest)=>{m.remoteOperationComplete=false as true;},
    (m:RecoveryManifest)=>{m.rereadCursorSafe=false as true;},
    (m:RecoveryManifest)=>{m.exactIdsConfirmed=false as true;},
    (m:RecoveryManifest)=>{m.date='2026-02-30';},
    (m:RecoveryManifest)=>{m.operation.quantity='3';},
    (m:RecoveryManifest)=>{m.ranges[0]!.expectedIds.reverse();},
    (m:RecoveryManifest)=>{m.ranges[0]!.expectedIds.push('9007199254740995');},
    (m:RecoveryManifest)=>{m.ranges.push({...m.ranges[0]!});},
    (m:RecoveryManifest)=>{m.ranges[0]!.end='9223372036854775808';},
    (m:RecoveryManifest)=>{m.ranges[0]!.expectedIds[0]='09007199254740993';},
    (m:RecoveryManifest)=>{m.ranges[0]!.end='9007199254750993';},
    (m:RecoveryManifest)=>{m.ranges[0]!.expectedIds=[];},
  ]){const m=manifest();mutate(m);assert.throws(()=>recoveryManifest(m));}
  assert.throws(()=>recoveryManifest({...manifest(),payload:'PRIVATE'}),/MANIFEST_INVALID/);
});
test('administrative authorization requires private hash-bound files and a matching official log',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'olos-recovery-')),mp=join(dir,'manifest.json'),ep=join(dir,'official-log.json');
  try{
    const m=manifest(),raw=JSON.stringify(m);
    await writeFile(mp,raw,{mode:0o600});await writeFile(ep,log,{mode:0o600});
    await assert.rejects(loadRecoveryManifest(mp,ep,fingerprint(raw),undefined),/NOT_AUTHORIZED/);
    const confirm='AUTHORIZE_EXPORTDATA_REREAD_RECOVERY';
    assert.deepEqual(await loadRecoveryManifest(mp,ep,fingerprint(raw),confirm),m);
    await assert.rejects(loadRecoveryManifest(mp,ep,'b'.repeat(64),confirm),/EVIDENCE_CHANGED/);
    await chmod(mp,0o644);await assert.rejects(loadRecoveryManifest(mp,ep,fingerprint(raw),confirm),/PRIVATE_FILE_REQUIRED/);await chmod(mp,0o600);
    await writeFile(ep,'[]');await assert.rejects(loadRecoveryManifest(mp,ep,fingerprint(raw),confirm),/EVIDENCE_CHANGED/);
    m.evidenceSha256=fingerprint('[]');const changed=JSON.stringify(m);await writeFile(mp,changed);
    await assert.rejects(loadRecoveryManifest(mp,ep,fingerprint(changed),confirm),/OFFICIAL_LOG_MISMATCH/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('manual rereads have an independent bounded response budget without increasing normal capture limits',()=>{
  const env={DATABASE_URL:'postgresql://unused@localhost/local',OLOS_SOURCE_KEY:'synthetic'};
  assert.equal(config(env).maxResponseBytes,32*1024*1024);assert.equal(config(env).recoveryMaxResponseBytes,8*1024*1024);
  for(const value of ['0','-1','NaN','8388609','33554432'])assert.throws(()=>config({...env,RECOVERY_MAX_RESPONSE_BYTES:value}),/CONFIG_INVALID_RECOVERY_MAX_RESPONSE_BYTES/);
});

function progressive():ProgressiveRecoveryManifest {
  const {remoteOperationComplete,rereadCursorSafe,exactIdsConfirmed,ranges,...base}=manifest();
  return {...base,version:2,mode:'progressive',documentationRef:'ExportDataV3-v1.1.0/re-read-data',ranges:ranges.map(({start,end})=>({start,end}))};
}
test('progressive authorization records bounds and documentation without claiming unknown individual IDs or cursor guarantees',async()=>{
  const p=progressive(),parsed=recoveryManifest(p);assert.deepEqual(parsed,p);
  assert(!('remoteOperationComplete' in parsed));assert(!('rereadCursorSafe' in parsed));assert(!('exactIdsConfirmed' in parsed));
  assert(!('expectedIds' in parsed.ranges[0]!));
  for(const field of ['remoteOperationComplete','rereadCursorSafe','exactIdsConfirmed'])assert.throws(()=>recoveryManifest({...p,[field]:true}),/MANIFEST_INVALID/);
  const dir=await mkdtemp(join(tmpdir(),'olos-progressive-')),mp=join(dir,'manifest.json'),ep=join(dir,'official-log.json');
  try{
    const raw=JSON.stringify(p);await writeFile(mp,raw,{mode:0o600});await writeFile(ep,log,{mode:0o600});
    assert.deepEqual(await loadRecoveryManifest(mp,ep,fingerprint(raw),'AUTHORIZE_EXPORTDATA_REREAD_RECOVERY'),p);
    p.operation.quantity='3';const changed=JSON.stringify(p);await writeFile(mp,changed);
    await assert.rejects(loadRecoveryManifest(mp,ep,fingerprint(changed),'AUTHORIZE_EXPORTDATA_REREAD_RECOVERY'),/OFFICIAL_LOG_MISMATCH/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('the reported 39150-position domain can be partitioned into small blocks without generating expected IDs',()=>{
  const p=progressive();p.operation={start:'51698102',end:'51737251',quantity:'39150',dateRead:p.operation.dateRead};p.ranges=[];
  for(let start=51698102n;start<=51737251n;start+=100n)p.ranges.push({start:String(start),end:String(start+99n>51737251n?51737251n:start+99n)});
  const parsed=recoveryManifest(p);assert.equal(parsed.ranges.length,392);assert.deepEqual(parsed.ranges.at(-1),{start:'51737202',end:'51737251'});
  assert(parsed.ranges.every(range=>!('expectedIds' in range)));
  assert.throws(()=>recoveryManifest({...p,ranges:p.ranges.slice(1)}),/EVIDENCE_COVERAGE_MISMATCH/);
  assert.throws(()=>recoveryManifest({...p,ranges:[p.ranges[0],...p.ranges.slice(2)]}),/MANIFEST_INVALID/);
});
