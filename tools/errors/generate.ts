import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspacePackages, type WorkspacePackage } from '../quality/graph.ts';
import { formatFiles } from '../generators/format.ts';
import { digest } from '../generators/files.ts';
import type { TemplateState } from '../generators/render.ts';

type Policy = {
  status: number;
  class: string;
  retry: 'never' | 'owner_only';
  message: string;
  remediation: string;
};
type Catalog = {
  version: number;
  public: Record<string, Policy>;
  internal: Record<string, string>;
};
const validCode = (code: string) => /^[a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)*$/u.test(code);
const rustName = (value: string) =>
  value
    .split('_')
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('');

export function readCatalog(root: string): Catalog {
  const raw: unknown = JSON.parse(
    readFileSync(path.join(root, 'tools/errors/catalog.json'), 'utf8'),
  );
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Invalid error catalog');
  const catalog = raw as Catalog;
  const object = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value);
  if (
    Object.keys(catalog).some((key) => !['version', 'public', 'internal'].includes(key)) ||
    catalog.version !== 1 ||
    !object(catalog.public) ||
    !object(catalog.internal)
  )
    throw new Error('Invalid error catalog version');
  for (const [code, policy] of Object.entries(catalog.public)) {
    if (
      !validCode(code) ||
      !policy ||
      !object(policy) ||
      Object.keys(policy).some(
        (key) => !['status', 'class', 'retry', 'message', 'remediation'].includes(key),
      ) ||
      !Number.isInteger(policy.status) ||
      policy.status < 400 ||
      policy.status > 599 ||
      !['validation', 'forbidden', 'not_found', 'transient', 'cancelled', 'unknown'].includes(
        policy.class,
      ) ||
      !['never', 'owner_only'].includes(policy.retry) ||
      typeof policy.message !== 'string' ||
      !policy.message ||
      !policy.message.isWellFormed() ||
      typeof policy.remediation !== 'string' ||
      !policy.remediation ||
      !policy.remediation.isWellFormed()
    )
      throw new Error(`Invalid public error policy: ${code}`);
  }
  if (!Object.keys(catalog.public).length || !Object.keys(catalog.internal).length)
    throw new Error('Empty error catalog');
  for (const [code, target] of Object.entries(catalog.internal)) {
    if (!validCode(code) || typeof target !== 'string' || !Object.hasOwn(catalog.public, target))
      throw new Error(`Unmapped internal error: ${code}`);
  }
  const variants = Object.keys(catalog.internal).map(rustName);
  if (new Set(variants).size !== variants.length)
    throw new Error('Invalid colliding Rust error codes');
  return catalog;
}

