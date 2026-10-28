import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { documentation } from './documentation.ts';

function inspect(skill: string): string[] {
  const root = mkdtempSync(path.join(os.tmpdir(), 'skill-format-'));
  try {
    mkdirSync(path.join(root, '.agents/skills/example'), { recursive: true });
    for (const [file, text] of Object.entries({
      'package.json': JSON.stringify({ scripts: {} }),
      'README.md': '',
      'AGENTS.md': '',
      '.agents/skills/example/SKILL.md': skill,
    }))
      writeFileSync(path.join(root, file), text);
    return documentation(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it('accepts standard quoted and multiline skill metadata without a custom YAML subset', () => {
  expect(
    inspect(
      '---\nname: "example"\ndescription: >-\n  Develop a feature.\n  Use for application changes.\n---\n\n# Instructions\n',
    ),
  ).toEqual([]);
});

it('rejects missing, malformed or incorrectly identified skill metadata', () => {
  expect(inspect('# Instructions\n')).toContainEqual(
    expect.stringContaining('requires YAML frontmatter'),
  );
  expect(inspect('---\nname: [\ndescription: Task\n---\n')).toContainEqual(
    expect.stringContaining('invalid skill YAML'),
  );
  expect(inspect('---\nname: example\nname: example\ndescription: Task\n---\n')).toContainEqual(
    expect.stringContaining('invalid skill YAML'),
  );
  for (const name of ['wrong', 'Example', 'example--name', '-example', 'a'.repeat(65)])
    expect(inspect(`---\nname: ${name}\ndescription: Task\n---\n`)).toContainEqual(
      expect.stringContaining('invalid skill name'),
    );
  for (const description of ['""', '"   "', 'false', 'a'.repeat(1025)])
    expect(inspect(`---\nname: example\ndescription: ${description}\n---\n`)).toContainEqual(
      expect.stringContaining('skill description'),
    );
});
