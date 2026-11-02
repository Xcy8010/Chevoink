// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ replace: vi.fn(), doc: 'same', meta: vi.fn(), update: null as null | ((ctx:unknown,doc:{value:string})=>void), blur:null as null | (()=>void) }))
const doc = (value:string) => ({ value, content: { size:value.length }, eq:(other:{value:string}) => other.value === value })
const context = () => ({ get: (key:string) => key === 'parser' ? (text:string) => ({ ...doc(text.trim()), content: text.trim() }) : key === 'serializer' ? (value:{value:string}) => value.value : {
  state: { doc: doc(state.doc),
    tr: { replaceWith: (_start:number,_end:number,text:string) => ({ setMeta: (key:string,value:boolean) => { state.meta(key,value); return { text } } }) } },
  dispatch: ({text}:{text:string}) => { state.doc=text; state.replace(text) },
} })
vi.mock('@milkdown/kit/core', () => ({editorViewCtx:'view',parserCtx:'parser',serializerCtx:'serializer'}))
vi.mock('@milkdown/kit/utils', () => ({replaceAll:(text:string) => () => state.replace(text)}))
vi.mock('@milkdown/crepe/feature/placeholder', () => ({placeholder:{}}))
vi.mock('@milkdown/crepe/builder', () => ({ CrepeBuilder: class {
  editor = { action:(fn:(ctx:unknown)=>unknown) => fn(context()) }
  addFeature(){return this} setReadonly(){} destroy(){return Promise.resolve()}
  on(fn:(listener:unknown)=>void){fn({updated:(fn:typeof state.update)=>{state.update=fn},blur:(fn:typeof state.blur)=>{state.blur=fn}})}
  create(){return Promise.resolve()}
} }))
import PlanRichMarkdownEditor from '../../src/features/studio/components/PlanRichMarkdownEditor'
import { readPlanPosition, savePlanPosition } from '../../src/features/studio/components/plan-view-position'
afterEach(()=>{cleanup();vi.clearAllMocks();state.doc='same'})
it('restores per-task scroll after async editor creation without resetting it on subsequent input', async () => {
  sessionStorage.clear()
  const seed = document.createElement('div'); seed.scrollTop = 620
  savePlanPosition('user:a:task:plan:preview', seed)
  const view = render(<PlanRichMarkdownEditor positionKey="user:a:task:plan:preview" markdown="same" editable mobile={false} />)
  await act(async () => {})
  const node = view.container.firstElementChild as HTMLElement
  expect(node.scrollTop).toBe(620)
  node.scrollTop = 840; fireEvent.scroll(node)
  view.rerender(<PlanRichMarkdownEditor positionKey="user:a:task:plan:preview" markdown={'same\n'} editable mobile={false} />)
  expect(node.scrollTop).toBe(840)
  expect(readPlanPosition('user:a:task:plan:preview')).toBe(840)
  expect(readPlanPosition('user:b:task:plan:preview')).toBe(0)
})
it('does not replace an equivalent normalized document but still applies a real external update', async()=>{
  const view=render(<PlanRichMarkdownEditor markdown="same" editable mobile={false}/> )
  await act(async()=>{})
  view.rerender(<PlanRichMarkdownEditor markdown={'same\n'} editable mobile={false}/> )
  expect(state.replace).not.toHaveBeenCalled()
  view.rerender(<PlanRichMarkdownEditor markdown="changed" editable mobile={false}/> )
  expect(state.replace).toHaveBeenCalledExactlyOnceWith('changed')
})
it('ignores late update and blur notifications from a disposed document', async()=>{
  const onChange=vi.fn(),onBlur=vi.fn()
  const view=render(<PlanRichMarkdownEditor markdown="same" editable mobile={false} onChange={onChange} onBlur={onBlur}/> )
  await act(async()=>{})
  const oldUpdate=state.update!,oldBlur=state.blur!
  view.unmount()
  oldUpdate(null,doc('late edit'));oldBlur()
  expect(onChange).not.toHaveBeenCalled();expect(onBlur).not.toHaveBeenCalled()
})
it('applies external content without publishing normalized Markdown as an author edit', async()=>{
  const onChange=vi.fn()
  const view=render(<PlanRichMarkdownEditor markdown="same" editable mobile={false} onChange={onChange}/>)
  await act(async()=>{})
  view.rerender(<PlanRichMarkdownEditor markdown="Agent appended a complete section" editable mobile={false} onChange={onChange}/>)
  expect(state.meta).toHaveBeenCalledExactlyOnceWith('addToHistory',false)
  expect(onChange).not.toHaveBeenCalled()
  act(()=>state.update?.(context(),doc(state.doc)))
  expect(onChange).not.toHaveBeenCalled()
  // A delayed callback for the former document cannot publish a shorter plan.
  act(()=>state.update?.(context(),doc('same')))
  expect(onChange).not.toHaveBeenCalled()
  state.doc='author edit'
  act(()=>state.update?.(context(),doc('author edit')))
  expect(onChange).toHaveBeenCalledExactlyOnceWith('author edit')
  state.doc='Agent appended a complete section'
  act(()=>state.update?.(context(),doc(state.doc)))
  expect(onChange).toHaveBeenLastCalledWith('Agent appended a complete section')
  expect(onChange).toHaveBeenCalledTimes(2)
})
it('does not save readonly editor callbacks', async()=>{
  const onChange=vi.fn()
  render(<PlanRichMarkdownEditor markdown="same" editable={false} mobile={false} onChange={onChange}/>)
  await act(async()=>{})
  state.doc='readonly normalization'
  act(()=>state.update?.(context(),doc('readonly normalization')))
  expect(onChange).not.toHaveBeenCalled()
})
