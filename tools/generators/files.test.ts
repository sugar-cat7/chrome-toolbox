import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  mkdirSync,
  chmodSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type * as fsModule from 'node:fs';
import { applyFiles, recover, digest } from './files.ts';
import { safeFile } from './safety.ts';

const failure = vi.hoisted(() => ({ partial: false, prune: '', race: '', swap: '', outside: '' }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof fsModule>();
  return {
    ...fs,
    mkdirSync: (...args: Parameters<typeof fs.mkdirSync>) => {
      const result = fs.mkdirSync(...args);
      if (failure.swap && String(args[0]).endsWith(failure.swap)) {
        failure.swap = '';
        fs.rmdirSync(args[0]);
        fs.symlinkSync(failure.outside, args[0], 'junction');
      }
      return result;
    },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (failure.partial && String(args[0]).includes('.template-write-')) {
        failure.partial = false;
        fs.writeFileSync(args[0], Buffer.from('partial'), args[2]);
        throw new Error('ENOSPC during write');
      }
      return fs.writeFileSync(...args);
    },
    rmdirSync: (...args: Parameters<typeof fs.rmdirSync>) => {
      if (failure.race && String(args[0]).endsWith(failure.race)) {
        failure.race = '';
        fs.writeFileSync(path.join(String(args[0]), 'concurrent-user.txt'), 'user change');
      }
      if (failure.prune && String(args[0]).endsWith(failure.prune)) {
        failure.prune = '';
        throw Object.assign(new Error('EACCES during directory pruning'), { code: 'EACCES' });
      }
      return fs.rmdirSync(...args);
    },
  };
});

