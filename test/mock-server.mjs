// Isolated Docker smoke fixture. Never connects to OLOS.
import { createServer } from 'node:http';
let passwordGrants = 0, refreshGrants = 0, reads = 0, generation = 0;
const catalog = [
  { TableName:'AttemptsRawData', Columns:['AttemptsRawDataID','CallId','StartDate','OriginalPhoneNumber','AgentId','CampaignId','DispositionId'] },
  { TableName:'Users', Columns:['AgentId','UserName'] },
  { TableName:'Campaign', Columns:['CampaignId','Description'] },
  { TableName:'Disposition', Columns:['DispositionId','Description'] },
];
createServer(async (req, res) => {
  res.setHeader('content-type','application/json');
  const parts=[]; for await (const part of req) parts.push(part);
  const body=Buffer.concat(parts).toString();
  if(req.url==='/stats') { res.end(JSON.stringify({passwordGrants,refreshGrants,reads})); return; }
  if(req.url.endsWith('/api/auth')) {
    if(body.includes('\r\nrefresh_token\r\n')) {
      if(!body.includes(`\r\nr${generation}\r\n`)){res.writeHead(400);res.end('{}');return;}
      refreshGrants++;
    } else passwordGrants++;
    generation++;
    res.end(JSON.stringify({access_token:`a${generation}`,refresh_token:`r${generation}`,token_type:'bearer',expires_in:0.6}));return;
  }
  if(req.headers.authorization!==`Bearer a${generation}`){res.writeHead(401);res.end('{}');return;}
  if(req.url.endsWith('available-tables'))res.end(JSON.stringify(catalog));
  else if(req.url.endsWith('read-data-current-day')) {
    reads++;res.end(JSON.stringify([{AttemptsRawDataID:'9007199254740993',CallId:'0001',AgentId:'7',CampaignId:'8',DispositionId:'9',OriginalPhoneNumber:'001100000000',StartDate:'2026-10-01T10:00:00.123456-03:00'}]));
  } else if(req.url.endsWith('/read-data')) {
    if(body.includes('\r\nUsers\r\n'))res.end('[{"AgentId":"7","UserName":"Fixture agent","Password":"DO_NOT_STORE_OR_LOG"}]');
    else if(body.includes('\r\nCampaign\r\n'))res.end('[{"CampaignId":"8","Description":"Fixture campaign"}]');
    else res.end('[{"DispositionId":"9","Description":"Fixture disposition"}]');
  } else {res.writeHead(404);res.end('{}');}
}).listen(8080,'0.0.0.0');
