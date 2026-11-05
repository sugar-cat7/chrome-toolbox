import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runSync } from '../process.ts';

/** First line of every results file: what produced the rows below it. */
export type BenchMeta = {
  type: 'meta';
  bench: string;
  timestamp: string;
  gitSha: string | null;
  server: string;
  model: string | null;
  /** `build_info`, `model_path` and `total_slots` from llama-server `GET /props`; null when absent. */
  serverProps: Record<string, unknown> | null;
  settings: Record<string, unknown>;
};

const PROPS_KEYS = ['build_info', 'model_path', 'total_slots'];

/** Best effort: whisper.cpp and older servers have no `/props`, which is recorded as null. */
async function serverProps(
  server: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetchImpl(`${server.replace(/\/+$/u, '')}/props`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return null;
    const picked = Object.fromEntries(
      Object.entries(body).filter(([key, value]) => PROPS_KEYS.includes(key) && value !== null),
    );
    return Object.keys(picked).length === 0 ? null : picked;
  } catch {
    return null;
  }
}

function gitSha(): string | null {
  try {
    return runSync('git', ['rev-parse', 'HEAD'], process.cwd());
  } catch {
    return null;
  }
}

export async function benchMeta(input: {
  bench: string;
  server: string;
  model: string | undefined;
  settings: Record<string, unknown>;
  fetch?: typeof fetch;
}): Promise<BenchMeta> {
  return {
    type: 'meta',
    bench: input.bench,
    timestamp: new Date().toISOString(),
    gitSha: gitSha(),
    server: input.server,
    model: input.model ?? null,
    serverProps: await serverProps(input.server, input.fetch ?? fetch),
    settings: input.settings,
  };
}

/** Writes the meta record as the first JSONL line, then one line per row. */
export function writeResults(out: string, meta: BenchMeta, rows: readonly object[]): void {
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, [meta, ...rows].map((row) => JSON.stringify(row)).join('\n') + '\n');
}
