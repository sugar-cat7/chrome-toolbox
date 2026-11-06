// Deadlines of an extension's browser run that includes a soak test of SOAK_MINUTES (the comment
// assistant's chat under load, marked `starter.soak` in its manifest): the runner and the gate
// both allow for it.

/** The production build each browser run starts with. */
export const EXTENSION_BUILD_TIMEOUT = 180_000;

/**
 * Minutes a soak test runs: SOAK_MINUTES, 2 by default (120 for the long run). Only a whole
 * number of minutes, 1 or more, is accepted: anything else would make a deadline the soak
 * cannot meet or never ends.
 */
export function soakMinutes(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const value = env.SOAK_MINUTES ?? '2';
  const minutes = /^[1-9]\d*$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(minutes))
    throw new Error(
      `SOAK_MINUTES must be a whole number of minutes, 1 or more (got ${JSON.stringify(value)})`,
    );
  return minutes;
}

/** The soak's warm-up before its first measurement: the bounded buffers fill. */
export const SOAK_WARM_UP = 60_000;

/**
 * The soak test's own deadline: the warm-up, the minutes it samples (by the clock, so the time
 * each sample takes does not add up), and a margin for the start, the last sample and the checks
 * after it: 2 minutes, plus 2% of the soak for timers that fire late on a busy machine.
 */
export const soakTimeout = (minutes: number): number =>
  SOAK_WARM_UP + minutes * 60_000 + 120_000 + Math.ceil(minutes * 60_000 * 0.02);

/**
 * The Playwright run: the usual 3 minutes for the other browser tests (the comment assistant's
 * perf spec, `perf.spec.ts`, takes about 61 s of them), then the soak.
 */
export const playwrightTimeout = (env?: Readonly<Record<string, string | undefined>>): number =>
  180_000 + soakTimeout(soakMinutes(env));

/** The whole `test:e2e` of an extension with a soak: the build, then the Playwright run. */
export const extensionBrowserTimeout = (
  env?: Readonly<Record<string, string | undefined>>,
): number => EXTENSION_BUILD_TIMEOUT + playwrightTimeout(env);
