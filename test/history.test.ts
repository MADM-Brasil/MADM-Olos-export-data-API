import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OlosApi, readFields } from '../src/api.js';
import { config } from '../src/config.js';
import type { OlosAuthManager } from '../src/auth.js';
import { HttpError, WorkerError } from '../src/errors.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('history utiliza previous-days sem parâmetros de data', async () => {
  const calls: string[] = [];

  const transport = async (path: string) => {
    calls.push(path);
    return '[]';
  };

  const auth = {
    getToken: async () => 'TOKEN_TESTE'
  } as OlosAuthManager;

  const api = new OlosApi(transport, auth);

  const response = await api.read({ kind: 'history' });

  assert.equal(response, '[]');

  assert.deepEqual(calls, [
    '/api/export-data/read-data-previous-days'
  ]);

  assert.deepEqual(
    readFields({ kind: 'history' }),
    { TableName: 'AttemptsRawData' }
  );
});

test('captura histórica exige autorização explícita', () => {
  const base = {
    DATABASE_URL: 'postgresql://unused@127.0.0.1:1/test',
    OLOS_SOURCE_KEY: 'history-test'
  };

  const disabled = config(base);

  assert.equal(disabled.historyCaptureAuthorized, false);

  const enabled = config({
    ...base,
    OLOS_HISTORY_CAPTURE_CONFIRMATION:
      'AUTHORIZE_EXPORTDATA_HISTORY_CAPTURE'
  });

  assert.equal(enabled.historyCaptureAuthorized, true);

  const invalid = config({
    ...base,
    OLOS_HISTORY_CAPTURE_CONFIRMATION: 'INVALID'
  });

  assert.equal(invalid.historyCaptureAuthorized, false);
});

test('history não repete POST nem para 401/429; previous mantém sua política', async () => {
  for (const error of [new HttpError(401),new HttpError(429),new HttpError(500),new WorkerError('NETWORK_OR_RESPONSE_FAILURE',true)]) {
    let requests = 0, waits = 0, invalidations = 0;
    const auth = { getToken: async () => 'synthetic', invalidate: () => { invalidations++; } } as unknown as OlosAuthManager;
    const api = new OlosApi(async () => { requests++; throw error; }, auth, async () => { waits++; });
    await assert.rejects(api.read({ kind: 'history' }));
    assert.equal(requests, 1); assert.equal(waits, 0); assert.equal(invalidations, 0);
  }
  let previous = 0;
  const auth = { getToken: async () => 'synthetic' } as OlosAuthManager;
  const api = new OlosApi(async () => { if (++previous === 1) throw new HttpError(429); return '[]'; }, auth, async () => {});
  assert.equal(await api.read({ kind: 'previous' }), '[]'); assert.equal(previous, 2);
});

test('history revalida a autorização de envio depois de obter o token', async () => {
  const events: string[] = [];
  const auth = { getToken: async () => { events.push('token'); return 'synthetic'; } } as OlosAuthManager;
  const api = new OlosApi(async () => { events.push('POST'); return '[]'; }, auth);
  await assert.rejects(api.read({ kind: 'history' }, async () => { events.push('fence'); throw new Error('lost owner'); }));
  assert.deepEqual(events, ['token','fence']);
});

test('CLI histórico rejeita falta de autorização e parâmetros antes de abrir banco ou HTTP', async () => {
  const execute = promisify(execFile);
  const env = { DATABASE_URL: 'postgresql://synthetic@127.0.0.1:1/unused', OLOS_SOURCE_KEY: 'synthetic' };
  for (const [args, code] of [[['capture-history'],'HISTORY_CAPTURE_NOT_AUTHORIZED'],
    [['capture-history','2026-09-01'],'HISTORY_PARAMETERS_INVALID']] as const) {
    await assert.rejects(execute(process.execPath, ['--import','tsx','src/main.ts',...args], { env, timeout: 10000 }),
      (error: any) => error.code === 1 && error.stdout.includes(code));
  }
});
