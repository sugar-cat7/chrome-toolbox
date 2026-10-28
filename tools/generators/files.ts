import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  chmodSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { safeFile } from './safety.ts';

export type Files = Map<string, Buffer>;
export const digest = (contents: Buffer | string): string =>
  createHash('sha256').update(contents).digest('hex');

export function walk(
  directory: string,
  prefix = '',
  ignored: ReadonlySet<string> = new Set(),
  ignoredPaths: ReadonlySet<string> = new Set(),
): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (ignored.has(entry.name) || ignored.has(relative) || ignoredPaths.has(relative)) return [];
      if (entry.isSymbolicLink())
        throw new Error(`Template must not contain symlinks: ${relative}`);
      return entry.isDirectory()
        ? walk(path.join(directory, entry.name), relative, ignored, ignoredPaths)
        : [relative];
    })
    .sort();
}

type Journal = {
  version: 1;
  files: {
    path: string;
    previous: string | null;
    next: string | null;
    temp?: string;
    mode?: number;
  }[];
  directories: string[];
  prunedDirectories?: { path: string; mode: number }[];
};
const journalName = '.template-transaction.json';

function removeEmptyDirectory(root: string, relative: string): void {
  try {
    const target = safeFile(root, relative);
    if (existsSync(target) && (lstatSync(target).mode & 0o7000) !== 0) return;
    rmdirSync(safeFile(root, relative));
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? ''))
      throw error;
  }
}

function atomicWrite(
  root: string,
  relative: string,
  contents: Buffer,
  temp: string,
  mode?: number,
): void {
  existingMode(root, relative);
  writeFileSync(safeFile(root, temp), contents, { flag: 'wx', mode: mode ?? 0o644 });
  if (mode !== undefined) chmodSync(safeFile(root, temp), mode);
  renameSync(safeFile(root, temp), safeFile(root, relative));
}

function existingMode(root: string, relative: string): number | undefined {
  const target = safeFile(root, relative);
  if (!existsSync(target)) return undefined;
  const metadata = lstatSync(target);
  if (!metadata.isFile()) throw new Error(`Not a regular file: ${relative}`);
  if ((metadata.mode & 0o7000) !== 0)
    throw new Error(`Special file permissions require manual review: ${relative}`);
  return metadata.mode & 0o777;
}

export function recover(root: string): void {
  const filename = safeFile(root, journalName);
  if (!existsSync(filename)) return;
  const journal = JSON.parse(readFileSync(filename, 'utf8')) as Journal;
  if (journal.version !== 1) throw new Error('Unknown template transaction version');
  for (const entry of journal.files) {
    existingMode(root, entry.path);
    if (
      entry.mode !== undefined &&
      (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777)
    )
      throw new Error('Unsafe transaction file mode');
    const target = safeFile(root, entry.path);
    const current = existsSync(target) ? digest(readFileSync(target)) : null;
    const before = entry.previous === null ? null : digest(Buffer.from(entry.previous, 'base64'));
    if (current !== before && current !== entry.next)
      throw new Error(
        `Recovery found a user change: ${entry.path}; preserve it and review the transaction before retrying`,
      );
    if (entry.temp) {
      safeFile(root, entry.temp);
      if (
        path.dirname(entry.temp) !== path.dirname(entry.path) ||
        !/^\.template-write-[0-9a-f-]+\.tmp$/u.test(path.basename(entry.temp))
      )
        throw new Error('Unsafe transaction temporary file');
    }
  }
  for (const directory of journal.directories) safeFile(root, directory);
  const pruned = journal.prunedDirectories ?? [];
  for (const directory of pruned) {
    const target = safeFile(root, directory.path);
    if (!Number.isInteger(directory.mode) || directory.mode < 0 || directory.mode > 0o777)
      throw new Error('Unsafe transaction directory mode');
    if (existsSync(target) && !lstatSync(target).isDirectory())
      throw new Error(`Not a recovery directory: ${directory.path}`);
  }
  for (const directory of [...pruned].sort(
    (a, b) => a.path.split('/').length - b.path.split('/').length,
  )) {
    const target = safeFile(root, directory.path);
    if (!existsSync(target)) {
      mkdirSync(target, { mode: directory.mode });
      const recreated = safeFile(root, directory.path);
      if (!lstatSync(recreated).isDirectory())
        throw new Error(`Recovery directory was replaced: ${directory.path}`);
      chmodSync(safeFile(root, directory.path), directory.mode);
    }
  }
  for (const entry of journal.files.toReversed()) {
    const target = safeFile(root, entry.path);
    if (entry.temp) rmSync(safeFile(root, entry.temp), { force: true });
    if (entry.previous === null) rmSync(target, { force: true });
    else if (entry.temp)
      atomicWrite(root, entry.path, Buffer.from(entry.previous, 'base64'), entry.temp, entry.mode);
    else writeFileSync(target, Buffer.from(entry.previous, 'base64'));
  }
  for (const directory of journal.directories.toReversed()) {
    removeEmptyDirectory(root, directory);
  }
  rmSync(filename);
}

