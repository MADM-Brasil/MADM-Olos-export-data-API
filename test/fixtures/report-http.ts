// Synthetic local HTTP transport. No OLOS, scheduler, credential or corporate connection.
import { once } from 'node:events';
import { resolve } from 'node:path';
import { adminServer } from '../../src/admin/server.js';
import { AdminAuth } from '../../src/admin/security.js';
import type { CredentialService } from '../../src/admin/credentials.js';
import type { AdminReports } from '../../src/admin/reports.js';
export async function reportHttp(reader:AdminReports) {
  const origin='http://localhost:8089';
  const repository={reports:(from:unknown,to:unknown)=>reader.read(from,to),today:()=>reader.today(),logs:async()=>[],auditLog:async()=>[],observation:async()=>({})} as unknown as Parameters<typeof adminServer>[0]['repository'];
  const scheduler={} as Parameters<typeof adminServer>[0]['scheduler'];
  const server=adminServer({origin,publicDir:resolve('admin/public'),auth:new AdminAuth(['synthetic-benchmark'],async()=>{},async()=>{}),
    credentials:{} as CredentialService,scheduler,repository});
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('listen');
  const url=`http://127.0.0.1:${address.port}`;
  const denied=await fetch(url+'/api/reports?from=2026-11-10&to=2026-11-10');if(denied.status!==401)throw new Error('Authentication required');await denied.arrayBuffer();
  const login=await fetch(url+'/api/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:'synthetic-benchmark',password:'synthetic'})});
  if(login.status!==200)throw new Error('login');const cookie=login.headers.get('set-cookie')!.split(';')[0]!;await login.arrayBuffer();
  return {url,cookie,origin,async request(path:string){const start=performance.now();const response=await fetch(url+path,{headers:{Cookie:cookie,Origin:origin}});const data=await response.json() as Record<string,unknown>;return {status:response.status,data,ms:performance.now()-start};},
    async close(){server.closeIdleConnections();await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));}};
}
