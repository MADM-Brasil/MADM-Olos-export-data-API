import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpTransport } from '../src/http.js';

for(const mib of [32,64,128])for(const declared of [false,true])test(`HTTP streaming grava ${mib} MiB (Content-Length=${declared})`, async () => {
  const chunk = Buffer.alloc(1024 * 1024, 65);
  const totalBytes = mib * 1024 * 1024;

  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/capture') {
      res.writeHead(404).end();
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/json',
      ...(declared?{'Content-Length':totalBytes}:{})
    });

    let sent = 0;

    const send = () => {
      while (sent < mib) {
        if (!res.write(chunk)) {
          sent++;
          res.once('drain', send);
          return;
        }
        sent++;
      }
      res.end();
    };

    send();
  });

  const dir = await mkdtemp(join(tmpdir(), 'olos-http-spool-'));

  try {
    server.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));

    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('SERVER_ADDRESS_INVALID');
    }

    const transport = new HttpTransport(
      `http://127.0.0.1:${address.port}`,
      30000,
      128 * 1024 * 1024,
      new AbortController().signal
    );

    try {
      const result = await transport.captureToSpool(
        '/capture',
        { TableName: 'AttemptsRawData' },
        'test-token',
        dir,
        randomUUID(),
        128 * 1024 * 1024,
        30000,
        new AbortController().signal
      );

      assert.equal(result.bytes, totalBytes);
      assert.equal((await stat(result.path)).size, totalBytes);
      assert.match(result.sha256, /^[a-f0-9]{64}$/);
    } finally {
      await transport.close();
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve())
    );
    await rm(dir, { recursive: true, force: true });
  }
});

for(const failure of ['limit-declared','limit-streamed','401','429','500','421','timeout','abort','interrupted'] as const)test(`streamed ${failure} preserves uncertainty and never replays`,async()=>{
  const directory=await mkdtemp(join(tmpdir(),'olos-http-fail-')),id=randomUUID(),abort=new AbortController();let requests=0,entered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const server=createServer(async(req,res)=>{
    for await(const _ of req){ /* one-shot multipart */ }
    requests++;entered();
    if(['401','429','500','421'].includes(failure)){res.writeHead(Number(failure));res.end('PRIVATE provider error');return;}
    if(failure==='timeout'||failure==='abort')return;
    if(failure==='interrupted'){res.writeHead(200,{'Content-Length':1000000});res.write('partial');setImmediate(()=>res.destroy());return;}
    if(failure==='limit-declared')res.writeHead(200,{'Content-Length':2048});else res.writeHead(200);
    res.end('x'.repeat(2048));
  });
  server.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const address=server.address();assert(address&&typeof address!=='string');
  const http=new HttpTransport(`http://127.0.0.1:${address.port}`,1000,1024,abort.signal);
  try{
    const operation=http.captureToSpool('/capture',{TableName:'AttemptsRawData'},'PRIVATE_TOKEN',directory,id,1024,failure==='timeout'?100:1000,abort.signal);
    // Install the rejection observer before awaiting server coordination.
    const rejected=assert.rejects(operation,/RESPONSE_TOO_LARGE|HTTP_401|HTTP_429|HTTP_500|HTTP_421|NETWORK_OR_RESPONSE_FAILURE/);
    if(failure==='abort'){await started;abort.abort();}
    await rejected;assert.equal(requests,1);
    const files=await readdir(directory);assert(!files.includes(`${id}.json.complete`));assert(!files.includes(`${id}.json`));
  }finally{await http.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});
