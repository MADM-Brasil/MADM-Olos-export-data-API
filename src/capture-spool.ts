import { basename, dirname, isAbsolute,resolve } from 'node:path';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir, open, link, unlink, lstat,readFile,statfs,
} from 'node:fs/promises';
import { join } from 'node:path';
import { WorkerError } from './errors.js';

export interface CaptureResult {
  path: string;
  bytes: number;
  sha256: string;
}
export async function assertCaptureCapacity(directory:string,maxBytes:number):Promise<void>{
  const fs=await statfs(directory,{bigint:true});
  if(fs.bavail*fs.bsize<BigInt(maxBytes)+16n*1024n*1024n)throw new WorkerError('CAPTURE_DISK_CAPACITY');
}
export async function syncCaptureDirectory(directory:string):Promise<void> {
  const dir=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{await dir.sync();}finally{await dir.close();}
}
export async function prepareCaptureDirectory(directory:string,requireMount=false):Promise<void> {
  if(!isAbsolute(directory)||directory!==resolve(directory)||directory==='/'||/^\/(proc|sys|dev)(\/|$)/.test(directory))throw new WorkerError('CAPTURE_DIRECTORY_INVALID');
  for(let path=directory;;path=dirname(path)){
    try{if((await lstat(path)).isSymbolicLink())throw new WorkerError('CAPTURE_DIRECTORY_INVALID');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(path==='/')break;
  }
  if(requireMount){
    const mounts=(await readFile('/proc/self/mountinfo','utf8')).split('\n');
    const mounted=mounts.some(line=>{
      const [entry,filesystem]=line.split(' - '),point=entry?.split(' ')[4]?.replace(/\\([0-7]{3})/g,(_,octal:string)=>String.fromCharCode(parseInt(octal,8)));
      return point===directory&&!!filesystem&&!/^(tmpfs|ramfs) /.test(filesystem)&&entry?.split(' ')[5]?.split(',').includes('rw');
    });
    if(!mounted)throw new WorkerError('CAPTURE_SPOOL_MOUNT_REQUIRED');
  }
  await mkdir(directory,{recursive:true,mode:0o700});
  const stat=await lstat(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.())throw new WorkerError('CAPTURE_DIRECTORY_INVALID');
  const probe=join(directory,`.probe-${randomUUID()}`),file=await open(probe,'wx',0o600);
  try{await file.sync();}finally{await file.close();await unlink(probe);}
  await syncCaptureDirectory(directory);
}

async function receipt(capture:CaptureResult):Promise<void> {
  const path=capture.path+'.complete',file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const stat=await file.stat();
    if(!stat.isFile()||stat.size>1024||(stat.mode&0o077)!==0)throw new WorkerError('CAPTURE_SPOOL_INVALID');
    const value:unknown=JSON.parse(await file.readFile('utf8'));
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='bytes,file,sha256,version')throw new WorkerError('CAPTURE_SPOOL_INVALID');
    const r=value as Record<string,unknown>;
    if(r.version!==1||r.file!==basename(capture.path)||r.bytes!==capture.bytes||r.sha256!==capture.sha256)throw new WorkerError('CAPTURE_SPOOL_INTEGRITY_FAILURE');
  }finally{await file.close();}
}

