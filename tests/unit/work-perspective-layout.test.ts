import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

import { shouldShowWorkActivityDock } from '../../src/features/studio/components/work-layout'

describe('Work activity dock responsive placement', () => {
  it('hides the inline activity copy when the locally controlled dock is visible', () => {
    const css = readFileSync('src/index.css', 'utf8')
    const panel = readFileSync('src/features/studio/agent/components/AgentPanel.tsx', 'utf8')
    expect(panel).toContain('<div data-agent-activity')
    expect(css).toMatch(/\.work-perspective\[data-activity-dock='visible'\] \[data-agent-activity\]\s*\{\s*display: none;/)
  })
  it('shows only when the conversation keeps its minimum usable width', () => {
    expect(shouldShowWorkActivityDock({
      containerWidth: 1920,
      leftWidth: 54,
      rightWidth: 520,
      hasActivity: true,
      hasViewer: false,
    })).toBe(true)

    expect(shouldShowWorkActivityDock({
      containerWidth: 1440,
      leftWidth: 54,
      rightWidth: 520,
      hasActivity: true,
      hasViewer: false,
    })).toBe(false)
  })

  it('keeps the activity inline below the minimum centered reading width', () => {
    const layout = { leftWidth: 44, rightWidth: 320, hasActivity: true, hasViewer: false }
    expect(shouldShowWorkActivityDock({ ...layout, containerWidth: 1576 })).toBe(true)
    expect(shouldShowWorkActivityDock({ ...layout, containerWidth: 1575 })).toBe(false)
  })

  it('never competes with an open chapter viewer or empty activity state', () => {
    expect(shouldShowWorkActivityDock({
      containerWidth: 2560,
      leftWidth: 54,
      rightWidth: 520,
      hasActivity: true,
      hasViewer: true,
    })).toBe(false)

    expect(shouldShowWorkActivityDock({
      containerWidth: 2560,
      leftWidth: 54,
      rightWidth: 520,
      hasActivity: false,
      hasViewer: false,
    })).toBe(false)
  })
})
