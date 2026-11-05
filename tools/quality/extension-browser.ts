import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pnpm } from '../process.ts';
import { EXTENSION_BUILD_TIMEOUT, playwrightTimeout } from './soak.ts';
import { browserCases } from './test-results.ts';

// Extension E2E always loads a fresh production build in Playwright's Chromium;
// the package's fixtures start their own local llama.cpp stub.
const cwd = process.cwd();
const args = process.argv.slice(2).filter((argument) => argument !== '--');
const evidence = path.resolve(cwd, `../../artifacts/browser-${path.basename(cwd)}.json`);
// A package whose browser tests include a soak marks it in its manifest (`starter.soak`).
const manifest = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
  starter?: { soak?: boolean };
};
rmSync(evidence, { force: true });
await pnpm(['exec', 'wxt', 'build'], { cwd, timeout: EXTENSION_BUILD_TIMEOUT });
await pnpm(['exec', 'playwright', 'test', ...args], {
  cwd,
  env: {
    ...process.env,
    STARTER_EXTENSION_PATH: path.join(cwd, 'dist/chrome-mv3'),
    STARTER_BROWSER_EVIDENCE: evidence,
  },
  // The soak runs for SOAK_MINUTES: the deadline grows with it.
  timeout: manifest.starter?.soak === true ? playwrightTimeout() : 180_000,
});
console.log(
  `Executed ${browserCases(JSON.parse(readFileSync(evidence, 'utf8')) as unknown)} required browser cases`,
);
