import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  cpSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pnpm } from '../process.ts';
import { contentId as sourceId } from '../quality/gate.ts';
import { applyFiles, digest } from './files.ts';
import { projectFiles } from './render.ts';
import { flags, projectOptions, verificationCases } from './options.ts';
import { faultRehearsal } from '../quality/faults.ts';
import { hookRehearsal } from '../quality/hooks-rehearsal.ts';
import { lifecycleRehearsal } from './lifecycle.ts';
import { writeEvidenceAfterCleanup } from '../quality/evidence.ts';
import { initializeVerificationGit } from '../quality/fixture.ts';
import { headSha } from '../quality/checkout.ts';

const source = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const input = flags(process.argv.slice(2));
const allowed = ['preset', 'cases', 'output', 'generate-only', 'faults', 'hooks', 'lifecycle'];
for (const key of Object.keys(input))
  if (!allowed.includes(key)) throw new Error(`Unknown verification flag --${key}`);
if (input.preset && input.cases) throw new Error('Use either --preset or --cases');
const requestedCases = typeof input.cases === 'string' ? input.cases.split(',') : undefined;
if (
  requestedCases &&
  (new Set(requestedCases).size !== requestedCases.length ||
    requestedCases.some((key) => !verificationCases.some((entry) => entry.key === key)))
)
  throw new Error('--cases requires distinct known verification cases');
const selected = requestedCases
  ? verificationCases.filter((entry) => requestedCases.includes(entry.key))
  : typeof input.preset === 'string'
    ? verificationCases.filter((entry) => entry.key === input.preset)
    : verificationCases;
if (!selected.length) throw new Error('Unknown preset verification case');
const temporary = typeof input.output !== 'string';
const output = temporary
  ? mkdtempSync(path.join(os.tmpdir(), 'starter-verify-'))
  : path.resolve(String(input.output));
mkdirSync(output, { recursive: true });
const reports: {
  preset: string;
  contentId: string;
  milliseconds: number;
  status: 'generated' | 'passed' | 'failed';
  error?: string;
}[] = [];
let completed = false;
try {
  for (const entry of selected) {
    const started = performance.now();
    const root = path.join(output, entry.key);
    if (existsSync(root) && readdirSync(root).length)
      throw new Error(`Verification destination must be empty: ${root}`);
    const options = projectOptions({
      name: `rehearsal-${entry.key}`,
      scope: '@rehearsal',
      preset: entry.preset,
      features: entry.features,
    });
    const files = projectFiles(source, options);
    const contentId = digest(
      Buffer.concat(
        [...files].flatMap(([filename, contents]) => [Buffer.from(filename), contents]),
      ),
    );
    applyFiles(root, files);
    try {
      initializeVerificationGit(root);
      await pnpm(['install', '--lockfile-only', '--no-frozen-lockfile'], { cwd: root });
      if (!input['generate-only']) {
        await pnpm(['env:setup'], { cwd: root, timeout: 10 * 60_000 });
        await pnpm(['env:doctor'], { cwd: root });
        await pnpm(['gate:full'], { cwd: root, timeout: 60 * 60_000 });
        if (input.faults) await faultRehearsal(root);
        if (input.hooks) await hookRehearsal(root);
        if (input.lifecycle) await lifecycleRehearsal(root);
      }
      reports.push({
        preset: entry.key,
        contentId,
        milliseconds: Math.round(performance.now() - started),
        status: input['generate-only'] ? 'generated' : 'passed',
      });
    } catch (error) {
      reports.push({
        preset: entry.key,
        contentId,
        milliseconds: Math.round(performance.now() - started),
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      if (existsSync(path.join(root, 'artifacts'))) {
        const destination = path.join(
          source,
          'artifacts',
          'generated',
          `${entry.key}-${process.platform}`,
        );
        rmSync(destination, { recursive: true, force: true });
        mkdirSync(path.dirname(destination), { recursive: true });
        cpSync(path.join(root, 'artifacts'), destination, { recursive: true });
      }
    }
  }
  completed = true;
} finally {
  writeEvidenceAfterCleanup(
    path.join(source, 'artifacts', `template-${process.platform}.json`),
    () => ({
      schema: 1,
      status: completed ? (input['generate-only'] ? 'generated' : 'passed') : 'failed',
      node: process.version,
      os: process.platform,
      sourceSha: headSha(source),
      sourceContentId: sourceId(source),
      generatedFrom: JSON.parse(readFileSync(path.join(source, '.template.json'), 'utf8')).version,
      reports,
    }),
    () => {
      if (temporary) rmSync(output, { recursive: true, force: true });
    },
  );
}
