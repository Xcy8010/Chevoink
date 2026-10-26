import { describe, expect, it } from 'vitest'
import { firstThreePrototypeBuildTool } from '../../api/lib/agent/tools/research-dossier-tools.js'
import { sceneTaskBuildTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { normalizeToolInput, validateToolInput } from '../../api/lib/agent/tools/input-validation.js'

const scene = () => ({ purpose: '让侦察队确认暗门仍可通行', goal: '找到离城路线', obstacle: '旧图没有标出塌方路段',
  choice: '沿水流实地核对暗门', cost: '耗费一小时，人员无额外损失', turn: '确认暗门通往城外废井' })
const direction = (id: string) => ({ id, title: `合成方向${id}`, readerPromise: '通过可回溯证据查明缺页原因',
  conflictEngine: '知情者因家人受到牵连而隐瞒证词', differentiation: '每条口供都要核对一件日常物证', risk: '不能把沉默当作有罪证据' })
const blueprint = (orderIndex: number) => ({ orderIndex, title: `合成第${orderIndex}章`, chapterJob: '确认卷宗存在被替换的页面',
  concreteEvent: '目录上的装订孔与现有卷宗不同', protagonistChoice: '保留旧目录并询问当年管理员',
  cost: '调查行踪被管理员得知，没有新增损失', newInformation: '目录曾被两人分别签收', exitHook: '第二名签收人主动递来一封未拆信', qualityRisks: [] })
const prototype = () => ({ directions: [direction('a'), direction('b')], genreRisks: ['避免巧合替代物证'],
  volumeSpine: ['确认卷宗缺页', '交叉核实证词', '重建页面流转路线'], chapterBlueprints: [1, 2, 3].map(blueprint) })

function issuePaths(result: ReturnType<typeof validateToolInput>) {
  expect(result.success).toBe(false)
  return result.success ? [] : result.error.issues.map(issue => issue.path.join('.'))
}

describe('literary normalization only repairs supplied representation', () => {
  it.each(['purpose', 'goal', 'obstacle', 'choice', 'cost', 'turn'] as const)('reports a missing scene %s instead of fabricating it', field => {
    const task: Partial<ReturnType<typeof scene>> = scene()
    delete task[field]
    const input = { arguments: JSON.stringify({ tasks: [task] }) }
    const original = structuredClone(input)
    const normalized = normalizeToolInput(sceneTaskBuildTool, input)
    expect(issuePaths(validateToolInput(sceneTaskBuildTool, normalized))).toContain(`tasks.0.${field}`)
    expect(input).toEqual(original)
  })
  it.each(['purpose', 'goal', 'obstacle', 'choice', 'cost', 'turn'] as const)('does not replace a blank scene %s with a literary template', field => {
    const normalized = normalizeToolInput(sceneTaskBuildTool, { tasks: [{ ...scene(), [field]: '   ' }] })
    expect(issuePaths(validateToolInput(sceneTaskBuildTool, normalized))).toContain(`tasks.0.${field}`)
  })
  it('preserves explicit no-loss choices and aliases through nested and stringified arrays', () => {
    const actual = scene()
    const aliased = { intent: actual.purpose, objective: actual.goal, resistance: actual.obstacle,
      decision: actual.choice, consequence: actual.cost, twist: actual.turn }
    const parsed = sceneTaskBuildTool.parameters.parse(normalizeToolInput(sceneTaskBuildTool,
      { arguments: JSON.stringify({ tasks: JSON.stringify([aliased]) }) }))
    expect(parsed.tasks[0]).toMatchObject(actual)
    expect(parsed.tasks[0].entryState).toEqual({ knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] })
    expect(parsed.tasks[0].exitState).toEqual(parsed.tasks[0].entryState)
    expect(parsed.tasks[0].styleBudget).toEqual({ description: 'low', dialogue: 'medium', rhetoric: 'low' })
  })
  it('reports every missing literary scene field from a goal-only call', () => {
    expect(issuePaths(validateToolInput(sceneTaskBuildTool, normalizeToolInput(sceneTaskBuildTool,
      { scene_tasks: [{ goal: '核对暗门' }] })))).toEqual(['tasks.0.purpose', 'tasks.0.obstacle', 'tasks.0.choice', 'tasks.0.cost', 'tasks.0.turn'])
  })
  it('does not equate purpose with a missing goal', () => {
    const task: Partial<ReturnType<typeof scene>> = scene()
    delete task.goal
    const normalized = normalizeToolInput(sceneTaskBuildTool, { tasks: [task] }) as { tasks: Array<Record<string, unknown>> }
    expect(normalized.tasks[0].purpose).toBe(task.purpose)
    expect(normalized.tasks[0].goal).toBeUndefined()
  })
  it('preserves a complete prototype without rewriting the authored decisions', () => {
    const input = prototype(), original = structuredClone(input)
    const parsed = firstThreePrototypeBuildTool.parameters.parse(normalizeToolInput(firstThreePrototypeBuildTool, input))
    expect(parsed).toEqual(input)
    expect(input).toEqual(original)
  })
  it.each(['title', 'readerPromise', 'conflictEngine', 'differentiation', 'risk'] as const)('reports missing direction %s instead of filling it from a template or another field', field => {
    const input = prototype()
    delete (input.directions[0] as Partial<ReturnType<typeof direction>>)[field]
    expect(issuePaths(validateToolInput(firstThreePrototypeBuildTool, normalizeToolInput(firstThreePrototypeBuildTool, input))))
      .toContain(`directions.0.${field}`)
  })
  it.each(['title', 'chapterJob', 'concreteEvent', 'protagonistChoice', 'cost', 'newInformation', 'exitHook'] as const)('reports missing blueprint %s even with an existing volume spine', field => {
    const input = prototype()
    delete (input.chapterBlueprints[0] as Partial<ReturnType<typeof blueprint>>)[field]
    expect(issuePaths(validateToolInput(firstThreePrototypeBuildTool, normalizeToolInput(firstThreePrototypeBuildTool, input))))
      .toContain(`chapterBlueprints.0.${field}`)
  })
  it('does not create directions, blueprints, genre risks or a volume spine when absent', () => {
    expect(issuePaths(validateToolInput(firstThreePrototypeBuildTool, normalizeToolInput(firstThreePrototypeBuildTool, {}))))
      .toEqual(['genreRisks', 'directions', 'volumeSpine', 'chapterBlueprints'])
  })
  it('retains short and oversized collections for count validation instead of padding or dropping items', () => {
    const input = prototype()
    const cases = [
      { ...input, directions: input.directions.slice(0, 1) },
      { ...input, directions: [...input.directions, direction('c'), direction('d')] },
      { ...input, volumeSpine: input.volumeSpine.slice(0, 2) },
      { ...input, chapterBlueprints: input.chapterBlueprints.slice(0, 2) },
      { ...input, chapterBlueprints: [...input.chapterBlueprints, blueprint(3)] },
    ]
    for (const value of cases) {
      const normalized = normalizeToolInput(firstThreePrototypeBuildTool, value) as typeof input
      expect(normalized.directions).toHaveLength(value.directions.length)
      expect(normalized.chapterBlueprints).toHaveLength(value.chapterBlueprints.length)
      expect(normalized.volumeSpine).toHaveLength(value.volumeSpine.length)
      expect(validateToolInput(firstThreePrototypeBuildTool, normalized).success).toBe(false)
    }
  })
  it('generates only missing technical IDs and preserves supplied chapter order', () => {
    const input = prototype()
    const first: Partial<ReturnType<typeof direction>> = { ...input.directions[0] }
    delete first.id
    const parsed = firstThreePrototypeBuildTool.parameters.parse(normalizeToolInput(firstThreePrototypeBuildTool,
      { ...input, directions: [first, input.directions[1]], chapterBlueprints: [...input.chapterBlueprints].reverse() }))
    expect(parsed.directions[0]).toEqual({ ...input.directions[0], id: 'direction-1' })
    expect(parsed.chapterBlueprints.map(item => item.orderIndex)).toEqual([3, 2, 1])
  })
  it.each([null, 7, [], '只有标题的方向'])('keeps an incomplete or invalid direction %j rejected', incomplete => {
    const input = { ...prototype(), directions: [incomplete, direction('b')] }
    expect(validateToolInput(firstThreePrototypeBuildTool, normalizeToolInput(firstThreePrototypeBuildTool, input)).success).toBe(false)
  })
})
