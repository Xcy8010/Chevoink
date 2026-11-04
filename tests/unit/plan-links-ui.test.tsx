// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import ChapterSidebar from '../../src/features/studio/components/ChapterSidebar'
import PlanSettingsPanel from '../../src/features/studio/components/PlanSettingsPanel'
import EditorCanvas from '../../src/features/studio/components/EditorCanvas'
import CreatePlanDialog from '../../src/features/studio/components/CreatePlanDialog'
import { buildServerPlanFile, buildWorkspacePlanFiles, mergeServerPlanFile, mergeWorkspacePlanFiles, getSavedPlanSnapshot } from '../../src/features/studio/lib/plan-review'
import { mergeRestoredArtifactsWithSnapshot } from '../../src/features/studio/lib/agent-persistence'
import type { AgentArtifact, WorkspacePlanFile } from '../../src/features/studio/types'
import type { NovelPlanFileItem } from '../../src/features/studio/api'

vi.mock('../../src/features/studio/components/PlanMarkdownEditor', () => ({ default: ({ markdown }: { markdown: string }) => <textarea readOnly aria-label="计划正文" value={markdown} /> }))
afterEach(cleanup)
const parent: WorkspacePlanFile = { id: 'parent', backendArtifactId: 'p1', artifactId: 'parent', title: '全书大纲', content: '父大纲原文', createdAt: '', planKind: 'outline', planHash: 'parent-v2' }
const detail: WorkspacePlanFile = { id: 'detail', backendArtifactId: 'd1', artifactId: 'detail', title: '第21章细纲', content: '\n自由原文\n', createdAt: '', planKind: 'detail', planHash: 'detail-v1', parentPlanId: 'p1', parentPlanHash: 'parent-v1', target: { kind: 'future', targetOrderIndex: 21 }, reviewState: 'stale' }
function settings(plan = detail, plans = [parent, detail]) {
  const props = { plan, plans, chapters: [], onSave: vi.fn().mockResolvedValue(undefined), onRename: vi.fn(), onClose: vi.fn(), onRequestDelete: vi.fn() }
  return { props, ...render(<PlanSettingsPanel {...props} />) }
}

it('preserves server link fields and exact body whitespace in its workspace mapping', () => {
  const item: NovelPlanFileItem = { ...detail, id: 'd1', runId: 'r1', updatedAt: '', orderIndex: 2, planKind: 'detail', planHash: 'd-v1', parentPlanId: 'p1', parentPlanHash: 'p-v1', target: detail.target!, reviewState: 'stale' }
  expect(buildServerPlanFile(item)).toMatchObject({ id: 'server-d1', content: '\n自由原文\n', planKind: 'detail', planHash: 'd-v1', parentPlanId: 'p1', parentPlanHash: 'p-v1', target: { kind: 'future', targetOrderIndex: 21 }, reviewState: 'stale' })
})

it('starts with plans collapsed and groups outlines, details and old plans independently', async () => {
  const old = { ...parent, id: 'old', artifactId: 'old', title: '旧计划', planKind: undefined, backendArtifactId: 'old' }
  render(<ChapterSidebar chapters={[]} volumes={[]} savedPlans={[parent, detail, old]} selectedChapterId={null} selectedTreeItemId={null} catalogPreview={{ title: '目录', content: '', description: '' }} novelWordCountLabel="0字" chapterCountLabel="0章" novelTitle="合成作品" activeCoverLabel="" onSelectChapter={vi.fn()} onSelectPlan={vi.fn()} onSelectCatalog={vi.fn()} onCreateChapter={vi.fn()} onCreatePlan={vi.fn()} onOpenChapterSettings={vi.fn()} onOpenPlanSettings={vi.fn()} />)
  expect(screen.getByRole('button', { name: '计划共3个' }).getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByText('全书大纲')).toBeNull()
  expect(screen.queryByText(/Agent 生成的创作计划/)).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: '计划共3个' }))
  expect(screen.getByRole('button', { name: '大纲共1个' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '细纲共1个' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '历史未分类共1个' })).toBeTruthy()
  expect(screen.getByText('待复核')).toBeTruthy()
  await userEvent.click(screen.getByRole('button', { name: '大纲共1个' }))
  expect(screen.queryByText('全书大纲')).toBeNull()
  expect(screen.getByText('第21章细纲')).toBeTruthy()
})

