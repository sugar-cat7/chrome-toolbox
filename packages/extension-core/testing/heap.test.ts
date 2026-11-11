import { describe, expect, it } from 'vitest';
import { heapParts } from './heap.ts';

// The layout V8 writes in Playwright 1.64's Chromium: six fields a node, its type by index.
const NODE_TYPES = [
  'hidden',
  'array',
  'string',
  'object',
  'code',
  'closure',
  'regexp',
  'number',
  'native',
  'synthetic',
  'concatenated string',
  'sliced string',
  'symbol',
  'bigint',
  'object shape',
];
const meta = {
  node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'detachedness'],
  node_types: [NODE_TYPES, 'string', 'number', 'number', 'number', 'number'],
  edge_fields: ['type', 'name_or_index', 'to_node'],
};
const TYPE = new Map(NODE_TYPES.map((type, index) => [type, index]));
/** A snapshot of nodes given as [type, self size]; names, ids and edges do not matter here. */
const snapshotOf = (nodes: readonly (readonly [string, number])[]) => ({
  snapshot: { meta, node_count: nodes.length, edge_count: 0 },
  nodes: nodes.flatMap(([type, size], id) => [TYPE.get(type) ?? -1, 0, id, size, 0, 0]),
  edges: [],
  strings: [''],
});

describe('heapParts', () => {
  const page: (readonly [string, number])[] = [
    ['synthetic', 0],
    ['object', 100],
    ['string', 40],
    ['closure', 32],
    ['code', 2_000],
    ['native', 500],
  ];
  it.each([
    { case: 'a page', nodes: page, parts: { data: 172, code: 2_000, native: 500 } },
    // V8 optimizing more of the page's functions (the side panel over a 2-hour soak).
    {
      case: 'the same page with hotter code',
      nodes: [...page, ['code', 4_000], ['code', 1_000]] as const,
      parts: { data: 172, code: 7_000, native: 500 },
    },
    // What a leak grows: objects, arrays and strings kept alive.
    {
      case: 'the same page holding more objects',
      nodes: [...page, ['object', 64], ['array', 24], ['concatenated string', 20]] as const,
      parts: { data: 280, code: 2_000, native: 500 },
    },
  ])('sums $case by part', ({ nodes, parts }) => {
    expect(heapParts(snapshotOf(nodes))).toEqual(parts);
  });

  it('refuses what is not a heap snapshot', () => {
    expect(() => heapParts({ nodes: [] })).toThrow('not a V8 heap snapshot');
    expect(() =>
      heapParts({ snapshot: { meta: { ...meta, node_fields: ['name'] } }, nodes: [] }),
    ).toThrow('the heap snapshot has no node type or size');
  });
});
