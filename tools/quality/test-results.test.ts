import { expect, it } from 'vitest';
import { nativeCases, rustCases } from './test-results.ts';

it('rejects exit-zero Rust runs with no tests or ignored tests while allowing empty doctests alongside real cases', () => {
  const summary = (passed: number, ignored = 0) =>
    `test result: ok. ${passed} passed; 0 failed; ${ignored} ignored; 0 measured; 0 filtered out; finished in 0.00s`;
  expect(rustCases(`${summary(2)}\n${summary(0)}`)).toBe(2);
  expect(() => rustCases(summary(0))).toThrow('must execute cases');
  expect(() => rustCases(summary(0, 2))).toThrow('must execute cases');
  expect(() => rustCases('build completed')).toThrow('must execute cases');
});

it('rejects empty, all-skipped and mixed-pending WDIO results rather than trusting successful runner jobs', () => {
  const report = (states: string[]) => ({
    state: { passed: states.filter((state) => state === 'passed').length, failed: 0, skipped: 0 },
    suites: [{ tests: states.map((state) => ({ state })) }],
  });
  expect(nativeCases([report(['passed'])])).toBe(1);
  expect(() => nativeCases([])).toThrow('zero cases');
  expect(() => nativeCases([report([])])).toThrow('zero cases');
  expect(() => nativeCases([report(['skipped'])])).toThrow('skipped or pending');
  expect(() => nativeCases([report(['passed', 'pending'])])).toThrow('skipped or pending');
});
