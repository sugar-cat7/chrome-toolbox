import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { flags } from '../generators/options.ts';
import { workspacePackages } from '../quality/graph.ts';
import { contentId } from '../quality/gate.ts';
import { pnpm } from '../process.ts';
import { digest, walk } from '../generators/files.ts';
import { approvedSmokeUrl, requireUpstreamReceipt } from './deployment.ts';

const root = process.cwd();
let operation = process.argv[2];
if (operation !== 'preflight' && operation !== 'deploy')
  throw new Error('Expected preflight|deploy');
const input = flags(process.argv.slice(3));
for (const key of Object.keys(input))
  if (!['target', 'environment', 'dry-run', 'smoke-url'].includes(key))
    throw new Error(`Unknown deployment flag --${key}`);
if (input['dry-run']) operation = 'preflight';
if (!['local', 'dev', 'production'].includes(String(input.environment)))
  throw new Error('Explicit --environment local|dev|production is required');
const pkg = workspacePackages(root).find(
  (value) =>
    value.directory === input.target ||
    path.basename(value.directory) === input.target ||
    value.name === input.target,
);
if (!pkg) throw new Error('Explicit --target must identify a selected package');
if (pkg.runtime !== 'worker') {
  if (operation === 'deploy')
    throw new Error(
      'This package has no Cloudflare deployment; see docs/native.md for unsigned Desktop builds',
    );
  console.log(
    JSON.stringify(
      {
        target: pkg.name,
        status: 'not_required',
        reason:
          'Selected package has no Cloudflare runtime. Native builds and public distribution are separate; see docs/native.md.',
        deployed: false,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
if (operation === 'deploy' && input.environment !== 'dev')
  throw new Error(
    'This entry deploys approved dev environments only; production requires a separate authorized workflow',
  );
const cwd = path.join(root, pkg.directory);
const before = contentId(root);
await pnpm(['check'], { cwd: root });
await pnpm(['--filter', pkg.name, 'test'], { cwd: root });
await pnpm(['--filter', pkg.name, 'test:runtime'], { cwd: root });
await pnpm(['--filter', pkg.name, 'build'], {
  cwd: root,
  env: {
    ...process.env,
    STARTER_BUILD_MODE: input.environment === 'local' ? 'offline' : String(input.environment),
  },
});
const config = JSON.parse(
  readFileSync(path.join(cwd, '.cloudflare/output/v0/workers/default/worker.config.json'), 'utf8'),
) as { env?: Record<string, { type: string; value?: string }>; domains?: string[] };
if (input.environment !== 'local' && config.env?.WRITE_MODE?.value !== 'deny')
  throw new Error('Remote artifact must deny unauthenticated writes');
if (input.environment !== 'local' && !process.env.CLOUDFLARE_ACCOUNT_ID)
  throw new Error(
    'CLOUDFLARE_ACCOUNT_ID is missing. Configure a named approved dev account and resource IDs; see docs/cloudflare.md. No deployment occurred.',
  );
const record = {
  contentId: before,
  target: pkg.name,
  environment: input.environment,
  configSource: `${pkg.directory}/cloudflare.config.ts`,
  artifact: `${pkg.directory}/.cloudflare/output/v0`,
  deployed: false,
  smoked: false,
  account: input.environment === 'local' ? null : digest(process.env.CLOUDFLARE_ACCOUNT_ID!),
  artifactId: digest(
    Buffer.concat(
      walk(path.join(cwd, '.cloudflare/output/v0')).flatMap((file) => [
        Buffer.from(`${file}\0`),
        readFileSync(path.join(cwd, '.cloudflare/output/v0', file)),
      ]),
    ),
  ),
};
if (contentId(root) !== before)
  throw new Error('Source changed during preflight; rerun on the final input');
mkdirSync(path.join(root, 'artifacts'), { recursive: true });
writeFileSync(
  path.join(root, 'artifacts/deploy-preflight.json'),
  `${JSON.stringify(record, null, 2)}\n`,
);
console.log(JSON.stringify(record, null, 2));
if (operation === 'deploy') {
  if (!process.env.CLOUDFLARE_API_TOKEN)
    throw new Error('CLOUDFLARE_API_TOKEN is missing; no deployment occurred');
  const smokeUrl = approvedSmokeUrl(input['smoke-url'], config.domains);
  const receipts = path.join(root, 'artifacts/deploy');
  for (const upstream of workspacePackages(root).filter(
    (candidate) => candidate.runtime === 'worker' && pkg.dependencies.includes(candidate.name),
  )) {
    const filename = path.join(receipts, path.basename(upstream.directory), 'dev.json');
    if (!existsSync(filename))
      throw new Error(
        `Missing upstream receipt for ${upstream.name}; deploy and smoke the API first`,
      );
    const receipt = requireUpstreamReceipt(JSON.parse(readFileSync(filename, 'utf8')) as unknown, {
      contentId: before,
      account: record.account!,
      target: upstream.name,
    });
    await pnpm(['--filter', upstream.name, 'build'], {
      cwd: root,
      env: { ...process.env, STARTER_BUILD_MODE: 'dev' },
    });
    const upstreamOutput = path.join(root, upstream.directory, '.cloudflare/output/v0');
    const upstreamConfig = JSON.parse(
      readFileSync(path.join(upstreamOutput, 'workers/default/worker.config.json'), 'utf8'),
    ) as { domains?: string[] };
    const upstreamUrl = approvedSmokeUrl(receipt.smokeUrl, upstreamConfig.domains);
    const previous = JSON.parse(readFileSync(filename, 'utf8')) as { artifactId: string };
    const expectedArtifact = digest(
      Buffer.concat(
        walk(upstreamOutput).flatMap((file) => [
          Buffer.from(`${file}\0`),
          readFileSync(path.join(upstreamOutput, file)),
        ]),
      ),
    );
    if (previous.artifactId !== expectedArtifact)
      throw new Error(
        'Upstream artifact/configuration changed; deploy and smoke the API again before the Web',
      );
    const response = await fetch(upstreamUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok || !((await response.json()) as { ok?: boolean }).ok)
      throw new Error('Upstream dev health smoke failed; no downstream deployment occurred');
  }
  // Prebuilt output above corresponds to the successful checks. Never auto-provision resources.
  if (contentId(root) !== before)
    throw new Error('Source changed before deployment; rerun the preflight');
  await pnpm(
    ['--filter', pkg.name, 'exec', 'cf', 'deploy', '--prebuilt', '--no-provision', '-m', 'dev'],
    { cwd: root },
  );
  record.deployed = true;
  const filename = path.join(receipts, path.basename(pkg.directory), 'dev.json');
  mkdirSync(path.dirname(filename), { recursive: true });
  const receipt = { ...record, smokeUrl: smokeUrl.href, deployedAt: new Date().toISOString() };
  writeFileSync(filename, `${JSON.stringify(receipt, null, 2)}\n`);
  const response = await fetch(smokeUrl, {
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok || !((await response.json()) as { ok?: boolean }).ok)
    throw new Error(
      'Dev deployment completed but health smoke failed; inspect the recorded receipt',
    );
  receipt.smoked = true;
  writeFileSync(filename, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log('Approved dev deployment and health smoke completed');
}
