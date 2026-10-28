import { observeHttp } from '@starter/observability';
import { failure, publicFailure, errorStatus } from '@starter/contracts';
import start from '@tanstack/react-start/server-entry';
import { compressAsset } from './assets.ts';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return observeHttp(
      request,
      {
        service: env.OTEL_SERVICE_NAME,
        instance: env.OTEL_INSTANCE,
        runId: env.OTEL_RUN_ID,
        version: env.OTEL_VERSION,
        ...(env.OTEL_ENDPOINT ? { endpoint: env.OTEL_ENDPOINT } : {}),
      },
      async (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname.startsWith('/assets/'))
          return compressAsset(request, await env.ASSETS.fetch(request));
        if (pathname === '/health') return Response.json({ ok: true, storage: 'service-binding' });
        if (pathname.startsWith('/api/') || pathname.startsWith('/extensions/')) {
          if (request.method !== 'GET' && env.WRITE_MODE !== 'allow') {
            const error = failure('write_forbidden');
            return Response.json(
              { error: publicFailure(error), requestId: crypto.randomUUID() },
              {
                status: errorStatus(error),
                headers: {
                  'x-diagnostic-id': error.diagnosticId,
                  'x-error-code': publicFailure(error).code,
                },
              },
            );
          }
          return env.API.fetch(request);
        }
        return start.fetch(request);
      },
    );
  },
} satisfies ExportedHandler<Env>;
