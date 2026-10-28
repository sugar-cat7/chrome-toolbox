import { expect, it } from 'vitest';
import { approvedSmokeUrl, requireUpstreamReceipt } from './deployment.ts';

it('only accepts the explicitly configured HTTPS dev health endpoint', () => {
  expect(approvedSmokeUrl('https://dev.example.test/health', ['dev.example.test']).pathname).toBe(
    '/health',
  );
  for (const url of [
    'http://dev.example.test/health',
    'https://unapproved.example.test/health',
    'https://token@dev.example.test/health',
    'https://dev.example.test/health?token=secret',
    'https://dev.example.test/other',
  ])
    expect(() => approvedSmokeUrl(url, ['dev.example.test'])).toThrow('Smoke URL must');
  expect(() => approvedSmokeUrl(undefined, undefined)).toThrow('Deploy requires');
});

it('rejects stale, failed or cross-account upstream deployment receipts', () => {
  const expected = {
    contentId: 'current-input',
    account: 'approved-account-hash',
    target: '@scope/api',
  };
  const receipt = {
    ...expected,
    environment: 'dev',
    deployed: true,
    smoked: true,
    smokeUrl: 'https://dev.example.test/health',
  };
  expect(requireUpstreamReceipt(receipt, expected).smokeUrl).toBe(receipt.smokeUrl);
  for (const patch of [
    { contentId: 'old-input' },
    { account: 'different-account' },
    { deployed: false },
    { smoked: false },
    { environment: 'production' },
  ])
    expect(() => requireUpstreamReceipt({ ...receipt, ...patch }, expected)).toThrow(
      'Upstream needs',
    );
});
