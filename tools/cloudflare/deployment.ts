export function approvedSmokeUrl(input: unknown, domains: string[] | undefined): URL {
  if (typeof input !== 'string')
    throw new Error('Deploy requires --smoke-url for the explicitly approved dev /health endpoint');
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Invalid dev smoke URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/health' ||
    !domains?.includes(url.hostname)
  )
    throw new Error(
      'Smoke URL must be HTTPS /health on a custom domain declared in this target SDK config, without credentials/query/fragment',
    );
  return url;
}

export function requireUpstreamReceipt(
  receipt: unknown,
  expected: { contentId: string; account: string; target: string },
): { smokeUrl: string } {
  const value = receipt as {
    contentId?: string;
    account?: string;
    target?: string;
    environment?: string;
    deployed?: boolean;
    smoked?: boolean;
    smokeUrl?: string;
  };
  if (
    value.contentId !== expected.contentId ||
    value.account !== expected.account ||
    value.target !== expected.target ||
    value.environment !== 'dev' ||
    !value.deployed ||
    !value.smoked ||
    !value.smokeUrl
  )
    throw new Error(
      'Upstream needs a successful dev deploy and smoke receipt for this source/account; deploy the API first',
    );
  return { smokeUrl: value.smokeUrl };
}
