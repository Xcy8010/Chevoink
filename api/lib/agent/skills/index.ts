import type { AgentExecutionMode, TaskIntent } from '../../../../shared/contracts/index.js'

export type CreativeFreedom = 'stable' | 'balanced' | 'bold'
export type SkillPhase = 'research' | 'plan' | 'scene' | 'draft' | 'critique' | 'revision' | 'commit'
export type SkillReasonCode =
  | 'PROJECT_POSITIONING'
  | 'LONG_OUTLINE'
  | 'WRITE_CHAPTER'
  | 'SCENE_CAUSALITY'
  | 'CHARACTER_VOICE'
  | 'EMOTION_GROUNDING'
  | 'STYLE_RISK_HIGH'
  | 'STYLE_CONTINUITY'
  | 'CHAPTER_BRIDGE'
  | 'CONTINUITY_AUDIT'
  | 'REPETITION_RISK'
  | 'CUSTOM_TRIGGER'
  | 'MANUAL_PIN'

type SkillTrigger = {
  pattern: RegExp
  reasonCode: SkillReasonCode
  weight: number
}

export type AgentSkill = {
  id: string
  name: string
  description: string
  version: string
  owner: 'chevoink' | 'user' | 'agent' | 'third_party'
  license: string
  attribution?: string
  status: 'active'
  intents: TaskIntent[]
  modes: AgentExecutionMode[]
  phases: SkillPhase[]
  strength: 'soft'
  triggers: SkillTrigger[]
  /** 触发短语的可读形式，用于技能清单与前端展示；内置技能用正则，故通常只有作者技能有值。 */
  triggerLabels?: string[]
  negativeTriggers: RegExp[]
  synopsis: string
  resources: Partial<Record<SkillPhase, string>>
  tokenBudget: number
  priority: number
  conflicts: string[]
  composesWith: string[]
}

export type SkillRouteCandidate = {
  skill: AgentSkill
  score: number
  reasonCodes: SkillReasonCode[]
}

export type SkillRouteDecision = {
  routerVersion: '3.1.0'
  phase: SkillPhase
  candidates: SkillRouteCandidate[]
  selected: AgentSkill[]
  reasonCodes: SkillReasonCode[]
  confidence: number
  estimatedTokens: number
  skippedReason?: 'FEATURE_DISABLED' | 'NON_CREATIVE_OPERATION' | 'NO_MATCH'
}

const MINOR_EDIT_PATTERN = /(?:只|仅)?(?:改|修改|修正|检查)?(?:一个|几个|一下)?(?:错别字|标点|空格|标题|序号|格式|排版)(?:即可|就行|不要动其他|不改内容)?/i
const NON_CREATIVE_PATTERN = /(?:发布|下架|删除|导出|移动.{0,12}(?:章|卷)|(?:章|卷).{0,12}移动|创建.{0,8}(?:章|卷)|(?:章|卷).{0,8}创建|字数统计|查询字数|打开|关闭|折叠|排序)/i
const noNegativeTriggers = [MINOR_EDIT_PATTERN, NON_CREATIVE_PATTERN]
const PRESERVE_INTENTIONAL_STYLE_PATTERN = /(?:不要|无需|不应|不能|别).{0,24}(?:仅因|因为|直接|强行).{0,24}(?:判断为?AI味|判错|润色|改成白话|删掉术语)/i

/** Router policy, not a rewrite of immutable skill resources. Mixed requests may
 * include UI/format operations; those words alone do not negate creative work. */
export function isMechanicalOnly(prompt: string): boolean {
  const withoutNegatedCreation = prompt.replace(/(?:不要|无需|不必|禁止|别)(?:再)?(?:润色|改写|续写|扩写|创作|写正文|修改内容)/g, '')
  const creative = /(?:润色|改写|续写|扩写|补写|创作|写(?:一|下|第|正文|场景|对白|对话|大纲)|规划|设计.{0,8}(?:人物|情节)|调整.{0,8}(?:节奏|情绪)|修改.{0,8}(?:对白|情节))/u.test(withoutNegatedCreation)
  return !creative && (MINOR_EDIT_PATTERN.test(prompt) || NON_CREATIVE_PATTERN.test(prompt))
}

function modeMatches(skill: AgentSkill, mode: AgentExecutionMode, phase: SkillPhase): boolean {
  // Work executes in build mode, including its planning stage. This grants no
  // tools/permissions and does not widen author-defined mode restrictions.
  return skill.modes.includes(mode) || (mode === 'build' && phase === 'plan' && skill.owner === 'chevoink'
    && ['cn-project-positioning.v3', 'cn-long-outline.v3'].includes(skill.id))
}

