import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseSync } from 'oxc-parser';
import { walk } from '../generators/files.ts';
import { workspacePackages } from './graph.ts';

type Node = Record<string, unknown> & { type: string; start: number; end: number };
const node = (value: unknown): Node | undefined =>
  value !== null && typeof value === 'object' && 'type' in value ? (value as Node) : undefined;
const name = (value: unknown): string => {
  const item = node(value);
  const valueName = item?.name ?? item?.value;
  return typeof valueName === 'string' || typeof valueName === 'number' ? `${valueName}` : '';
};
const member = (value: unknown): string => {
  const item = node(value);
  return item?.type === 'MemberExpression' ? name(item.property) : name(value);
};

// File/function exceptions are transport or void UI event owners, declared in the
// owning manifest with a reason. They do not permit throw/catch, unchecked Result,
// raw error messages, SDK initialization, or privacy violations.
export function failureHandling(root: string): string[] {
  // Small import-graph fixtures and third-party trees have no Result contract.
  // Real project checks separately require and validate the error catalog.
  if (!existsSync(path.join(root, 'tools/errors/catalog.json'))) return [];
  const errors: string[] = [];
  const packages = workspacePackages(root);
  const signatures = new Map<string, Set<string>>();
  for (const pkg of packages) {
    const source = path.join(root, pkg.directory, 'src');
    if (!existsSync(source)) continue;
    for (const file of walk(source).filter((file) => /\.[cm]?[jt]sx?$/u.test(file))) {
      const absolute = path.join(source, file);
      const text = readFileSync(absolute, 'utf8');
      const found = new Set<string>();
      const collect = (value: unknown, parent?: Node): void => {
        if (Array.isArray(value)) {
          value.forEach((child) => collect(child, parent));
          return;
        }
        const item = node(value);
        if (!item) return;
        if (
          ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(
            item.type,
          )
        ) {
          const annotation = node(item.returnType);
          if (annotation && /\bResult\s*</u.test(text.slice(annotation.start, annotation.end))) {
            const identity =
              name(item.id) ||
              (parent?.type === 'VariableDeclarator'
                ? name(parent.id)
                : parent?.type === 'Property' || parent?.type === 'MethodDefinition'
                  ? name(parent.key)
                  : '');
            if (identity) found.add(identity);
          }
        }
        Object.values(item).forEach((child) => collect(child, item));
      };
      collect(parseSync(absolute, text).program);
      signatures.set(absolute, found);
    }
  }
  for (const pkg of packages) {
    const source = path.join(root, pkg.directory, 'src');
    if (!existsSync(source)) continue;
    const manifest = JSON.parse(
      readFileSync(path.join(root, pkg.directory, 'package.json'), 'utf8'),
    ) as { starter?: { resultBoundaries?: Record<string, string>; role?: string } };
    const boundaries = manifest.starter?.resultBoundaries ?? {};
    const telemetryOwnerPackage =
      pkg.directory === 'packages/observability' && pkg.runtime === 'library';
    if (manifest.starter?.role === 'observability' && !telemetryOwnerPackage)
      errors.push(
        `${pkg.directory}: only the shared observability library may own the telemetry SDK`,
      );
    for (const [boundary, reason] of Object.entries(boundaries))
      if (
        !/^src\/.+:[\w]+$/u.test(boundary) ||
        typeof reason !== 'string' ||
        reason.trim().length < 20
      )
        errors.push(`${pkg.directory}: invalid Result boundary declaration ${boundary}`);
    const observed = new Set<string>();
    for (const relative of walk(source).filter(
      (file) =>
        /\.[cm]?[jt]sx?$/u.test(file) &&
        !/\.(?:test|spec)\./u.test(file) &&
        !(
          file === 'routeTree.gen.ts' &&
          pkg.runtime === 'worker' &&
          pkg.dependencies.includes('@tanstack/react-start')
        ) &&
        !(file === 'errors.generated.ts' && pkg.directory === 'packages/contracts'),
    )) {
      const filename = `${pkg.directory}/src/${relative}`;
      const text = readFileSync(path.join(root, filename), 'utf8');
      const parsed = parseSync(filename, text);
      if (parsed.errors.length) {
        errors.push(`${filename}: failure-handling parse failed`);
        continue;
      }
      const resultOwner = pkg.directory === 'packages/contracts' && relative === 'result.ts';
      const telemetryOwner = telemetryOwnerPackage && manifest.starter?.role === 'observability';
      const resultFunctions = new Set([
        'Ok',
        'Err',
        'capture',
        'captureSync',
        'capturePublic',
        'decode',
        'decodePublicError',
      ]);
      for (const signature of signatures.get(path.join(root, filename)) ?? [])
        resultFunctions.add(signature);
      const importedHelpers = new Map<string, string>();
      const report = (item: Node, message: string) =>
        errors.push(`${filename}:${text.slice(0, item.start).split('\n').length}: ${message}`);
      const visit = (value: unknown, ancestors: Node[]): void => {
        if (Array.isArray(value)) {
          value.forEach((child) => visit(child, ancestors));
          return;
        }
        const item = node(value);
        if (!item) return;
        const parent = ancestors.at(-1);
        if (
          item.type === 'ImportDeclaration' &&
          /\/(?:contracts|observability)$/u.test(name(item.source))
        ) {
          for (const specifier of (item.specifiers as unknown[]) ?? []) {
            const spec = node(specifier);
            if (spec) importedHelpers.set(name(spec.local), name(spec.imported));
          }
        }
        if (item.type === 'ImportDeclaration') {
          const specifier = name(item.source);
          const workspace = packages.find((candidate) => candidate.name === specifier);
          const stem = specifier.startsWith('.')
            ? path.resolve(root, path.dirname(filename), specifier)
            : workspace
              ? path.join(root, workspace.directory, 'src/index.ts')
              : '';
          const resolved = [stem, `${stem}.ts`, `${stem}.tsx`, path.join(stem, 'index.ts')].find(
            (file) => signatures.has(file),
          );
          if (resolved)
            for (const value of (item.specifiers as unknown[]) ?? []) {
              const imported = node(value);
              if (imported?.type === 'ImportNamespaceSpecifier')
                for (const signature of signatures.get(resolved) ?? [])
                  resultFunctions.add(`${name(imported.local)}.${signature}`);
              if (imported && signatures.get(resolved)?.has(name(imported.imported)))
                resultFunctions.add(name(imported.local));
            }
        }
        if (!resultOwner && !telemetryOwner && item.type === 'ThrowStatement')
          report(
            item,
            'Expected failures must return Result; throw belongs only to the normalization owner',
          );
        if (!resultOwner && item.type === 'CatchClause')
          report(
            item,
            'Normalize SDK rejection with capture at ingress; do not catch or swallow failures in application code',
          );
        if (!resultOwner && item.type === 'CallExpression' && member(item.callee) === 'catch')
          report(item, 'Promise rejection handling belongs to the Result normalization owner');
        if (!resultOwner && item.type === 'CallExpression' && member(item.callee) === 'then') {
          const rejection = node((item.arguments as unknown[])?.[1]);
          if (
            rejection &&
            !(rejection.type === 'Identifier' && name(rejection) === 'undefined') &&
            !(rejection.type === 'Literal' && rejection.value === null)
          )
            report(item, 'Promise rejection handling belongs to the Result normalization owner');
        }
        if (
          !telemetryOwner &&
          item.type === 'ImportDeclaration' &&
          /^(?:@opentelemetry\/|pino(?:\/|$)|winston(?:\/|$)|bunyan(?:\/|$))/u.test(
            name(item.source),
          )
        )
          report(item, 'OTel SDK and logger initialization belong to the observability workspace');
        if (
          !telemetryOwner &&
          item.type === 'CallExpression' &&
          name(node(item.callee)?.object) === 'console'
        )
          report(item, 'Application telemetry must use the privacy-filtered observability owner');
        if (
          !resultOwner &&
          ['TSAsExpression', 'TSTypeAssertion'].includes(item.type) &&
          /\bResult\b/u.test(
            text.slice(node(item.typeAnnotation)?.start, node(item.typeAnnotation)?.end),
          )
        )
          report(item, 'A type assertion cannot manufacture a handled Result');
        if (
          ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(
            item.type,
          ) &&
          item.async
        ) {
          const identity =
            name(item.id) ||
            (parent?.type === 'VariableDeclarator'
              ? name(parent.id)
              : parent?.type === 'Property' || parent?.type === 'MethodDefinition'
                ? name(parent.key)
                : parent?.type === 'CallExpression' && member(parent.callee) === 'useCallback'
                  ? name(
                      ancestors.findLast((ancestor) => ancestor.type === 'VariableDeclarator')?.id,
                    )
                  : '');
          const key = `src/${relative}:${identity}`;
          if (Object.hasOwn(boundaries, key)) observed.add(key);
          const annotation = node(item.returnType);
          const returnText = annotation ? text.slice(annotation.start, annotation.end) : '';
          const callbackOwner = ancestors.some(
            (ancestor) =>
              ancestor.type === 'CallExpression' &&
              ['capture', 'capturePublic', 'launch', 'observeHttp', 'observeAdapter'].includes(
                importedHelpers.get(member(ancestor.callee)) ?? member(ancestor.callee),
              ),
          );
          // Contextually typed adapter methods are checked by the shared Result port.
          const adapter = ancestors.some(
            (ancestor) =>
              ancestor.type === 'VariableDeclarator' &&
              /\bNotesAdapter\b/u.test(
                text.slice(node(ancestor.id)?.start, node(ancestor.id)?.end),
              ),
          );
          if (
            !resultOwner &&
            !telemetryOwner &&
            !/\bResult\s*</u.test(returnText) &&
            !Object.hasOwn(boundaries, key) &&
            !callbackOwner &&
            !adapter
          )
            report(
              item,
              'Async application ports must explicitly return Promise<Result<...>> or declare an exact transport/event boundary',
            );
          if (/\bResult\s*</u.test(returnText) && identity) resultFunctions.add(identity);
        }
        if (item.type === 'ExpressionStatement') {
          let expression = node(item.expression);
          while (
            expression &&
            (expression.type === 'AwaitExpression' ||
              (expression.type === 'UnaryExpression' && expression.operator === 'void'))
          )
            expression = node(expression.argument);
          if (
            expression?.type === 'CallExpression' &&
            (resultFunctions.has(
              importedHelpers.get(member(expression.callee)) ?? member(expression.callee),
            ) ||
              resultFunctions.has(
                `${name(node(expression.callee)?.object)}.${member(expression.callee)}`,
              ))
          )
            report(item, 'Result is discarded; inspect ok and propagate or present the failure');
        }
        Object.values(item).forEach((child) => visit(child, [...ancestors, item]));
      };
      visit(parsed.program, []);
    }
    for (const key of Object.keys(boundaries))
      if (!observed.has(key))
        errors.push(`${pkg.directory}: stale or unobserved Result boundary ${key}`);
    if (pkg.runtime === 'desktop') {
      const native = path.join(root, pkg.directory, 'src-tauri/src');
      for (const file of walk(native).filter(
        (entry) => entry.endsWith('.rs') && entry !== 'errors_generated.rs',
      )) {
        const text = readFileSync(path.join(native, file), 'utf8').split('#[cfg(test)]')[0]!;
        if (/Result\s*<[^;\n]*,\s*String\s*>/u.test(text))
          errors.push(
            `${pkg.directory}/src-tauri/src/${file}: native failures must use generated AppError or PublicError`,
          );
        if (/let\s+_\s*=\s*[^;]*(?:\.map_err\(|\b(?:write|send|export)\w*\()/u.test(text))
          errors.push(
            `${pkg.directory}/src-tauri/src/${file}: native fallible work must not discard Result`,
          );
      }
    }
  }
  return errors;
}
