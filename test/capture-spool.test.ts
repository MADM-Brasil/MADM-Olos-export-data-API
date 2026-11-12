import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { captureToDisk,assertCaptureCapacity } from '../src/capture-spool.js';

async function* chunks(parts: string[]) {
  for (const part of parts) {
    yield Buffer.from(part);
  }
}

test('recusa iniciar captura sem capacidade para o limite configurado',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'olos-spool-capacity-'));
  try{await assertCaptureCapacity(dir,1024);await assert.rejects(assertCaptureCapacity(dir,Number.MAX_SAFE_INTEGER),/CAPTURE_DISK_CAPACITY/);}
  finally{await rm(dir,{recursive:true,force:true});}
});

test('persiste resposta completa com hash correto', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'olos-spool-'));

  try {
    const id = randomUUID();

    const result = await captureToDisk(
      chunks(['[', '{"id":1}', ']']),
      dir,
      id,
      1024
    );

    const content = await readFile(result.path);

    assert.equal(content.toString(), '[{"id":1}]');
    assert.equal(result.bytes, content.length);

    assert.equal(
      result.sha256,
      createHash('sha256').update(content).digest('hex')
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejeita resposta maior que o limite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'olos-spool-'));

  try {
    const id = randomUUID();

    await assert.rejects(
      captureToDisk(chunks(['12345', '67890']), dir, id, 8),
      /RESPONSE_TOO_LARGE/
    );

    const files = await readdir(dir);

    assert.equal(
      files.some(f => f === `${id}.json`),
      false
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('nao sobrescreve uma captura existente', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'olos-spool-'));

  try {
    const id = randomUUID();

    await captureToDisk(chunks(['original']), dir, id, 1024);

    await assert.rejects(
      captureToDisk(chunks(['alterado']), dir, id, 1024),
      /CAPTURE_ALREADY_EXISTS/
    );

    const content = await readFile(join(dir, `${id}.json`));

    assert.equal(content.toString(), 'original');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('interrupcao nao publica resposta incompleta', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'olos-spool-'));

  async function* interrupted() {
    yield Buffer.from('parcial');
    throw new Error('DOWNLOAD_INTERRUPTED');
  }

  try {
    const id = randomUUID();

    await assert.rejects(
      captureToDisk(interrupted(), dir, id, 1024),
      /DOWNLOAD_INTERRUPTED/
    );

    const files = await readdir(dir);

    assert.equal(files.includes(`${id}.json`), false);
    assert.equal(files.some(f => f.endsWith('.partial')), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('recebe 64 MiB por streaming com integridade', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'olos-large-'));

  async function* largeBody() {
    const chunk = Buffer.alloc(1024 * 1024, 65);

    for (let i = 0; i < 64; i++) {
      yield chunk;
    }
  }

  try {
    const result = await captureToDisk(
      largeBody(),
      dir,
      randomUUID(),
      128 * 1024 * 1024
    );

    assert.equal(result.bytes, 64 * 1024 * 1024);

    const expected = createHash('sha256');
    const chunk = Buffer.alloc(1024 * 1024, 65);

    for (let i = 0; i < 64; i++) {
      expected.update(chunk);
    }

    assert.equal(result.sha256, expected.digest('hex'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detecta arquivo alterado apos captura', async () => {
  const { verifyCaptureOnDisk } =
    await import('../src/capture-spool.js');

  const { writeFile } = await import('node:fs/promises');

  const dir = await mkdtemp(join(tmpdir(), 'olos-integrity-'));

  try {
    const result = await captureToDisk(
      chunks(['{"id":123}']),
      dir,
      randomUUID(),
      1024
    );

    await verifyCaptureOnDisk(result);

    await writeFile(result.path, '{"id":999}');

    await assert.rejects(
      verifyCaptureOnDisk(result),
      /CAPTURE_SPOOL_INTEGRITY_FAILURE/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
