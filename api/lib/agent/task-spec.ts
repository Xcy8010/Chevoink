import { createHash, randomUUID } from 'node:crypto'
import { DataAccessError } from '../prisma.js'
import { localEditGuidance } from './local-edit-scope.js'
import { parseAuthorWritingRequest } from './author-writing-request.js'
import { requiresWritingConfirmation } from './writing-pacing-policy.js'
import { researchAuthor, researchAlternativeSelection, researchSourceSites, researchSourceHosts } from './research-navigation-policy.js'

import type { TaskIntent, TaskSpec, UserDirective } from '../../../shared/contracts/index.js'
import type { CreativeFreedom } from '../../../shared/contracts/index.js'
import type { StoryCompilerMode } from '../../../shared/contracts/index.js'

type DirectiveCandidate = Pick<UserDirective, 'kind' | 'text'>

const PREFERENCE_MARKERS = /(希望|尽量|偏好|最好|倾向)/

// Match actions within clauses, never across a forbidden write into a later
// research target. A list separator also bounds direct 不写/不改 actions.
function actionClauses(prompt: string): string[] {
  return prompt.split(/[。！？!?；;\n，,]+|(?:但是|然后|接着|但|\bbut\b)|(?=请(?:你)?(?:优先)?(?:研究|搜索|读取))/iu)
    .flatMap(clause => {
      const items = clause.split('、')
      const prohibition = items[0].match(/(?:不要|不需要|无需|不用|不必|禁止|不得|不能|不许|别|不)(?=创建|创作|写|改|修|润色|生成|保存|读取|读|只凭)/u)?.[0]
      return items.map((item, index) => index > 0 && prohibition ? prohibition + item : item)
    })
}

