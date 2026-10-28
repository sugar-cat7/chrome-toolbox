export function rustCases(output: string): number {
  const summaries = [
    ...output.matchAll(
      /test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out/gu,
    ),
  ];
  const passed = summaries.reduce((total, match) => total + Number(match[1]), 0);
  if (
    !passed ||
    summaries.some((match) => [2, 3, 4, 5].some((index) => Number(match[index]) !== 0))
  )
    throw new Error(
      'Required Rust tests must execute cases without failures, ignored or filtered tests',
    );
  return passed;
}

export function nativeCases(reports: unknown[]): number {
  let passed = 0;
  for (const report of reports) {
    const value = report as {
      state?: { passed?: number; failed?: number; skipped?: number };
      suites?: { tests?: { state: string }[] }[];
    };
    const tests = value.suites?.flatMap((suite) => suite.tests ?? []) ?? [];
    if (
      value.state?.failed ||
      value.state?.skipped ||
      tests.some((test) => test.state !== 'passed')
    )
      throw new Error('Required native tests contain failed, skipped or pending cases');
    passed += tests.length;
  }
  if (!passed) throw new Error('Required native tests collected zero cases');
  return passed;
}

export function vitestCases(report: unknown): number {
  const value = report as {
    numTotalTests: number;
    numPassedTests: number;
    numPendingTests: number;
    numTodoTests: number;
    numFailedTests: number;
  };
  if (
    !value.numTotalTests ||
    value.numPassedTests !== value.numTotalTests ||
    value.numPendingTests ||
    value.numTodoTests ||
    value.numFailedTests
  )
    throw new Error('Required test run must execute cases without failed, skipped or todo tests');
  return value.numPassedTests;
}

export function browserCases(report: unknown): number {
  const value = report as {
    stats?: { expected: number; unexpected: number; skipped: number; flaky: number };
  };
  if (!value.stats?.expected || value.stats.unexpected || value.stats.skipped || value.stats.flaky)
    throw new Error(
      'Required browser tests must execute cases without failed, skipped or flaky tests',
    );
  return value.stats.expected;
}

export function lighthouseScores(
  report: unknown,
  profile: 'mobile' | 'desktop',
): Record<string, number> {
  const value = report as {
    runtimeError?: unknown;
    configSettings?: {
      formFactor?: string;
      throttlingMethod?: string;
      skipAudits?: unknown;
      onlyAudits?: unknown;
      onlyCategories?: unknown;
      ignoreStatusCode?: boolean;
    };
    categories?: Record<string, { score?: number | null }>;
    audits?: Record<string, { scoreDisplayMode?: string }>;
  };
  const settings = value.configSettings;
  if (
    value.runtimeError ||
    !settings ||
    settings.formFactor !== profile ||
    settings.throttlingMethod !== 'simulate' ||
    (settings.skipAudits !== null && settings.skipAudits !== undefined) ||
    (settings.onlyAudits !== null && settings.onlyAudits !== undefined) ||
    (settings.onlyCategories !== null && settings.onlyCategories !== undefined) ||
    settings.ignoreStatusCode
  )
    throw new Error(
      'Lighthouse must complete the unmodified official mobile/desktop audit without exclusions',
    );
  const categories = value.categories ?? {};
  for (const required of [
    'performance',
    'accessibility',
    'best-practices',
    'seo',
    'agentic-browsing',
  ]) {
    if (!Object.hasOwn(categories, required))
      throw new Error(`Lighthouse missing required category: ${required}`);
  }
  if (
    !value.audits ||
    !Object.keys(value.audits).length ||
    Object.values(value.audits).some((audit) => audit.scoreDisplayMode === 'error')
  )
    throw new Error('Lighthouse collected no audits or an audit failed to execute');
  const scores = Object.fromEntries(
    Object.entries(categories).map(([id, category]) => [id, category.score]),
  );
  const failed = Object.entries(scores).filter(([, score]) => score !== 1);
  if (failed.length)
    throw new Error(
      `Lighthouse requires every category to score 100: ${failed.map(([id, score]) => `${id}=${score === null || score === undefined ? 'missing' : score * 100}`).join(', ')}`,
    );
  return scores as Record<string, number>;
}
