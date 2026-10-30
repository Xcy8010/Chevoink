import type { MemoryGraph } from '../../shared/contracts/index.js'

/** Public synthetic graph: intentionally over the old 80-node / 100-semantic-edge cutoffs. */
export const memoryGraphFixture: MemoryGraph = {
  novelId: 'synthetic-graph', version: 'fixture-1', updatedAt: '2026-10-01T00:00:00.000Z',
  nodes: Array.from({ length: 103 }, (_, i) => ({
    id: `node-${String(i).padStart(3, '0')}`, label: `测试实体 ${i + 1}`,
    type: ['character', 'item', 'location', 'organization', 'concept', 'event'][i % 6],
    description: `合成实体 ${i + 1}`, status: 'confirmed', aliases: [], updatedAt: '2026-10-01T00:00:00.000Z',
  })),
  edges: Array.from({ length: 145 }, (_, i) => ({
    id: `relation-${i}`, source: `node-${String(i < 102 ? i : i - 102).padStart(3, '0')}`,
    target: `node-${String(i < 102 ? i + 1 : (i - 102 + 13) % 103).padStart(3, '0')}`,
    type: i % 3 === 0 ? '同行' : i % 3 === 1 ? '持有' : '位于', state: null, confidence: 0.8, sourceId: `synthetic-${i}`,
  })),
}
/** Explicit public hub/community topology, alongside the sparse fixture: still 103 real fixture entities / 145 relations. */
const hubPairs: [number, number][] = [
  ...Array.from({ length: 46 }, (_, i): [number, number] => [0, i + 1]),
  ...Array.from({ length: 27 }, (_, i): [number, number] => [47, i + 48]),
  ...Array.from({ length: 27 }, (_, i): [number, number] => [75, i + 76]),
  [0, 47], [47, 75],
  ...Array.from({ length: 43 }, (_, i): [number, number] => [i + 1, i + 2]),
]
export const memoryGraphHubFixture: MemoryGraph = {
  ...memoryGraphFixture, novelId: 'synthetic-hub-graph', version: 'fixture-hub-1',
  edges: hubPairs.map(([source, target], i) => ({
    id: `hub-relation-${i}`, source: memoryGraphFixture.nodes[source].id, target: memoryGraphFixture.nodes[target].id,
    type: i % 3 === 0 ? '同行' : i % 3 === 1 ? '持有' : '位于', state: null, confidence: 0.8, sourceId: `synthetic-hub-${i}`,
  })),
}
