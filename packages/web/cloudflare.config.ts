import { bindings, defineConfig } from 'cf/config';
import * as entrypoint from './src/server.ts' with { type: 'cf-worker' };

export default defineConfig(({ mode }) => {
  const environment = mode === 'offline' ? 'local' : (mode ?? 'local');
  if (!['local', 'dev', 'production'].includes(environment))
    throw new Error(`Unknown environment: ${environment}`);
  return {
    worker: {
      name: 'super-starter-web',
      entrypoint,
      compatibilityDate: '2026-10-09',
      compatibilityFlags: ['nodejs_compat'],
      workersDev: false,
      assets: { runWorkerFirst: ['/assets/*'] },
      env: {
        OTEL_SERVICE_NAME: bindings.text('super-starter-web'),
        OTEL_INSTANCE: bindings.text('super-starter'),
        OTEL_RUN_ID: bindings.text(
          environment === 'local' ? (process.env.STARTER_OTEL_RUN_ID ?? 'local') : environment,
        ),
        OTEL_VERSION: bindings.text(process.env.STARTER_OTEL_VERSION ?? 'development'),
        OTEL_ENDPOINT: bindings.text(
          environment === 'local' ? (process.env.STARTER_OTEL_ENDPOINT ?? '') : '',
        ),
        ASSETS: bindings.assets(),
        WRITE_MODE: bindings.text(environment === 'local' ? 'allow' : 'deny'),
        API: bindings.worker({ worker: 'super-starter-api' }),
      },
    },
  };
});
