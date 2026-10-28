import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import type { ChildProcess } from 'node:child_process';
import { expect, it } from 'vitest';
import { run, spawnOwned, stopTree } from './process.ts';

it.each(['ignore', 'inherit'])(
  'waits for directly interrupted descendants with %s streams before returning cleanup',
  async (stdio) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'owned-direct-exit-'));
    const address = path.join(root, 'address');
    const server = path.join(root, 'server.mjs');
    const parent = path.join(root, 'parent.mjs');
    writeFileSync(
      server,
      "import {createServer} from 'node:http';import{writeFileSync,renameSync}from'node:fs';process.on('SIGTERM',()=>{});const server=createServer((_,res)=>res.end('ready'));server.listen(0,'127.0.0.1',()=>{writeFileSync(process.argv[2]+'.tmp',JSON.stringify({origin:'http://127.0.0.1:'+server.address().port,pid:process.pid}));renameSync(process.argv[2]+'.tmp',process.argv[2])}); ",
    );
    writeFileSync(
      parent,
      "import {spawn}from'node:child_process';spawn(process.execPath,[process.argv[2],process.argv[3]],{stdio:process.argv[4]});setInterval(()=>{},1000);",
    );
    const child = spawnOwned(process.execPath, [parent, server, address, stdio], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.resume();
    child.stderr?.resume();
    try {
      const deadline = performance.now() + 10000;
      while (!existsSync(address) && performance.now() < deadline) await pause(30);
      expect(existsSync(address)).toBe(true);
      const { origin, pid } = JSON.parse(readFileSync(address, 'utf8')) as {
        origin: string;
        pid: number;
      };
      expect(await (await fetch(origin)).text()).toBe('ready');
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      expect(child.kill('SIGTERM')).toBe(true);
      await exited;
      await stopTree(child, 0);
      await expect(fetch(origin, { signal: AbortSignal.timeout(1000) })).rejects.toThrow(
        /fetch failed|aborted/iu,
      );
      // A terminated Windows process cannot retain handles in this owned fixture.
      if (process.platform === 'win32') assert.throws(() => process.kill(pid, 0), /ESRCH/u);
      rmSync(root, { recursive: true, force: true });
      expect(existsSync(root)).toBe(false);
    } finally {
      await stopTree(child, 0);
      rmSync(root, { recursive: true, force: true });
    }
  },
  20000,
);

