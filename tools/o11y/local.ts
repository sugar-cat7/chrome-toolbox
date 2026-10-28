import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync, chmodSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { availablePort } from '../dev-environment/servers.ts';
import { run } from '../process.ts';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const stateDirectory = path.join(root, '.state/o11y');
export type LocalState = {
  version: 1;
  project: string;
  directory: string;
  clickhousePort: number;
  otlpPort: number;
  healthPort: number;
  queryPassword: string;
  bootstrapPassword: string;
  ingestPassword: string;
};
const stateFile = path.join(stateDirectory, 'credentials.json');
export function state(): LocalState {
  if (!existsSync(stateFile)) throw new Error('Observability is not initialized; run pnpm o11y:up');
  if (lstatSync(stateFile).isSymbolicLink())
    throw new Error('Refusing symlinked observability credentials');
  const value = JSON.parse(readFileSync(stateFile, 'utf8')) as LocalState;
  if (
    value.version !== 1 ||
    value.directory !== stateDirectory ||
    !/^o11y-[a-f0-9]{12}$/u.test(value.project)
  )
    throw new Error('Invalid local observability state');
  if (process.platform !== 'win32' && (lstatSync(stateFile).mode & 0o077) !== 0)
    throw new Error('Observability credentials must be private (0600)');
  return value;
}
export async function query(sql: string, params: Record<string, string> = {}): Promise<unknown[]> {
  const local = state();
  const url = new URL(`http://127.0.0.1:${local.clickhousePort}/`);
  url.searchParams.set('default_format', 'JSON');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(`param_${key}`, value);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`investigate:${local.queryPassword}`).toString('base64')}`,
    },
    body: sql,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Read-only ClickHouse query rejected (${response.status})`);
  }
  const payload: unknown = await response.json();
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('data' in payload) ||
    !Array.isArray(payload.data)
  )
    throw new Error('Invalid ClickHouse query result');
  return payload.data;
}
export async function status(): Promise<{
  initialized: boolean;
  collectable: boolean;
  queryReady: boolean;
  endpoint?: string;
}> {
  if (!existsSync(stateFile)) return { initialized: false, collectable: false, queryReady: false };
  const local = state();
  let collectable = false;
  let queryReady = false;
  try {
    const response = await fetch(`http://127.0.0.1:${local.healthPort}/`, {
      signal: AbortSignal.timeout(2000),
    });
    await response.arrayBuffer();
    collectable = response.ok;
  } catch {
    collectable = false;
  }
  try {
    queryReady = (await query('SELECT 1 AS healthy LIMIT 1')).length === 1;
  } catch {
    queryReady = false;
  }
  return {
    initialized: true,
    collectable,
    queryReady,
    endpoint: `http://127.0.0.1:${local.otlpPort}`,
  };
}
async function compose(args: string[]): Promise<void> {
  const local = state();
  await run(
    'docker',
    [
      'compose',
      '--project-name',
      local.project,
      '--env-file',
      path.join(stateDirectory, 'compose.env'),
      '-f',
      path.join(root, 'tools/o11y/compose.yaml'),
      ...args,
    ],
    { cwd: root, timeout: 8 * 60_000 },
  );
}
export async function up(): Promise<LocalState> {
  if (!existsSync(stateFile)) {
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    chmodSync(stateDirectory, 0o700);
    for (const folder of ['data', 'native'])
      mkdirSync(path.join(stateDirectory, folder), { mode: 0o700 });
    const local: LocalState = {
      version: 1,
      project: `o11y-${createHash('sha256').update(root).digest('hex').slice(0, 12)}`,
      directory: stateDirectory,
      clickhousePort: await availablePort(),
      otlpPort: await availablePort(),
      healthPort: await availablePort(),
      queryPassword: randomBytes(32).toString('hex'),
      bootstrapPassword: randomBytes(32).toString('hex'),
      ingestPassword: randomBytes(32).toString('hex'),
    };
    writeFileSync(stateFile, JSON.stringify(local), { mode: 0o600 });
    writeFileSync(
      path.join(stateDirectory, 'compose.env'),
      Object.entries({
        O11Y_PROJECT: local.project,
        O11Y_STATE: stateDirectory,
        O11Y_UID: process.getuid?.() ?? 101,
        O11Y_GID: process.getgid?.() ?? 101,
        O11Y_CLICKHOUSE_PORT: local.clickhousePort,
        O11Y_OTLP_PORT: local.otlpPort,
        O11Y_HEALTH_PORT: local.healthPort,
        O11Y_BOOTSTRAP_PASSWORD: local.bootstrapPassword,
        O11Y_INGEST_PASSWORD: local.ingestPassword,
      })
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') + '\n',
      { mode: 0o600 },
    );
  }
  const local = state();
  writeFileSync(
    path.join(stateDirectory, 'resources.xml'),
    readFileSync(path.join(root, 'tools/o11y/resources.xml')),
    { mode: 0o600 },
  );
  const hash = (password: string) => createHash('sha256').update(password).digest('hex');
  writeFileSync(
    path.join(stateDirectory, 'init.sql'),
    `CREATE DATABASE IF NOT EXISTS otel;\nCREATE USER IF NOT EXISTS ingest IDENTIFIED WITH sha256_hash BY '${hash(local.ingestPassword)}';\nGRANT SELECT, INSERT, CREATE TABLE, CREATE DATABASE ON otel.* TO ingest;\nCREATE USER IF NOT EXISTS investigate IDENTIFIED WITH sha256_hash BY '${hash(local.queryPassword)}' SETTINGS readonly=1, max_execution_time=5, max_result_rows=4096, result_overflow_mode='throw', max_rows_to_read=1000000, max_memory_usage=268435456, allow_introspection_functions=0;\nALTER USER investigate SETTINGS readonly=1, max_execution_time=5, max_result_rows=4096, result_overflow_mode='throw', max_rows_to_read=1000000, max_memory_usage=268435456, allow_introspection_functions=0;\nGRANT SELECT ON otel.* TO investigate;\n`,
    { mode: 0o600 },
  );
  const bootstrapHash = createHash('sha256').update(local.bootstrapPassword).digest('hex');
  writeFileSync(
    path.join(stateDirectory, 'users.xml'),
    `<clickhouse><users><default remove="true"/><bootstrap><password_sha256_hex>${bootstrapHash}</password_sha256_hex><networks><ip>127.0.0.1</ip><ip>::1</ip></networks><profile>default</profile><quota>default</quota><access_management>1</access_management></bootstrap></users></clickhouse>`,
    { mode: 0o600 },
  );
  await compose(['up', '--detach', '--wait', '--wait-timeout', '90', 'clickhouse']);
  await compose([
    'exec',
    '-T',
    'clickhouse',
    'sh',
    '-c',
    'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --multiquery < /docker-entrypoint-initdb.d/init.sql',
  ]);
  await compose(['up', '--detach', 'collector']);
  for (let attempt = 0; attempt < 30; attempt++) {
    const health = await status();
    if (health.collectable && health.queryReady) {
      console.log(JSON.stringify(health));
      return state();
    }
    await pause(500);
  }
  throw new Error(
    'Local observability did not become collectable/queryReady; inspect owned container diagnostics without printing credentials',
  );
}
export async function down(): Promise<void> {
  if (existsSync(stateFile)) await compose(['down']);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const operation = process.argv[2];
  if (operation === 'up') await up();
  else if (operation === 'down') await down();
  else if (operation === 'status') console.log(JSON.stringify(await status()));
  else throw new Error('Use o11y:up, o11y:down or o11y:status');
}