export function applyFiles(
  root: string,
  files: Files,
  remove: string[] = [],
  beforeWrite?: (index: number) => void,
): void {
  mkdirSync(root, { recursive: true });
  if (existsSync(safeFile(root, journalName)))
    throw new Error('Interrupted transaction found; rerun template:init with --recover');
  const targets = [...new Set([...files.keys(), ...remove])];
  if (new Set(targets.map((filename) => filename.toLowerCase())).size !== targets.length)
    throw new Error('Case-insensitive path collision');
  for (const filename of targets) existingMode(root, filename);
  const directories = [
    ...new Set(
      [...files.keys()].flatMap((filename) => {
        const parts = filename.split('/').slice(0, -1);
        return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
      }),
    ),
  ]
    .filter((relative) => !existsSync(safeFile(root, relative)))
    .sort((a, b) => a.split('/').length - b.split('/').length);
  const journal: Journal = {
    version: 1,
    files: targets.map((relative) => {
      const target = safeFile(root, relative);
      const mode = existingMode(root, relative);
      return {
        path: relative,
        previous: existsSync(target) ? readFileSync(target).toString('base64') : null,
        next: files.has(relative) ? digest(files.get(relative)!) : null,
        temp: path.posix.join(path.posix.dirname(relative), `.template-write-${randomUUID()}.tmp`),
        ...(mode === undefined ? {} : { mode }),
      };
    }),
    directories,
    prunedDirectories: [
      ...new Set(
        remove.flatMap((filename) => {
          const parts = filename.split('/').slice(0, -1);
          return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
        }),
      ),
    ]
      .filter((relative) => existsSync(safeFile(root, relative)))
      .flatMap((relative) => {
        const target = safeFile(root, relative);
        const metadata = lstatSync(target);
        if (!metadata.isDirectory()) throw new Error(`Not a removal directory: ${relative}`);
        if ((metadata.mode & 0o7000) !== 0) return [];
        return [{ path: relative, mode: metadata.mode & 0o777 }];
      }),
  };
  writeFileSync(safeFile(root, journalName), `${JSON.stringify(journal)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  try {
    for (const directory of directories) mkdirSync(safeFile(root, directory), { recursive: true });
    let index = 0;
    for (const [relative, contents] of files) {
      beforeWrite?.(index++);
      const entry = journal.files.find((value) => value.path === relative)!;
      atomicWrite(root, relative, contents, entry.temp!, entry.mode);
    }
    for (const relative of remove) {
      existingMode(root, relative);
      rmSync(safeFile(root, relative));
    }
    for (const directory of [...(journal.prunedDirectories ?? [])].sort(
      (a, b) => b.path.split('/').length - a.path.split('/').length,
    ))
      removeEmptyDirectory(root, directory.path);
    rmSync(safeFile(root, journalName));
  } catch (error) {
    try {
      recover(root);
    } catch (recovery) {
      throw new AggregateError(
        [error, recovery],
        'Generation failed; transaction retained for explicit recovery',
      );
    }
    throw error;
  }
}
