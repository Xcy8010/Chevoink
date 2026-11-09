import { describe, expect, it } from 'vitest'
import { advanceWorkSplitGesture, fitWorkSplit, resizeWorkSplit, WORK_SPLIT, type WorkSplit, type WorkSplitGesture } from '../../src/features/studio/components/work-split'

const state: WorkSplit = { viewer: 600, inspector: 400, chatCollapsed: false, viewerCollapsed: false, inspectorCollapsed: false }
const width = 1600
describe('continuous Work gestures', () => {
  it('folds only the viewer at its minimum when dragging its left seam right', () => {
    const start = fitWorkSplit(state, width, true)
    const a = resizeWorkSplit(start, state, width, 200, 'content', true)
    expect([a.viewer, a.inspector]).toEqual([400, 400])
    const atMinimum = state.viewer - WORK_SPLIT.viewer
    expect(resizeWorkSplit(start, a, width, atMinimum - 1, 'content', true).viewerCollapsed).toBe(false)
    const folded = resizeWorkSplit(start, a, width, atMinimum, 'content', true)
    expect(folded).toMatchObject({ viewerCollapsed: true, inspectorCollapsed: false, inspector: 400 })
    expect(fitWorkSplit(folded, width, true)).toMatchObject({ viewer: 0, inspector: 400 })
  })
  it('folds only the viewer at its minimum when dragging its right seam left', () => {
    const start = fitWorkSplit(state, width, true)
    const atMinimum = WORK_SPLIT.viewer - state.viewer
    const before = resizeWorkSplit(start, state, width, atMinimum + 1, 'inspector', true)
    expect(before).toMatchObject({ viewerCollapsed: false, viewer: 221, inspector: 779 })
    const folded = resizeWorkSplit(start, before, width, atMinimum, 'inspector', true)
    expect(folded).toMatchObject({ viewerCollapsed: true, inspectorCollapsed: false, inspector: 780 })
    expect(fitWorkSplit(folded, width, true)).toMatchObject({ viewer: 0, inspector: 780 })
    const farther = resizeWorkSplit(start, folded, width, atMinimum - 200, 'inspector', true)
    expect(farther).toMatchObject({ viewerCollapsed: true, inspectorCollapsed: false, inspector: 780 })
  })
  it('collapses chat at the same 360px minimum and reverses in the held gesture', () => {
    const start = fitWorkSplit(state, width, true)
    const folded = resizeWorkSplit(start, state, width, -290, 'content', true)
    expect(folded.chatCollapsed).toBe(true)
    const back = resizeWorkSplit(start, folded, width, -100, 'content', true)
    expect(back.chatCollapsed).toBe(false)
    expect(back.inspector).toBe(400)
  })
  it('can reopen a previously folded chat with a fresh pointer gesture', () => {
    const folded = { ...state, chatCollapsed: true }
    const start = fitWorkSplit(folded, width, true)
    expect(resizeWorkSplit(start, folded, width, 40, 'content', true).chatCollapsed).toBe(false)
  })
  it('keeps an independently closed inspector closed while resizing the viewer', () => {
    const closed = { ...state, inspectorCollapsed: true }
    const result = resizeWorkSplit(fitWorkSplit(closed, width, true), closed, width, -80, 'content', true)
    expect(result.inspectorCollapsed).toBe(true)
    expect(result.inspector).toBe(46)
  })
  it('folds and unfolds the inspector independently without dropping the viewer', () => {
    const start = fitWorkSplit(state, width, true)
    const folded = resizeWorkSplit(start, state, width, 290, 'inspector', true)
    expect(folded.inspectorCollapsed).toBe(true)
    const back = resizeWorkSplit(start, folded, width, 0, 'inspector', true)
    expect(back.inspectorCollapsed).toBe(false)
    expect(back.viewer).toBe(600)
  })
  it('fits measured workspace widths without accidentally hiding chat on narrower screens', () => {
    for (const size of [600, 768, 980, 1120, 1440, 1920]) {
      const result = fitWorkSplit(state, size, true)
      expect(result.chatCollapsed).toBe(false)
      expect(result.chat).toBeGreaterThanOrEqual(360)
      expect(result.chat + result.rail + result.viewer + result.inspector).toBe(size)
    }
  })
  it('hands a held left seam to the inspector after the viewer folds', () => {
    const gesture: WorkSplitGesture = { x: 600, start: fitWorkSplit(state, width, true), width, boundary: 'content', hasViewer: true }
    const folded = advanceWorkSplitGesture(gesture, state, 980)
    expect(folded).toMatchObject({ viewerCollapsed: true, inspector: 400, inspectorCollapsed: false })
    const narrower = advanceWorkSplitGesture(gesture, folded, 1030)
    expect(narrower).toMatchObject({ viewerCollapsed: true, inspector: 350, inspectorCollapsed: false })
    const wider = advanceWorkSplitGesture(gesture, narrower, 930)
    expect(wider).toMatchObject({ viewerCollapsed: true, viewer: 600, inspector: 450, chatCollapsed: false })
    const atMinimum = advanceWorkSplitGesture(gesture, wider, 1180)
    expect(atMinimum).toMatchObject({ viewerCollapsed: true, inspector: WORK_SPLIT.inspector, inspectorCollapsed: false })
    const edge = advanceWorkSplitGesture(gesture, atMinimum, 1599)
    expect(edge).toMatchObject({ viewerCollapsed: true, inspectorCollapsed: true, chatCollapsed: false })
    const reopened = advanceWorkSplitGesture(gesture, edge, 1569)
    expect(reopened).toMatchObject({ viewerCollapsed: true, inspectorCollapsed: false })
  })
  it('opens a collapsed inspector after a short drag even without a viewer', () => {
    const closed = { ...state, inspectorCollapsed: true }
    const start = fitWorkSplit(closed, width, false)
    expect(resizeWorkSplit(start, closed, width, -30, 'content', false).inspectorCollapsed).toBe(false)
  })
  it('holds the inspector at its minimum until deliberate outward overdrag', () => {
    const start = fitWorkSplit(state, width, true)
    const atMinimum = state.inspector - WORK_SPLIT.inspector
    const atEdge = resizeWorkSplit(start, state, width, atMinimum, 'inspector', true)
    expect(atEdge).toMatchObject({ inspector: WORK_SPLIT.inspector, inspectorCollapsed: false, viewerCollapsed: false })
    const folded = resizeWorkSplit(start, atEdge, width, atMinimum + WORK_SPLIT.foldResistance + 1, 'inspector', true)
    expect(folded).toMatchObject({ inspectorCollapsed: true, viewerCollapsed: false })
  })
  it('reopens chat after a short rightward reversal from the left edge', () => {
    const gesture: WorkSplitGesture = { x: 600, start: fitWorkSplit(state, width, true), width, boundary: 'content', hasViewer: true }
    const folded = advanceWorkSplitGesture(gesture, state, 250)
    const edge = advanceWorkSplitGesture(gesture, folded, 0)
    expect(edge.chatCollapsed).toBe(true)
    expect(advanceWorkSplitGesture(gesture, edge, WORK_SPLIT.hysteresis + 1).chatCollapsed).toBe(false)
  })
  it('restores chat if no other content remains visible', () => {
    for (const hasViewer of [true, false]) {
      expect(fitWorkSplit({ ...state, chatCollapsed: true, viewerCollapsed: true, inspectorCollapsed: true }, width, hasViewer).chatCollapsed).toBe(false)
    }
  })
  it('uses the remaining canvas for the inspector when chat folds without a viewer', () => {
    const result = fitWorkSplit({ ...state, chatCollapsed: true }, width, false)
    expect(result.inspector).toBe(width)
    expect(result.chat + result.rail + result.viewer + result.inspector).toBe(width)
  })
  it('can reverse repeated independent inspector folds without leaving the viewport', () => {
    for (const left of [0, 280]) {
      const gesture: WorkSplitGesture = { x: left + 1200, left, start: fitWorkSplit(state, width, true), width, boundary: 'inspector', hasViewer: true }
      const edge = left + width - 1
      let current = advanceWorkSplitGesture(gesture, state, edge - 70)
      expect(current.inspectorCollapsed).toBe(true)
      for (let cycle = 0; cycle < 20; cycle++) {
        current = advanceWorkSplitGesture(gesture, current, edge)
        expect(current.inspectorCollapsed, `cycle ${cycle}`).toBe(true)
        expect(current.viewerCollapsed, `cycle ${cycle}`).toBe(false)
        current = advanceWorkSplitGesture(gesture, current, edge - 30)
        expect(current.inspectorCollapsed, `cycle ${cycle}`).toBe(false)
      }
    }
  })
  it('can repeat chat folds near the left viewport edge', () => {
    const gesture: WorkSplitGesture = { x: 600, start: fitWorkSplit(state, width, true), width, boundary: 'content', hasViewer: true }
    let current = state
    for (let cycle = 0; cycle < 20; cycle++) {
      current = advanceWorkSplitGesture(gesture, current, 1)
      expect(current.chatCollapsed).toBe(true)
      current = advanceWorkSplitGesture(gesture, current, 31)
      expect(current.chatCollapsed).toBe(false)
    }
  })
})
