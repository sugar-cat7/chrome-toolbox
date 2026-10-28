import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveConfig } from 'vite-plus';
import { format } from 'vite-plus/fmt';

async function main() {
  // Run as an ESM eval in the owning project's cwd so both public SDK imports
  // resolve to that project's installed Vite+, including during cold generation.
  const { entries, sideConfigs } = JSON.parse(readFileSync(0, 'utf8'));
  const config = await resolveConfig({ configFile: path.resolve('vite.config.ts') }, 'build');
  const options = config.fmt;
  const directories = new Set();
  for (const [filename] of entries) {
    let directory = path.dirname(path.resolve(filename));
    while (!directories.has(directory)) {
      directories.add(directory);
      const parent = path.dirname(directory);
      if (directory === parent) break;
      directory = parent;
    }
  }
  const simpleIgnore = (value) =>
    typeof value === 'string' &&
    (/^(?:\*\*\/node_modules\/\*\*|artifacts\/\*\*|\.template\.json)$/u.test(value) ||
      /^packages\/[a-z0-9-]+\/(?:dist\/\*\*|\.cloudflare\/\*\*|\.wrangler\/\*\*|src\/routeTree\.gen\.ts|src-tauri\/(?:target|gen)\/\*\*)$/u.test(
        value,
      ));
  const compatible =
    options &&
    typeof options.singleQuote === 'boolean' &&
    Object.keys(options).every((key) => ['singleQuote', 'ignorePatterns'].includes(key)) &&
    Array.isArray(options.ignorePatterns) &&
    options.ignorePatterns.every(simpleIgnore) &&
    [...directories].every((directory) =>
      sideConfigs.every((filename) => !existsSync(path.join(directory, filename))),
    );
  let output = null;
  if (compatible) {
    output = [];
    for (const [filename, source] of entries) {
      if (options.ignorePatterns.some((pattern) => path.matchesGlob(filename, pattern))) {
        output.push(source);
        continue;
      }
      const result = await format(filename, source, { singleQuote: options.singleQuote });
      if (result.errors.length)
        throw new Error(
          `Generated format failed for ${filename}: ${JSON.stringify(result.errors)}`,
        );
      output.push(result.code);
    }
  }
  // Config/plugin logging cannot be mistaken for the response protocol.
  console.log(`STARTER_FORMAT_BATCH ${JSON.stringify(output)}`);
}

try {
  await main();
} catch (error) {
  console.error(error);
  // Keep the event loop alive for SDK subprocess callbacks before reporting failure.
  process.exitCode = 1;
}
