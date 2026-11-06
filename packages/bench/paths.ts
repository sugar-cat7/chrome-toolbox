import path from 'node:path';

/**
 * The repository root. pnpm runs this package's scripts in `packages/bench`, so the benches
 * resolve every relative path (`--set`, `--manifest`, `--out` and their defaults) from here, as
 * they did when they were root scripts: `bench-data/` is the repository's gitignored directory.
 */
export const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

/** A path given on the command line, or its default, resolved from the repository root. */
export const fromRoot = (file: string): string => path.resolve(REPO_ROOT, file);