it('requires reading and an explicit confirmation before adopting a changed parent version', async () => {
  const { props } = settings()
  const checkbox = screen.getByRole('checkbox') as HTMLInputElement
  expect(checkbox.disabled).toBe(true)
  expect(checkbox.checked).toBe(false)
  expect(props.onSave).not.toHaveBeenCalled()
  const details = screen.getByText('阅读父大纲：全书大纲').closest('details')!
  details.open = true
  fireEvent(details, new Event('toggle'))
  expect(checkbox.disabled).toBe(false)
  expect(checkbox.checked).toBe(false)
  await userEvent.click(checkbox)
  await userEvent.click(screen.getByRole('button', { name: '保存并确认复核' }))
  await waitFor(() => expect(props.onSave).toHaveBeenCalledWith({ title: '第21章细纲', planKind: 'detail', target: { kind: 'future', targetOrderIndex: 21 }, parentPlanId: 'p1', expectedParentPlanHash: 'parent-v2' }))
})

it('allows ordinary settings saves to retain stale status without silently confirming the parent', async () => {
  const { props } = settings()
  await userEvent.click(screen.getByRole('button', { name: '保存' }))
  expect(props.onSave).toHaveBeenCalledWith({ title: '第21章细纲', planKind: 'detail', target: { kind: 'future', targetOrderIndex: 21 } })
  expect(props.onRename).not.toHaveBeenCalled()
})

it('resets reading and confirmation when the parent changes while the settings remain open', async () => {
  const { props, rerender } = settings()
  const details = screen.getByText('阅读父大纲：全书大纲').closest('details')!
  details.open = true; fireEvent(details, new Event('toggle'))
  await userEvent.click(screen.getByRole('checkbox'))
  rerender(<PlanSettingsPanel {...props} plans={[{ ...parent, content: '更新后的大纲', planHash: 'parent-v3' }, detail]} />)
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true)
})

it('can save a future target on an unlinked draft and rejects invalid chapter order', async () => {
  const { props } = settings({ ...detail, parentPlanId: null, parentPlanHash: null, target: null, reviewState: 'unlinked' })
  await userEvent.selectOptions(screen.getByRole('combobox', { name: '目标章节' }), 'future')
  fireEvent.change(screen.getByRole('spinbutton', { name: '全书章节序号' }), { target: { value: '0' } })
  await userEvent.click(screen.getByRole('button', { name: '保存' }))
  expect(props.onSave).not.toHaveBeenCalled()
  expect(screen.getByRole('alert').textContent).toContain('章节序号')
  fireEvent.change(screen.getByRole('spinbutton', { name: '全书章节序号' }), { target: { value: '45' } })
  await userEvent.click(screen.getByRole('button', { name: '保存' }))
  expect(props.onSave).toHaveBeenCalledWith({ title: '第21章细纲', planKind: 'detail', target: { kind: 'future', targetOrderIndex: 45 } })
})

it('keeps settings open with the original failure after a version conflict', async () => {
  const { props } = settings()
  props.onSave.mockRejectedValueOnce(new Error('大纲已更新，请重新阅读'))
  await userEvent.click(screen.getByRole('button', { name: '保存' }))
  expect(screen.getByRole('alert').textContent).toBe('大纲已更新，请重新阅读')
  expect(props.onClose).not.toHaveBeenCalled()
})