function blockedByNegative(skill: AgentSkill, prompt: string): boolean {
  return skill.negativeTriggers.some(pattern => {
    if (!pattern.test(prompt)) return false
    if (skill.owner !== 'chevoink' || pattern === PRESERVE_INTENTIONAL_STYLE_PATTERN) return true
    return isMechanicalOnly(prompt)
  })
}

/**
 * Agent 3.0 首批内置中文网文 Skill Pack。
 * 元数据始终可见，resources 只在服务端路由命中后完整装载，避免把整套规范常驻上下文。
 */
export const skillCatalog: AgentSkill[] = [
  {
    id: 'cn-project-positioning.v3',
    name: '中文网文项目定位',
    description: '把题材想法转换为目标读者、核心承诺、差异点和明确禁区。',
    version: '3.0.0', owner: 'chevoink', license: 'internal', status: 'active',
    intents: ['plan'], modes: ['plan'], phases: ['plan'], strength: 'soft',
    triggers: [{ pattern: /(新书|题材|定位|受众|卖点|创意|故事方向|写一本)/, reasonCode: 'PROJECT_POSITIONING', weight: 28 }],
    negativeTriggers: noNegativeTriggers,
    synopsis: '先明确读者为何追读和本书独有判断，再进入长篇规划。',
    resources: {
      plan: '先形成项目定位：目标读者、核心阅读承诺、主角持续欲望、稳定冲突引擎、与同题材常见写法的差异，以及作者明确不要的表达。缺少关键信息时只询问会改变故事方向的问题；不要从一句题材描述直接展开几十章模板目录。',
    },
    tokenBudget: 420, priority: 95, conflicts: [], composesWith: ['cn-long-outline.v3'],
  },
  {
    id: 'cn-long-outline.v3',
    name: '中文网文长篇规划',
    description: '按卷级承诺—兑现、冲突升级和人物代价组织长篇，而不是机械章节表。',
    version: '3.0.1', owner: 'chevoink', license: 'Apache-2.0-adapted',
    attribution: '工作流思想参考 Novel Architect（Apache-2.0），实现与中文规则均为 Chevoink 重写。',
    status: 'active', intents: ['plan'], modes: ['plan'], phases: ['plan'], strength: 'soft',
    triggers: [{ pattern: /(大纲|长篇|分卷|卷纲|情节弧|规划|计划|主线|支线)/, reasonCode: 'LONG_OUTLINE', weight: 32 }],
    negativeTriggers: noNegativeTriggers,
    synopsis: '规划承诺、升级、选择、代价和兑现，章节数量由内容决定。',
    resources: {
      plan: '按作者本次类型与情绪承诺，用“读者承诺—阶段阻力—人物选择—实际后果或收益—阶段兑现—遗留问题”组织每卷；可无额外代价，不强加损失。先证明冲突引擎能够持续变化，再拆章节；不固定三幕、每卷章数、反转频率或爽点间隔。每个重要节点说明前因、状态变化和后续约束，不扩大本次授权范围。',
    },
    tokenBudget: 520, priority: 92, conflicts: [], composesWith: ['cn-project-positioning.v3', 'cn-scene-task.v3'],
  },
  {
    id: 'cn-scene-task.v3',
    name: '场景任务构建',
    description: '写前明确人物目标、具体阻力、选择、代价和场景终态。',
    version: '3.0.2', owner: 'chevoink', license: 'Apache-2.0-adapted',
    attribution: 'PREPARE→WRITE→REVIEW 状态门思想参考 Novel Architect（Apache-2.0），未复制其提示词。',
    status: 'active', intents: ['write', 'plan'], modes: ['plan', 'build'], phases: ['scene', 'draft'], strength: 'soft',
    triggers: [{ pattern: /(写|续写|补写|场景|这一章|下一章|正文|冲突|交锋|追逐)/, reasonCode: 'SCENE_CAUSALITY', weight: 24 }],
    negativeTriggers: noNegativeTriggers,
    synopsis: '先证明场景会改变故事状态，再生成正文。',
    resources: {
      scene: '写正文前在内部形成最小场景任务包：视角人物此刻想得到什么；谁或什么具体阻止；人物采取什么行动与选择；已有代价或实际后果（可以无额外损失、获得授权的收益）；信息、关系、资源、位置或目标哪项变化；如何承接上一场终态。先核对完整原请求的类型、情绪承诺、身份、篇幅和停笔位置；不为结构强加反派、成交或惩罚，不套固定节拍。',
      draft: '先在内部确认本章必要场景；每个场景都要有目标、阻力和状态变化。同章历史作者规格仅作创作背景，当前明确修改优先。人物身份、低谷段数、篇幅与停笔准确兑现；场景任务若写了问价终态，也不能越过作者问价前停笔。没有作用的场景合并或删除。正文不展示任务包或结构术语。',
    },
    tokenBudget: 460, priority: 100, conflicts: [], composesWith: ['cn-webfiction-draft.v3', 'cn-chapter-bridge.v3'],
  },
  {
    id: 'cn-webfiction-draft.v3',
    name: '中文网文自然正文',
    description: '以事件推进和人物行动为主体，控制无功能描写、解释复述与炫技式修辞。',
    version: '3.0.2', owner: 'chevoink', license: 'internal', status: 'active',
    intents: ['write'], modes: ['build'], phases: ['draft'], strength: 'soft',
    triggers: [{ pattern: /(写|续写|补写|扩写|正文|章节|下一章|这一章)/, reasonCode: 'WRITE_CHAPTER', weight: 36 }],
    negativeTriggers: noNegativeTriggers,
    synopsis: '保证首次 Draft 就具体、连贯、有事件，不把修复全部推给改稿阶段。',
    resources: {
      draft: '服从本次作者类型与情绪承诺，承接同章历史背景中未明确改变的身份、剧情、篇幅、开篇比例与停笔。历史背景不授权新写入，旧展示格式不覆盖最新真实作者偏好；写入章节不等于聊天贴全文。以行动与后果为骨架；要求捡漏爽感时，正文明确独享优势、获利空间、兴奋或野心与抓住机会的主动决定，低谷快速交代，强反差服务发现与选择。低修辞预算只控制无功能修饰，不代表低情绪；其他题材按各自承诺。停在问价或交易前就在发现与期待中兑现，不强求成交、现金、反派或收益惩罚。清晰面板、提示、数值、纸面文字和直接引文允许引号及结构化排版，仍处理无功能堆砌与重复解释；作品名使用《》。',
    },
    tokenBudget: 620, priority: 110, conflicts: [], composesWith: ['cn-scene-task.v3', 'cn-character-voice.v3', 'cn-emotion-grounding.v3'],
  },
  {
    id: 'cn-character-voice.v3',
    name: '人物声口与知识边界',
    description: '从欲望、关系、知识边界、回避方式和既有语言样本区分人物。',
    version: '3.0.0', owner: 'chevoink', license: 'MIT-adapted',
    attribution: '角色状态组织方法参考 OpenFic 公开项目，未复制源提示词或作品文本。',
    status: 'active', intents: ['write', 'revise', 'plan', 'review'], modes: ['plan', 'build', 'review'],
    phases: ['plan', 'draft', 'critique', 'revision'], strength: 'soft',
    triggers: [
      { pattern: /(人物|角色|声口|口吻|知识边界|回避方式)/, reasonCode: 'CHARACTER_VOICE', weight: 30 },
      { pattern: /(对话|关系|争执|交锋|主角|配角|聊天)/, reasonCode: 'CHARACTER_VOICE', weight: 12 },
    ],
    negativeTriggers: noNegativeTriggers,
    synopsis: '让人物因目的和经历不同而说不同的话，不靠口头禅标签化。',
    resources: {
      plan: '为关键人物记录：想得到什么、害怕失去什么、掌握与不知道的信息、面对不同关系时如何说话、习惯回避什么，以及声音如何随成长变化。不要用几个口头禅代替完整人物。',
      draft: '写对话前核对关系阶段和各自知识边界。对白围绕目的、回避和误解展开；通过称谓、句长、关注点、沉默和回应方式自然分化人物，不给每句对白追加动作标签。',
      critique: '只指出能由原文举证的声口趋同、信息越权和动机跳变；把事实硬伤与审美偏好分开，引用尽量短。',
      revision: '仅修订选中的声口问题，保留原句骨架和人物已有习惯；优先调整目的、潜台词与反应差异。',
    },
    tokenBudget: 520, priority: 88, conflicts: [], composesWith: ['cn-emotion-grounding.v3', 'cn-webfiction-draft.v3'],
  },
  {
    id: 'cn-emotion-grounding.v3',
    name: '情绪落地',
    description: '把情绪连接到欲望、触发、身体反应、选择和关系后果。',
    version: '3.0.2', owner: 'chevoink', license: 'internal', status: 'active',
    intents: ['write', 'revise', 'review'], modes: ['build', 'review'], phases: ['draft', 'critique', 'revision'], strength: 'soft',
    triggers: [{ pattern: /(情感|情绪|感动|心动|痛苦|害怕|恐惧|愤怒|悲伤|压抑|暧昧|代入)/, reasonCode: 'EMOTION_GROUNDING', weight: 30 }],
    negativeTriggers: noNegativeTriggers,
    synopsis: '让情绪有原因、有身体和关系代价，不靠正确标签制造感动。',
    resources: {
      draft: '先确认情绪的触发、欲望与反应或选择。爽文要求的兴奋和野心应在具体优势、翻身或获利机会前实际呈现，让主角主动决定；不能只允许却全部写成冷静无感。隐藏优势而压住表情是策略，内心可以鲜明。其他题材克制或外放按作者要求，允许直述，不必写全链。',
      critique: '寻找只有情绪标签却没有触发、欲望、行为或后果的段落；不要把克制、直述或留白误判为空洞。',
      revision: '只补足缺失的因果链环节，优先使用本角色已有经历和当前场景物件；禁止统一替换成颤抖、攥拳、眼眶发热等模板动作。',
    },
    tokenBudget: 480, priority: 86, conflicts: [], composesWith: ['cn-character-voice.v3', 'cn-prose-specificity.v3'],
  },
  {
    id: 'cn-prose-specificity.v3',
    name: '中文语言具体化',
    description: '基于文本证据处理抽象判断、空洞修辞、同构句式和解释性复述。',
    version: '3.0.0', owner: 'chevoink', license: 'internal', status: 'active',
    intents: ['write', 'revise', 'review'], modes: ['build', 'review'], phases: ['draft', 'critique', 'revision'], strength: 'soft',
    triggers: [{ pattern: /(AI味|机械|僵硬|不自然|套话|润色|文风|语言|华丽|堆砌|虚浮)/i, reasonCode: 'STYLE_RISK_HIGH', weight: 38 }],
    negativeTriggers: [...noNegativeTriggers, PRESERVE_INTENTIONAL_STYLE_PATTERN],
    synopsis: '删除通常优先于同义替换，不用另一套公式覆盖作者声音。',
    resources: {
      draft: '首次写作也要避免空泛判断、连续同构句、无铺垫稀有意象和解释性复述。先写清人物动作与后果，再决定是否需要修辞；一个有效细节胜过一串形容词，但不要机械执行“展示而非讲述”。',
      critique: '标出真实出现的重复意象、同构句式、抽象情绪、副词依赖、孤立华丽词或总结式收尾，并附短证据；结合题材和人物语域判断，未出现的问题不凑清单。',
      revision: '只改作者选中的证据点。删除通常优先于同义替换；把抽象判断换成与人物处境有关的动作、选择或物件，同时保留作者原有的直述、怪癖和节奏。',
    },
    tokenBudget: 520, priority: 96, conflicts: [], composesWith: ['cn-style-continuity.v3', 'cn-emotion-grounding.v3'],
  },
  {
    id: 'cn-style-continuity.v3',
    name: '文风连续性',
    description: '检查叙事距离、句段节奏、修辞密度和语域是否无理由漂移。',
    version: '3.0.0', owner: 'chevoink', license: 'internal', status: 'active',
    intents: ['write', 'revise', 'review'], modes: ['build', 'review'], phases: ['draft', 'critique', 'revision'], strength: 'soft',
    triggers: [{ pattern: /(文风|风格|割裂|不统一|前后|叙事距离|节奏|语域)/, reasonCode: 'STYLE_CONTINUITY', weight: 30 }],
    negativeTriggers: noNegativeTriggers,
    synopsis: '优先延续本书既有声音，允许有剧情依据的主动变调。',
    resources: {
      draft: '延续近期章节已形成的叙事距离、句段呼吸、对白密度和修辞强度。若因视角、时代、梦境或情绪高潮主动变调，要有清晰过渡；不要把平台通用风格压过作者声音。',
      critique: '按段比较叙事距离、句长、词汇语域、修辞密度和对白习惯，只报告无剧情依据且读感突兀的漂移。',
      revision: '以最小范围把异常段拉回相邻文本的声音，不整章洗稿，不消灭作者有意的不规则表达。',
    },
    tokenBudget: 430, priority: 84, conflicts: [], composesWith: ['cn-prose-specificity.v3'],
  },
  {
    id: 'cn-chapter-bridge.v3',
    name: '章节桥接',
    description: '承接上一章终态中的动作、知识、情绪余波和未完成问题。',
    version: '3.0.0', owner: 'chevoink', license: 'internal', status: 'active',
    intents: ['write', 'plan'], modes: ['plan', 'build'], phases: ['scene', 'draft'], strength: 'soft',
    triggers: [{ pattern: /(续写|下一章|接着|承接|衔接|上一章|章间|继续写)/, reasonCode: 'CHAPTER_BRIDGE', weight: 34 }],
    negativeTriggers: noNegativeTriggers,
    synopsis: '新章从上一章真实后果出发，不用重复摘要或生硬转场。',
    resources: {
      scene: '写前提取上一章终态：未完成动作、人物所在位置、各自知道什么、情绪余波、关系变化、正在倒计时的风险，以及本章必须接住的问题。新章开场至少自然承接其中一项，但不复述上一章摘要。',
      draft: '让上一章留下的动作或后果进入本章人物当前处境。允许时间跳跃，但必须给读者足够的定位证据；禁止用“时间飞逝”“话说回来”掩盖因果断层。',
    },
    tokenBudget: 440, priority: 94, conflicts: [], composesWith: ['cn-scene-task.v3', 'cn-continuity-audit.v3'],
  },
  {
    id: 'cn-continuity-audit.v3',
    name: '证据化连续性审阅',
    description: '依据来源检查设定、时间线、人物知识、持有物和伏笔，不凭印象判错。',
    version: '3.0.0', owner: 'chevoink', license: 'MIT-adapted',
    attribution: '分层记忆与证据召回思想参考 TencentDB-Agent-Memory，规则与实现均为 Chevoink 重写。',
    status: 'active', intents: ['write', 'revise', 'review', 'structure'], modes: ['build', 'review'],
    phases: ['draft', 'critique', 'revision', 'commit'], strength: 'soft',
    triggers: [{ pattern: /(连续|一致|时间线|伏笔|设定|持有物|伤势|知识状态|前文|矛盾|(?:核对|检查).{0,16}关系|关系.{0,8}(?:一致|前后|冲突|状态))/, reasonCode: 'CONTINUITY_AUDIT', weight: 32 }],
    negativeTriggers: [MINOR_EDIT_PATTERN, /(?:发布|下架|导出|折叠|打开|关闭)/i],
    synopsis: '事实结论必须可追溯，没有证据的疑点只标待核实。',
    resources: {
      draft: '只携带当前场景必需的已确认事实、关系、知识状态、未收束事件和作者禁区。遇到冲突或推断记忆时回到来源核实，不自行选边。',
      critique: '逐项给出位置、冲突双方和 sourceId/revision；没有证据的疑点标为待核实，不升级为硬伤。',
      revision: '按选中的连续性问题最小改动，不能为了修一处事实重写无关文风。',
      commit: '写入后复核本章新增事实、关系、知识和伏笔状态，并保留来源 revision。',
    },
    tokenBudget: 500, priority: 90, conflicts: [], composesWith: ['cn-chapter-bridge.v3'],
  },
  {
    id: 'cn-anti-repetition.v3',
    name: '近期结构去重',
    description: '识别近期章节重复的开场、意象、冲突解法、句式和结尾功能。',
    version: '3.0.0', owner: 'chevoink', license: 'internal', status: 'active',
    intents: ['write', 'revise', 'review'], modes: ['build', 'review'], phases: ['draft', 'critique', 'revision'], strength: 'soft',
    triggers: [{ pattern: /(重复|雷同|套路|同样|又是|新鲜感|去重)/, reasonCode: 'REPETITION_RISK', weight: 30 }],
    negativeTriggers: noNegativeTriggers,
    synopsis: '避免近期章节同构，但不追求为了不同而不同。',
    resources: {
      draft: '对照近期章节的开场动作、场景空间、冲突解法、核心意象、句式节奏和结尾功能。若连续重复，改变承载方式而不是只换同义词；仍以人物因果和本章任务为先。',
      critique: '给出近期重复项及对应章节证据，区分有意母题复现和无意识模板复用。',
      revision: '只替换造成同构读感的局部结构或意象，保留必要的主题回声和事实连续性。',
    },
    tokenBudget: 430, priority: 78, conflicts: [], composesWith: ['cn-webfiction-draft.v3', 'cn-style-continuity.v3'],
  },
]

