import { allTools } from './tools/registry.js'
import { mapAgentVisibleProse } from '../../../shared/agent-output.js'

/**
 * 正文/思考信道面向作者的可见性清洗：工具英文名、参数名、内部系统英文名与编号原文
 * 都是协议层词汇，出现在信道里对作者等于乱码（作者反馈：scene_task_build、compilationId、
 * cmt… 这类 ID 不该进信道）。统一替换成注册表中文工具名 / 中文功能名 / 中文参数名。
 *
 * 流式播出走 createVisibleTextStreamer：逐 token 清洗后再下发，尾部未完成的标识符先扣留，
 * 从源头杜绝「先播英文、轮末再修正成中文」的二次闪变（作者明确不要二次修正观感）。
 */

const TOOL_LABEL_BY_NAME = new Map(allTools.map((tool) => [tool.name, tool.title]))

/** 内部系统英文名 → 中文功能名（非工具注册表成员，单独维护） */
const INTERNAL_NAME_ALIASES: Array<[RegExp, string]> = [
  [/Story\s*Compiler/gi, '剧情编译'],
  [/Chapter\s*Bridge/gi, '章节桥'],
  [/Scene\s*Task/gi, '场景任务'],
  [/Story\s*Charter/gi, '故事宪章'],
]

/** camelCase 参数名 → 中文参数名；未登记的 camelCase 一律按「对应参数」处理（参数名不该进作者信道） */
const PARAM_LABEL_BY_NAME: Record<string, string> = {
  compilationId: '编译编号',
  sceneTaskId: '场景任务编号',
  chapterId: '章节编号',
  sessionId: '任务窗口编号',
  novelId: '作品编号',
  runId: '任务编号',
  taskId: '任务编号',
}

/** snake_case 标识符（工具名形态）：命中注册表替换为中文工具名，未命中统一「对应工具」 */
const SNAKE_CASE_IDENTIFIER = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g
/** camelCase 标识符（参数名形态） */
const CAMEL_CASE_IDENTIFIER = /\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g
/** 不透明编号（cuid/uuid 形态 16 位起纯小写字母数字）：编号原文等同泄漏，统一遮罩 */
const OPAQUE_IDENTIFIER = /\b[a-z0-9]{16,}\b/g

/** 等式左边的标识符/参数名形态（清洗前英文标识符与清洗后中文参数名两种形态都覆盖） */
const PROTOCOL_EQ_SUBJECT = '(?:[a-zA-Z][A-Za-z0-9]*(?:[_A-Z][A-Za-z0-9]*)+|章节编号|场景任务编号|任务窗口编号|作品编号|任务编号|编译编号|对应参数|对应工具|编号)'
/** 协议残留括注：模型把 ID/参数等式写进正文（chapterId=cmt…），清洗后会变成「（章节编号=编号）」
 *  这类天书括注——对作者不携带任何可理解信息，整段删除（作者明确要求信道输出人人都能看懂） */
const PROTOCOL_PARENTHETICAL = new RegExp(`[（(]\\s*${PROTOCOL_EQ_SUBJECT}\\s*[=＝:：]\\s*[^()（）]*?[)）]`, 'g')
/** 尾部未闭合的协议括注（等式已出现、闭括号未到）：流式期间扣留，避免先播「（章节编号=」再收回 */
const OPEN_PROTOCOL_PARENTHETICAL = new RegExp(`[（(]\\s*${PROTOCOL_EQ_SUBJECT}\\s*[=＝:：]\\s*[^()（）]*$`)

export function humanizeAgentVisibleText(text: string): string {
  return mapAgentVisibleProse(text, humanizeProse)
}

/** Baseline execution normalization is deliberately independent of author UI.
 * Retry, promise and saved-delivery guards must retain their previous input. */
export const normalizeExecutionText = humanizeAgentVisibleText

function humanizeProse(text: string): string {
  if (!text) return text
  let out = text.replace(PROTOCOL_PARENTHETICAL, '')
  out = out.replace(OPAQUE_IDENTIFIER, '编号')
  out = out.replace(SNAKE_CASE_IDENTIFIER, (name) => TOOL_LABEL_BY_NAME.get(name) ?? '对应工具')
  out = out.replace(CAMEL_CASE_IDENTIFIER, (name) => PARAM_LABEL_BY_NAME[name] ?? '对应参数')
  for (const [pattern, label] of INTERNAL_NAME_ALIASES) {
    out = out.replace(pattern, label)
  }
  return out
}

/** 信道里可能出现的英文标识符来源（工具名/参数名/内部系统英文名及其单词）：
 *  用于流式清洗时判断「尾部是否还有没播完的标识符」 */
const KNOWN_SOURCES: string[] = [
  ...TOOL_LABEL_BY_NAME.keys(),
  ...Object.keys(PARAM_LABEL_BY_NAME),
  ...INTERNAL_NAME_ALIASES.flatMap(([pattern]) =>
    // 取字面量短语与其逐词前缀来源：'Story Compiler' → 'Story Compiler' / 'Story' / 'Compiler'
    pattern.source.replace(/\\s\*/g, ' ').split(' '),
  ),
  ...INTERNAL_NAME_ALIASES.flatMap(([pattern]) => [pattern.source.replace(/\\s\*/g, ' ')]),
]

const TRAILING_TOKEN = /[A-Za-z0-9_]+$/
/** 6~15 位纯小写字母数字：还可能长成不透明编号（16 位起才遮罩），流式期间先扣留 */
const GROWING_OPAQUE = /^[a-z0-9]{6,15}$/

/** 返回文本尾部需要扣留的字符数：尾部标识符仍可能长成已知英文名或编号时，先不播出 */
function holdbackTail(text: string): number {
  const openParen = text.match(OPEN_PROTOCOL_PARENTHETICAL)
  if (openParen) return openParen[0].length
  const match = text.match(TRAILING_TOKEN)
  const token = match?.[0]
  if (!token) return 0
  const lower = token.toLowerCase()
  const isPrefixOfKnown = KNOWN_SOURCES.some((source) => source.toLowerCase() !== lower && source.toLowerCase().startsWith(lower))
  if (isPrefixOfKnown || GROWING_OPAQUE.test(token)) return token.length
  return 0
}

/** 流式清洗器：边流边清洗，只下发清洗后的安全增量；尾部未完成标识符扣留到能定论再播。
 *  轮末由 text.final / 持久化结算整段替换，保证作者任何时刻都看不到英文协议词汇 */
export function createExecutionTextDetector() {
  let buffer = ''
  let emitted = ''
  return {
    push(delta: string): string {
      buffer += delta
      const tail = holdbackTail(buffer)
      const safe = humanizeAgentVisibleText(tail > 0 ? buffer.slice(0, buffer.length - tail) : buffer)
      if (!safe.startsWith(emitted)) {
        // 清洗结果与已下发前缀不一致（极罕见边例）：本轮停发增量，等轮末整段结算替换，
        // 宁可少播一拍也不让英文漏出或文本错乱
        // This prefix was NOT delivered. Keep the actual emitted prefix so a
        // later compatible snapshot can catch up without silently dropping text.
        return ''
      }
      const increment = safe.slice(emitted.length)
      emitted = safe
      return increment
    },
  }
}