it('creates the chosen kind and keeps a failed create open for correction', async () => {
  const onCreate = vi.fn().mockRejectedValueOnce(new Error('网络失败')).mockResolvedValueOnce(undefined)
  const onClose = vi.fn()
  render(<CreatePlanDialog onCreate={onCreate} onClose={onClose} />)
  await userEvent.click(screen.getByRole('button', { name: '细纲' }))
  await userEvent.click(screen.getByRole('button', { name: '新建', exact: true }))
  expect(onCreate).toHaveBeenCalledWith('detail')
  expect(screen.getByRole('alert').textContent).toBe('网络失败')
  expect(onClose).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: '新建', exact: true }))
  expect(onClose).toHaveBeenCalledOnce()
})


it('replaces clean historical v1 text with the server v2 text and its matching hash', () => {
  const local = { ...parent, id: 'history-local', artifactId: 'history-local', content: '历史v1', planHash: 'v1' }
  const server = { ...parent, id: 'server-p1', artifactId: 'server-p1', content: '云端v2', planHash: 'v2' }
  const merged = mergeWorkspacePlanFiles([local], [server])
  expect(merged).toHaveLength(1)
  expect(merged[0]).toMatchObject({ id: 'server-p1', artifactId: 'history-local', content: '云端v2', planHash: 'v2' })
  expect(getSavedPlanSnapshot(merged[0])).toEqual({ title: parent.title, content: '云端v2', planHash: 'v2' })
})

it('preserves an explicit dirty draft with its original baseline when a remote v2 arrives', () => {
  const local = { ...parent, id: 'history-local', artifactId: 'history-local', content: '\n作者草稿\n', planHash: 'v1', localDraft: { basePlanHash: 'v1' } }
  const item = { ...parent, id: 'p1', content: '云端v2', planHash: 'v2', runId: 'r', orderIndex: 1, updatedAt: '', parentPlanId: null, parentPlanHash: null, target: null, reviewState: 'unlinked' } as NovelPlanFileItem
  const refreshed = mergeServerPlanFile(item, local)
  expect(refreshed).toMatchObject({ content: '\n作者草稿\n', planHash: 'v1', localDraft: { basePlanHash: 'v1' }, hasRemoteConflict: true, savedSnapshot: { content: '云端v2', planHash: 'v2' } })
  const merged = mergeWorkspacePlanFiles([local], [refreshed])
  expect(merged[0]).toMatchObject({ content: '\n作者草稿\n', planHash: 'v1', hasRemoteConflict: true })
  expect(getSavedPlanSnapshot(merged[0])).toMatchObject({ content: '云端v2', planHash: 'v2' })
})

it('advances a newer queued draft baseline only after its own body save is acknowledged', () => {
  const local = { ...parent, content: '较新草稿', planHash: 'v1', localDraft: { basePlanHash: 'v1' } }
  const item = { ...parent, id: 'p1', content: '刚刚保存的正文', planHash: 'v2', runId: 'r', orderIndex: 1, updatedAt: '', parentPlanId: null, parentPlanHash: null, target: null, reviewState: 'unlinked' } as NovelPlanFileItem
  expect(mergeServerPlanFile(item, local)).toMatchObject({ content: '较新草稿', planHash: 'v1', hasRemoteConflict: true })
  const acknowledged = mergeServerPlanFile(item, local, item.content)
  expect(acknowledged).toMatchObject({ content: '较新草稿', planHash: 'v2', localDraft: { basePlanHash: 'v2' }, hasRemoteConflict: false })
  const finalItem = { ...item, content: '较新草稿', planHash: 'v3' }
  expect(mergeServerPlanFile(finalItem, acknowledged, finalItem.content).localDraft).toBeUndefined()
})

it('does not erase an already observed remote conflict when an older own save response arrives', () => {
  const local = { ...parent, content: '待存草稿', planHash: 'v1', localDraft: { basePlanHash: 'v1' }, hasRemoteConflict: true, savedSnapshot: { title: parent.title, content: '别的任务v3', planHash: 'v3' } }
  const item = { ...parent, id: 'p1', content: '待存草稿', planHash: 'v2', runId: 'r', orderIndex: 1, updatedAt: '', parentPlanId: null, parentPlanHash: null, target: null, reviewState: 'unlinked' } as NovelPlanFileItem
  const result = mergeServerPlanFile(item, local, item.content)
  expect(result).toMatchObject({ planHash: 'v2', hasRemoteConflict: true, savedSnapshot: { content: '别的任务v3', planHash: 'v3' } })
})