const legacySkillAliases: Record<string, string> = {
  'scene-craft.v2': 'cn-scene-task.v3',
  'character-voice.v2': 'cn-character-voice.v3',
  'continuity-evidence.v2': 'cn-continuity-audit.v3',
  'prose-specificity.v2': 'cn-prose-specificity.v3',
  'story-shaping.v2': 'cn-long-outline.v3',
}

function freedomGuidance(freedom: CreativeFreedom): string {
  if (freedom === 'stable') return '创作模式：平衡延续。优先承接已有文风、人物轨迹与段落节奏，只修明确错误，不主动清洗作者有意保留的不规则表达。'
  if (freedom === 'bold') return '创作模式：大胆探索。允许明显的场景、结构和表达创新，优先打开新可能；核心设定和不可逆剧情仍服从作者与故事事实，质量报告只提示不自动改写。'
  return '创作模式：严谨创作。守住人物知识、因果、时空和已确立世界规则，服从本次作者类型与情绪承诺；严谨不等于克制。按原写作请求完成最终版本的连续性与人类感检查；付费自动修订保持一次有界处理，普通正文工具可在原授权内连续修改，相关修法优先合并，剩余意见保留真实状态，不追求清零。既有章节与范围外修订仍须作者明确授权。'
}

export function inferSkillPhase(intent: TaskIntent): SkillPhase {
  if (intent === 'plan') return 'plan'
  if (intent === 'review' || intent === 'research_analysis') return 'critique'
  if (intent === 'revise') return 'revision'
  return 'draft'
}

