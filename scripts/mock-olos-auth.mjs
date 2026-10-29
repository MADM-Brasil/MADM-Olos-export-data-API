// Synthetic credentials only. This simulator never proxies requests to a real OLOS.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
export function createMockAuthServer() {
  const stats={auth_requests:0,non_auth_requests:0};
  const server=createServer(async(req,res)=>{
    if(req.url==='/mock-stats'&&req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(stats));return;}
    if(req.url!=='/WebApiExportData/api/auth'||req.method!=='POST'){stats.non_auth_requests++;res.writeHead(403);res.end('{}');return;}
    stats.auth_requests++;
    const chunks=[];let size=0;
    for await(const part of req){size+=part.length;if(size>16384){res.writeHead(413);res.end();return;}chunks.push(part);}
    const body=Buffer.concat(chunks).toString();
    const field=name=>body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r\\n]*)`))?.[1];
    if(!req.headers['content-type']?.startsWith('multipart/form-data')||field('client_id')!=='homolog-client'||field('client_secret')!=='homolog-client-secret'||
      field('grant_type')!=='password'||!['homolog-admin','homolog-visitor'].includes(field('username'))||field('password')!=='homolog-password'){
      res.writeHead(401);res.end('{"error":"invalid_grant"}');return;
    }
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({access_token:`PRIVATE_MOCK_TOKEN_${stats.auth_requests}`,refresh_token:'PRIVATE_MOCK_REFRESH',token_type:'bearer',expires_in:120}));
  });
  return {server,stats};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const {server}=createMockAuthServer();server.listen(18081,'127.0.0.1',()=>console.log('OLOS auth simulator listening on loopback:18081'));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close());
}