describe('generation transaction', () => {
  it.each(['replace', 'rollback', 'recover'])(
    'preserves actual file modes with a restrictive umask during %s',
    (operation) => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'template-file-mode-'));
      try {
        const moduleUrl = pathToFileURL(path.resolve('tools/generators/files.ts')).href;
        const result = spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `
              import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
              import path from 'node:path';
              const { applyFiles, digest, recover } = await import(process.argv[2]);
              const root = process.argv[1];
              const operation = process.argv[3];
              process.umask(0o022);
              const names = ['group.txt', 'executable.txt'];
              for (const [index, name] of names.entries()) {
                writeFileSync(path.join(root, name), 'original');
                chmodSync(path.join(root, name), index ? 0o770 : 0o660);
              }
              const before = names.map(name => statSync(path.join(root, name)).mode & 0o7777);
              writeFileSync(path.join(root, 'user.txt'), 'preserve');
              let failure = null;
              if (operation === 'recover') {
                for (const name of names) {
                  writeFileSync(path.join(root, name), 'replacement');
                  chmodSync(path.join(root, name), 0o600);
                }
                writeFileSync(path.join(root, '.template-transaction.json'), JSON.stringify({
                  version: 1, directories: [], files: names.map((name, index) => ({
                    path: name, previous: Buffer.from('original').toString('base64'),
                    next: digest('replacement'), temp: '.template-write-' + index + '.tmp',
                    mode: before[index],
                  })),
                }));
                recover(root);
              } else {
                try {
                  applyFiles(root, new Map([
                    ...names.map(name => [name, Buffer.from('replacement')]),
                    ['new.txt', Buffer.from('new')],
                  ]), [], index => {
                    if (operation === 'rollback' && index === 1) throw new Error('interrupted');
                  });
                } catch (error) { failure = error.message; }
              }
              console.log(JSON.stringify({
                before, after: names.map(name => statSync(path.join(root, name)).mode & 0o7777),
                contents: names.map(name => readFileSync(path.join(root, name), 'utf8')),
                failure, journal: existsSync(path.join(root, '.template-transaction.json')),
                newMode: existsSync(path.join(root, 'new.txt'))
                  ? statSync(path.join(root, 'new.txt')).mode & 0o7777 : null,
                user: readFileSync(path.join(root, 'user.txt'), 'utf8'),
              }));
            `,
            root,
            moduleUrl,
            operation,
          ],
          { encoding: 'utf8', timeout: 30000 },
        );
        expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
        const report = JSON.parse(result.stdout) as {
          before: number[];
          after: number[];
          contents: string[];
          failure: string | null;
          journal: boolean;
          newMode: number | null;
          user: string;
        };
        expect(report.before).toEqual(
          process.platform === 'win32' ? [0o666, 0o666] : [0o660, 0o770],
        );
        expect(report.after).toEqual(report.before);
        expect(report.contents).toEqual(
          operation === 'replace' ? ['replacement', 'replacement'] : ['original', 'original'],
        );
        expect(report.failure).toBe(operation === 'rollback' ? 'interrupted' : null);
        expect(report.journal).toBe(false);
        expect(report.newMode).toBe(
          operation === 'replace' ? (process.platform === 'win32' ? 0o666 : 0o644) : null,
        );
        expect(report.user).toBe('preserve');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it.each([0o4750, 0o2750, 0o1750])(
    'protects special file mode %s before any transaction mutation',
    (requestedMode) => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'template-special-file-'));
      try {
        const filename = path.join(root, 'existing.txt');
        writeFileSync(filename, 'original');
        chmodSync(filename, requestedMode);
        const mode = statSync(filename).mode & 0o7777;
        expect(mode & 0o7000).toBe(process.platform === 'win32' ? 0 : requestedMode & 0o7000);
        const replace = () =>
          applyFiles(
            root,
            new Map([
              ['earlier.txt', Buffer.from('new')],
              ['existing.txt', Buffer.from('replacement')],
            ]),
          );
        let replacementError: string | null = null;
        try {
          replace();
        } catch (error) {
          replacementError = (error as Error).message;
        }
        const expectedError =
          process.platform === 'win32'
            ? null
            : 'Special file permissions require manual review: existing.txt';
        expect(replacementError).toBe(expectedError);
        expect(readFileSync(filename, 'utf8')).toBe(
          process.platform === 'win32' ? 'replacement' : 'original',
        );
        expect(statSync(filename).mode & 0o7777).toBe(mode);
        expect(existsSync(path.join(root, 'earlier.txt'))).toBe(process.platform === 'win32');
        let removalError: string | null = null;
        try {
          applyFiles(root, new Map(), ['existing.txt']);
        } catch (error) {
          removalError = (error as Error).message;
        }
        expect(removalError).toBe(expectedError);
        expect(existsSync(filename)).toBe(process.platform !== 'win32');
        expect(existsSync(path.join(root, '.template-transaction.json'))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it.each([0o4750, -1, 0o1000, 1.5])(
    'refuses unsafe recovery file mode %s before mutation',
    (mode) => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'template-unsafe-file-mode-'));
      try {
        const filename = path.join(root, 'existing.txt');
        writeFileSync(filename, 'replacement');
        const before = statSync(filename).mode & 0o7777;
        const journal = path.join(root, '.template-transaction.json');
        writeFileSync(
          journal,
          JSON.stringify({
            version: 1,
            directories: [],
            files: [
              {
                path: 'existing.txt',
                previous: Buffer.from('original').toString('base64'),
                next: digest('replacement'),
                temp: '.template-write-a.tmp',
                mode,
              },
            ],
          }),
        );
        expect(() => recover(root)).toThrow('Unsafe transaction file mode');
        expect(readFileSync(filename, 'utf8')).toBe('replacement');
        expect(statSync(filename).mode & 0o7777).toBe(before);
        expect(existsSync(journal)).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it('preserves specially permissioned managed ancestors through pruning failure and retry', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'template-special-mode-'));
    try {
      const directory = path.join(root, 'packages/api/src');
      mkdirSync(directory, { recursive: true });
      chmodSync(directory, 0o2750);
      const mode = statSync(directory).mode & 0o7777;
      expect(mode & 0o7000).toBe(process.platform === 'win32' ? 0 : 0o2000);
      writeFileSync(path.join(directory, 'notes.ts'), 'original');
      failure.prune = path.join('packages', 'api');
      expect(() => applyFiles(root, new Map(), ['packages/api/src/notes.ts'])).toThrow('EACCES');
      expect(readFileSync(path.join(directory, 'notes.ts'), 'utf8')).toBe('original');
      expect(statSync(directory).mode & 0o7777).toBe(mode);
      expect(existsSync(path.join(root, '.template-transaction.json'))).toBe(false);
      applyFiles(root, new Map(), ['packages/api/src/notes.ts']);
      expect(existsSync(path.join(directory, 'notes.ts'))).toBe(false);
      expect(existsSync(directory)).toBe((mode & 0o7000) !== 0);
      expect(existsSync(directory) ? statSync(directory).mode & 0o7777 : null).toBe(
        (mode & 0o7000) !== 0 ? mode : null,
      );
    } finally {
      failure.prune = '';
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('preserves special directory permissions added after the journal was written', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'template-special-mode-race-'));
    try {
      const directory = path.join(root, 'packages/api/src');
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, 'notes.ts'), 'managed');
      let mode = 0;
      applyFiles(
        root,
        new Map([['new.txt', Buffer.from('new')]]),
        ['packages/api/src/notes.ts'],
        () => {
          chmodSync(directory, 0o1750);
          mode = statSync(directory).mode & 0o7777;
          expect(mode & 0o7000).toBe(process.platform === 'win32' ? 0 : 0o1000);
        },
      );
      expect(existsSync(path.join(directory, 'notes.ts'))).toBe(false);
      expect(existsSync(directory)).toBe((mode & 0o7000) !== 0);
      expect(existsSync(directory) ? statSync(directory).mode & 0o7777 : null).toBe(
        (mode & 0o7000) !== 0 ? mode : null,
      );
      expect(readFileSync(path.join(root, 'new.txt'), 'utf8')).toBe('new');
      expect(existsSync(path.join(root, '.template-transaction.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('refuses a symlink swap after recovery creates a directory without changing external permissions', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'template-recovery-swap-'));
    const outside = mkdtempSync(path.join(os.tmpdir(), 'template-recovery-outside-'));
    try {
      chmodSync(outside, 0o550);
      const mode = statSync(outside).mode & 0o777;
      writeFileSync(
        path.join(root, '.template-transaction.json'),
        JSON.stringify({
          version: 1,
          files: [
            {
              path: 'restored/file.txt',
              previous: Buffer.from('original').toString('base64'),
              next: null,
            },
          ],
          directories: [],
          prunedDirectories: [{ path: 'restored', mode: mode === 0o750 ? 0o700 : 0o750 }],
        }),
      );
      failure.outside = outside;
      failure.swap = 'restored';
      expect(() => recover(root)).toThrow('Refusing symlink traversal');
      expect(statSync(outside).mode & 0o777).toBe(mode);
      expect(existsSync(path.join(outside, 'file.txt'))).toBe(false);
      expect(existsSync(path.join(root, '.template-transaction.json'))).toBe(true);
    } finally {
      failure.swap = '';
      failure.outside = '';
      chmodSync(outside, 0o700);
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
  it('removes only empty managed-file ancestors while protecting user files and unrelated directories', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'template-exclusion-'));
    try {
      for (const directory of [
        'packages/api/src',
        'packages/jobs/src',
        'packages/keep/src',
        'packages/keep/user-empty',
        'packages/user-empty',
      ])
        mkdirSync(path.join(root, directory), { recursive: true });
      writeFileSync(path.join(root, 'packages/api/src/notes.ts'), 'managed');
      writeFileSync(path.join(root, 'packages/jobs/src/notes.ts'), 'managed');
      writeFileSync(path.join(root, 'packages/keep/src/notes.ts'), 'managed');
      writeFileSync(path.join(root, 'packages/jobs/user.txt'), 'user changes');
      applyFiles(root, new Map(), [
        'packages/api/src/notes.ts',
        'packages/jobs/src/notes.ts',
        'packages/keep/src/notes.ts',
      ]);
      expect(existsSync(path.join(root, 'packages/api'))).toBe(false);
      expect(existsSync(path.join(root, 'packages/jobs/src'))).toBe(false);
      expect(readFileSync(path.join(root, 'packages/jobs/user.txt'), 'utf8')).toBe('user changes');
      expect(existsSync(path.join(root, 'packages/user-empty'))).toBe(true);
      expect(existsSync(path.join(root, 'packages/keep/user-empty'))).toBe(true);
      expect(existsSync(path.join(root, '.template-transaction.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('preserves raced-in content during nonrecursive empty-directory removal', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'template-prune-race-'));
    try {
      mkdirSync(path.join(root, 'packages/api/src'), { recursive: true });
      writeFileSync(path.join(root, 'packages/api/src/notes.ts'), 'managed');
      failure.race = path.join('packages', 'api', 'src');
      applyFiles(root, new Map(), ['packages/api/src/notes.ts']);
      expect(readFileSync(path.join(root, 'packages/api/src/concurrent-user.txt'), 'utf8')).toBe(
        'user change',
      );
      expect(existsSync(path.join(root, 'packages/api/src/notes.ts'))).toBe(false);
      expect(existsSync(path.join(root, '.template-transaction.json'))).toBe(false);
    } finally {
      failure.race = '';
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('preserves raced-in user content when rolling back a newly created directory', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'template-rollback-race-'));
    try {
      failure.race = 'new';
      expect(() =>
        applyFiles(
          root,
          new Map([
            ['new/file.ts', Buffer.from('new')],
            ['later.txt', Buffer.from('later')],
          ]),
          [],
          (index) => {
            if (index === 1) throw new Error('write interrupted');
          },
        ),
      ).toThrow('write interrupted');
      expect(readFileSync(path.join(root, 'new/concurrent-user.txt'), 'utf8')).toBe('user change');
      expect(existsSync(path.join(root, 'new/file.ts'))).toBe(false);
      expect(existsSync(path.join(root, '.template-transaction.json'))).toBe(false);
    } finally {
      failure.race = '';
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('restores removed files and directory modes when pruning fails after deleting a parent', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'template-prune-rollback-'));
    try {
      const directory = path.join(root, 'packages/api/src');
      mkdirSync(directory, { recursive: true });
      chmodSync(directory, 0o750);
      const mode = statSync(directory).mode & 0o777;
      writeFileSync(path.join(directory, 'notes.ts'), 'original');
      failure.prune = path.join('packages', 'api');
      expect(() => applyFiles(root, new Map(), ['packages/api/src/notes.ts'])).toThrow('EACCES');
      expect(readFileSync(path.join(directory, 'notes.ts'), 'utf8')).toBe('original');
      expect(statSync(directory).mode & 0o777).toBe(mode);
      expect(existsSync(path.join(root, '.template-transaction.json'))).toBe(false);
      applyFiles(root, new Map(), ['packages/api/src/notes.ts']);
      expect(existsSync(path.join(root, 'packages/api'))).toBe(false);
    } finally {
      failure.prune = '';
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('validates pruned-directory recovery paths before mutation and restores interrupted removal', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'template-prune-recover-'));
    try {
      const filename = path.join(root, '.template-transaction.json');
      const journal = {
        version: 1,
        files: [
          {
            path: 'packages/api/src/notes.ts',
            previous: Buffer.from('original').toString('base64'),
            next: null,
          },
        ],
        directories: [],
        prunedDirectories: [
          { path: 'packages', mode: 0o755 },
          { path: 'packages/api', mode: 0o700 },
          { path: 'packages/api/src', mode: 0o750 },
        ],
      };
      writeFileSync(
        filename,
        JSON.stringify({
          ...journal,
          prunedDirectories: [...journal.prunedDirectories, { path: '../outside', mode: 0o755 }],
        }),
      );
      expect(() => recover(root)).toThrow('Unsafe');
      expect(existsSync(path.join(root, 'packages'))).toBe(false);
      writeFileSync(filename, JSON.stringify(journal));
      recover(root);
      expect(readFileSync(path.join(root, 'packages/api/src/notes.ts'), 'utf8')).toBe('original');
      expect(existsSync(filename)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('preserves old bytes when the operating system writes only part of a replacement', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'template-partial-'));
    try {
      writeFileSync(path.join(root, 'existing.txt'), 'original');
      failure.partial = true;
      expect(() =>
        applyFiles(root, new Map([['existing.txt', Buffer.from('replacement')]])),
      ).toThrow('ENOSPC during write');
      expect(readFileSync(path.join(root, 'existing.txt'), 'utf8')).toBe('original');
      expect(existsSync(path.join(root, '.template-transaction.json'))).toBe(false);
      applyFiles(root, new Map([['existing.txt', Buffer.from('retry')]]));
      expect(readFileSync(path.join(root, 'existing.txt'), 'utf8')).toBe('retry');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('rolls back every earlier write and preserves unrelated user changes after an I/O failure', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'template-rollback-'));
    try {
      writeFileSync(path.join(root, 'existing.json'), 'original');
      writeFileSync(path.join(root, 'user.txt'), 'user changes');
      expect(() =>
        applyFiles(
          root,
          new Map([
            ['existing.json', Buffer.from('replacement')],
            ['new/file.ts', Buffer.from('new')],
          ]),
          [],
          (index) => {
            if (index === 1) throw new Error('simulated disk failure');
          },
        ),
      ).toThrow('simulated disk failure');
      expect(readFileSync(path.join(root, 'existing.json'), 'utf8')).toBe('original');
      expect(readFileSync(path.join(root, 'user.txt'), 'utf8')).toBe('user changes');
      expect(existsSync(path.join(root, 'new'))).toBe(false);
      applyFiles(root, new Map([['new/file.ts', Buffer.from('repaired')]]));
      expect(readFileSync(path.join(root, 'new/file.ts'), 'utf8')).toBe('repaired');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('recovers an interrupted transaction without reading an external path', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'template-recover-'));
    try {
      writeFileSync(path.join(root, 'file.txt'), 'partial write');
      writeFileSync(
        path.join(root, '.template-transaction.json'),
        JSON.stringify({
          version: 1,
          files: [
            {
              path: 'file.txt',
              previous: Buffer.from('before').toString('base64'),
              next: digest('partial write'),
            },
          ],
          directories: [],
        }),
      );
      recover(root);
      expect(readFileSync(path.join(root, 'file.txt'), 'utf8')).toBe('before');
      writeFileSync(
        path.join(root, '.template-transaction.json'),
        JSON.stringify({
          version: 1,
          files: [{ path: '../outside', previous: null }],
          directories: [],
        }),
      );
      expect(() => recover(root)).toThrow('Unsafe');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('refuses recovery before any rollback when a user has edited a partially written file', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'template-concurrent-'));
    try {
      writeFileSync(path.join(root, 'first.txt'), 'generated');
      writeFileSync(path.join(root, 'second.txt'), 'user edit after crash');
      writeFileSync(
        path.join(root, '.template-transaction.json'),
        JSON.stringify({
          version: 1,
          files: ['first.txt', 'second.txt'].map((filename) => ({
            path: filename,
            previous: Buffer.from('before').toString('base64'),
            next: digest('generated'),
          })),
          directories: [],
        }),
      );
      expect(() => recover(root)).toThrow('Recovery found a user change');
      expect(readFileSync(path.join(root, 'first.txt'), 'utf8')).toBe('generated');
      expect(readFileSync(path.join(root, 'second.txt'), 'utf8')).toBe('user edit after crash');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('rejects Windows alternate streams and dangling symlink traversal on every platform', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'template-paths-'));
    try {
      for (const filename of ['file:stream', 'CON.txt', 'dir/../file', 'file.'])
        expect(() => safeFile(root, filename)).toThrow('Unsafe relative path');
      symlinkSync(path.join(root, 'missing'), path.join(root, 'link'), 'junction');
      expect(() => safeFile(root, 'link/file')).toThrow('Refusing symlink traversal');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