function baseIntentScore(skill: AgentSkill, intent: TaskIntent): number {
  if (!skill.intents.includes(intent)) return 0
  if (skill.id === 'cn-webfiction-draft.v3' && intent === 'write') return 52
  if (skill.id === 'cn-scene-task.v3' && intent === 'write') return 46
  if (skill.id === 'cn-long-outline.v3' && intent === 'plan') return 46
  if (skill.id === 'cn-project-positioning.v3' && intent === 'plan') return 36
  if (skill.id === 'cn-prose-specificity.v3' && intent === 'revise') return 34
  if (skill.id === 'cn-continuity-audit.v3' && intent === 'review') return 32
  return 18
}

function uniqueReasonCodes(candidates: SkillRouteCandidate[]): SkillReasonCode[] {
  return [...new Set(candidates.flatMap((candidate) => candidate.reasonCodes))]
}

/**
 * 取技能在当前阶段的说明；作者自建或导入的技能常常只写了一个阶段，
 * 手动指定后不能因为阶段不匹配就装载成空内容，这里回退到该技能自己声明的首个可用阶段。
 */
export function resolveSkillResource(skill: AgentSkill, phase: SkillPhase): { phase: SkillPhase; resource: string } | null {
  const direct = skill.resources[phase]
  if (direct) return { phase, resource: direct }
  for (const fallbackPhase of skill.phases) {
    const resource = skill.resources[fallbackPhase]
    if (resource) return { phase: fallbackPhase, resource }
  }
  return null
}

