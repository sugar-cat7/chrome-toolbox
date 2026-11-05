import { parseArgs } from 'node:util';
import { loadClefSamples, type ClefSample } from './datasets.ts';
import { postJson } from './http.ts';
import { percentile } from './metrics.ts';
import { benchMeta, writeResults } from './results.ts';

/**
 * `systemone`: llama-server serves Clef natively on `POST /v1/systemone`.
 * `logprobs`: only a text model answered; p(abusive) comes from yes/no token logprobs.
 * `unavailable`: neither works; the comment extension falls back to LLM classification.
 */
export type ClefMode = 'systemone' | 'logprobs' | 'unavailable';
export type ClefProbe = { mode: ClefMode; detail: string };
export type ClefOptions = { fetch?: typeof fetch; model?: string };
export type ClefRow = ClefSample & { pToxic?: number; ms: number; error?: string };
export type ClefScore = {
  accuracy: number;
  p50Ms?: number | undefined;
  failed: number;
  rows: ClefRow[];
};

const QUESTION =
  'Is this live-stream chat comment abusive, that is, does it insult, harass or demean someone?';
const CRITERIA = {
  yes: 'Abusive: it insults, harasses or demeans someone.',
  no: 'Not abusive: friendly, neutral, or civil criticism.',
};
const SYSTEM_PROMPT = `You moderate a live-stream chat. ${QUESTION} Reply with one word: yes or no.`;
// Self-written and clearly abusive; the probe only checks that a probability comes back.
const PROBE_COMMENT = "you're useless, quit streaming";
const TOXIC_THRESHOLD = 0.5;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const jsonInit = (body: object): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const modelField = (options: ClefOptions) =>
  options.model === undefined ? {} : { model: options.model };

/** One `choice` question with options yes/no (llama.cpp tools/server README, TypeSafe API). */
async function systemoneProbability(
  base: string,
  text: string,
  options: ClefOptions,
): Promise<number> {
  const body = (await postJson(
    options.fetch ?? fetch,
    `${base}/v1/systemone`,
    jsonInit({
      ...modelField(options),
      state: text,
      questions: { abusive: { type: 'choice', instructions: QUESTION, criteria: CRITERIA } },
    }),
  )) as { answers?: { abusive?: { probabilities?: { yes?: unknown; no?: unknown } } } } | null;
  const { yes, no } = body?.answers?.abusive?.probabilities ?? {};
  if (typeof yes !== 'number' || typeof no !== 'number' || !(yes + no > 0))
    throw new Error('/v1/systemone answer has no yes/no probabilities');
  return yes / (yes + no);
}

/** A one-token yes/no answer; p(yes) is normalised over the yes/no variants in top_logprobs. */
async function logprobsProbability(
  base: string,
  text: string,
  options: ClefOptions,
): Promise<number> {
  const body = (await postJson(
    options.fetch ?? fetch,
    `${base}/v1/chat/completions`,
    jsonInit({
      ...modelField(options),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
      max_tokens: 1,
      temperature: 0,
      logprobs: true,
      top_logprobs: 5,
      // Without this, a reasoning template spends the single token on its thinking tag.
      chat_template_kwargs: { enable_thinking: false },
    }),
  )) as {
    choices?: { logprobs?: { content?: { top_logprobs?: unknown[] }[] } | null }[];
  } | null;
  const mass = { yes: 0, no: 0 };
  for (const entry of body?.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs ?? []) {
    const { token, logprob } = (entry ?? {}) as { token?: unknown; logprob?: unknown };
    if (typeof token !== 'string' || typeof logprob !== 'number') continue;
    const word = token.trim().toLowerCase();
    if (word === 'yes' || word === 'no') mass[word] += Math.exp(logprob);
  }
  if (!(mass.yes + mass.no > 0))
    throw new Error('/v1/chat/completions top_logprobs has no yes/no token');
  return mass.yes / (mass.yes + mass.no);
}

const classifiers = { systemone: systemoneProbability, logprobs: logprobsProbability };

/** Tries systemone, then logprobs; any network error, non-2xx or shape mismatch moves on. */
export async function probeClef(server: string, options: ClefOptions = {}): Promise<ClefProbe> {
  const base = server.replace(/\/+$/u, '');
  const reasons: string[] = [];
  for (const mode of ['systemone', 'logprobs'] as const) {
    try {
      const p = await classifiers[mode](base, PROBE_COMMENT, options);
      reasons.push(`${mode}: p(abusive)=${p.toFixed(3)} for the probe comment`);
      return { mode, detail: reasons.join('; ') };
    } catch (error) {
      reasons.push(`${mode}: ${message(error)}`);
    }
  }
  return { mode: 'unavailable', detail: reasons.join('; ') };
}