function affirmativeClause(clause: string): string | null {
  const value = clause.replace(/(?:不要|无需|不用|不必)(?:再)?(?:询问我|问我|确认|征求同意)/gu, '')
  return /(?:不要|不需要|无需|不用|不必|禁止|不得|不能|不许|别|不(?=创建|创作|写|改|修|保存|生成|新建|润色|读)|不(?:再)?(?:批量|统一|全局)|do not|don't|must not|never)/iu.test(value) ? null : value
}

function affirmativeClauses(prompt: string): string[] {
  return actionClauses(prompt).flatMap(clause => {
    const value = affirmativeClause(clause)
    return value === null ? [] : [value]
  })
}

/** Adjacent positive scope/action clauses may govern one operation. A denied
 * clause is a boundary, never omitted so its neighbours can form new authority. */
function affirmativeClauseGroups(prompt: string): string[] {
  const groups: string[] = []
  for (const sentence of prompt.split(/[。！？!?；;\r\n\u2028\u2029]+/u)) {
    let group: string[] = []
    for (const clause of actionClauses(sentence)) {
      const value = /(?:只读|read.only)/iu.test(clause) ? null : affirmativeClause(clause)
      if (value === null) {
        if (group.length) groups.push(group.join('，'))
        group = []
      } else group.push(value)
    }
    if (group.length) groups.push(group.join('，'))
  }
  return groups
}

/** Search location and evidence constraints do not revoke network access. */
function explicitlyDeniesNetwork(prompt: string): boolean {
  if (/(?:不要|不需要|无需|不用|不必|禁止|不得|不能|不许|别|不)(?:再|进行|使用|调用)?(?:任何)?(?:联网|上网)/u.test(prompt)) return true
  return actionClauses(prompt).some(clause => /(?:不要|无需|不用|不必|禁止|不得|不能|不许|别|不)(?:再|进行)?(?:联网|上网)|(?:不要|无需|不用|不必|禁止|不得|不能|不许|别|不)(?:使用|调用|访问)(?:任何)?(?:网络|互联网|联网工具|外部网站)|(?:不要|无需|不用|不必|禁止|不得|不能|不许|别|不)(?:搜索|检索|抓取|读取)(?:任何)?(?:外部|网上|网络)(?:资料|信息|来源|网页)?|^\s*(?:本次|这次|请|只需|完全|全程|现在|先|暂时|你|本轮|都|\s)*(?:不要|禁止|不得|别)(?:搜索|检索|抓取|浏览)(?:了|网页|网站|网络)?\s*$|\b(?:do not|don't|must not|never)\s+(?:go online|(?:use|access)\s+(?:the\s+)?(?:internet|network|web)|(?:search|browse|fetch)(?:\s+(?:the\s+)?(?:web|internet|external sources?))?)\s*[.!]?$/iu.test(clause.trim()))
}

function affirmativeMutation(prompt: string): boolean {
  return affirmativeClauses(prompt).some(clause => {
    const effect = clause.replace(/(?:只给|给出|提供|列出|说明|分析|讨论).{0,32}(?:建议|方法|思路|方案|意见)/gu, '')
      .replace(/(?:改写|修改|修复|优化|润色)(?:的)?(?:建议|方法|思路|方案)/gu, '')
    return /(?:写(?!作)|续写|改写|修改|修复|润色|重写|扩写|缩写|替换|删除|插入|保存|写入|存入|创建|新建|发布|生成).{0,24}(?:章|正文|段|句|对白|对话|剧情|计划|报告|文件|小说|作品|稿|卷)|\b(?:write|create|edit|revise|polish|rewrite|save|delete|publish)\b.{0,40}\b(?:chapter|prose|paragraph|sentence|dialogue|plan|report|file|novel)\b/iu.test(effect)
  })
}

function explicitlyDeniesResearchRead(prompt: string): boolean {
  return actionClauses(prompt).some(clause => /(?:不要|不需要|无需|不用|不必|禁止|不得|不能|不许|别|不)(?:再|自动)?(?:读|读取|获取|抓取|访问|打开|浏览)(?:取)?(?:任何)?(?:正文|原文|章节|网页|页面|链接)(?!后|之后|以后|时|就|便)|(?:只|仅)(?:做|进行)?(?:搜索|检索|查找)[^。\n]{0,32}(?:链接|网址)|(?:只|仅)(?:返回|列出|提供)(?:搜索)?(?:链接|网址)|\b(?:do not|don't|must not|never)\s+(?:read|fetch|open|browse)\b|\b(?:search only|only search|links only)\b/iu.test(clause))
}

function namedResearchTarget(prompt: string, sourceHosts: string[]): TaskSpec['researchTarget'] {
  const titles = [...new Set([...prompt.matchAll(/《([^》\n]{1,120})》/gu)].map(match => match[1].trim()))]
  if (titles.length !== 1 || !titles[0]) return undefined
  const author = prompt.match(/作者(?:是|为|[:：])\s*([^\s，,。；;、()（）《》：:]{1,120})/u)?.[1]
  const positive = affirmativeClauses(prompt).join('\n').replace(/《[^》]*》/gu, '')
  // Missing a craft keyword cannot waive evidence. Only an explicit, solely
  // bibliographic objective can finish without chapter-text support.
  const bibliographyOnly = /作者|书目|出版信息|出版时间|出版情况|ISBN|\b(?:author|bibliograph|publication)\b/iu.test(positive)
    && !/分析|解读|拆解|比较|总结|手法|正文|原文|修辞|主题|段落|情节|人物|叙事|章节|样本|写作|\b(?:analy[sz]|craft|chapter|text|narrative)/iu.test(positive)
  const textAnalysisRequired = !bibliographyOnly && !explicitlyDeniesResearchRead(prompt)
  return { title: titles[0], ...(author ? { author } : {}), textAnalysisRequired,
    ...(sourceHosts.length ? { sourceHosts } : {}) }
}

/** A requested short scene is prose, even when a separate clause forbids an outline. */
function boundedSceneRequest(prompt: string): boolean {
  return prompt.split(/[。；;\n，,]+/u).some(clause => !/(?:不要|不得|禁止|不许|别|do not|don't)/iu.test(clause)
    && !/(?:如何|怎么|写作建议|写作方法|创作方法|how to|advice)/iu.test(clause)
    && /^(?:\s|请(?:你)?|帮我|麻烦(?:你)?|现在|直接|只|就|先|给我|替我|为我)*(?:写|创作|撰写).{0,32}(?:短场景|一小段.{0,8}(?:场景|冲突)|小段场景)|^\s*(?:please\s+)?(?:write|draft).{0,24}(?:short|single).{0,12}scene/iu.test(clause))
}

/** Only the current original request may authorize prose. Historical chapters,
 * research results and an assistant's own plan are never author confirmation. */
export function classifyWritingPacing(prompt: string): TaskSpec['writingPacing'] {
  const positive = affirmativeClauses(prompt).join('\n')
  const greeting = /^(?:你好|您好|嗨|哈喽|hello|hi|hey|在吗|谢谢|早上好|晚上好|你是谁|你能做什么)[\s，,。.!！?？～~]*$/iu.test(prompt.trim())
  const question = /^(?:请问|告诉我|解释|介绍|什么是|为什么|如何|怎么|怎样|能否解释|你觉得|你认为|(?:我)?(?:想|想要|希望)(?:了解|知道|学习)|what\b|why\b|how\b|explain\b)/iu.test(prompt.trim())
  const explicitEffect = /(?:帮我|替我|为我|请你|然后|再)(?:直接)?(?:写|修改|改写|续写|创建|删除|保存|更新|润色|重写|生成)/u.test(positive)
  // Resolve informational questions before matching a book-sized object:
  // "如何写一本小说" asks for advice, not even a saved planning artifact.
  const advisory = /^(?:(?:那|那么|你觉得|你看|请问)[，,\s]*)?(?:下一步|接下来)(?:我|我们)?(?:应该|该|可以|要)?(?:做什么|怎么做|怎么办|如何推进|干什么)[呢吗吧？?。.!！\s]*$/u.test(prompt.trim())
  // Trust without an explicit action or a verified continuation referent is a
  // conversational response. It cannot select the editor's chapter as scope.
  const delegationOnly = /^(?:其他|其它|其余|剩下)(?:的|事情|事)?[，,\s]*(?:我)?(?:都|全)?(?:听你的|听你安排|交给你|由你决定|你决定)[吧。.!！\s]*$/u.test(prompt.trim())
  if (greeting || advisory || delegationOnly || (question && !explicitEffect)) return 'conversation_only'
  if (boundedSceneRequest(prompt)
    && !/(?:等|待).{0,24}(?:确认|同意|批准).{0,16}(?:再|才).{0,12}(?:写|动笔)|(?:先|只).{0,8}(?:大纲|规划|计划|方案)/u.test(positive)) return 'explicit_writing'
  // A classifier/quantity is optional ("写玄幻小说", "写本修仙小说").
  // Do not turn explicit continuation or revision into a new-book proposal.
  const broad = /(?<!续|改|重|扩|缩)(?:写|创作|创建|开|构思|策划).{0,40}(?:小说|故事)|(?:写|创作).{0,8}全书|(?:write|create).{0,30}(?:a|an|entire|whole).{0,24}(?:novel|book)/iu.test(positive)
  if (!broad) return undefined
  // A bounded chapter request or explicit autonomous serialization is stronger
  // evidence than a general book goal. Never infer this from "写一本" alone.
  const bounded = /(?:写|创作|完成|起草).{0,12}(?:第[一二两三四五六七八九十百0-9]+章|前[一二两三四五六七八九十0-9]+章|首章|下一章)|(?:write|draft).{0,12}(?:chapter\s*\d+|first chapter)/iu.test(positive)
  const autonomous = /(?:自动|自主|自行|直接).{0,16}(?:写完|完成全书|创作全书|连续写|逐章写)|(?:全权|授权).{0,16}(?:写作|创作)|(?:write|finish).{0,24}(?:autonomously|automatically)/iu.test(positive)
  const confirmationFirst = requiresWritingConfirmation(prompt)
  return !confirmationFirst && (bounded || autonomous) ? 'explicit_writing' : 'proposal_only'
}

/** Repair greeting/question legacy contracts only from the recovered original
 * user message. Never infer a broader grant or change task identity on resume. */
export function narrowLegacyConversationTask(spec: TaskSpec, originalPrompt: string): TaskSpec {
  if (spec.scope.authorEffects || spec.authorization || spec.writingPacing || classifyWritingPacing(originalPrompt) !== 'conversation_only') return spec
  return { ...spec, writingPacing: 'conversation_only', expectedOutputs: [{ kind: 'text', required: true,
    description: '回应本任务原始用户问题或问候，不执行作品创作，不恢复其他任务的待办' }] }
}

/** Only explicit lower bounds for an in-chat report. This extracts a length
 * obligation, never grants research access or chapter-writing permissions. */
function explicitReportMinimum(prompt: string): number | undefined {
  if (/(保存|导出|文件|写入计划)/u.test(prompt)) return undefined
  // A separate "不要写章节" constraint must not erase the report's length.
  prompt = prompt.split(/[。！？!?；;\n，,]+/u)
    .filter(clause => !/^\s*(?:请)?(?:不要|无需|不用|不必)/u.test(clause)).join('，')
  const number = '(\\d+(?:\\.\\d+)?|一万|两万|二万|三万|五千)'
  const unit = '(万|千)?(?:个汉字|字)'
  const match = prompt.match(new RegExp(`(?:分析报告|研究报告|拆书报告|拆解报告)(?:正文)?(?:字数)?[：:，,\\s]*(?:至少|不少于|不低于)\\s*${number}${unit}`, 'u'))
    ?? prompt.match(new RegExp(`(?:至少|不少于|不低于)\\s*${number}${unit}的?(?:分析报告|研究报告|拆书报告|拆解报告)`, 'u'))
  if (!match) return undefined
  const named: Record<string, number> = { 一万: 10000, 两万: 20000, 二万: 20000, 三万: 30000, 五千: 5000 }
  const value = named[match[1]] ?? Number(match[1]) * (match[2] === '万' ? 10000 : match[2] === '千' ? 1000 : 1)
  return Number.isSafeInteger(value) && value > 0 && value <= 2_000_000 ? value : undefined
}

function sentences(prompt: string): string[] {
  return prompt
    .split(/[。！？!?；;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 30)
}

export function extractDirectiveCandidates(prompt: string): DirectiveCandidate[] {
  const result: DirectiveCandidate[] = []
  const seen = new Set<string>()
  for (const text of sentences(prompt)) {
    const normalized = text.replace(/\s+/g, ' ').slice(0, 500)
    if (seen.has(normalized)) continue
    let kind: DirectiveCandidate['kind'] | null = null
    if (/(不要|不得|不能|禁止|严禁)/.test(normalized)) kind = 'must_not'
    else if (/(必须|务必|一定要|只能|保持)/.test(normalized)) kind = 'must'
    else if (/(改为|改成|以后|决定|采用)/.test(normalized)) kind = 'decision'
    else if (PREFERENCE_MARKERS.test(normalized)) kind = 'preference'
    if (kind) {
      seen.add(normalized)
      result.push({ kind, text: normalized })
    }
  }
  return result
}

/** Source discovery and chapter samples require a bounded research task.
 * Only fresh human admission may opt in, never a legacy resume/bootstrap. */
function externalCraftResearch(prompt: string, mutation?: boolean): boolean {
  if (explicitlyDeniesNetwork(prompt)) return false
  // Do not turn mixed local revision or explicit persistence into readonly
  // research. Keep this stricter exclusion local to the new admission rule.
  if (mutation ?? affirmativeMutation(prompt)) return false
  const positive = affirmativeClauses(prompt).join('\n')
  return /联网|上网|搜索|检索|搜.{0,12}(?:小说|作品|书)|查找|查阅|\b(?:search|browse|look up|fetch)\b/iu.test(positive)
    && /小说|这本书|本书|作品|《[^》]+》|\b(?:novel|book)\b/iu.test(positive)
    && /写作(?:手法|技巧|思路|方法)|叙事|人物塑造|悬念|结构|节奏|研究|按证据分析|公开(?:章节|正文|样本)|\b(?:writing|narrative|storytelling)\s+(?:techniques?|craft|style|approach)|\b(?:research|evidence|public chapters?)\b/iu.test(positive)
}

function classifyIntent(prompt: string, researchAdmission = false): TaskIntent {
  // Separate a research-only request from the existing review-and-repair
  // workflow. Mixed requests retain their existing workflow until explicit
  // phase permissions are resolved; do not silently discard requested writes.
  const clauses = prompt.split(/[。！？!?；;\n，,]+/u)
  const requestsResearch = /拆书|拆解|调研|解读|读后评估|(?:阅读|分析).{0,16}(?:小说|这本书|本书|作品)|(?:research|analy[sz]e|dissect).{0,32}(?:novel|book)/iu.test(prompt)
  const requestsWriting = clauses.some(clause => !/(?:不要|无需|不用|不必|禁止|不得|不能|只读|不写|不改|do not|don't)/iu.test(clause)
    && /(?:写|续写|改写|修改|润色|创建|新建|发布|删除).{0,16}(?:章|正文|小说|作品|卷)|(?:保存|写入|存入).{0,24}(?:计划|文件)|(?:write|create|edit|publish).{0,20}(?:chapter|novel)/iu.test(clause))
  if ((requestsResearch || researchAdmission && externalCraftResearch(prompt)) && !requestsWriting
    && !(researchAdmission && affirmativeMutation(prompt))) return 'research_analysis'
  if (affirmativeClauseGroups(prompt).some(clause => /(全书|所有章节|批量|统一).{0,16}(改名|替换|修改|变更)|全局改/.test(clause))) return 'global_transform'
  if (/(卷|章节).{0,12}(移动|排序|顺序|拆分|合并|插入)|新增.*卷/.test(prompt)) return 'structure'
  if (/(检查|审阅|评估|分析|找问题|一致性)|\b(?:check|review|assess|evaluate|analy[sz]e)\b/iu.test(prompt)) {
    // Required checks are subordinate to an explicit chapter write/revision.
    // "Do not skip checks" negates skipping, never the preceding writing ask.
    const chapterEffects = clauses.flatMap(clause => clause.split(/(?:但是|但|不过|\bbut\b|并(?:且)?(?=不要|不得|不能|禁止)|\band\s+(?=do not|don't|must not))/iu)).map(clause => clause
      .replace(/(?:不要|不得|不许|不能|禁止|别)(?:再)?(?:跳过|省略|略过).{0,12}(?:检查|审查|评估|校验|检测)/gu, '')
      .replace(/(?:do not|don't|must not|never)\s+(?:skip|omit|bypass)\b.{0,32}\b(?:checks?|reviews?|validation)\b/giu, ''))
      .filter(clause => !/(?:不要|无需|不用|不必|禁止|不得|不能|(?<!分)别|只读|不写|不改|不修改|不修订|不修正|do not|don't|must not|never|read.only)/iu.test(clause))
      .map(clause => clause
        .replace(/(?:提出|给出|提供|列出|说明|输出|讲解).{0,32}(?:建议|方案|思路|方法|报告)/gu, '')
        .replace(/(?:改写|修改|修复|修订|修正|优化|润色)(?:的)?(?:建议|方案|思路|方法)/gu, ''))
    const revisesChapter = chapterEffects.some(clause => /(?:改写|修改|修复|修订|修正|优化|润色|重写|扩写|缩写).{0,16}(?:章|正文)|(?:章|正文).{0,16}(?:改写|修改|修复|修订|修正|优化|润色|重写)|\b(?:revise|edit|repair|rewrite|polish|fix)\b(?:(?!\b(?:advice|report|suggestion)\b).){0,40}\b(?:chapter|prose)\b/iu.test(clause))
    if (revisesChapter) return 'revise'
    const writesChapter = chapterEffects.some(clause => /(?:写|续写|创作|起草).{0,16}(?:章节|章(?!节)|正文)(?!(?:的)?(?:(?:检查|审阅|质量|分析|评估).{0,8})?报告)|(?:完成|写完|补完|补齐).{0,8}(?:章节|章(?!节)|正文)(?!(?:的)?(?:质量|连续性|一致性|事实)?(?:检查|审查|评估|分析|校验|检测|报告))|\b(?:write|draft|finish|complete)\b(?:(?!\b(?:review|check|report|assessment|evaluation)\b).){0,40}\b(?:chapter|prose)\b(?!(?:['’]s)?\s+(?:quality\s+)?(?:review|check|report)\b)/iu.test(clause))
    return writesChapter ? 'write' : 'review'
  }
  if (/(规划|大纲|计划|设计剧情)/.test(prompt)) return 'plan'
  if (affirmativeClauses(prompt).some(clause => !/(?:只读|read.only)/iu.test(clause)
    && /(改写|润色|扩写|缩写|修改|调整)|(?:修订|修正).{0,16}(?:章|正文)|(?:章|正文).{0,16}(?:修订|修正)/u.test(clause))) return 'revise'
  return 'write'
}

/** Repair only legacy research classification, using the complete original
 * user request recovered by the resume service. Never mint a new task identity
 * or grant additional effects from history, a summary, or tool output. */
export function narrowLegacyResearchTask(spec: TaskSpec, originalPrompt: string): TaskSpec {
  if (spec.scope.authorEffects || spec.authorization || spec.intent === 'research_analysis' || classifyIntent(originalPrompt) !== 'research_analysis') return spec
  const minimumChineseCharacters = explicitReportMinimum(originalPrompt)
  return { ...spec, intent: 'research_analysis', expectedOutputs: [{ kind: 'validation_report', required: true,
    description: '完成原始请求的只读研究并交付可核验报告',
    ...(minimumChineseCharacters ? { minimumChineseCharacters } : {}) }] }
}

export function buildTaskSpec(input: {
  runId: string
  novelId: string
  chapterId?: string | null
  prompt: string
  selection?: { start?: number; end?: number } | null
  /** Fresh server admission only; resume/fallback never opts old runs in. */
  manuscriptProtocol?: 1
  reviewProtocol?: 1
  continuityEvidenceProtocol?: 1
  continuityReportProtocol?: 5
  terminalEvidenceProtocol?: 1 | 2
  terminalQuoteAddressProtocol?: 1
  terminalCoverageProtocol?: 1 | 2
  localEditProtocol?: 1
  /** Internal fresh human admission only; not exposed in a request schema. */
  researchAdmission?: 1
  researchNavigationAdmission?: 1
  /** Fresh HTTP boundary; separate from research budget opt-in. */
  networkAdmission?: 1
  /** Genuine fresh HTTP authority; legacy build/recovery retains its classifier. */
  authorWritingProtocol?: 2
  creativeFreedom?: CreativeFreedom
  qualityMode?: StoryCompilerMode
}): TaskSpec {
  if (input.manuscriptProtocol === 1 && input.selection && (!input.chapterId || !Number.isSafeInteger(input.selection.start)
    || !Number.isSafeInteger(input.selection.end) || input.selection.start! < 0 || input.selection.end! <= input.selection.start!)) {
    throw new DataAccessError(409, 'AUTHOR_SELECTION_STALE', '选区必须绑定当前章节及非空 UTF-16 坐标，请重新选择正文。')
  }
  const writingRequest = input.authorWritingProtocol === 2 ? parseAuthorWritingRequest(input.prompt) : null
  const effects = writingRequest?.evidence.operations.filter(operation => operation.polarity === 'affirmative'
    && (operation.accepted || operation.reason === 'unclosed_source_quote')) ?? []
  const manuscriptRequested = effects.some(operation => operation.kind === 'write' || operation.kind === 'revise')
  const structureRequested = effects.some(operation => operation.kind === 'structure')
  const artifactRequested = effects.some(operation => operation.kind === 'artifact')
  const globalTransform = writingRequest && effects.some(operation => operation.kind === 'revise'
    && operation.targetIndices.some(index => writingRequest.evidence.targets[index].kind === 'global')
    && /改名|替换|修改|变更|rename|replace/iu.test(input.prompt.slice(operation.span.start, operation.span.end)))
  const freshResearch = input.researchAdmission === 1 && externalCraftResearch(input.prompt,
    writingRequest ? manuscriptRequested || structureRequested || artifactRequested : undefined)
  const networkDenied = (input.networkAdmission === 1 || input.researchAdmission === 1) && explicitlyDeniesNetwork(input.prompt)
  const researchReadDenied = input.researchAdmission === 1 && explicitlyDeniesResearchRead(input.prompt)
  const legacyPacing = classifyWritingPacing(input.prompt)
  const bookProposal = writingRequest && manuscriptRequested && !writingRequest.range && legacyPacing === 'proposal_only'
    && effects.some(operation => operation.kind === 'write'
      && operation.targetIndices.some(index => writingRequest.evidence.targets[index].kind === 'book'))
  const writingPacing = freshResearch ? undefined : !writingRequest ? legacyPacing
    : bookProposal ? 'proposal_only' as const : manuscriptRequested ? legacyPacing === 'explicit_writing' ? legacyPacing : undefined
      : structureRequested || artifactRequested ? undefined : legacyPacing === 'conversation_only' ? legacyPacing : undefined
  const inferredIntent = freshResearch ? 'research_analysis' : writingPacing === 'proposal_only' ? 'plan'
    : writingPacing === 'explicit_writing' && boundedSceneRequest(input.prompt) ? 'write' : classifyIntent(input.prompt, input.researchAdmission === 1)
  const intent = !writingRequest ? inferredIntent : freshResearch ? 'research_analysis'
    : bookProposal ? 'plan' : manuscriptRequested ? globalTransform ? 'global_transform' : writingRequest.intent ?? 'write'
      : structureRequested ? 'structure' : artifactRequested ? inferredIntent
        : writingRequest.intent === 'review' ? 'review' : 'write'
  const minimumChineseCharacters = intent === 'review' || intent === 'research_analysis' ? explicitReportMinimum(input.prompt) : undefined
  const requiresStructureValidation = intent === 'structure' || /(?:续写|写完|补完|完成|写到).{0,12}第?[一二两三四五六七八九十百千0-9]+卷|第?[一二两三四五六七八九十百千0-9]+卷.{0,12}(?:续写|写完|补完|完成)/.test(input.prompt)
  const protectsEarlierContent = /(不|不要|不得|不能|禁止).{0,8}(改动|修改|重写|影响).{0,8}(前面|此前|已有|之前)|保持.{0,8}(前面|此前|已有|之前).{0,8}不变/.test(input.prompt)
  const directives = extractDirectiveCandidates(input.prompt)
  const chapterIds = input.chapterId ? [input.chapterId] : undefined
  const selection = input.chapterId && input.selection?.start !== undefined && input.selection.end !== undefined
    ? { chapterId: input.chapterId, start: input.selection.start, end: input.selection.end }
    : undefined
  const outputKind = intent === 'global_transform'
    ? 'changeset'
    : intent === 'review' || intent === 'research_analysis' || intent === 'structure'
      ? 'validation_report'
      : intent === 'plan'
        ? 'artifact'
        : 'text'

  const sourceHosts = researchSourceHosts(input.prompt)
  const researchTarget = freshResearch && !networkDenied ? namedResearchTarget(input.prompt, sourceHosts) : undefined
  return {
    id: randomUUID(),
    runId: input.runId,
    intent,
    controlPolicy: 'until_completion',
    ...(writingPacing ? { writingPacing } : {}),
    ...(networkDenied ? { networkAccess: 'denied' as const } : {}),
    ...(researchReadDenied ? { researchReadAccess: 'denied' as const } : {}),
    ...(freshResearch && !networkDenied
      ? { researchDiscoveryProtocol: 1 as const } : {}),
    ...(freshResearch && input.researchNavigationAdmission === 1 && !networkDenied ? { researchNavigation: {
      version: 1 as const, requestHash: createHash('sha256').update(input.prompt).digest('hex'),
      alternativeSelection: researchAlternativeSelection(input.prompt),
      ...(researchSourceSites(input.prompt).length ? { sourceSites: researchSourceSites(input.prompt) } : {}),
      ...(sourceHosts.length ? { sourceHosts } : {}),
    } } : {}),
    ...(researchTarget ? { researchTarget: {
      ...researchTarget, ...(input.researchNavigationAdmission === 1
        ? { author: researchAuthor(input.prompt) } : {}),
    } } : {}),
    researchBudget: !networkDenied && (freshResearch
      || /完整拆书|全书拆解|逐章分析|逐章拆解|深度研究|全面研究|深入研究|深入分析|深度分析|拆解这本小说|拆解整本|full.book|deep research/i.test(input.prompt)) ? 'extended' : 'standard',
    scope: { novelId: input.novelId, chapterIds, selection, ...(writingRequest ? { authorEffects: { version: 1 as const,
      requestHash: createHash('sha256').update(input.prompt).digest('hex'), manuscript: manuscriptRequested && !bookProposal, structure: structureRequested } } : {}),
      ...(input.manuscriptProtocol ? { manuscriptProtocol: input.manuscriptProtocol } : {}),
      ...(input.reviewProtocol ? { reviewProtocol: input.reviewProtocol } : {}),
      ...(input.continuityEvidenceProtocol ? { continuityEvidenceProtocol: input.continuityEvidenceProtocol } : {}),
      ...(input.continuityReportProtocol ? { continuityReportProtocol: input.continuityReportProtocol } : {}),
      ...(input.terminalEvidenceProtocol ? { terminalEvidenceProtocol: input.terminalEvidenceProtocol } : {}),
      ...(input.terminalQuoteAddressProtocol ? { terminalQuoteAddressProtocol: input.terminalQuoteAddressProtocol } : {}),
      ...(input.terminalCoverageProtocol ? { terminalCoverageProtocol: input.terminalCoverageProtocol } : {}),
      ...(input.localEditProtocol ? { localEditProtocol: input.localEditProtocol } : {}) },
    goals: [input.prompt.trim().slice(0, 1000) || '继续完成上一轮任务'],
    hardConstraints: directives
      .filter((item) => item.kind === 'must' || item.kind === 'must_not')
      .map((item) => ({ id: randomUUID(), kind: 'author_directive', text: item.text })),
    softPreferences: directives
      .filter((item) => item.kind === 'preference')
      .map((item) => ({ id: randomUUID(), text: item.text, weight: 0.8 })),
    expectedOutputs: [{ kind: outputKind, description: writingPacing === 'conversation_only'
      ? '回应本任务原始用户问题或问候，不执行作品创作，不恢复其他任务的待办'
      : writingPacing === 'proposal_only'
      ? '交付题材定位、核心冲突、人物与全书大纲、首批章节范围建议，等待作者确认后再另起正文写作；本轮不写章节正文'
      : `完成${intent}任务并给出可核验结果${minimumChineseCharacters ? `；报告至少${minimumChineseCharacters}个汉字（不计代码、URL、标点与重复段落）` : ''}`, required: true,
      ...(minimumChineseCharacters ? { minimumChineseCharacters } : {}) }],
    postconditions: [
      ...(intent === 'global_transform'
        ? [{ code: 'CHANGESET_VERIFIED', description: '全书变更通过预览、版本校验与原子应用', severity: 'error' as const }]
        : []),
      ...(requiresStructureValidation
        ? [{ code: 'STRUCTURE_VALIDATED', description: '卷章顺序与标题结构通过校验', severity: 'error' as const }]
        : []),
      ...(protectsEarlierContent
        ? [{ code: 'EARLIER_CONTENT_UNCHANGED', description: '任务开始前已有章节正文保持不变，仅新增目标范围内容', severity: 'error' as const }]
        : []),
    ],
    ambiguity: input.prompt.trim().length <= 2 ? 'must_ask' : 'safe_to_assume',
    creativeFreedom: input.creativeFreedom ?? 'balanced',
    qualityMode: input.qualityMode ?? 'premium',
    createdAt: new Date().toISOString(),
  }
}

/** A legacy write label alone creates no chapter-delivery obligation. */
export function requiresManuscriptDelivery(spec: Pick<TaskSpec, 'intent' | 'scope' | 'writingPacing'>): boolean {
  return spec.scope.authorEffects?.manuscript !== false && ['write', 'revise'].includes(spec.intent)
    && !['conversation_only', 'proposal_only'].includes(spec.writingPacing ?? '')
}

export function renderTaskSpec(spec: TaskSpec): string {
  const networkRule = spec.networkAccess === 'denied'
    ? '[系统] 原始请求明确禁止联网：本任务不提供或执行搜索、网页获取，不预约、不请求供应商、不收工具费。只使用已有获准材料并说明证据限制。\n' : ''
  const readRule = spec.researchReadAccess === 'denied'
    ? '[系统] 原始请求只允许搜索或返回链接：不提供或执行web_read，不自动打开网页，不预约或收读取费。\n' : ''
  const navigationRule = spec.researchNavigation ? `[系统] 本任务导航协议：相关官方评论或检索页仅可用web_read purpose="navigation"获取可读书目与实际href，与正文获取共同计入本任务8次Fetch总预算，导航没有另设次数；元数据不可引用为目标正文。首选作品：${spec.researchTarget?.title ?? '按原请求核验'}${spec.researchTarget?.author ? `；作者：${spec.researchTarget.author}` : ''}。${spec.researchNavigation.alternativeSelection === 'denied'
    ? '没有换书授权，不能自行改选。' : '原请求允许首选公开来源不可用后改选；仅服务端确认真实访问/404回执后可用selectAlternative=true导航核验一次替代作品。空搜索、乱码、未知请求不解锁改选。'}没有可读正文时报告实际来源与不足。\n` : ''
  const responseRule = spec.responseDeliveryProtocol === 1
    ? '[系统] 本任务的实际交付由你根据完整原始用户请求拆解。下方推测的写作标签与章节范围仅限制实际写入权限，不要求你为普通问题创作正文。判断当前请求只需答复时，可按需使用读取工具核对资料，随后正常输出完整答复，无需终结工具、额外待办或规划轮次；也可单独原生调用 task_respond 直接交付 answer。若已经准备或修改章节，须按真实正文、当前检查和提交证据完成原流程，不能改用答复结束。\n' : ''
  return responseRule + networkRule + readRule + navigationRule + renderTaskSpecBody(spec)
}

function renderTaskSpecBody(spec: TaskSpec): string {
  if (spec.intent === 'research_analysis') {
    const budget = spec.networkAccess === 'denied' ? '禁止新增联网' : spec.researchReadAccess === 'denied'
      ? '常规最多5次搜索，有真实关键资料缺口且有新检索方向时总共最多10次；禁止页面获取' : '最多5次搜索、8次页面获取；有真实关键资料缺口且有新来源或章节检索方向时，搜索总共最多10次'
    return `[系统] 本轮只读研究契约（taskSpecId=${spec.id}）：\n目标：${spec.goals.join('；')}\n只读取资料并交付分析；不得创建或改写章节、卷、作品、记忆、封面或派生写作窗口，历史写作指令不构成本轮授权。正文不可读或覆盖不足必须说明缺失，不能虚称全书读完。按照用户要求完整输出报告，不套用写作任务的简短收尾规则。复杂任务可维护本轮真实待办，无待办不补建已完成清单。\n联网预算：${budget}，Search与Fetch分别计数，所有分岔与续跑共享本任务总额；复用已保存结果和正文，不重复未变化的检索词或失败URL。资料已充分就停止，不必用满次数；单个页面失败改用其他来源，不因两次读取失败停止搜索。保留已有证据并说明实际缺口。普通分析不自行扩展到影视化、销量或结局争议。用户指定外部平台作品时优先搜索该平台官方来源；除非原请求明确限定站点，也可核验其他合法公开来源，不先搜索本平台作品库。\n取证顺序：1）用作品名/作者及官方域名定向搜索；未指定书时先选定一本有公开章节的作品，核实官方作品页的书名和作者，不把平台首页当作品页。2）沿搜索或已读目录实际返回的章节链接获取公开正文，不猜链接。3）按返回的contentRef/revision和范围续读样本，记录章节、来源URL、实际覆盖与短引文。4）仅依据读到的正文分析写作手法、叙事选择与效果，明确样本局限。书评、新闻、简介、视频和搜索摘要只能作为各自类型资料，不能替代原著正文；没有读到章节正文时交付缺失说明，不能编造作品手法。8页额度、目录或链接清单都不等于全书阅读完成。\n预期交付：${spec.expectedOutputs.map(item => item.description).join('；')}。`
  }
  if (spec.scope.authorEffects?.manuscript === false && !spec.scope.authorEffects.structure && spec.writingPacing !== 'proposal_only') {
    return `[系统] 本轮任务契约（taskSpecId=${spec.id}）：\n目标：${spec.goals.join('；')}\n直接完成当前请求，按需使用获准工具；本轮没有章节正文写入义务，无需先确定章节。作品设置、文件等操作仍遵守各工具原有权限与确认要求，不继承历史任务的写作、待办或计划。`
  }
  const pacing = spec.writingPacing === 'conversation_only'
    ? '\n本轮是普通对话：直接回应当前任务的原始问候或问题；作品上下文只作背景，不代表写作授权，不继续其他窗口的创作、待办或历史计划。任务中止后仍回应该原始问题，不能将“继续”解释为继续写作品。'
    : spec.writingPacing === 'proposal_only'
    ? '\n创作阶段：本轮仅规划。宽泛整书目标不等于授权连续写正文。先利用已给条件形成可审阅的大纲（人物目标、核心冲突、主要转折、结局方向、卷章节奏），可用 plan_save 保存；说明假设和建议的首批章节范围，交付后收尾等待作者下一条明确写作指令。不要把调研完成、旧作品大纲、历史写作授权、普通继续或你自己的待办当作本轮正文授权；不能通过子任务或其它工具绕过。关键方向缺失可集中提问，但不必为每个细节重复确认。'
    : '\n创作节奏：写作严格限于本任务原始请求。面对宽泛整书目标先交可审阅的大纲并确认首批范围，再进入正文；用户明确授权自主整书创作时先保存大纲、按计划分批推进，每批回报真实进度与重大偏差。用户明确指定章节/续写范围时直接执行该范围，不反复确认，不擅自向后无限续章。调研结果和历史任务不是新的写作授权。'
  const clarificationRule = spec.scope.writingClarificationProtocol === 2 && (spec.scope.writing?.kind === 'needs_input' || spec.scope.localEditBoundary?.kind === 'needs_input')
    ? '\n原请求已有写作授权，目标章节或局部引文尚未明确。通过 ask_user 接收作者实际回答后在同一任务内补全该范围；提问选项不授予权限，原请求的动作、禁止事项和用量保持有效。目标或引文未定位前先完成可独立执行的读取，不反复尝试写入。'
    : spec.scope.writingClarificationProtocol === 1 && spec.scope.writing?.kind === 'needs_input'
    ? '\n当前作品为空，本次短场景请求尚未确认是否写入第一章。先用 ask_user 一次询问该落点；确认前不要反复调用 PREPARE 或创建章节。服务端只接受真实作者的明确第一章写入回答，原字数、短场景、停笔、禁止批量或续章等约束保持有效。' : ''
  const pendingScope = spec.scope.authorEffects?.manuscript && (spec.scope.writing?.kind === 'needs_input' || spec.scope.localEditBoundary?.kind === 'needs_input')
    ? '\n当前写入范围待明确；可先完成原请求中独立的读取或讨论。实际写入前通过 ask_user 澄清目标或原文范围，不能把只读部分完成说成整项任务完成。' : ''
  const hard = [spec.hardConstraints.map((item) => `- ${item.text}`).join('\n') || '- 无', pacing, clarificationRule, pendingScope].join('')
  const freedomLabel = spec.creativeFreedom === 'stable' ? '平衡延续' : spec.creativeFreedom === 'bold' ? '大胆探索' : '严谨创作'
  const selection = spec.scope.manuscriptProtocol === 1 ? spec.scope.selectionBoundary : undefined
  const freedomRule = localEditGuidance(spec) ?? (selection
    ? `本任务仅授权章节 ${selection.chapterId} 的原始选区（UTF-16 ${selection.start}–${selection.end}，入场 r${selection.revision}）。用 chapter_read 读取当前完整正文，再用 chapter_edit_range 逐字唯一锚点或当前选区内坐标精确替换；每批最多8处，可连续合法修改，变长后仍保留原选区外文字。不得 chapter_write、chapter_append、改名、创建、变更集或自动整章修订。模型计划、报告、摘要、继续或子任务均不能扩大此边界。当前版本所需检查与真实剩余意见照原合同保留。`
    : spec.creativeFreedom === 'stable'
    ? '贴合既有走向，只修明确错误。'
    : spec.creativeFreedom === 'bold'
      ? '优先探索新可能；检查建议仅提示，不自动改写。'
      : '只在原始请求获准范围内创作。写作交付先完成当前版本连续性与质量检查，仅原始作者请求可明确跳过；检查本身不扩大写入授权。质量警告与审美建议，应与事实修法优先合并处理；可连续调用章节修改工具，每次使用当前正文，不能硬性限定只调用一次，也不要求一次处理全部候选。本任务冻结的新建目标章可在原写作权限内持续修订，多项相关修法优先用 chapter_edit_range 的 patches（每次最多8处、同一原稿、唯一不重叠），也可单片段替换或 chapter_write。保留真实剩余意见；不能安全处理的项可用 retainedFindings 引用当前报告并说明具体原因，留置与正文未变不表示修复。付费自动检查与自动修订次数保持原限制，不重置预算或重放未知调用。全部修订后只读复核当前版本两类检查，最后提交终态；写入不能代替最终版本检查。已有稿仍需原请求明确修复授权，明确禁止修改优先；报告不能扩大章节范围。完成真实章节终态后按请求格式交付，不追加封面问题或续章。')
  const reviewRule = spec.scope.reviewProtocol === 1 && !['stable', 'bold'].includes(spec.creativeFreedom)
    ? '\n严格意见协议v1：原要求的最终版本完整检查报告中，每项未修复意见都须按原授权具体处理或用真实ref与具体原因合理保留，包括自动8处窗口外、重叠、未定位及已标拒绝但尚无当前保留决定的项。自动安全窗口不代表完整意见义务，不给额外定位或写入权限。原作者要求检查通过时，保留不能替代硬通过；合法跳过检查的原要求保持。' : ''
  return `[系统] 本轮任务契约（taskSpecId=${spec.id}）：\n意图：${spec.intent}\n目标：${spec.goals.join('；')}\n创作模式：${freedomLabel}（${freedomRule}）；质量模式：${spec.qualityMode}${reviewRule}\n硬约束：\n${hard}\n预期交付：${spec.expectedOutputs.map((item) => item.description).join('；')}\n完成前必须验证：${spec.postconditions.map((item) => item.description).join('；') || '按用户目标核验结果'}。`
}