function estimateLoadedTokens(skills: AgentSkill[], phase: SkillPhase): number {
  const chars = skills.reduce((total, skill) => total + (resolveSkillResource(skill, phase)?.resource.length ?? 0), 0)
  return Math.ceil(chars / 2.2)
}

function isAuthorSkill(skill: AgentSkill): boolean {
  return skill.owner !== 'chevoink'
}

export function routeSkills(input: {
  mode: AgentExecutionMode
  prompt: string
  intent: TaskIntent
  phase?: SkillPhase
  freedom: CreativeFreedom
  enabledSkillIds?: ReadonlySet<string>
  catalog?: readonly AgentSkill[]
  /** 作者在输入框里手动指定的技能；它们绕过意图/阶段/评分门槛，必需装载。 */
  pinnedSkillIds?: ReadonlySet<string>
}): SkillRouteDecision {
  const phase = input.phase ?? inferSkillPhase(input.intent)
  const normalizedPrompt = input.prompt.trim()
  const catalog = input.catalog ?? skillCatalog
  const isEnabled = (skill: AgentSkill): boolean => input.enabledSkillIds?.has(skill.id) ?? true

  const pinnedCandidates: SkillRouteCandidate[] = input.pinnedSkillIds?.size
    ? catalog
        .filter((skill) => input.pinnedSkillIds?.has(skill.id) && skill.status === 'active' && isEnabled(skill) && Boolean(resolveSkillResource(skill, phase)))
        .map((skill) => ({ skill, score: 1_000 + skill.priority / 100, reasonCodes: ['MANUAL_PIN'] as SkillReasonCode[] }))
    : []
  const pinnedIds = new Set(pinnedCandidates.map((candidate) => candidate.skill.id))

  const skipMinorEdit = input.intent === 'revise' && isMechanicalOnly(normalizedPrompt)
  const skipOperation = ['global_transform', 'structure'].includes(input.intent) && isMechanicalOnly(normalizedPrompt)

  // 手动指定是作者的明确指令，优先于“非创作操作”早退。
  if (pinnedCandidates.length === 0 && (skipMinorEdit || skipOperation)) {
    return {
      routerVersion: '3.1.0', phase, candidates: [], selected: [], reasonCodes: [], confidence: 1,
      estimatedTokens: 0, skippedReason: 'NON_CREATIVE_OPERATION',
    }
  }

  const scored = catalog
    .filter((skill) => !pinnedIds.has(skill.id) && isEnabled(skill) && skill.status === 'active' && skill.intents.includes(input.intent) && modeMatches(skill, input.mode, phase) &&
      skill.phases.includes(phase) && !blockedByNegative(skill, normalizedPrompt))
    .map((skill) => {
      const matchedTriggers = skill.triggers.filter((trigger) => trigger.pattern.test(normalizedPrompt))
      const reasonCodes = [...new Set(matchedTriggers.map((trigger) => trigger.reasonCode))]
      const score = baseIntentScore(skill, input.intent) + matchedTriggers.reduce((total, trigger) => total + trigger.weight, 0) + skill.priority / 100
      return { skill, score, reasonCodes }
    })
    .sort((left, right) => right.score - left.score || right.skill.priority - left.skill.priority)

  const primaryCandidates = scored.filter((candidate) => candidate.score >= 30).slice(0, 8)
  // 作者自建与导入的技能基准分只有 18，没字面命中触发词时永远进不了候选；
  // 只要它声明了本轮意图与阶段，就应该有机会被看到。
  const authorFallbackCandidates = scored
    .filter((candidate) => isAuthorSkill(candidate.skill) && candidate.score < 30 && candidate.score >= 18)
    .slice(0, 3)
  const candidates = [...pinnedCandidates, ...primaryCandidates, ...authorFallbackCandidates]

  if (candidates.length === 0) {
    return {
      routerVersion: '3.1.0', phase, candidates: [], selected: [], reasonCodes: [], confidence: 1,
      estimatedTokens: 0, skippedReason: 'NO_MATCH',
    }
  }

  const explicitSignals = primaryCandidates.filter((candidate) => candidate.reasonCodes.length > 0).length
  const maxLoaded = explicitSignals >= 2 || input.intent === 'write' || input.intent === 'plan' ? 3 : 2
  const selectedCandidates: SkillRouteCandidate[] = []
  const foundationIds = new Set(['cn-webfiction-draft.v3', 'cn-scene-task.v3'])
  const specialistReasonPriority = (candidate: SkillRouteCandidate): number => {
    if (candidate.reasonCodes.includes('CHAPTER_BRIDGE')) return 2_000
    if (candidate.reasonCodes.includes('CONTINUITY_AUDIT')) return 1_500
    return candidate.score
  }
  const explicitlyMatchedSpecialists = input.intent === 'write'
    ? primaryCandidates
        .filter((candidate) => candidate.reasonCodes.length > 0 && candidate.score >= 30 && !foundationIds.has(candidate.skill.id))
        .sort((left, right) => specialistReasonPriority(right) - specialistReasonPriority(left) || right.score - left.score)
        // A weak contextual hint gets one slot, preserving the writing foundation.
        // Strong explicit specialist requests may reserve two slots as before.
        .slice(0, Math.min(maxLoaded - 1, Math.max(1, primaryCandidates.filter(candidate => candidate.reasonCodes.length > 0 && candidate.score >= 40 && !foundationIds.has(candidate.skill.id)).length)))
    : []
  // 内置基础技法基准分高达 46~52，不给作者技能保底槽位的话它们会被永远挤出。
  const authorPool = [...primaryCandidates, ...authorFallbackCandidates].filter((candidate) => isAuthorSkill(candidate.skill))
  const authorReserved = authorPool.slice(0, authorPool.some((candidate) => candidate.reasonCodes.length > 0) ? 2 : 1)
  const orderedCandidates = [
    ...pinnedCandidates,
    ...authorReserved,
    ...explicitlyMatchedSpecialists.filter((candidate) => !authorReserved.includes(candidate)),
    ...primaryCandidates.filter((candidate) => !authorReserved.includes(candidate) && !explicitlyMatchedSpecialists.includes(candidate)),
    ...authorFallbackCandidates.filter((candidate) => !authorReserved.includes(candidate)),
  ]
  const hardCap = Math.min(6, maxLoaded + pinnedCandidates.length + authorReserved.length)
  for (const candidate of orderedCandidates) {
    if (selectedCandidates.length >= hardCap) break
    // 手动指定不参与冲突让位：作者已经表态要用它。
    const pinnedCandidate = pinnedIds.has(candidate.skill.id)
    const conflicts = !pinnedCandidate && selectedCandidates.some((selected) => selected.skill.conflicts.includes(candidate.skill.id) || candidate.skill.conflicts.includes(selected.skill.id))
    if (!conflicts) selectedCandidates.push(candidate)
  }

  const selected = selectedCandidates.map((candidate) => candidate.skill)
  const topScore = selectedCandidates[0]?.score ?? 0
  const secondScore = selectedCandidates[1]?.score ?? 0
  const confidence = Math.min(0.99, Math.max(0.55, 0.62 + topScore / 220 + (topScore - secondScore) / 400))

  return {
    routerVersion: '3.1.0', phase, candidates, selected,
    reasonCodes: uniqueReasonCodes(selectedCandidates),
    confidence: Math.round(confidence * 100) / 100,
    estimatedTokens: estimateLoadedTokens(selected, phase),
  }
}

