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
