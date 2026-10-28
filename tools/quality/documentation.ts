import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { walk } from '../generators/files.ts';

export function documentation(root: string): string[] {
  const errors: string[] = [];
  const files = [
    'README.md',
    'AGENTS.md',
    ...['docs', '.agents', '.github']
      .filter((directory) => existsSync(path.join(root, directory)))
      .flatMap((directory) =>
        walk(path.join(root, directory))
          .filter((filename) => filename.endsWith('.md'))
          .map((filename) => `${directory}/${filename}`),
      ),
  ];
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  for (const filename of files) {
    if (!existsSync(path.join(root, filename))) {
      errors.push(`Missing instruction entry: ${filename}`);
      continue;
    }
    const text = readFileSync(path.join(root, filename), 'utf8');
    if (filename.startsWith('.agents/skills/') && filename.endsWith('/SKILL.md')) {
      const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
      if (!header) errors.push(`${filename}: skill requires YAML frontmatter`);
      else {
        let metadata: unknown;
        try {
          metadata = parse(header[1]!, { strict: true, uniqueKeys: true });
        } catch {
          errors.push(`${filename}: invalid skill YAML frontmatter`);
        }
        const fields =
          metadata && typeof metadata === 'object' && !Array.isArray(metadata)
            ? (metadata as Record<string, unknown>)
            : {};
        const name = fields.name;
        if (
          typeof name !== 'string' ||
          name.length > 64 ||
          !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) ||
          name !== path.basename(path.dirname(filename))
        )
          errors.push(`${filename}: invalid skill name or directory mismatch`);
        const description = fields.description;
        if (
          typeof description !== 'string' ||
          !description.trim() ||
          Array.from(description).length > 1024
        )
          errors.push(`${filename}: skill description must contain 1–1024 characters`);
      }
    }
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
      const target = match[1]?.split('#')[0];
      if (!target || /^(?:https?:|#)/u.test(target)) continue;
      if (!existsSync(path.resolve(root, path.dirname(filename), target)))
        errors.push(`${filename}: broken local reference ${target}`);
    }
    // Commands are code examples; ordinary prose such as "pnpm is" is not an invocation.
    const examples = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```|`([^`\n]+)`/gu)]
      .map((match) => match[1] ?? match[2] ?? '')
      .join('\n');
    for (const match of examples.matchAll(/\bpnpm ([a-z][a-z:-]+)\b/gu)) {
      const command = match[1];
      if (
        command &&
        !['exec', 'install', 'add', 'remove', 'update', 'run'].includes(command) &&
        !manifest.scripts[command]
      )
        errors.push(`${filename}: unknown root command pnpm ${command}`);
    }
  }
  return errors;
}
