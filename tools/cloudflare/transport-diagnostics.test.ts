import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('reports bounded transport codes while excluding exception and socket secrets', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      new URL('./transport-diagnostics.ts', import.meta.url).href,
      '--input-type=module',
      '--eval',
      `import { channel } from 'node:diagnostics_channel';
       channel('undici:request:error').publish({error:{name:'SocketError',code:'UND_ERR_SOCKET',
         message:'secret-token',stack:'secret-stack',socket:{remoteAddress:'secret-address'},
         cause:{code:'ECONNRESET',message:'secret-cause'}}});
       channel('undici:request:error').publish({error:{name:'https://secret-host',
         code:'secret token',cause:{code:'x'.repeat(65)}}});`,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  expect(result.status).toBe(0);
  expect(result.stderr).toContain('WORKER_TRANSPORT_DIAGNOSTIC_READY');
  const reports = result.stderr
    .trim()
    .split('\n')
    .filter((line) => line.startsWith('WORKER_TRANSPORT_DIAGNOSTIC '))
    .map((line) => JSON.parse(line.slice('WORKER_TRANSPORT_DIAGNOSTIC '.length)));
  expect(reports).toEqual([
    {
      name: 'SocketError',
      code: 'UND_ERR_SOCKET',
      cause: { code: 'ECONNRESET' },
      socketPresent: true,
    },
    { name: null, code: null, cause: { code: null }, socketPresent: false },
  ]);
  expect(result.stdout + result.stderr).not.toContain('secret');
});
