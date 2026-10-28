import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

export function safeFile(root: string, relative: string): string {
  if (
    relative.includes('\\') ||
    path.posix.isAbsolute(relative) ||
    /^[a-z]:/iu.test(relative) ||
    relative
      .split('/')
      .some(
        (part) =>
          part === '..' ||
          part === '.' ||
          part === '' ||
          part.includes(':') ||
          part.split('').some((char) => char.charCodeAt(0) < 32) ||
          /[. ]$/u.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
      )
  ) {
    throw new Error(`Unsafe relative path: ${relative}`);
  }
  const base = realpathSync(root);
  let current = base;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error(`Refusing symlink traversal: ${relative}`);
  }
  return current;
}
