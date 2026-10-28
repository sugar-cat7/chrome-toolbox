import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ownHeadSha } from '../quality/checkout.ts';

// A generated project identifies its immutable source, never an enclosing Git checkout.
export function verificationIdentity(root: string, expected = process.env.CI_HEAD_SHA): string {
  const template = JSON.parse(readFileSync(path.join(root, '.template.json'), 'utf8')) as {
    kind: 'reference' | 'project';
    origin?: { sha: string | null };
  };
  const sha = ownHeadSha(root) ?? (template.kind === 'project' ? template.origin?.sha : null);
  if (!sha || !/^[a-f0-9]{40}$/u.test(sha))
    throw new Error('Observability verification requires a known source SHA');
  if (expected && sha !== expected)
    throw new Error('Observability source SHA does not match CI input');
  return sha;
}
