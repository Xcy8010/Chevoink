import { describe, expect, it } from 'vitest'
import type { AgentArtifact } from '../../src/features/studio/types.js'
import { mergeHydratedArtifactsWithCurrentSnapshot } from '../../src/features/studio/lib/agent-persistence.js'

const artifact = (input: Partial<AgentArtifact> & Pick<AgentArtifact, 'id' | 'title' | 'content'>): AgentArtifact => ({
  id: input.id,
  title: input.title,
  content: input.content,
  task: 'plan-chapter',
  type: 'chapter_plan',
  createdAt: '2026-11-23T08:00:00.000Z',
  status: 'ready',
  runId: 'run-a',
  sessionId: 'session-a',
  ...input,
})

describe('任务工件历史补载', () => {
  it('迟到的历史保留改名与刻意清空的计划，同一轮的其他工件保持独立', () => {
    const original = artifact({ id: 'local-a', backendArtifactId: 'a', title: '原计划', content: '原文' })
    const edited = { ...original, title: '新计划', content: '', rawContent: '', planLocalDraft: {} }
    const second = { ...original, id: 'local-b', backendArtifactId: 'b', title: '同轮另一份计划' }
    const merged = mergeHydratedArtifactsWithCurrentSnapshot([{ ...original, id: 'history-a' }], [original], [edited, second])
    expect(merged[0]).toMatchObject({ title: '新计划', content: '', rawContent: '', backendArtifactId: 'a' })
    expect(merged[1]).toEqual(second)
  })

  it('保留请求期间的新工件和本地改稿，同时吸收服务端历史', () => {
    const original = artifact({ id: 'history-run-a-artifact-a', backendArtifactId: 'artifact-a', title: '旧计划', content: '快照正文' })
    const server = artifact({ id: 'history-run-a-artifact-a', backendArtifactId: 'artifact-a', title: '旧计划', content: '服务器正文' })
    const edited = { ...original, content: '用户改过的正文', rawContent: '用户改过的原文' }
    const createdWhileLoading = artifact({ id: 'local-run-b', runId: 'run-b', title: '新结果', content: '新生成的内容' })

    const merged = mergeHydratedArtifactsWithCurrentSnapshot([server], [original], [edited, createdWhileLoading])

    expect(merged).toHaveLength(2)
    expect(merged.find(item => item.backendArtifactId === 'artifact-a')).toMatchObject({
      content: '用户改过的正文', rawContent: '用户改过的原文',
    })
    expect(merged).toContainEqual(createdWhileLoading)
  })
})
