import pg from 'pg';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import { WorkerError, log } from '../errors.js';
import { corporateReportFormat } from './corporate-reports.js';
import { legacyReportFormat } from './report-format.js';

export function reportRuntime(cfg:Config,env:NodeJS.ProcessEnv) {
  const version=env.ADMIN_REPORT_CONTRACT_VERSION??'2';
  if(version==='1')return {format:legacyReportFormat,pool:undefined};
  if(version!=='2')throw new WorkerError('REPORT_CONTRACT_CONFIGURATION_INVALID');
  const connection=cfg.corporateDelivery?.connection;
  const raw=env.ADMIN_REPORT_CORPORATE_DATABASE_URL||connection?.destinationUrl;
  if(!raw)return {format:corporateReportFormat(undefined,'unconfigured'),pool:undefined};
  let url:URL;
  try {
    url=new URL(raw);
    if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||!url.username||url.pathname!=='/madm'||url.search||url.hash)
      throw new Error();
  } catch {throw new WorkerError('REPORT_CORPORATE_CONFIGURATION_INVALID');}
  const caFile=env.ADMIN_REPORT_CORPORATE_CA_FILE||connection?.destinationCa;
  const pool=new pg.Pool({connectionString:url.toString(),max:1,connectionTimeoutMillis:1000,statement_timeout:25000,
    application_name:'olos-report-corporate-reader',ssl:{rejectUnauthorized:true,...(caFile?{ca:readFileSync(caFile,'utf8')}:{})},
    options:'-c default_transaction_read_only=on -c timezone=UTC -c datestyle=ISO,YMD'});
  pool.on('error',()=>log('report_snapshot_failed',{error:'REPORT_CORPORATE_UNAVAILABLE'}));
  const binding=createHash('sha256').update(JSON.stringify([url.hostname,url.port||'5432',url.pathname,'raw.olos_calls'])).digest('hex');
  const existingEndpoint=connection?new URL(connection.destinationUrl):undefined;
  const sameEndpoint=existingEndpoint&&existingEndpoint.hostname===url.hostname&&(existingEndpoint.port||'5432')===(url.port||'5432')&&existingEndpoint.pathname===url.pathname;
  const explicitZone=env.ADMIN_REPORT_TIMESTAMP_ZONE;
  const zone=explicitZone?(env.ADMIN_REPORT_TIMESTAMP_CONFIRMATION===`CONFIRM_TIMESTAMP_${explicitZone}`?explicitZone:undefined):sameEndpoint&&connection?.timestampConfirmed?connection.timestampZone:undefined;
  return {pool,format:corporateReportFormat(pool,binding,zone)};
}
