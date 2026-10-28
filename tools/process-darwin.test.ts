import type { ChildProcess } from 'node:child_process';
import type * as childProcessModule from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { spawnOwned, stopTree } from './process.ts';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn<() => ChildProcess>(),
  spawnSync: vi.fn<() => { status: number | null; stdout: string; error?: Error }>(),
  kill: vi.fn<typeof process.kill>(),
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof childProcessModule>()),
  spawn: mocks.spawn,
  spawnSync: mocks.spawnSync,
}));
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.restoreAllMocks();
  mocks.spawn.mockReset();
  mocks.spawnSync.mockReset();
  mocks.kill.mockReset();
});

function fixture(table: string, errorSignal: NodeJS.Signals | 0 = 0): ChildProcess {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  mocks.spawn.mockReturnValue({ pid: 4242 } as ChildProcess);
  mocks.spawnSync.mockReturnValue({ status: 0, stdout: table });
  mocks.kill.mockImplementation((_pid, signal) => {
    if (signal === errorSignal) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    return true;
  });
  vi.spyOn(process, 'kill').mockImplementation(mocks.kill);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return spawnOwned('fixture', []);
}

it('confirms a zombie-only owned Darwin group while ignoring another live group', async () => {
  const child = fixture(' 4242 4242 Z\n 4243 4242 Z+\n 9000 9000 Ss\n 9001 9000 H\n');
  await stopTree(child);
  expect(mocks.kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
  expect(mocks.kill).not.toHaveBeenCalledWith(-4242, 'SIGKILL');
  expect(mocks.spawnSync).toHaveBeenCalledWith('/bin/ps', ['-A', '-o', 'pid=,pgid=,stat='], {
    encoding: 'utf8',
    timeout: 1_000,
  });
  expect(console.warn).toHaveBeenCalledWith(
    'Stopped Darwin group 4242: ["4242 4242 Z","4243 4242 Z+"]',
  );
});

it('confirms the owned Darwin group disappeared from a complete process table', async () => {
  await stopTree(fixture(' 9000 9000 Ss\n'));
  expect(console.warn).toHaveBeenCalledWith('Stopped Darwin group 4242: []');
});

it('preserves permission failure when the owned group contains a live descendant', async () => {
  await expect(stopTree(fixture('4242 4242 Z\n4243 4242 S\n'))).rejects.toThrow('kill EPERM');
  expect(console.warn).not.toHaveBeenCalled();
});

it.each([
  'malformed row\n',
  '4242 4242 invalid\n',
  '4242 4242 Zebra\n',
  '',
  '4242 999999999999999999999 Z\n',
])('rejects an incomplete process table (%s)', async (table) => {
  await expect(stopTree(fixture(table))).rejects.toThrow('Invalid Darwin process table');
});

it('rejects a failed or timed-out process table command', async () => {
  const child = fixture('');
  mocks.spawnSync.mockReturnValue({ status: null, error: new Error('timeout'), stdout: '' });
  await expect(stopTree(child)).rejects.toThrow('Unable to inspect the owned Darwin process group');
});

it.each(['SIGTERM', 'SIGKILL'] as const)(
  'confirms an already stopped Darwin group after %s returns EPERM',
  async (signal) => {
    await stopTree(fixture('4242 4242 Z\n', signal), 0);
    expect(mocks.kill).toHaveBeenCalledWith(-4242, signal);
    expect(console.warn).toHaveBeenCalledWith('Stopped Darwin group 4242: ["4242 4242 Z"]');
  },
);

it.each(['SIGTERM', 'SIGKILL'] as const)(
  'preserves a Darwin %s permission failure for live descendants',
  async (signal) => {
    await expect(stopTree(fixture('4242 4242 Z\n4243 4242 S\n', signal), 0)).rejects.toThrow(
      'kill EPERM',
    );
    expect(console.warn).not.toHaveBeenCalled();
  },
);

it('does not reinterpret another OS permission failure', async () => {
  const child = fixture('4242 4242 Z\n');
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  await expect(stopTree(child)).rejects.toThrow('kill EPERM');
  expect(mocks.spawnSync).not.toHaveBeenCalled();
});