export async function captureToDisk(
  body: AsyncIterable<Uint8Array>,
  directory: string,
  readId: string,
  maxBytes: number
): Promise<CaptureResult> {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(readId)) {
    throw new WorkerError('CAPTURE_ID_INVALID');
  }

  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new WorkerError('CAPTURE_LIMIT_INVALID');
  }

  await prepareCaptureDirectory(directory);

  const temp = join(directory, `${readId}.${randomUUID()}.partial`);
  const destination = join(directory, `${readId}.json`);

  const file = await open(temp, 'wx', 0o600);
  const hash = createHash('sha256');

  let bytes = 0;
  let completed = false;

  try {
    for await (const chunk of body) {
      bytes += chunk.byteLength;

      if (bytes > maxBytes) {
        throw new WorkerError('RESPONSE_TOO_LARGE');
      }

      hash.update(chunk);

      let offset = 0;
      while (offset < chunk.byteLength) {
        const result = await file.write(
          chunk,
          offset,
          chunk.byteLength - offset
        );

        if (result.bytesWritten <= 0) {
          throw new WorkerError('CAPTURE_WRITE_FAILED');
        }

        offset += result.bytesWritten;
      }
    }

    await file.sync();

    const sha256 = hash.digest('hex');
    await file.close();

    // Publicar exclusivamente: nunca substituir captura existente.
    try {
      await link(temp, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new WorkerError('CAPTURE_ALREADY_EXISTS');
      }
      throw error;
    }

    // Sincronizar a entrada do arquivo no diretório.
    await syncCaptureDirectory(directory);
    // Completion receipt is published last. A .json without this receipt is not adoptable.
    const receiptTemp=temp+'.receipt';
    const manifest=await open(receiptTemp,'wx',0o600);
    try{await manifest.writeFile(JSON.stringify({version:1,file:basename(destination),bytes,sha256}));await manifest.sync();}finally{await manifest.close();}
    await link(receiptTemp,destination+'.complete');
    await syncCaptureDirectory(directory);

    await unlink(temp);
    await unlink(receiptTemp);
    await syncCaptureDirectory(directory);

    completed = true;

    return {
      path: destination,
      bytes,
      sha256
    };
  } finally {
    await file.close().catch(() => {});

    if (!completed) {
      // Preservar evidência parcial para diagnóstico.
      // A limpeza será feita somente após reconciliação.
    }
  }
}


export async function verifyCaptureOnDisk(
  capture: CaptureResult
): Promise<void> {
  if (
    !Number.isSafeInteger(capture.bytes) ||
    capture.bytes < 0 ||
    !/^[a-f0-9]{64}$/.test(capture.sha256) ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.json$/.test(basename(capture.path))
  ) {
    throw new WorkerError('CAPTURE_SPOOL_INVALID');
  }

  try {
    await receipt(capture);
    const file=await openCaptureFile(capture.path);
    try{
      const hash=createHash('sha256');let bytes=0;
      for await(const chunk of file.createReadStream({autoClose:false})){bytes+=chunk.length;if(bytes>capture.bytes)throw new WorkerError('CAPTURE_SPOOL_INTEGRITY_FAILURE');hash.update(chunk);}
      if(bytes!==capture.bytes||hash.digest('hex')!==capture.sha256)throw new WorkerError('CAPTURE_SPOOL_INTEGRITY_FAILURE');
    }finally{await file.close();}
  } catch (error) {
    if (error instanceof WorkerError) throw error;
    throw new WorkerError('CAPTURE_SPOOL_INTEGRITY_FAILURE');
  }

}

export async function openCaptureFile(path:string) {
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  const stat=await file.stat();
  if(!stat.isFile()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.()){
    await file.close();throw new WorkerError('CAPTURE_SPOOL_INVALID');
  }
  return file;
}

export async function publishedCapture(directory:string,readId:string,maxBytes:number):Promise<CaptureResult> {
  if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(readId))throw new WorkerError('CAPTURE_ID_INVALID');
  const path=join(directory,`${readId}.json`),file=await open(path+'.complete',constants.O_RDONLY|constants.O_NOFOLLOW);
  let capture:CaptureResult;
  try{
    const stat=await file.stat();if(!stat.isFile()||stat.size>1024)throw new WorkerError('CAPTURE_SPOOL_INVALID');
    const r:unknown=JSON.parse(await file.readFile('utf8'));
    if(!r||typeof r!=='object'||!('bytes' in r)||!('sha256' in r)||typeof r.bytes!=='number'||typeof r.sha256!=='string'||r.bytes>maxBytes)throw new WorkerError('CAPTURE_SPOOL_INVALID');
    capture={path,bytes:r.bytes,sha256:r.sha256};
  }finally{await file.close();}
  await verifyCaptureOnDisk(capture);
  const data=await openCaptureFile(path);try{await data.sync();}finally{await data.close();}
  await syncCaptureDirectory(dirname(path));
  return capture;
}
