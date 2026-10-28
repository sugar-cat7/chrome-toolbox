import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pnpm } from '../process.ts';
import { vitestCases } from './test-results.ts';

const cwd = process.cwd();
const args = process.argv.slice(2).filter((argument) => argument !== '--');
if (
  args.some((argument) =>
    /^(?:--passWithNoTests|--allowOnly|--reporter|--outputFile)(?:=|$)/u.test(argument),
  )
)
  throw new Error('Required tests own their no-tests policy and evidence reporter');
const config = args[args.indexOf('--config') + 1];
const evidence = path.join(
  cwd,
  'artifacts',
  `tests-${args.includes('--config') ? path.basename(config ?? 'default') : 'default'}.json`,
);
mkdirSync(path.dirname(evidence), { recursive: true });
rmSync(evidence, { force: true });
await pnpm(
  [
    'exec',
    'vp',
    'test',
    'run',
    ...args,
    '--allowOnly=false',
    '--reporter',
    'default',
    '--reporter',
    'json',
    '--outputFile',
    evidence,
  ],
  { cwd, timeout: 180000 },
);
console.log(
  `Executed ${vitestCases(JSON.parse(readFileSync(evidence, 'utf8')) as unknown)} required test cases`,
);
