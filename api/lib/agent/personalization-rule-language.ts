import type { AgentPersonalizationRuleOperation, InterpretedAgentPersonalizationRule } from '../../../shared/contracts/agent-personalization.js'
import { DataAccessError } from '../prisma.js'
import { listPersonalizationRuleOperations } from './personalization-tool-policy.js'

type RulePermission = InterpretedAgentPersonalizationRule['permission']

// Resolve one complete, affirmative expression. Anything with added scope,
// exceptions, or conflicting decisions must be rewritten before it can be saved.
const sentencePatterns: Array<[RulePermission, RegExp]> = [
  ['ask', /^(?:在)?(.+?)(?:之前|前|时),?\s*(?:都)?(?:请|必须|需要|要|先)*(?:询问我|问我|征得我的同意|让我确认|经我确认)$/u],
  ['ask', /^(?:请)?(?:先问我|先询问我|先让我确认)(?:，|,)?再(.+)$/u],
  ['ask', /^(?:未经我(?:同意|确认)|没有我的确认)(?:，|,)?(?:请)?(?:不要|不得|禁止)(.+)$/u],
  ['deny', /^(?:请)?(?:永远不要|绝不|不要|不允许|禁止|不得)(.+)$/u],
  ['allow', /^(?:请)?(?:你)?可以(?:直接)?(.+)$/u],
  ['allow', /^允许(?:直接)?(.+)$/u],
  ['allow', /^(?:请)?无需(?:询问|问)我(?:就)?(?:可以|直接)?(.+)$/u],
]

const actionAliases: Readonly<Record<string, readonly string[]>> = {
  account_profile: ['查看本人资料', '读取我的个人资料', '查看我的个人资料'],
  chapter_read: ['查阅章节', '查阅章节正文', '查看章节正文', '读取章节', '阅读章节正文'],
  chapter_edit_range: ['修改章节片段', '改写章节正文片段', '修改正文片段'],
  chapter_write: ['写入正文', '写入章节', '覆盖章节正文'],
  chapter_append: ['追加正文', '续写章节正文'],
  chapter_rename: ['修改章节标题', '调整章节标题'],
  novel_publish: ['发布我的作品'],
  web_search: ['联网查找创作资料', '联网搜索资料', '搜索网页'],
  web_read: ['读取网页', '打开网页'],
}

function normalize(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')
}

export function interpretRuleSentence(text: string, operations: AgentPersonalizationRuleOperation[]): InterpretedAgentPersonalizationRule | null {
  const sentence = normalize(text).replace(/[。.!！]+$/u, '')
  for (const [permission, pattern] of sentencePatterns) {
    const action = pattern.exec(sentence)?.[1]?.trim().replace(/[，,]$/u, '').trim()
    if (!action) continue
    const matches = operations.filter(({ title, toolName }) =>
      [title, toolName, ...(actionAliases[toolName] ?? [])].some(label => normalize(label) === action))
    if (matches.length === 1) {
      const { title, toolName } = matches[0]
      return { title, toolName, permission }
    }
  }
  return null
}

export async function interpretPersonalizationRule(text: string) {
  const interpretation = interpretRuleSentence(text, await listPersonalizationRuleOperations())
  if (!interpretation) throw new DataAccessError(422, 'PERSONALIZATION_RULE_UNRECOGNIZED',
    '暂时无法识别这条规则。请用一句话说明一项具体操作，以及是否允许或需要先问你。')
  return interpretation
}