export function buildSkillManifestDigest(skills: AgentSkill[], freedom: CreativeFreedom): string {
  const listed = skills.length
    ? skills.map((skill) => `- ${skill.id}@${skill.version}（${skill.name}）：${skill.synopsis}`).join('\n')
    : '- 本轮无需专用创作 Skill。'
  return `${freedomGuidance(freedom)}\n本轮 Skill Router 候选：\n${listed}`
}

export type SkillDigestOptions = {
  /** 当前作品已启用的全部技能；传入后会向模型公开“本轮未加载”的技能清单。 */
  availableSkills?: readonly AgentSkill[]
  /** 作者本轮手动指定的技能 id。 */
  pinnedSkillIds?: readonly string[]
}

function skillOwnerLabel(skill: AgentSkill): string {
  if (skill.owner === 'chevoink') return '内置技能'
  if (skill.owner === 'user') return '作者技能'
  if (skill.owner === 'agent') return 'Agent 创建'
  return '导入技能'
}

/**
 * 作者自建、尤其是导入的技能，如果本轮没被路由命中，模型对它们零感知，
 * 也就永远不知道什么时候应该用。这里把它们以元数据形式公开，并给出加载判断规则。
 */
function buildUnloadedSkillGuide(decision: SkillRouteDecision, options: SkillDigestOptions): string | null {
  const available = options.availableSkills
  if (!available || available.length === 0) return null
  const loadedIds = new Set(decision.selected.map((skill) => skill.id))
  const rest = available.filter((skill) => !loadedIds.has(skill.id) && skill.status === 'active' && Boolean(resolveSkillResource(skill, decision.phase)))
  if (rest.length === 0) return null

  const lines = [...rest]
    .sort((left, right) => Number(isAuthorSkill(right)) - Number(isAuthorSkill(left)) || right.priority - left.priority)
    .slice(0, 14)
    .map((skill) => {
      const triggers = (skill.triggerLabels ?? []).slice(0, 3)
      const triggerText = triggers.length ? `｜适用：${triggers.join('、')}` : ''
      return `- ${skill.id}@${skill.version}（${skill.name}｜${skillOwnerLabel(skill)}｜阶段 ${skill.phases.join('/')}${triggerText}）：${skill.synopsis}`
    })

  return `本轮未加载、但当前作品已启用的技能：
${lines.join('\n')}
使用判断：作者点名某个技能，或本轮需求与某条技能的描述/适用场景明确吻合时，先用 skill_load 按当前阶段 ${decision.phase} 加载它再动手；同类能力下作者技能与导入技能优先于内置技能。不要为了展示能力批量加载。`
}

