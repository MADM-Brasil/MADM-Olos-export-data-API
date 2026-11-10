// Service-only RSS: parent generates HTTP traffic and holds the SQL oracle.
import pg from 'pg';
import { AdminReports } from '../../src/admin/reports.js';
import { ReportUpdater } from '../../src/admin/report-updater.js';
import { reportHttp } from './report-http.js';
await import('../../src/admin/main.js'); // Load the actual service dependency graph, never start OLOS.
const url=process.env.TEST_DATABASE_URL;
if(!url||new URL(url).hostname!=='127.0.0.1'||new URL(url).pathname!=='/olos_admin_reports_test'||!process.send)throw new Error('Disposable IPC benchmark required');
const u=new URL(url);u.username='snapshot_bench_http';
const writer=new pg.Pool({connectionString:url,max:1,connectionTimeoutMillis:1000,statement_timeout:5000}),http=new pg.Pool({connectionString:u.toString(),max:1,connectionTimeoutMillis:1000,statement_timeout:5000});
writer.on('error',()=>{});http.on('error',()=>{});
const updater=new ReportUpdater(writer,'perf',{schema:'raw',table:'olos_calls'}),server=await reportHttp(new AdminReports(http,'perf',{schema:'raw',table:'olos_calls'}));
let start!:()=>void,stop!:(requests:number)=>void;
const started=new Promise<void>(r=>{start=r;}),stopped=new Promise<number>(r=>{stop=r;});
process.on('message',(value:unknown)=>{const message=value as {type:string;requests:number};if(message.type==='start')start();if(message.type==='stop')stop(message.requests);});
let peak=process.memoryUsage().rss,refreshMs=0;const timer=setInterval(()=>{peak=Math.max(peak,process.memoryUsage().rss);},10);timer.unref();
process.send({type:'ready',url:server.url,cookie:server.cookie,origin:server.origin});
try{
 await started;await writer.query("UPDATE olos_http.report_snapshot_state SET next_attempt_at='-infinity' WHERE source_key='perf'");
 const at=performance.now(),refresh=updater.refreshOnce().then(result=>{refreshMs=performance.now()-at;if(result.state!=='published')throw new Error('REFRESH_FAILED');});
 const requests=await stopped;await refresh;peak=Math.max(peak,process.memoryUsage().rss);
 process.send({type:'stats',stats:{peak_rss_mib:peak/1048576,refresh_with_http_ms:refreshMs,requests,limit_mib:256,baseline:'Actual managed-admin dependencies, reader and updater; no oracle or HTTP traffic clients'}});
}catch(error){process.send({type:'failure',error:error instanceof Error?error.message:'SERVICE_FAILED'});process.exitCode=1;}
finally{clearInterval(timer);await server.close();await updater.stop();await writer.end();await http.end();process.disconnect();}
