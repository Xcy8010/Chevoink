import { describe, expect, it } from 'vitest'
import { toolFailureRecovery } from '../../api/lib/agent/tool-failure-recovery.js'

describe('chapter authority failure feedback', () => {
  it('requires checking the original request and catalog within the existing scope', () => {
    const recovery = toolFailureRecovery('AUTHOR_CHAPTER_SCOPE')!
    expect(recovery.label).toContain('目标或位置')
    expect(recovery.guidance).toContain('不表示任务已结束')
    expect(recovery.guidance).toContain('原始请求和当前作品目录')
    expect(recovery.guidance).toContain('仅在现有授权范围内')
    expect(recovery.guidance).toContain('不得混用')
    expect(recovery.guidance).toContain('任务已暂停、结束或授权不匹配时不得继续')
  })

  it.each(['RUNTIME_SCOPE_MISMATCH', 'RUNTIME_NOT_ACTIVE', 'RUN_CANCELLED', 'RUN_PAUSED', 'UNKNOWN_FAILURE'])(
    'does not label %s as a correctable chapter placement', code => {
      expect(toolFailureRecovery(code)).toBeUndefined()
    })
})
