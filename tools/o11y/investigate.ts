import { investigation } from './policy.ts';
import { query, status } from './local.ts';
const health = await status();
if (!health.queryReady) throw new Error('NOT RUN: read-only query is unavailable; run o11y:status');
const [name, input, ...extra] = process.argv.slice(2);
if (!name || !input || extra.length)
  throw new Error(
    'Provide one investigation tool and its JSON arguments; see docs/observability.md',
  );
const selected = investigation(name, JSON.parse(input) as unknown);
console.log(JSON.stringify({ health, rows: await query(selected.query, selected.params) }));