it('forwards Worker build interruption to its detached non-cooperating child', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'owned-build-'));
  const executor = path.join(root, 'executor.mjs');
  const address = path.join(root, 'address');
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'build-interruption-fixture', private: true, type: 'module' }),
  );
  writeFileSync(
    executor,
    "import {createServer} from 'node:http'; import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{}); const server=createServer((_,res)=>res.end('ready')); server.listen(0,'127.0.0.1',()=>writeFileSync(process.env.BUILD_ADDRESS,'http://127.0.0.1:'+server.address().port));",
  );
  const child = spawnOwned(
    process.execPath,
    [fileURLToPath(new URL('./cloudflare/build.ts', import.meta.url))],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'npm_execpath'),
        ),
        npm_execpath: executor,
        BUILD_ADDRESS: address,
      },
    },
  );
  let output = `npm_execpath key spellings: ${Object.keys(process.env)
    .filter((key) => key.toLowerCase() === 'npm_execpath')
    .join(', ')}; expected fixture executor: ${executor}\n`;
  const record = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-16_000);
  };
  child.stdout?.on('data', record);
  child.stderr?.on('data', record);
  try {
    const started = performance.now();
    while (!existsSync(address) && performance.now() - started < 10_000) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          `Build fixture exited before ready: exit ${child.exitCode}, signal ${child.signalCode}\n${output}`,
        );
      await pause(30);
    }
    if (!existsSync(address)) throw new Error(`Build fixture readiness timeout:\n${output}`);
    expect(existsSync(address)).toBe(true);
    const origin = readFileSync(address, 'utf8');
    expect(await (await fetch(origin)).text()).toBe('ready');
    expect(child.kill('SIGTERM')).toBe(true);
    while (
      child.exitCode === null &&
      child.signalCode === null &&
      performance.now() - started < 13_000
    )
      await pause(30);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(child.exitCode === 0).toBe(false);
    expect({ code: child.exitCode, signal: child.signalCode }).toEqual(
      process.platform === 'win32' ? { code: null, signal: 'SIGTERM' } : { code: 1, signal: null },
    );
    // Windows launcher exit precedes the owned Job acknowledgement. POSIX
    // still verifies the build wrapper's own awaited interruption cleanup.
    if (process.platform === 'win32') await stopTree(child, 0);
    await expect(fetch(origin, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow(
      /fetch failed|aborted/iu,
    );
  } finally {
    await stopTree(child);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

it('cleans an orphaned descendant while preserving an unrelated server', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'owned-process-'));
  const server = path.join(root, 'server.mjs');
  const intermediate = path.join(root, 'intermediate.mjs');
  const parent = path.join(root, 'parent.mjs');
  const children: ChildProcess[] = [];
  writeFileSync(
    server,
    "import {createServer} from 'node:http'; const server=createServer((_,res)=>res.end('ready')); server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port));",
  );
  writeFileSync(
    intermediate,
    "import {spawn} from 'node:child_process'; const child=spawn(process.execPath,[process.argv[2]],{stdio:['ignore','inherit','inherit'],detached:process.platform==='win32'}); child.unref(); setTimeout(()=>process.exit(0),200);",
  );
  writeFileSync(
    parent,
    "import {spawn} from 'node:child_process'; const child=spawn(process.execPath,[process.argv[2],process.argv[3]],{stdio:['ignore','inherit','inherit']}); child.on('exit',()=>console.log('INTERMEDIATE_EXITED')); setInterval(()=>{},1000);",
  );
  const start = async (
    args: string[],
    waitForExit = false,
  ): Promise<{ child: ChildProcess; origin: string }> => {
    const child = spawnOwned(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const started = performance.now();
    while (
      (!/http:\/\/127\.0\.0\.1:\d+/u.test(output) ||
        (waitForExit && !output.includes('INTERMEDIATE_EXITED'))) &&
      performance.now() - started < 15000
    ) {
      if (child.exitCode !== null) throw new Error(`Process exited before ready: ${output}`);
      await pause(30);
    }
    const origin = /http:\/\/127\.0\.0\.1:\d+/u.exec(output)?.[0];
    if (!origin || (waitForExit && !output.includes('INTERMEDIATE_EXITED')))
      throw new Error(`Process readiness timeout: ${output}`);
    return { child, origin };
  };
  try {
    const sentinel = await start([server]);
    const orphan = await start([parent, intermediate, server], true);
    expect(await (await fetch(orphan.origin)).text()).toBe('ready');
    await stopTree(orphan.child);
    await expect(fetch(orphan.origin, { signal: AbortSignal.timeout(1000) })).rejects.toThrow(
      /fetch failed|aborted/iu,
    );
    expect(await (await fetch(sentinel.origin)).text()).toBe('ready');
  } finally {
    await Promise.all(children.map((child) => stopTree(child)));
    rmSync(root, { recursive: true, force: true });
  }
}, 40000);

it.each(['ignore', 'inherit'])(
  'reclaims descendants with %s streams after the owned root exits successfully',
  async (stdio) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'owned-success-'));
    const address = path.join(root, 'address');
    const server = path.join(root, 'server.mjs');
    const parent = path.join(root, 'parent.mjs');
    writeFileSync(
      server,
      "import {createServer} from 'node:http'; import {writeFileSync} from 'node:fs'; const server=createServer((_,res)=>res.end('ready')); server.listen(0,'127.0.0.1',()=>writeFileSync(process.argv[2],'http://127.0.0.1:'+server.address().port));",
    );
    writeFileSync(
      parent,
      "import {spawn} from 'node:child_process'; import {existsSync} from 'node:fs'; const child=spawn(process.execPath,[process.argv[2],process.argv[3]],{stdio:process.argv[4]}); child.unref(); const timer=setInterval(()=>{if(existsSync(process.argv[3])) {clearInterval(timer); process.exit(0)}},20);",
    );
    try {
      await run(process.execPath, [parent, server, address, stdio], {
        timeout: 15000,
        capture: true,
      });
      expect(existsSync(address)).toBe(true);
      await expect(
        fetch(readFileSync(address, 'utf8'), { signal: AbortSignal.timeout(1000) }),
      ).rejects.toThrow(/fetch failed|aborted/iu);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  20000,
);
