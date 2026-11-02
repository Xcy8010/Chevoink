// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { CrepeBuilder } from '@milkdown/crepe/builder'
import { EditorStatus, editorViewCtx, parserCtx } from '@milkdown/kit/core'

const real = vi.hoisted(() => ({ editor: null as CrepeBuilder | null, created: false }))
// Capture the real builder; its ProseMirror state, listener, serializer and
// trailing plugin all run unchanged.
vi.mock('@milkdown/crepe/builder', async importOriginal => {
  const actual = await importOriginal<typeof import('@milkdown/crepe/builder')>()
  return { ...actual, CrepeBuilder: class extends actual.CrepeBuilder {
    constructor(options: ConstructorParameters<typeof actual.CrepeBuilder>[0]) {
      super(options)
      real.editor = this
      const create = this.create
      this.create = async () => { const result = await create(); real.created = true; return result }
    }
  } }
})
import PlanRichMarkdownEditor from '../../src/features/studio/components/PlanRichMarkdownEditor'

afterEach(async () => {
  const editor = real.editor
  cleanup()
  if (editor) await vi.waitFor(() => expect(editor.editor.status).toBe(EditorStatus.Destroyed))
  real.editor = null
  real.created = false
})
async function mount(markdown: string, onChange: (markdown: string) => void) {
  const view = render(<PlanRichMarkdownEditor markdown={markdown} editable mobile={false} onChange={onChange} />)
  await act(async () => { await vi.waitFor(() => expect(real.created).toBe(true)) })
  return view
}

it('saves a real list edit even though Markdown parsing omits its trailing paragraph', async () => {
  const onChange = vi.fn()
  await mount('- 第一项\n- 第二项', onChange)
  act(() => real.editor!.editor.action(ctx => {
    const view = ctx.get(editorViewCtx)
    view.dispatch(view.state.tr.insertText('作者新增', 3))
    expect(view.state.doc.lastChild!.type.name).toBe('paragraph')
  }))
  await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
  const saved = onChange.mock.calls[0][0] as string
  expect(saved).toContain('作者新增第一项')
  expect(saved).toContain('第二项')
  real.editor!.editor.action(ctx => {
    expect(ctx.get(editorViewCtx).state.doc.eq(ctx.get(parserCtx)(saved)!)).toBe(false)
  })
})

it('does not save an external list update or the real trailing-plugin transaction it generates', async () => {
  const onChange = vi.fn(), updated = vi.fn()
  const view = await mount('初始计划', onChange)
  real.editor!.on(listener => listener.updated(updated))
  view.rerender(<PlanRichMarkdownEditor markdown={'- 服务端第一项\n- 服务端第二项'} editable mobile={false} onChange={onChange} />)
  await vi.waitFor(() => expect(updated).toHaveBeenCalled())
  real.editor!.editor.action(ctx => {
    expect(ctx.get(editorViewCtx).state.doc.lastChild!.type.name).toBe('paragraph')
  })
  expect(onChange).not.toHaveBeenCalled()
  act(() => real.editor!.editor.action(ctx => {
    const view = ctx.get(editorViewCtx)
    view.dispatch(view.state.tr.insertText('作者继续编辑', 3))
  }))
  await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
  expect(onChange.mock.calls[0][0]).toContain('作者继续编辑服务端第一项')
})

it('drops a real debounced old edit after a newer server document replaces it', async () => {
  const onChange = vi.fn(), updated = vi.fn()
  const view = await mount('较短计划', onChange)
  real.editor!.on(listener => listener.updated(updated))
  act(() => real.editor!.editor.action(ctx => {
    const view = ctx.get(editorViewCtx)
    view.dispatch(view.state.tr.insertText('旧编辑', 1))
  }))
  const complete = '服务端已经保存完整计划和新增小节'
  view.rerender(<PlanRichMarkdownEditor markdown={complete} editable mobile={false} onChange={onChange} />)
  await vi.waitFor(() => expect(updated).toHaveBeenCalled())
  expect(onChange).not.toHaveBeenCalled()
  real.editor!.editor.action(ctx => expect(ctx.get(editorViewCtx).state.doc.textContent).toBe(complete))
})
