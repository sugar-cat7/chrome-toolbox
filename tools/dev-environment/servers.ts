import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import { spawnOwned, pnpmCommand, stopTree } from '../process.ts';
export { stopTree } from '../process.ts';
import { workspacePackages, type WorkspacePackage } from '../quality/graph.ts';
import { prepareDatabase } from '../cloudflare/database.ts';

export async function availablePort(): Promise<number> {
  const server = createServer();
  return await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else if (!address || typeof address === 'string')
          reject(new Error('Unable to allocate port'));
        else resolve(address.port);
      });
    });
  });
}

export class Servers {
  children: ChildProcess[] = [];
  origins = new Map<string, string>();
  failures: Error[] = [];
  readonly root: string;
  readonly stateRoot: string;
  readonly environment: NodeJS.ProcessEnv;
  stopping = false;
  private cancellation = new AbortController();
  private registry: string | undefined;
  constructor(root: string, stateRoot = path.join(root, '.state'), environment = process.env) {
    this.root = root;
    this.stateRoot = stateRoot;
    this.environment = environment;
  }
  async start(pkg: WorkspacePackage, script = 'dev'): Promise<string> {
    // A request made after stop is an intentional restart. Pending starts keep
    // their cancelled signal and may never spawn after stop completes.
    if (this.stopping) {
      this.cancellation = new AbortController();
      this.stopping = false;
    }
    const signal = this.cancellation.signal;
    signal.throwIfAborted();
    if (pkg.runtime === 'worker')
      await prepareDatabase(
        path.join(this.root, pkg.directory),
        this.stateRoot,
        signal,
        this.environment,
      );
    signal.throwIfAborted();
    // Build/migration commands use sockets too. Select the listening port only
    // after preparation; strictPort still reports any subsequent collision.
    const port = await availablePort();
    signal.throwIfAborted();
    const invocation = pnpmCommand(['--filter', pkg.name, script]);
    // Forced native cleanup may leave fresh SDK registrations behind. Give each
    // lifecycle one shared namespace, independent of persistent Worker data.
    if (!this.registry) {
      mkdirSync(path.join(this.stateRoot, 'registry'), { recursive: true });
      this.registry = mkdtempSync(path.join(this.stateRoot, 'registry', 'session-'));
    }
    const registry = this.registry;
    const child = spawnOwned(invocation.command, invocation.args, {
      cwd: this.root,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...this.environment,
        STARTER_PORT: String(port),
        STARTER_STATE_ROOT: this.stateRoot,
        CLOUDFLARE_REGISTRY_PATH: registry,
        WRANGLER_REGISTRY_PATH: registry,
        MINIFLARE_REGISTRY_PATH: registry,
        CLOUDFLARE_SEND_METRICS: 'false',
      },
    });
    this.children.push(child);
    let output = '';
    const log = (chunk: Buffer) => {
      const message = chunk.toString();
      output = (output + message).slice(-20_000);
      process.stdout.write(`[${pkg.name}] ${message}`);
    };
    child.stdout?.on('data', log);
    child.stderr?.on('data', log);
    let exited = false;
    child.once('error', (error) => {
      exited = true;
      this.failures.push(error);
    });
    child.once('exit', (code, exitSignal) => {
      exited = true;
      if (!signal.aborted && code !== 0)
        this.failures.push(new Error(`${pkg.name}: exit ${code}, signal ${exitSignal}`));
    });
    const origin = `http://127.0.0.1:${port}`;
    const started = performance.now();
    while (performance.now() - started < 90_000) {
      signal.throwIfAborted();
      if (exited) throw new Error(`${pkg.name} exited before ready\n${output}`);
      try {
        if (!stripVTControlCharacters(output).includes(origin)) {
          await pause(100, undefined, { signal });
          continue;
        }
        const response = await fetch(`${origin}${pkg.runtime === 'worker' ? '/health' : '/'}`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
        });
        await response.arrayBuffer();
        if (response.ok) {
          signal.throwIfAborted();
          this.origins.set(pkg.name, origin);
          console.log(
            `READY ${pkg.name} ${origin} ${Math.round(performance.now() - started)}ms; registry ${registry}`,
          );
          return origin;
        }
      } catch {
        /* Wait only for the owned server; strictPort reports collisions. */
      }
      signal.throwIfAborted();
      await pause(200, undefined, { signal });
    }
    throw new Error(`${pkg.name} ready timeout\n${output}`);
  }
  async workers(target: string, script = 'dev'): Promise<string> {
    const packages = workspacePackages(this.root);
    const pkg = packages.find(
      (value) =>
        value.name === target ||
        value.directory === target ||
        path.basename(value.directory) === target,
    );
    if (!pkg || pkg.runtime !== 'worker') throw new Error(`Unknown Worker: ${target}`);
    for (const dependency of pkg.dependencies) {
      const upstream = packages.find((value) => value.name === dependency);
      if (upstream?.runtime === 'worker' && !this.origins.has(upstream.name))
        await this.workers(upstream.name, script);
    }
    return this.origins.get(pkg.name) ?? (await this.start(pkg, script));
  }
  async stop(graceMs?: number): Promise<void> {
    this.stopping = true;
    this.cancellation.abort(new Error('Server startup cancelled by stop'));
    const registry = this.registry;
    await Promise.all(this.children.toReversed().map((child) => stopTree(child, graceMs)));
    if (registry) rmSync(registry, { recursive: true, force: true });
    this.registry = undefined;
    this.children = [];
    this.origins.clear();
  }

  async native(pkg: WorkspacePackage, args: string[]): Promise<void> {
    const signal = this.cancellation.signal;
    signal.throwIfAborted();
    const invocation = pnpmCommand(['--filter', pkg.name, 'exec', 'tauri', ...args]);
    const child = spawnOwned(invocation.command, invocation.args, {
      cwd: this.root,
      env: this.environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    this.children.push(child);
    let output = '';
    const log = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-20000);
      process.stdout.write(`[${pkg.name}/native] ${chunk.toString()}`);
    };
    child.stdout?.on('data', log);
    child.stderr?.on('data', log);
    child.once('error', (error) => this.failures.push(error));
    child.once('exit', (code, exitSignal) => {
      if (!signal.aborted && code !== 0)
        this.failures.push(new Error(`${pkg.name} native exit ${code}, signal ${exitSignal}`));
    });
    const start = performance.now();
    while (!output.includes('NATIVE_READY') && performance.now() - start < 30 * 60000) {
      signal.throwIfAborted();
      if (child.exitCode !== null || this.failures.length)
        throw new Error(`${pkg.name} native exited before ready\n${output}`);
      await pause(100, undefined, { signal });
    }
    signal.throwIfAborted();
    if (!output.includes('NATIVE_READY'))
      throw new Error(`${pkg.name} native ready timeout\n${output}`);
    console.log(`READY ${pkg.name}/native ${Math.round(performance.now() - start)}ms`);
  }
}
