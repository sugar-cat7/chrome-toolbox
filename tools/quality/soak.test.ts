import { describe, expect, it } from 'vitest';
import { packageChecks } from './definitions.ts';
import { workspacePackages, type WorkspacePackage } from './graph.ts';
import { extensionBrowserTimeout, playwrightTimeout, soakMinutes, soakTimeout } from './soak.ts';

describe('soak deadlines', () => {
  it.each([
    { env: {}, minutes: 2, soak: 302_400, playwright: 482_400, browser: 662_400 },
    {
      env: { SOAK_MINUTES: '1' },
      minutes: 1,
      soak: 241_200,
      playwright: 421_200,
      browser: 601_200,
    },
    {
      env: { SOAK_MINUTES: '120' },
      minutes: 120,
      soak: 7_524_000,
      playwright: 7_704_000,
      browser: 7_884_000,
    },
  ])(
    '$env.SOAK_MINUTES minutes give the run room for the soak',
    ({ env, minutes, soak, playwright, browser }) => {
      expect(soakMinutes(env)).toBe(minutes);
      expect(soakTimeout(minutes)).toBe(soak);
      expect(playwrightTimeout(env)).toBe(playwright);
      expect(extensionBrowserTimeout(env)).toBe(browser);
    },
  );

  it('leaves the soak more room than its samples take, in proportion to its length', () => {
    // A sample (forced GCs on two pages and a stats request) took up to 2.7 s on a busy machine.
    // Sampled by the clock that time no longer adds up each minute, and the margin still grows
    // by at least a second a minute.
    for (const minutes of [1, 2, 30, 120, 480])
      expect(soakTimeout(minutes) - 60_000 - minutes * 60_000).toBeGreaterThanOrEqual(
        120_000 + minutes * 1_000,
      );
  });

  it.each(['0', '-1', '0.5', '2.5', 'Infinity', '', 'NaN', 'two', ' '])(
    'refuses SOAK_MINUTES=%j',
    (value) => {
      expect(() => soakMinutes({ SOAK_MINUTES: value })).toThrow(
        `SOAK_MINUTES must be a whole number of minutes, 1 or more (got ${JSON.stringify(value)})`,
      );
    },
  );
});

describe('browser check deadlines', () => {
  const extension = (soak: boolean): WorkspacePackage => ({
    name: '@example/extension',
    directory: 'packages/extension',
    runtime: 'extension',
    dependencies: [],
    scripts: { test: 'vitest', 'test:e2e': 'playwright' },
    ...(soak ? { soak: true } : {}),
  });
  const browserTimeout = (pkg: WorkspacePackage): number | undefined =>
    packageChecks(pkg, 'full').find((check) => check.id === `${pkg.name}/browser`)?.timeout;

  it('gives only an extension whose e2e has a soak the longer deadline', () => {
    expect(browserTimeout(extension(true))).toBe(extensionBrowserTimeout());
    expect(browserTimeout(extension(false))).toBe(180_000);
  });

  it('reads the soak marker from the manifests: only the comment assistant has one', () => {
    const marked = workspacePackages(process.cwd())
      .filter((pkg) => pkg.soak === true)
      .map((pkg) => pkg.name);
    expect(marked).toEqual(['@chrome-toolbox/comment-assistant']);
  });
});
