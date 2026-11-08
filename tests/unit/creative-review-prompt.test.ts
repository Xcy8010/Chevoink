import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LOCAL_FICTION_REVIEW_GUIDANCE } from '../../api/lib/agent/knowledge/writing.js'
import { SKILL_ROUTER_VERSION } from '../../api/lib/agent/skills/index.js'
import { resolveRuntimeSkillContext } from '../../api/lib/agent/skills/service.js'
import { prepareCreativeReview } from '../../api/lib/agent/tools/creative-review.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { prisma } from '../../api/lib/prisma.js'

vi.mock('../../api/lib/prisma.js', () => ({
  prisma: { $transaction: vi.fn(), chapter: { findFirst: vi.fn() } },
}))
vi.mock('../../api/lib/agent/manuscript-scope.js', () => ({
  assertAgentManuscriptCurrent: vi.fn(),
}))
vi.mock('../../api/lib/agent/skills/service.js', () => ({
  resolveRuntimeSkillContext: vi.fn(),
}))

describe('creative review prompt', () => {
  const content = '她把发言时间让给弟弟。妹妹依旧拒绝。'
  const scope = { chapterId: 'chapter-fixture', creativeFreedom: 'balanced' as const, skillIds: [] }
  const ctx = { userId: 'author-fixture', novelId: 'novel-fixture', runId: 'run-fixture' } as ToolContext

  beforeEach(() => {
    vi.mocked(prisma.chapter.findFirst).mockResolvedValue({
      id: scope.chapterId, title: '周会', content, revision: 1,
    } as never)
    vi.mocked(resolveRuntimeSkillContext).mockResolvedValue({ catalog: [], routerVersion: SKILL_ROUTER_VERSION })
  })

  it('asks for at most three evidenced issues only when a local critique is requested', async () => {
    const end = content.indexOf('妹妹')
    const work = await prepareCreativeReview(ctx, { ...scope, start: 0, end }, 'critique')
    expect(work.system).toContain(LOCAL_FICTION_REVIEW_GUIDANCE)
    expect(work.system).toContain('现稿成立时可以零修改')
    expect(work.content).toContain('她把发言时间让给弟弟。')
    expect(work.content).not.toContain('妹妹依旧拒绝。')
  })

  it('preserves full-chapter and frozen critique instructions', async () => {
    const full = await prepareCreativeReview(ctx, scope, 'critique')
    expect(full.system).not.toContain(LOCAL_FICTION_REVIEW_GUIDANCE)
    expect(full.content).toContain(content)
    const fullRange = await prepareCreativeReview(ctx, { ...scope, start: 0, end: content.length }, 'critique')
    expect(fullRange.system).toBe(full.system)

    vi.mocked(resolveRuntimeSkillContext).mockResolvedValueOnce({ catalog: [], routerVersion: '4.2.0' })
    const frozen = await prepareCreativeReview(ctx, { ...scope, start: 0, end: 5 }, 'critique')
    expect(frozen.system).toBe(full.system)
  })
})
