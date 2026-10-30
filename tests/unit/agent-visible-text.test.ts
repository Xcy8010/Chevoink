import { describe, expect, it } from 'vitest'
import { createVisibleTextStreamer, humanizeAgentVisibleText } from '../../api/lib/agent/visible-text.js'
import { createExecutionTextDetector, normalizeExecutionText } from '../../api/lib/agent/execution-text-detector.js'
import { createRepeatDetector } from '../../api/lib/agent/repeat-detect.js'
import { promisesFurtherAction } from '../../api/lib/agent/completion-guard.js'
import { getToolByName } from '../../api/lib/agent/tools/registry.js'

const manuscript = 'AnnBlue kept her chapter_read notebook. 12345678901234567890 is engraved on it.\n\n他说：“调用 scene_task_build，chapterId=cmttleebg03h9wqox9lieracs。”\n\n> 用户原话：工具 chapter_write。'

describe('author text classification before publication', () => {
  it('publishes an ordinary single paragraph before final at every chunk boundary', () => {
    const raw = '好的，故事从清晨开始。她沿着河岸向前走。'
    for (let split = 3; split < raw.length; split++) {
      const stream = createVisibleTextStreamer()
      const first = stream.push(raw.slice(0, split))
      expect(first).toBe(raw.slice(0, split))
      expect(first + stream.push(raw.slice(split)) + stream.finish()).toBe(raw)
    }
    const stream = createVisibleTextStreamer()
    expect(stream.push('普通正文。')).toBe('普通正文。')
    expect(stream.push('\n\n调用参数：chapterId=hidden')).toBe('\n\n')
    expect(stream.finish()).not.toContain('hidden')
  })
  it('preserves manuscript English, numbers, dialogue and author quotes exactly', () => {
    expect(humanizeAgentVisibleText(manuscript)).toBe(manuscript)
    expect(humanizeAgentVisibleText('他在纸上写下 {"chapterId":"secret"}，然后离开。')).toBe('他在纸上写下 {"chapterId":"secret"}，然后离开。')
    for (const text of ['他把工具 get_user_input 交给 printHello，编号 12345678901234567890。',
      'The variable get_user_input calls printHello. 12345678901234567890.',
      '她说：“调用 get_user_input 和 printHello。”']) expect(humanizeAgentVisibleText(text)).toBe(text)
  })
  it('preserves source links, reference labels and code examples exactly', () => {
    const example = '来源：[chapter_read](https://example.com/?chapterId=cmttleebg03h9wqox9lieracs)\n\n```json\n{"chapterId":"cmttleebg03h9wqox9lieracs","tool":"chapter_read"}\n```\n\n参数示例：`chapterId`。'
    expect(humanizeAgentVisibleText(example)).toBe(example)
  })
  it('maps positively operational names and IDs to Chinese without changing facts', () => {
    const projected = humanizeAgentVisibleText('拿到 compilationId=cmttleebg03h9wqox9lieracs，调用 scene_task_build 补齐场景。')
    expect(projected).not.toMatch(/compilationId|cmttleebg03h9wqox9lieracs|scene_task_build/)
    expect(projected).toBe('')
    expect(humanizeAgentVisibleText('接下来我会调用 scene_task_build 补齐场景。')).toContain('准备章节')
  })
  it('keeps full-turn execution guards independent when author parameters are withheld', () => {
    const raw = '调用参数：model=hidden，reasoningEffort=high。'
    const execution = normalizeExecutionText(raw)
    expect(execution).toBe('调用参数：model=hidden，对应参数=high。')
    expect(humanizeAgentVisibleText(raw)).toBe('')
    const promise = '调用参数：model=hidden，接下来我会检查本章。'
    expect(promisesFurtherAction(normalizeExecutionText(promise))).toBe(true)
    expect(humanizeAgentVisibleText(promise)).toBe('')
  })
  it('preserves complete multiline dialogue and narrative numeric quotations before paragraph classification', () => {
    for (const raw of ['她轻声念道：“先别急。\n\n调用 chapter_write，是他们约定的暗号。”',
      '她在笔记里记着 chapterId="12345678901234567890"。']) {
      expect(humanizeAgentVisibleText(raw)).toBe(raw)
      for (let split = 1; split < raw.length; split++) {
        const stream = createVisibleTextStreamer()
        expect(stream.push(raw.slice(0, split)) + stream.push(raw.slice(split)) + stream.finish()).toBe(raw)
      }
    }
  })
  it.each([['“', '”'], ['「', '」'], ['『', '』'], ['‘', '’']])(
    'keeps multiline %s%s dialogue intact at every streaming boundary', (open, close) => {
      const raw = `她轻声念道：${open}先别急。\n\n调用 chapter_write，是他们约定的暗号。${close}\n\n`
      expect(humanizeAgentVisibleText(raw)).toBe(raw)
      const firstParagraph = raw.indexOf('\n\n') + 2
      const openStream = createVisibleTextStreamer()
      expect(openStream.push(raw.slice(0, firstParagraph))).toBe('')
      expect(openStream.push(raw.slice(firstParagraph)) + openStream.finish()).toBe(raw)
      for (let split = 1; split < raw.length; split++) {
        const stream = createVisibleTextStreamer()
        expect(stream.push(raw.slice(0, split)) + stream.push(raw.slice(split)) + stream.finish()).toBe(raw)
      }
    },
  )
  it.each([
    '- 调用 scene_task_build，compilationId=cmttleebg03h9wqox9lieracs。',
    '接下来我会调用 scene_task_build，compilationId=cmttleebg03h9wqox9lieracs。',
    '我先调用 scene_task_build，chapterId="cmttleebg03h9wqox9lieracs"，sceneTaskId=cmttleebg03h9wqox9lieracs。',
    '调用参数：\n\n```json\n{"chapterId":"private-id","model":"internal","reasoningEffort":"high"}\n```',
  ])('withholds structural operational parameters and their translated equations: %s', raw => {
    expect(humanizeAgentVisibleText(raw)).not.toMatch(/scene_task_build|compilationId|chapterId|sceneTaskId|private-id|reasoningEffort|编译任务=|目标章节=/)
    for (let split = 1; split < raw.length; split++) {
      const stream = createVisibleTextStreamer()
      expect(stream.push(raw.slice(0, split)) + stream.push(raw.slice(split)) + stream.finish()).not.toMatch(/scene_task_build|compilationId|chapterId|sceneTaskId|private-id|reasoningEffort|编译任务=|目标章节=/)
    }
  })
  it('does not render operational JSON or quoted parameter values', () => {
    expect(humanizeAgentVisibleText('{"chapterId":"cmttleebg03h9wqox9lieracs","arguments":{}}')).toBe('')
    expect(humanizeAgentVisibleText('调用工具，chapterId="cmttleebg03h9wqox9lieracs"。')).not.toContain('cmttleebg03h9wqox9lieracs')
    expect(humanizeAgentVisibleText('调用 future_unknown_tool。')).toBe('调用 推进创作。')
  })
  it('suppresses technical fenced and inline parameters only with an operational introduction', () => {
    for (const payload of ['```json\n{"chapterId":"private-id","model":"internal","reasoningEffort":"high"}\n```', '`chapterId=private-id`']) {
      const raw = `调用参数：\n${payload}`
      expect(humanizeAgentVisibleText(raw)).not.toMatch(/chapterId|private-id|reasoningEffort|internal/)
      const example = `参数示例：\n${payload}`
      expect(humanizeAgentVisibleText(example)).toBe(example)
      const novel = `他打开笔记，里面写着：\n${payload}`
      expect(humanizeAgentVisibleText(novel)).toBe(novel)
      for (let split = 1; split < raw.length; split++) {
        const stream = createVisibleTextStreamer()
        const shown = stream.push(raw.slice(0, split)) + stream.push(raw.slice(split)) + stream.finish()
        expect(shown).not.toMatch(/chapterId|private-id|reasoningEffort|internal/)
      }
    }
  })
  it.each([
    '调用 scene_task_build，compilationId=cmttleebg03h9wqox9lieracs。',
    '{"chapterId":"cmttleebg03h9wqox9lieracs","arguments":{"sceneTaskId":"hidden"}}',
    'I will call chapter_write with chapterId=cmttleebg03h9wqox9lieracs.',
    '<invoke name="chapter_write"><parameter name="chapterId">cmttleebg03h9wqox9lieracs</parameter></invoke>',
    '调用参数：model=hidden，reasoningEffort=high。',
  ])('holds every possible split of unknown partial progress: %s', raw => {
    for (let split = 1; split < raw.length; split++) {
      const stream = createVisibleTextStreamer()
      expect(stream.push(raw.slice(0, split))).toBe('')
      expect(stream.push(raw.slice(split))).toBe('')
      const final = stream.finish()
      expect(final).toBe(humanizeAgentVisibleText(raw))
      expect(final).not.toMatch(/scene_task|chapter_write|chapterId|compilationId|cmttle|model=|reasoningEffort/)
    }
  })
  it('streams classified paragraphs and preserves final content', () => {
    const stream = createVisibleTextStreamer()
    const chunks = ['调用 scene', '_task_build。\n', '\nAnnBlue kept 12345678901234567890.', '\n\n最后一段。']
    let shown = ''
    for (const chunk of chunks) {
      shown += stream.push(chunk)
      expect(shown).not.toMatch(/scene_task|compilationId/)
    }
    expect(shown + stream.finish()).toBe(humanizeAgentVisibleText(chunks.join('')))
  })
  it('holds incomplete multiline code and links, preserving completed examples', () => {
    const chunks = ['```json\n', '{"chapterId":"cmttleebg03h9wqox9lieracs"}\n\n', '```\n\n', manuscript]
    const stream = createVisibleTextStreamer()
    const shown = chunks.map(chunk => stream.push(chunk)).join('') + stream.finish()
    expect(shown).toBe(chunks.join(''))
  })
  it('keeps execution detection independent while ordinary author progress is live', () => {
    const detector = createExecutionTextDetector(), author = createVisibleTextStreamer()
    expect(detector.push('正文正在推进。')).toBe('正文正在推进。')
    expect(author.push('正文正在推进。')).toBe('正文正在推进。')
    expect(detector.push('调用 scene')).toBe('调用 ')
    expect(author.push('\n\n调用 scene')).toBe('\n\n')
    expect(detector.push('_task_build。')).toContain(getToolByName('scene_task_build')!.title)
    const execution = createExecutionTextDetector(), guarded = createRepeatDetector(100, 5, 3), held = createVisibleTextStreamer()
    for (let index = 0; index < 3; index++) {
      const increment = '重复的正文'
      expect(held.push(increment)).toBe(increment)
      expect(guarded.push(execution.push(increment))).toBe(index === 2 ? increment : null)
    }
  })
})

describe('scene_task_build 参数信封兜底', () => {
  it('解包 object 形态 arguments 信封', () => {
    const tool = getToolByName('scene_task_build')
    const coerced = tool?.coerceArgs?.({ arguments: { tasks: [{ goal: '守城夜战' }] } }) as Record<string, unknown>
    expect(Array.isArray(coerced?.tasks)).toBe(true)
  })

  it('解包字符串化 JSON 形态 arguments 信封', () => {
    const tool = getToolByName('scene_task_build')
    const coerced = tool?.coerceArgs?.({ arguments: '{"tasks": [{"goal": "守城夜战"}]}' }) as Record<string, unknown>
    expect(Array.isArray(coerced?.tasks)).toBe(true)
  })

  it('平铺参数原样通过', () => {
    const tool = getToolByName('scene_task_build')
    const coerced = tool?.coerceArgs?.({ tasks: [{ goal: '守城夜战' }] }) as Record<string, unknown>
    expect(Array.isArray(coerced?.tasks)).toBe(true)
  })
})
