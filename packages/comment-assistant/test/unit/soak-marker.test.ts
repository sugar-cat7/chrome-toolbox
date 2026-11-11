import path from 'node:path';
import { expect, it } from 'vitest';
import { workspacePackages } from '../../../../tools/quality/graph.ts';

it('lists the packages that mark a browser soak in their manifest', () => {
  // The gate and the runner lengthen the deadline of a marked package's browser run only.
  const root = path.resolve(import.meta.dirname, '../../../..');
  const marked = workspacePackages(root)
    .filter((pkg) => pkg.soak === true)
    .map((pkg) => pkg.name);
  expect(marked).toEqual([
    '@chrome-toolbox/comment-assistant',
    '@chrome-toolbox/page-translator',
    '@chrome-toolbox/subtitle-translator',
  ]);
});
