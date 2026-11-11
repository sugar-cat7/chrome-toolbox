# contracts

Portable schemas and the failure contract shared by every package. It depends only on Zod (the tree-shakable `zod/mini` API) and runs in service workers, side panels, the Worker and tests alike.

## Status

Implemented; it comes from the project template and every package uses it.

| File                      | Contents                                                                                                                                                                                                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/result.ts`           | `Result<T, E>` with `Ok` and `Err`; `AppError` (internal code and a 32-character diagnostic ID) made by `failure(code)`; `capture` and `captureSync` turn throwing SDK calls into `Result`; `decode` validates untrusted data; `launch` runs async work from a void browser callback; `PublicError` and its projection. |
| `src/errors.generated.ts` | `INTERNAL_ERRORS` and `PUBLIC_ERRORS`, generated from [`tools/errors/catalog.json`](../../tools/errors/catalog.json). Do not edit by hand.                                                                                                                                                                              |
| `src/index.ts`            | Re-exports the above, plus the notes schemas of the template's sample app (`noteInput`, `noteSchema`, `apiErrorSchema`).                                                                                                                                                                                                |

Expected failures are `Result` values; application code does not `throw` or `catch` them. [docs/errors.md](../../docs/errors.md) describes the contract.

`src/chat.ts` exports `rawChatCommentSchema` and its `RawChatComment` type, author roles and
field limits. It rejects unknown keys, empty ids/text, oversized UTF-16 fields and timestamps
outside nonnegative safe integers. The comment extension extends this contract with its legacy
code-point limits, empty text, numeric times and optional `held` metadata for compatibility.

## Use

```ts
import { z } from 'zod/mini';
import { capture, decode, type Result } from '@chrome-toolbox/contracts';

const healthSchema = z.object({ status: z.literal('ok') });

async function health(baseUrl: string): Promise<Result<{ status: 'ok' }>> {
  const response = await capture(() => fetch(`${baseUrl}/health`), 'network_failed');
  if (!response.ok) return response;
  const body = await capture(() => response.value.json(), 'response_invalid');
  return body.ok ? decode(healthSchema, body.value) : body;
}
```

To add an error code, define it in `tools/errors/catalog.json`, then run `pnpm errors:generate` from the repository root and commit the catalog with the generated files. `pnpm errors:check` reports drift without writing.

## Development and tests

From the repository root:

```console
pnpm --filter @chrome-toolbox/contracts test
pnpm --filter @chrome-toolbox/contracts check
pnpm --filter @chrome-toolbox/contracts build
```

`test` runs the Vitest tests in `src/*.test.ts` (Result helpers, error projection and the schemas). `build` packs the library with Vite+ (`vp pack`).
