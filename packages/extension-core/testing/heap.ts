// Reads a V8 heap snapshot (CDP `HeapProfiler.takeHeapSnapshot`) for leak checks. Node-only,
// like the rest of testing/: the Playwright fixtures take the snapshot, this sums it.
import { z } from 'zod/mini';

const heapSnapshotSchema = z.object({
  snapshot: z.object({
    meta: z.object({
      node_fields: z.array(z.string()),
      node_types: z.tuple([z.array(z.string())], z.unknown()),
    }),
  }),
  nodes: z.array(z.number()),
});

/**
 * A heap snapshot's self sizes in bytes, in three parts. `code`: bytecode, feedback and
 * optimized code, which V8 keeps adding while the page's functions grow hot (bounded by the
 * page's code, not a leak). `native`: Blink's own objects (DOM, layout, style), outside the JS
 * heap. `data`: everything else, the page's objects, arrays, strings, closures and their shapes:
 * what a leak grows.
 */
export type HeapParts = Readonly<{ data: number; code: number; native: number }>;

/** Sums a parsed heap snapshot by part (see `HeapParts`). */
export function heapParts(snapshot: unknown): HeapParts {
  const parsed = heapSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) throw new Error('not a V8 heap snapshot');
  const { snapshot: header, nodes } = parsed.data;
  const fields = header.meta.node_fields;
  const [types] = header.meta.node_types;
  const typeAt = fields.indexOf('type');
  const sizeAt = fields.indexOf('self_size');
  if (typeAt < 0 || sizeAt < 0) throw new Error('the heap snapshot has no node type or size');
  const parts = { data: 0, code: 0, native: 0 };
  for (let node = 0; node < nodes.length; node += fields.length) {
    const type = types[nodes[node + typeAt] ?? -1];
    const size = nodes[node + sizeAt] ?? 0;
    if (type === 'code') parts.code += size;
    else if (type === 'native') parts.native += size;
    // Synthetic nodes are the snapshot's own roots (size 0).
    else if (type !== 'synthetic') parts.data += size;
  }
  return parts;
}
