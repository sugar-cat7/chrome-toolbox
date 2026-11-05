import path from 'node:path';
import { expect, it } from 'vitest';
import { workspacePackages } from '../../../../tools/quality/graph.ts';

it('marks its browser soak in the manifest, the only package of the workspace with one', () => {
  // The gate and the runner lengthen the deadline of a marked package's browser run only.
  const root = path.resolve(import.meta.dirname, '../../../..');
  const marked = workspacePackages(root)
    .filter((pkg) => pkg.soak === true)
    .map((pkg) => pkg.name);
  expect(marked).toEqual(['@chrome-toolbox/comment-assistant']);
});