export function buildSkillExecutionDigest(decision: SkillRouteDecision, freedom: CreativeFreedom, options: SkillDigestOptions = {}): string {
  const unloadedGuide = buildUnloadedSkillGuide(decision, options)
  if (decision.selected.length === 0) {
    return [
      `${freedomGuidance(freedom)}\n本轮没有命中需要加载的创作 Skill；不得为了展示能力强行套用写作模板。`,
      unloadedGuide,
    ].filter((block): block is string => Boolean(block)).join('\n\n')
  }

  const pinned = new Set(options.pinnedSkillIds ?? [])
  const loaded = decision.selected.map((skill) => {
    const resolved = resolveSkillResource(skill, decision.phase)
    if (!resolved) return null
    const phaseLabel = resolved.phase === decision.phase ? decision.phase : `${resolved.phase}（本轮阶段 ${decision.phase} 未提供专用说明）`
    const pinnedMark = pinned.has(skill.id) ? ' / 作者本轮手动指定' : ''
    return `[Skill ${skill.id}@${skill.version} / ${phaseLabel} / soft${pinnedMark}]\n${resolved.resource}`
  }).filter((item): item is string => Boolean(item)).join('\n\n')

  const head = `${freedomGuidance(freedom)}
以下 Skill 已由服务端确定性路由并完整加载。它们是本轮工作方法，不是可忽略的候选，也不是逐项照抄到正文的检查表：
${loaded}
共同边界：不得覆盖作者硬约束、故事事实、权限与版本校验；发生冲突时作者要求与有来源的故事证据优先。`

  return [head, unloadedGuide].filter((block): block is string => Boolean(block)).join('\n\n')
}

export function loadSkill(skillId: string, phase: SkillPhase, freedom: CreativeFreedom, catalog: readonly AgentSkill[] = skillCatalog): string | null {
  const resolvedId = legacySkillAliases[skillId] ?? skillId
  const skill = catalog.find((item) => item.id === resolvedId)
  if (!skill) return null
  const resolved = resolveSkillResource(skill, phase)
  if (!resolved) return null
  return `[Skill ${skill.id}@${skill.version} / ${resolved.phase} / soft]\n${freedomGuidance(freedom)}\n${resolved.resource}\n边界：不得覆盖用户硬约束、故事证据、权限和版本校验；不要把本说明原样写入小说。`
}
