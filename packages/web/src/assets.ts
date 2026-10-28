// Compress the actual public asset response, in local preview and deployed Workers alike.
// The body is already encoded; workerd must not encode it a second time.
export async function compressAsset(request: Request, response: Response): Promise<Response> {
  if (
    request.method !== 'GET' ||
    request.headers.has('range') ||
    response.status !== 200 ||
    !response.body ||
    response.headers.has('content-encoding') ||
    /\bno-transform\b/iu.test(response.headers.get('cache-control') ?? '') ||
    !/^(?:text\/(?:javascript|css)|application\/javascript|image\/svg\+xml)(?:;|$)/iu.test(
      response.headers.get('content-type') ?? '',
    )
  )
    return response;
  const headers = new Headers(response.headers);
  const vary = headers.get('vary');
  if (!vary?.split(',').some((name) => name.trim().toLowerCase() === 'accept-encoding'))
    headers.set('vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
  const encodings = new Map(
    (request.headers.get('accept-encoding') ?? '').split(',').map((entry) => {
      const [name, ...parameters] = entry.trim().toLowerCase().split(';');
      const quality = parameters.find((parameter) => parameter.trim().startsWith('q='));
      const value = quality ? Number(quality.trim().slice(2)) : 1;
      return [name?.trim(), Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0];
    }),
  );
  const acceptsGzip = (encodings.get('gzip') ?? encodings.get('*') ?? 0) > 0;
  const acceptsIdentity = (encodings.get('identity') ?? (encodings.get('*') === 0 ? 0 : 1)) > 0;
  if (!acceptsGzip && !acceptsIdentity) {
    await response.body.cancel();
    return new Response('No acceptable asset encoding', {
      status: 406,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        vary: headers.get('vary')!,
        'cache-control': 'no-store',
        'accept-encoding': 'gzip, identity',
      },
    });
  }
  if (!acceptsGzip)
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  headers.set('content-encoding', 'gzip');
  headers.delete('content-length');
  const etag = headers.get('etag');
  if (etag && !etag.startsWith('W/')) headers.set('etag', `W/${etag}`);
  return new Response(response.body.pipeThrough(new CompressionStream('gzip')), {
    status: response.status,
    statusText: response.statusText,
    headers,
    encodeBody: 'manual',
  });
}
