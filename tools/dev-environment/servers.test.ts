import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { Servers } from './servers.ts';

it('cancels a pending start before spawn and permits an explicit real-server restart', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'starter-cancel-'));
  vi.stubEnv('GIT_DIR', 'foreign-parent');
  const environment = { ...process.env, GIT_DIR: undefined, STARTER_ENVIRONMENT_PROBE: 'owned' };
  const servers = new Servers(root, undefined, environment);
  const pkg = {
    name: 'startup-fixture',
    directory: '.',
    runtime: 'library' as const,
    dependencies: [],
    scripts: { dev: 'node server.cjs' },
  };
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: pkg.name, scripts: pkg.scripts }),
  );
  writeFileSync(
    path.join(root, 'server.cjs'),
    "const fs=require('node:fs');if(process.env.GIT_DIR||process.env.STARTER_ENVIRONMENT_PROBE!=='owned')throw new Error('Foreign environment leaked');const registry=process.env.MINIFLARE_REGISTRY_PATH;if(registry!==process.env.WRANGLER_REGISTRY_PATH)throw new Error('SDK registry mismatch');fs.writeFileSync(registry+'/registration','owned');fs.writeFileSync('registry-path',registry);require('node:http').createServer((req,res)=>res.end('ready')).listen(Number(process.env.STARTER_PORT),'127.0.0.1',()=>console.log('http://127.0.0.1:'+process.env.STARTER_PORT));\n",
  );
  const data = path.join(root, '.state', 'api', 'durable-data');
  const sibling = path.join(root, '.state', 'registry', 'user-owned');
  mkdirSync(path.dirname(data), { recursive: true });
  mkdirSync(sibling, { recursive: true });
  writeFileSync(data, 'persistent');
  writeFileSync(path.join(sibling, 'registration'), 'protected');
  try {
    const pending = servers.start(pkg);
    await Promise.all([expect(pending).rejects.toThrow('cancelled by stop'), servers.stop()]);
    expect(servers.children).toHaveLength(0);
    const origin = await servers.start(pkg);
    expect(await (await fetch(origin)).text()).toBe('ready');
    const firstRegistry = readFileSync(path.join(root, 'registry-path'), 'utf8');
    expect(readFileSync(path.join(firstRegistry, 'registration'), 'utf8')).toBe('owned');
    await servers.stop();
    expect(servers.children).toHaveLength(0);
    await expect(fetch(origin, { signal: AbortSignal.timeout(1000) })).rejects.toThrow(
      'fetch failed',
    );
    expect(existsSync(firstRegistry)).toBe(false);
    const restarted = await servers.start(pkg);
    expect(await (await fetch(restarted)).text()).toBe('ready');
    const secondRegistry = readFileSync(path.join(root, 'registry-path'), 'utf8');
    expect(secondRegistry).not.toBe(firstRegistry);
    expect(readFileSync(path.join(secondRegistry, 'registration'), 'utf8')).toBe('owned');
    await servers.stop();
    expect(existsSync(secondRegistry)).toBe(false);
    expect(readFileSync(data, 'utf8')).toBe('persistent');
    expect(readFileSync(path.join(sibling, 'registration'), 'utf8')).toBe('protected');
  } finally {
    await servers.stop();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

it('keeps stopped lifecycle exits out of an immediate restart and reports unexpected termination', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'starter-lifecycle-exit-'));
  const servers = new Servers(root);
  const pkg = {
    name: 'lifecycle-exit-fixture',
    directory: '.',
    runtime: 'library' as const,
    dependencies: [],
    scripts: { dev: 'node server.cjs' },
  };
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: pkg.name, scripts: pkg.scripts }),
  );
  writeFileSync(
    path.join(root, 'server.cjs'),
    "require('node:http').createServer((req,res)=>res.end('ready')).listen(Number(process.env.STARTER_PORT),'127.0.0.1',()=>console.log('http://127.0.0.1:'+process.env.STARTER_PORT));\n",
  );
  try {
    let origin = await servers.start(pkg);
    expect(await (await fetch(origin)).text()).toBe('ready');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await servers.stop(0);
      origin = await servers.start(pkg);
      expect(await (await fetch(origin)).text()).toBe('ready');
      expect(servers.failures).toEqual([]);
    }
    const child = servers.children[0]!;
    const exited = once(child, 'exit');
    expect(child.kill('SIGTERM')).toBe(true);
    await exited;
    expect(servers.stopping).toBe(false);
    expect(servers.failures).toHaveLength(1);
    expect(servers.failures[0]?.message).toContain(`${pkg.name}: exit`);
  } finally {
    await servers.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

it('probes an owned server whose logged URL contains split terminal color sequences', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'starter-colored-url-'));
  const servers = new Servers(root);
  const pkg = {
    name: 'colored-url-fixture',
    directory: '.',
    runtime: 'library' as const,
    dependencies: [],
    scripts: { dev: 'node server.cjs' },
  };
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: pkg.name, scripts: pkg.scripts }),
  );
  writeFileSync(
    path.join(root, 'server.cjs'),
    "const fs=require('node:fs');require('node:http').createServer((req,res)=>{fs.writeFileSync('health-request',req.url);res.end('ready');}).listen(Number(process.env.STARTER_PORT),'127.0.0.1',()=>{process.stdout.write('Local: \\u001b[36mhttp://127.0.0.1:\\u001b[');setTimeout(()=>process.stdout.write('1m'+process.env.STARTER_PORT+'\\u001b[22m/\\u001b[39m\\n'),30);});\n",
  );
  const deadline = setTimeout(() => void servers.stop(), 5000);
  try {
    const origin = await servers.start(pkg);
    expect(readFileSync(path.join(root, 'health-request'), 'utf8')).toBe('/');
    expect(servers.origins.get(pkg.name)).toBe(origin);
    expect(await (await fetch(origin)).text()).toBe('ready');
  } finally {
    clearTimeout(deadline);
    await servers.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

it('waits for the health body and retries a probe whose body exceeds its deadline', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'starter-health-body-'));
  const servers = new Servers(root);
  const pkg = {
    name: 'health-body-fixture',
    directory: '.',
    runtime: 'library' as const,
    dependencies: [],
    scripts: { dev: 'node server.cjs' },
  };
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: pkg.name, scripts: pkg.scripts }),
  );
  writeFileSync(
    path.join(root, 'server.cjs'),
    "const fs=require('node:fs');let requests=0;require('node:http').createServer((req,res)=>{requests+=1;res.writeHead(200);res.flushHeaders();if(requests===1){res.once('close',()=>fs.writeFileSync('timed-out-body','closed'));return;}setTimeout(()=>{fs.writeFileSync('completed-body','finished');res.end('ready');},150);}).listen(Number(process.env.STARTER_PORT),'127.0.0.1',()=>console.log('http://127.0.0.1:'+process.env.STARTER_PORT));\n",
  );
  try {
    const origin = await servers.start(pkg);
    expect(existsSync(path.join(root, 'timed-out-body'))).toBe(true);
    expect(existsSync(path.join(root, 'completed-body'))).toBe(true);
    expect(await (await fetch(origin)).text()).toBe('ready');
    expect(servers.children).toHaveLength(1);
  } finally {
    await servers.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