export function generatedErrors(
  root: string,
  selected: Pick<WorkspacePackage, 'directory' | 'runtime'>[] = workspacePackages(root),
  cold = false,
  format = true,
): Map<string, Buffer> {
  const catalog = readCatalog(root);
  const banner = '// Generated from tools/errors/catalog.json by errors:generate. Do not edit.\n';
  const files = new Map<string, Buffer>();
  const packages = selected;
  const contracts = packages.find((pkg) => pkg.directory === 'packages/contracts');
  if (contracts)
    files.set(
      `${contracts.directory}/src/errors.generated.ts`,
      Buffer.from(
        `${banner}export const PUBLIC_ERRORS = ${JSON.stringify(catalog.public, null, 2)} as const;\nexport const INTERNAL_ERRORS = ${JSON.stringify(catalog.internal, null, 2)} as const;\nexport type PublicErrorCode = keyof typeof PUBLIC_ERRORS;\nexport type InternalErrorCode = keyof typeof INTERNAL_ERRORS;\n`,
      ),
    );
  const literal = (value: string) =>
    `"${Array.from(value)
      .map((char) => {
        if (char === '"' || char === '\\') return `\\${char}`;
        const code = char.codePointAt(0)!;
        return code < 32 || code === 127 ? `\\u{${code.toString(16)}}` : char;
      })
      .join('')}"`;
  const rust = `${banner}use serde::Serialize;\n#[derive(Clone, Copy, Debug)]\n#[allow(dead_code, reason = "The generated catalog contains codes for every runtime, including optional adapters")]\npub enum ErrorCode {\n${Object.keys(
    catalog.internal,
  )
    .map((code) => `    ${rustName(code)},`)
    .join(
      '\n',
    )}\n}\n#[derive(Clone, Debug, Serialize)]\n#[serde(rename_all = "camelCase")]\npub struct PublicError {\n    pub code: &'static str,\n    pub message: &'static str,\n    pub failure_class: &'static str,\n    pub retry: &'static str,\n    pub remediation: &'static str,\n    pub diagnostic_id: String,\n}\n#[derive(Clone, Debug)]\npub struct AppError { pub code: ErrorCode, pub diagnostic_id: String }\nimpl AppError {\n    pub fn new(code: ErrorCode) -> Self { Self { code, diagnostic_id: uuid::Uuid::new_v4().simple().to_string() } }\n    pub fn public(&self) -> PublicError {\n        let (code, message, failure_class, retry, remediation) = match self.code {\n${Object.entries(
    catalog.internal,
  )
    .map(([code, target]) => {
      const p = catalog.public[target]!;
      return `            ErrorCode::${rustName(code)} => (${[target, p.message, p.class, p.retry, p.remediation].map(literal).join(', ')}),`;
    })
    .join(
      '\n',
    )}\n        };\n        PublicError { code, message, failure_class, retry, remediation, diagnostic_id: self.diagnostic_id.clone() }\n    }\n    pub fn internal_code(&self) -> &'static str { match self.code {\n${Object.keys(
    catalog.internal,
  )
    .map((code) => `        ErrorCode::${rustName(code)} => ${literal(code)},`)
    .join(
      '\n',
    )}\n    } }\n}\nimpl std::fmt::Display for AppError { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{} ({})", self.internal_code(), self.diagnostic_id) } }\nimpl std::error::Error for AppError {}\n`;
  for (const pkg of packages.filter((entry) => entry.runtime === 'desktop')) {
    if (!format) {
      files.set(`${pkg.directory}/src-tauri/src/errors_generated.rs`, Buffer.from(rust));
      continue;
    }
    const formatted = spawnSync('rustfmt', ['--edition', '2024', '--emit', 'stdout'], {
      cwd: existsSync(path.join(root, pkg.directory, 'src-tauri'))
        ? path.join(root, pkg.directory, 'src-tauri')
        : root,
      input: rust,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (formatted.status !== 0 && !cold)
      throw new Error('Generated Rust formatting failed; run selected native env:setup');
    files.set(
      `${pkg.directory}/src-tauri/src/errors_generated.rs`,
      Buffer.from(formatted.status === 0 ? formatted.stdout : rust),
    );
  }
  files.set(
    'docs/errors.generated.md',
    Buffer.from(
      `# Error catalog\n\nGenerated by \`pnpm errors:generate\`; edit \`tools/errors/catalog.json\`.\n\n| Public code | HTTP | Class | Retry owner | Message |\n| --- | --- | --- | --- | --- |\n${Object.entries(
        catalog.public,
      )
        .map(([code, p]) => `| ${code} | ${p.status} | ${p.class} | ${p.retry} | ${p.message} |`)
        .join('\n')}\n\nInternal to public projection:\n\n${Object.entries(catalog.internal)
        .map(([code, target]) => `- \`${code}\` → \`${target}\``)
        .join('\n')}\n`,
    ),
  );
  return format ? formatFiles(root, files) : files;
}

// Setup may finalize a cold Rust output only while it still matches the generator's
// ownership hash. Explicit errors:generate is the deliberate code generation command.
export function writeGeneratedErrors(root: string, protect = false): void {
  const files = generatedErrors(root);
  const filename = path.join(root, '.template.json');
  const state = existsSync(filename)
    ? (JSON.parse(readFileSync(filename, 'utf8')) as TemplateState)
    : undefined;
  if (protect)
    for (const [file, expected] of files) {
      const target = path.join(root, file);
      if (
        existsSync(target) &&
        !readFileSync(target).equals(expected) &&
        digest(readFileSync(target)) !== state?.managed[file]
      )
        throw new Error(
          `User changed generated error output: ${file}; review it before errors:generate`,
        );
    }
  for (const [file, contents] of files) {
    writeFileSync(path.join(root, file), contents);
    if (state) state.managed[file] = digest(contents);
  }
  if (state) writeFileSync(filename, `${JSON.stringify(state, null, 2)}\n`);
}

export function checkGeneratedErrors(root: string, selected = workspacePackages(root)): string[] {
  return [...generatedErrors(root, selected)]
    .filter(
      ([file, expected]) =>
        !existsSync(path.join(root, file)) || !readFileSync(path.join(root, file)).equals(expected),
    )
    .map(([file]) => `${file}: error catalog drift; run pnpm errors:generate`);
}

if (process.argv[1]?.endsWith(`${path.sep}generate.ts`)) {
  const root = process.cwd();
  if (process.argv.includes('--check')) {
    const errors = checkGeneratedErrors(root);
    if (errors.length) throw new Error(errors.join('\n'));
  } else writeGeneratedErrors(root);
}
