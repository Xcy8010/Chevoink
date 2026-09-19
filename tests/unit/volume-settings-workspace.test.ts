import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

const workspace = readFileSync('src/features/studio/StudioWorkspace.tsx', 'utf8')
const immersive = readFileSync('src/features/studio/components/ImmersiveComposer.tsx', 'utf8')
// Exercise the actual parent callbacks with their dependencies supplied, without
// mounting unrelated agent/network providers from the full workspace.
function callback(name: string, context: Record<string, unknown>) {
  const source = ts.createSourceFile('workspace.tsx', workspace, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let code = ''
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) code = node.getText(source)
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer)) code = `const ${name} = ${node.initializer.arguments[0].getText(source)}`
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!code) throw new Error(`missing callback ${name}`)
  const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function(...Object.keys(context), `${compiled}; return ${name}`)(...Object.values(context)) as (...args: unknown[]) => Promise<unknown>
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function guardContext() {
  return { activeNovelId: 'n', workspaceOwnerRef: { current: { novelId: 'n', epoch: 1 } }, currentNovelStateRef: { current: { id: 'n' } }, pendingChapterReviewsRef: { current: [] as unknown[] }, chapterSaveState: 'saved', novelSaveState: 'saved', chapterDirtyRef: { current: false }, novelDirty: false, persistChapter: vi.fn(async () => undefined), saveNovelMutation: { mutateAsync: vi.fn(async () => undefined) }, toast: { error: vi.fn() } }
}
describe('volume settings parent wiring', () => {
  it('wires every Work/IDE/mobile and immersive chapter sidebar to volume settings', () => {
    for (const source of [workspace, immersive]) {
      const sidebars = source.match(/<ChapterSidebar\b[\s\S]*?\/>/g) ?? []
      expect(sidebars.length).toBeGreaterThan(0)
      for (const sidebar of sidebars) expect(sidebar).toContain('onOpenVolumeSettings=')
    }
    expect(workspace).toContain('beforeChange={beforeVolumeChange}')
    expect(workspace).toContain('onChanged={refreshAfterVolumeChange}')
  })
  it('permits clean state but does not mistake a void save result for a successful save', async () => {
    const context = guardContext()
    const before = callback('beforeVolumeChange', context)
    expect(await before()).toBe(true)
    context.chapterDirtyRef.current = true
    expect(await before()).toBe(false)
    expect(context.persistChapter).toHaveBeenCalledWith('manual')
    context.pendingChapterReviewsRef.current = [{}]
    expect(await before()).toBe(false)
    expect(context.persistChapter).toHaveBeenCalledTimes(1)
  })
  it('blocks saving/pending and fences switching away and back during save before opening', async () => {
    const context = guardContext()
    expect(await callback('beforeVolumeChange', { ...context, chapterSaveState: 'saving' })()).toBe(false)
    const gate = deferred<boolean>()
    const setVolumeSettings = vi.fn()
    const open = callback('handleOpenVolumeSettings', { ...context, beforeVolumeChange: () => gate.promise, setVolumeSettings })
    const request = open('v')
    context.workspaceOwnerRef.current = { novelId: 'n', epoch: 3 }
    gate.resolve(true)
    await request
    expect(setVolumeSettings).not.toHaveBeenCalled()
  })
  it('drops late workspace payloads when ownership changes', async () => {
    const context = guardContext(), gate = deferred<unknown>()
    const refresh = callback('refreshWorkspaceAfterAgentWrite', { ...context, agentWorkspaceDirtyRef: { current: true }, getStudioPayload: () => gate.promise })
    const request = refresh()
    context.workspaceOwnerRef.current = { novelId: 'other', epoch: 2 }
    gate.resolve({})
    await expect(request).resolves.toBeUndefined()
  })
  it('refreshes current chapter revision/order baseline while retaining its ID after a volume move', async () => {
    const context = guardContext(), setChapterDraft = vi.fn(), setQueryData = vi.fn()
    const chapter = { id: 'c', revision: 7, volumeId: 'next', orderIndex: 3, orderInVolume: 1, content: '正文' }
    const draftRef = { current: {} }
    const refresh = callback('refreshAfterVolumeChange', { ...context, refreshWorkspaceAfterAgentWrite: vi.fn(async () => undefined), selectedChapterIdStateRef: { current: 'c' }, getChapterContent: vi.fn(async () => chapter), buildChapterDraft: (value: unknown) => value, chapterDraftStateRef: draftRef, setChapterDraft, queryClient: { setQueryData } })
    await refresh()
    expect(draftRef.current).toBe(chapter)
    expect(setChapterDraft).toHaveBeenCalledWith(chapter)
    expect(setQueryData).toHaveBeenCalledWith(['studio-chapter', 'n', 'c'], chapter)
  })
  it('does not overwrite fresh typing or a different work with a late chapter refresh', async () => {
    for (const interrupt of ['dirty', 'owner']) {
      const context = guardContext(), gate = deferred<unknown>(), setChapterDraft = vi.fn(), setQueryData = vi.fn()
      const refresh = callback('refreshAfterVolumeChange', { ...context, refreshWorkspaceAfterAgentWrite: async () => undefined, selectedChapterIdStateRef: { current: 'c' }, getChapterContent: () => gate.promise, buildChapterDraft: (value: unknown) => value, chapterDraftStateRef: { current: {} }, setChapterDraft, queryClient: { setQueryData } })
      const request = refresh()
      await Promise.resolve()
      if (interrupt === 'dirty') context.chapterDirtyRef.current = true
      else context.workspaceOwnerRef.current = { novelId: 'other', epoch: 2 }
      gate.resolve({ id: 'c', revision: 9 })
      await request
      expect(setChapterDraft).not.toHaveBeenCalled()
      expect(setQueryData).not.toHaveBeenCalled()
    }
  })
})
