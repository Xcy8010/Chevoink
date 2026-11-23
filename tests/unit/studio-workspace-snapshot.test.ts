// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { readStoredAgentWorkspace, writeStoredAgentWorkspace } from '../../src/features/studio/lib/agent-persistence'
import { createLocalAgentTaskWindow, getAgentWorkspaceStorageKey } from '../../src/features/studio/lib/agent-session'
import type { AgentArtifact } from '../../src/features/studio/types'

afterEach(() => { vi.restoreAllMocks(); localStorage.clear() })

it('未编辑的工件正文只写一次；编辑前原文和旧版快照均可还原', () => {
  const original = '原始计划内容'
  const artifact: AgentArtifact = {
    id: 'a', task: 'plan-chapter', type: 'chapter_plan', title: '计划', content: original,
    rawContent: original, createdAt: '2026-11-23T00:00:00Z', status: 'ready',
  }
  const task = createLocalAgentTaskWindow({ artifacts: [artifact, { ...artifact, id: 'b', content: '本地编辑' }] })
  const snapshot = { tasks: [task], activeTaskId: task.id }
  const key = getAgentWorkspaceStorageKey('novel')
  localStorage.setItem(key, JSON.stringify(snapshot))
  expect(readStoredAgentWorkspace('novel')?.tasks[0].artifacts).toEqual(task.artifacts)
  expect(writeStoredAgentWorkspace('novel', snapshot)).toBe(true)
  expect(JSON.parse(localStorage.getItem(key)!).tasks[0].artifacts[0].rawContent).toBeNull()
  expect(readStoredAgentWorkspace('novel')?.tasks[0].artifacts).toEqual(task.artifacts)
})

it('存储已满时保持上次快照，不让错误传出到创作区', () => {
  const task = createLocalAgentTaskWindow({ prompt: '原有草稿' })
  const snapshot = { tasks: [task], activeTaskId: task.id }
  writeStoredAgentWorkspace('novel', snapshot)
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError') })
  expect(writeStoredAgentWorkspace('novel', { ...snapshot, tasks: [{ ...task, prompt: '正在编辑' }] })).toBe(false)
  expect(readStoredAgentWorkspace('novel')?.tasks[0].prompt).toBe('原有草稿')
})
