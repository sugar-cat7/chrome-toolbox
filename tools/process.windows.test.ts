import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { spawnOwned, stopTree } from './process.ts';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn<(...args: unknown[]) => ProcessFixture>(),
  spawnSync: vi.fn<(...args: unknown[]) => never>(),
}));
vi.mock('node:child_process', () => mocks);

class ProcessFixture extends EventEmitter {
  pid = 123;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn<(signal: NodeJS.Signals) => boolean>((signal: NodeJS.Signals) => {
    this.signalCode = signal;
    this.emit('exit', null, signal);
    return true;
  });
  close(code: number) {
    this.exitCode = code;
    this.emit('exit', code, null);
    this.emit('close', code, null);
  }
}

function start() {
  const realProcess = process;
  vi.stubGlobal(
    'process',
    new Proxy(realProcess, {
      get(target, key) {
        return key === 'platform' ? 'win32' : Reflect.get(target, key);
      },
    }),
  );
  const guardian = new ProcessFixture();
  const launcher = new ProcessFixture();
  mocks.spawn.mockReturnValueOnce(guardian).mockReturnValueOnce(launcher);
  const child = spawnOwned('node.exe', ['fixture.js']);
  return { guardian, launcher, child };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  mocks.spawn.mockReset();
});

it('waits for recorded host close after a successful Windows Job acknowledgement', async () => {
  const { guardian, launcher, child } = start();
  let settled = false;
  const cleanup = stopTree(child).then(() => {
    settled = true;
  });
  guardian.stdout.write('STOP');
  guardian.stdout.write('PED\n');
  guardian.close(0);
  await nextTurn();
  expect(settled).toBe(false);
  expect(launcher.kill).toHaveBeenCalledWith('SIGKILL');
  launcher.emit('close', null, 'SIGKILL');
  await cleanup;
  expect(settled).toBe(true);
});

it('terminates the host promptly on guard failure and waits for its close before rejecting', async () => {
  const { guardian, launcher, child } = start();
  guardian.close(1);
  await nextTurn();
  expect(launcher.kill).toHaveBeenCalledWith('SIGKILL');
  let settled = false;
  const cleanup = stopTree(child).then(
    () => {
      settled = true;
      return null;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  await nextTurn();
  expect(launcher.kill).toHaveBeenCalledWith('SIGKILL');
  expect(settled).toBe(false);
  launcher.emit('close', null, 'SIGKILL');
  expect(await cleanup).toEqual(new Error('Owned Windows Job guard failed to confirm termination'));
});

it('records both process closes even when they precede the cleanup call', async () => {
  const { guardian, launcher, child } = start();
  launcher.kill('SIGTERM');
  launcher.emit('close', null, 'SIGTERM');
  guardian.stdout.write('STOPPED\n');
  guardian.close(0);
  await nextTurn();
  await stopTree(child);
  expect(launcher.kill).toHaveBeenCalledTimes(1);
});

it('shares concurrent stop requests while signal flags have not arrived', async () => {
  const { guardian, launcher, child } = start();
  launcher.kill.mockImplementationOnce(() => true).mockImplementation(() => false);
  const first = stopTree(child);
  const second = stopTree(child);
  await nextTurn();
  expect(launcher.kill).toHaveBeenCalledTimes(1);
  guardian.stdout.write('STOPPED\n');
  guardian.close(0);
  launcher.close(1);
  await Promise.all([first, second]);
  expect(launcher.kill).toHaveBeenCalledTimes(1);
});

it('uses the independent guard barrier when a native exit precedes Node signal flags', async () => {
  const { guardian, launcher, child } = start();
  launcher.kill.mockImplementation(() => false);
  let control = '';
  guardian.stdin.on('data', (chunk: Buffer) => {
    control += chunk.toString();
  });
  let settled = false;
  const cleanup = stopTree(child).then(() => {
    settled = true;
  });
  await nextTurn();
  expect(control).toBe('STOP\n');
  expect(settled).toBe(false);
  guardian.stdout.write('STOPPED\n');
  guardian.close(0);
  launcher.close(1);
  await cleanup;
  expect(settled).toBe(true);
});

it.each([
  { code: 0, ack: false },
  { code: 1, ack: true },
])('requires both successful guard exit and acknowledgement: %j', async ({ code, ack }) => {
  const { guardian, launcher, child } = start();
  const cleanup = stopTree(child).then(
    () => null,
    (error: unknown) => error,
  );
  if (ack) guardian.stdout.write('STOPPED\n');
  guardian.close(code);
  launcher.close(1);
  expect(await cleanup).toEqual(new Error('Owned Windows Job guard failed to confirm termination'));
});

it('fails its existing deadline and terminates only the two owned hosts', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { guardian, launcher, child } = start();
  const unrelated = new ProcessFixture();
  const cleanup = stopTree(child).then(
    () => null,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(10000);
  expect(await cleanup).toEqual(new Error('Owned Windows Job cleanup timeout'));
  expect(guardian.kill).toHaveBeenCalledWith('SIGKILL');
  expect(launcher.kill).toHaveBeenCalledTimes(1);
  expect(unrelated.kill).not.toHaveBeenCalled();
  guardian.close(1);
  launcher.close(1);
});

it('requests guard cleanup when launcher spawning throws synchronously', async () => {
  const realProcess = process;
  vi.stubGlobal(
    'process',
    new Proxy(realProcess, {
      get(target, key) {
        return key === 'platform' ? 'win32' : Reflect.get(target, key);
      },
    }),
  );
  const guardian = new ProcessFixture();
  let control = '';
  guardian.stdin.on('data', (chunk: Buffer) => {
    control += chunk.toString();
  });
  mocks.spawn.mockReturnValueOnce(guardian).mockImplementationOnce(() => {
    throw new Error('fixture spawn failure');
  });
  expect(() => spawnOwned('node.exe', [])).toThrow('fixture spawn failure');
  expect(control).toBe('STOP\n');
  guardian.stdout.write('STOPPED\n');
  guardian.close(0);
  await nextTurn();
});