it('reads only a saved parent text and confirms that same snapshot hash when its draft differs', async () => {
  const dirtyParent = { ...parent, content: '尚未保存的父纲草稿', planHash: 'parent-v1', localDraft: { basePlanHash: 'parent-v1' }, hasRemoteConflict: true, savedSnapshot: { title: parent.title, content: '已保存的父纲v2', planHash: 'parent-v2' } }
  const { props } = settings(detail, [dirtyParent, detail])
  const summary = screen.getByText('阅读父大纲：全书大纲')
  expect(screen.queryByText('尚未保存的父纲草稿')).toBeNull()
  expect(screen.getByText('已保存的父纲v2')).toBeTruthy()
  const details = summary.closest('details')!
  details.open = true; fireEvent(details, new Event('toggle'))
  await userEvent.click(screen.getByRole('checkbox'))
  await userEvent.click(screen.getByRole('button', { name: '保存并确认复核' }))
  expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({ expectedParentPlanHash: 'parent-v2' }))
})

it('does not offer a dirty parent without any saved snapshot for reading and confirming', () => {
  const dirtyParent = { ...parent, content: '未保存草稿', localDraft: { basePlanHash: 'parent-v1' } }
  settings(detail, [dirtyParent, detail])
  expect(screen.queryByText(/阅读父大纲/)).toBeNull()
  expect(screen.queryByRole('checkbox')).toBeNull()
})


it.each(['default', 'mobile'] as const)('shows a dirty-plan conflict in the %s editor without replacing its draft', variant => {
  render(<EditorCanvas chapterDraft={null} workspaceDocument={{ kind: 'plan', id: 'p1', title: '草稿', content: '\n作者草稿\n', description: '', editableContent: true }} chapterLoading={false} chapterErrorMessage={null} chapterSaveState="error" chapterSaveMessage="计划已在其他任务更新，当前草稿尚未保存。" latestWordCountLabel="0字" selectedCommentCount={0} onSave={vi.fn()} onRetryLoad={vi.fn()} onCreateChapter={vi.fn()} onOpenChapterSettings={vi.fn()} onStatusChange={vi.fn()} onChange={vi.fn()} variant={variant} />)
  expect(screen.getByRole('alert').textContent).toBe('计划已在其他任务更新，当前草稿尚未保存。')
  expect((screen.getByRole('textbox', { name: '计划正文' }) as HTMLTextAreaElement).value).toBe('\n作者草稿\n')
})


it('keeps a persisted dirty baseline when task history is restored before the latest server plan list', () => {
  const artifact: AgentArtifact = { id: 'history', backendArtifactId: 'p1', task: 'plan-chapter', type: 'chapter_plan', title: parent.title, content: '历史正文v1', createdAt: '', status: 'ready', savedAsPlan: true }
  const draft: AgentArtifact = { ...artifact, content: '\n未保存的恢复草稿\n', rawContent: '\n未保存的恢复草稿\n', planLocalDraft: { basePlanHash: 'v1' } }
  const restored = mergeRestoredArtifactsWithSnapshot([artifact], [draft])
  const merged = mergeWorkspacePlanFiles(buildWorkspacePlanFiles(restored), [{ ...parent, content: '另一任务保存v2', planHash: 'v2' }])
  expect(merged[0]).toMatchObject({ content: '\n未保存的恢复草稿\n', planHash: 'v1', localDraft: { basePlanHash: 'v1' }, hasRemoteConflict: true, savedSnapshot: { content: '另一任务保存v2', planHash: 'v2' } })
})
