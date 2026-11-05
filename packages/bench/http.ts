const REQUEST_TIMEOUT_MS = 120_000;

/** POSTs and returns the parsed JSON body; throws a readable error on network, HTTP or JSON failure. */
export async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    const cause = error instanceof Error ? (error.cause ?? error) : error;
    throw new Error(
      `request to ${url} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${url} returned invalid JSON`);
  }
}