/** Classifies every sample with the probed mode; a failed sample counts as a wrong answer. */
export async function scoreClef(
  server: string,
  probe: ClefProbe,
  samples: readonly ClefSample[],
  options: ClefOptions = {},
): Promise<ClefScore> {
  if (probe.mode === 'unavailable')
    throw new Error(`cannot score: Clef is unavailable (${probe.detail})`);
  if (samples.length === 0) throw new Error('no samples to score');
  const classify = classifiers[probe.mode];
  const base = server.replace(/\/+$/u, '');
  const rows: ClefRow[] = [];
  // Sequential on purpose: concurrent requests would pollute the latency measurement.
  for (const sample of samples) {
    const row: ClefRow = { ...sample, ms: 0 };
    const started = performance.now();
    try {
      row.pToxic = await classify(base, sample.text, options);
    } catch (error) {
      row.error = message(error);
    }
    row.ms = performance.now() - started;
    rows.push(row);
  }
  const scored = rows.flatMap((row) =>
    row.pToxic === undefined ? [] : [{ ...row, pToxic: row.pToxic }],
  );
  if (scored.length === 0)
    throw new Error(`every sample failed; first error: ${rows[0]?.error ?? 'unknown'}`);
  const flagged = (pToxic: number): boolean => pToxic >= TOXIC_THRESHOLD;
  const correct = scored.filter((row) => flagged(row.pToxic) === row.toxic).length;
  return {
    accuracy: correct / rows.length,
    p50Ms: percentile(
      scored.map((row) => row.ms),
      50,
    ),
    failed: rows.length - scored.length,
    rows,
  };
}

function summary(mode: ClefMode, score: ClefScore): string {
  return [
    '| mode | samples | failed | accuracy | p50 ms |',
    '| --- | --- | --- | --- | --- |',
    `| ${mode} | ${score.rows.length} | ${score.failed} | ${score.accuracy.toFixed(2)} | ${score.p50Ms?.toFixed(0) ?? '-'} |`,
  ].join('\n');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((argument) => argument !== '--'),
    options: {
      server: { type: 'string' },
      model: { type: 'string' },
      set: { type: 'string', default: 'tools/bench/fixtures/clef.jsonl' },
      out: { type: 'string' },
    },
  });
  if (values.server === undefined) throw new Error('--server <url> is required');
  const samples = loadClefSamples(values.set);
  const options = values.model === undefined ? {} : { model: values.model };
  const probe = await probeClef(values.server, options);
  console.log(`probe: ${probe.detail}`);
  let mode = probe.mode;
  if (mode !== 'unavailable') {
    try {
      const score = await scoreClef(values.server, probe, samples, options);
      const out =
        values.out ??
        `bench-data/results/clef-${mode}-${(values.model ?? 'default').replace(/[^\w.-]+/gu, '_')}-${new Date().toISOString().replace(/[:.]/gu, '-')}.jsonl`;
      const meta = await benchMeta({
        bench: 'clef',
        server: values.server,
        model: values.model,
        settings: {
          mode,
          probe: probe.detail,
          threshold: TOXIC_THRESHOLD,
          set: values.set,
          // The logprobs request; /v1/systemone takes no generation settings.
          logprobs:
            mode === 'logprobs'
              ? {
                  temperature: 0,
                  maxTokens: 1,
                  topLogprobs: 5,
                  templateKwargs: { enable_thinking: false },
                }
              : null,
        },
      });
      writeResults(out, meta, score.rows);
      for (const row of score.rows)
        console.log(
          `${row.toxic ? 'toxic' : 'ok'}\t${row.pToxic?.toFixed(3) ?? '-'}\t${row.ms.toFixed(0)}ms\t${row.error ?? row.text}`,
        );
      console.log(summary(mode, score));
      console.log(`wrote ${out}`);
    } catch (error) {
      console.error(`scoring failed: ${message(error)}`);
      mode = 'unavailable';
    }
  }
  // ①② read this exact last line.
  console.log(`CLEF_MODE=${mode}`);
  if (mode === 'unavailable') process.exitCode = 1;
}

if (import.meta.main)
  main().catch((error: unknown) => {
    console.error(message(error));
    process.exitCode = 1;
  });
