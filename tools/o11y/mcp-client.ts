import { createInterface } from 'node:readline';
import { type ChildProcess } from 'node:child_process';
import { spawnOwned, stopTree } from '../process.ts';
import { state, root } from './local.ts';

export class ClickHouseMcp {
  private child: ChildProcess;
  private sequence = 0;
  private closed = false;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  constructor() {
    const local = state();
    const env = { ...process.env };
    // Ignore ambient write/auth/connection overrides; credentials stay in a private
    // local file and process environment, never command arguments or protocol output.
    for (const key of Object.keys(env)) if (/^CLICKHOUSE_|^FASTMCP_/u.test(key)) delete env[key];
    Object.assign(env, {
      CLICKHOUSE_HOST: '127.0.0.1',
      CLICKHOUSE_PORT: String(local.clickhousePort),
      CLICKHOUSE_USER: 'investigate',
      CLICKHOUSE_PASSWORD: local.queryPassword,
      CLICKHOUSE_SECURE: 'false',
      CLICKHOUSE_VERIFY: 'true',
      CLICKHOUSE_ALLOW_WRITE_ACCESS: 'false',
      CLICKHOUSE_MCP_SERVER_TRANSPORT: 'stdio',
      CLICKHOUSE_MCP_QUERY_TIMEOUT: '5',
      CLICKHOUSE_CONNECT_TIMEOUT: '5',
      CLICKHOUSE_MCP_MAX_WORKERS: '2',
    });
    this.child = spawnOwned('mise', ['--env', 'o11y', 'exec', '--', 'mcp-clickhouse'], {
      cwd: root,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    this.child.stderr?.on('data', () => {}); // Server diagnostics can contain query parameters; do not forward.
    this.child.stdin?.on('error', () => this.fail('Official ClickHouse MCP input closed'));
    createInterface({ input: this.child.stdout! }).on('line', (line) => {
      let response: unknown;
      try {
        response = JSON.parse(line);
      } catch {
        this.fail('Invalid official MCP response');
        return;
      }
      if (
        !response ||
        typeof response !== 'object' ||
        !('id' in response) ||
        typeof response.id !== 'number'
      )
        return;
      const waiting = this.pending.get(response.id);
      if (!waiting) return;
      clearTimeout(waiting.timer);
      this.pending.delete(response.id);
      if ('error' in response) waiting.reject(new Error('Official ClickHouse MCP request failed'));
      else if ('result' in response) waiting.resolve(response.result);
      else waiting.reject(new Error('Missing official MCP result'));
    });
    this.child.on('error', () =>
      this.fail('Official ClickHouse MCP could not start; run o11y:setup'),
    );
    this.child.on('close', () => this.fail('Official ClickHouse MCP closed'));
  }
  private fail(message: string): void {
    this.closed = true;
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error(message));
    }
    this.pending.clear();
  }
  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Official ClickHouse MCP is closed'));
    if (this.pending.size >= 4)
      return Promise.reject(new Error('Bounded MCP concurrency exceeded'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Official MCP request timed out'));
      }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'bounded-observability', version: '1.0.0' },
    });
    this.child.stdin?.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
    const discovered = await this.request('tools/list', {});
    if (
      !discovered ||
      typeof discovered !== 'object' ||
      !('tools' in discovered) ||
      !Array.isArray(discovered.tools) ||
      !discovered.tools.some(
        (tool) => tool && typeof tool === 'object' && 'name' in tool && tool.name === 'run_query',
      )
    )
      throw new Error('Official MCP run_query tool not discovered; verify installed SDK contract');
  }
  async stop(): Promise<void> {
    this.fail('MCP stopped');
    await stopTree(this.child);
  }
}
