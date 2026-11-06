# observability

The repository's only JavaScript telemetry SDK owner, from the project template. It wraps OpenTelemetry for finite named operations: traces, logs and duration histograms in OTLP JSON, W3C `traceparent` propagation, bounded export and privacy filtering.

## Status

Implemented, but only the template's `web` sample app uses it. **No extension imports this package, and the extensions send no telemetry.** Adding telemetry to an extension would change the [privacy policy](../../README.md#privacy) and needs an explicit decision first.

| Export                                  | Purpose                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| `createTelemetry(config)`               | Telemetry for one service instance; without an `endpoint` it exports nothing.  |
| `observeHttp`, `observeAdapter`         | Wrap an HTTP handler or a UI adapter call in a span with its `Result` outcome. |
| `OPERATIONS`                            | The fixed operation names (notes, HTTP, Cloudflare bindings, UI start).        |
| `parseTraceparent`, `collectorEndpoint` | Validate incoming trace context and a Collector URL.                           |

The optional local OpenTelemetry Collector and ClickHouse stack, and the read-only investigation tools, are described in [docs/observability.md](../../docs/observability.md).

## Development and tests

From the repository root:

```console
pnpm --filter @chrome-toolbox/observability test
pnpm --filter @chrome-toolbox/observability check
pnpm --filter @chrome-toolbox/observability build
```

`test` runs the Vitest tests in `src/index.test.ts` with an in-memory exporter; no Collector is needed. `build` packs the library with Vite+ (`vp pack`).
