/**
 * 写作文笔知识集（plan/14 §六 D2）：怎么写得好，分通用规范卡与题材文风卡。
 * 首批为静态卡片（人工撰写），按 importance 取 top 注入；后续可迁移到数据库表并加检索工具。
 */

export type WritingKnowledgeCard = {
  /** 主题：开篇/对话/打斗/情感/悬念钩子/节奏… */
  topic: string
  /** 守则内容（≤400 字） */
  content: string
  /** 注入优先级，越大越优先 */
  importance: number
}

/** 通用文笔规范卡（题材无关）：常驻注入 top3 */
export const GENERAL_WRITING_CARDS: WritingKnowledgeCard[] = [
  {
    topic: '展示优于陈述',
    content: '当情绪或性格缺少可信依据时，优先补一个与人物处境有关的动作、选择、对话或生活细节；直述、概括和留白本身并非错误，不要把每句「感到/觉得」机械替换成攥拳、颤抖等模板动作。',
    importance: 10,
  },
  {
    topic: '章节钩子结构',
    content: '只有当本章承担连载拉读或悬念推进任务时，才检查结尾是否保留未完成动作、信息差或情感余波；舒缓章、收束章可以自然落地。开篇应让读者尽快定位人物处境，但不规定字数，也不禁止有剧情作用的环境或回忆。',
    importance: 9,
  },
  {
    topic: 'AI 痕迹规避',
    content: '只处理原文中真实出现的机械模式：无铺垫的孤立华丽词、同构句式、解释性复述、与人物无关的修饰堆砌和连续总结。词语本身不设黑名单；结合题材、视角、语域和作者既有声音判断，删除通常优先于同义替换。',
    importance: 8,
  },
  {
    topic: '对话推动剧情',
    content: '当对话篇幅较长却没有改变信息、关系、行动或气氛时，再判断是否需要压缩。寒暄可以承担关系质感和潜台词；动作标签只在有新信息时使用，不要求每句对白都配动作。人物差异来自目的、知识边界和回避方式，而不只是口头禅。',
    importance: 8,
  },
  {
    topic: '视角一致性',
    content: '默认延续作品已经采用的视角规则。限知视角下检查人物是否无依据知道他人心理或不可见信息；全知、多视角及有意切换不应被误判，切换只需让读者能够识别。',
    importance: 8,
  },
  {
    topic: '节奏控制',
    content: '句段节奏应服务当前视角与场景压力。只有当连续同构影响阅读、或设定说明让人物行动停滞时才提示调整；不规定连续段数和说明字数，也不把短句等同紧张、长句等同抒情。',
    importance: 7,
  },
]

/** 类型是阅读体验的软指导，当前作者请求优先于保存的作品标签。 */
export const GENRE_WRITING_CARDS: Record<string, WritingKnowledgeCard[]> = {
  爽文: [
    {
      topic: '爽文的阅读承诺与兑现',
      content: '爽文以主角获得主动权、优势被验证、愿望得到兑现带来鲜明满足感。围绕读者欲望或处境压力→主角优势与机会→主动行动、博弈和具体阻力→读者看得懂的收益与情绪释放→更大的下一步期待组织情节；这是因果参考，不是固定节拍。连载既兑现本章的一部分承诺，又打开下一步，不能把全部收益推迟到章末钩子之后。同一核心优势应驱动变化的兑现循环：收益改变后续资源、地位和选择，打开更大的具体目标，不重置成长或重复空洞震惊；只展开本次授权范围。',
      importance: 13,
    },
    {
      topic: '首章收益与情绪强度',
      content: '机会出现、能力觉醒、看见资源价值或确认翻身可能，本身就能成为首章兑现。允许有依据的野心、直接内心判断、清晰面板、喜悦和旁人反应。为隐藏优势而压住表情是策略，不等于内心毫无兴奋。若作者要求停在报价或交易之前，就在已授权的发现与期待中兑现，不补成交、不硬加反派打脸；不规定几章一次爽点。',
      importance: 12,
    },
  ],
  异能: [{
    topic: '异能优势与规则',
    content: '让读者理解能力能做什么、主角知道什么、如何验证并主动使用。能力带来的机会可以明确、令人兴奋；规则严谨是遵守已确立的边界和因果，不是每次觉醒或收益都额外索取代价。既有代价必须承接，未设定的惩罚不强加。面板、提示和数值是世界内信息，可用清晰结构呈现。',
    importance: 11,
  }],
  慢热: [{ topic: '慢热的积累', content: '按作者要求让关系、线索或生活变化逐步积累；每场提供有意义的新理解或细微变化，允许舒缓、留白和自然收束，不强加爆发、升级或打脸。', importance: 12 }],
  现实: [{ topic: '现实题材的经验与后果', content: '阅读体验来自具体处境、可信选择、关系与生活后果；人物可以成功、喜悦或失意，不默认必须逆袭，也不把克制当唯一真实。让细节服务人物当前关心的事。', importance: 12 }],
  幽默: [{ topic: '喜剧的节奏与回响', content: '按作者要求让错位、人物欲望、对白节奏与可理解的反应产生笑点，允许夸张和刻意排比。笑点要有语境和后果，不能只靠无关段子；不强加文学克制或爽文打脸。', importance: 12 }],
  科幻: [
    {
      topic: '硬设定自洽',
      content: '科技设定一旦写出就是铁律：能力边界、代价、限制条件全书一致，新章节使用设定前先核对已有描述。禁止为剧情方便临时扩充能力（「其实它还能…」）。设定服务于两难困境而不是万能解药。',
      importance: 10,
    },
    {
      topic: '术语密度控制',
      content: '新术语按场景需要引入，让读者理解它如何影响判断和行动；不规定数量。已有术语优先复用，必要说明可以直接写清。科技奇观、探索或困境按作者的阅读承诺展开，不默认每项技术都必须换来损失。',
      importance: 9,
    },
    {
      topic: '尺度感与陌生化',
      content: '科幻的爽点在尺度与陌生感：宇宙尺度的数字要落到人的体感上（「信号往返一次，地球上已过去三代人」）。日常物件的异化比全新造物更有冲击力。留一处「不给答案的谜」维持世界的深度。',
      importance: 8,
    },
  ],
  悬疑: [
    {
      topic: '信息释放节奏',
      content: '悬疑的承诺是好奇、推理与不确定感。让调查、线索、推断或危险有实质变化，局部答案可以带来满足并打开更深问题；关键揭晓应有可回看的依据，但不规定每章线索数、埋设次数或回收比例。不要为爽感提前揭底或强行让主角碾压。',
      importance: 10,
    },
    {
      topic: '红鲱鱼与公平性',
      content: '误导（红鲱鱼）必须基于真实存在的线索让读者自己推错，而不是靠叙述者说谎。揭晓时所有伏笔要能闭环：凶手/真相的每个要素都在正文出现过。禁止最后一章空降新人物新动机。',
      importance: 9,
    },
    {
      topic: '压迫感营造',
      content: '恐惧来自「知道危险存在但不知道在哪」：写脚步声消失比写脚步声逼近更瘆人。环境细节做威胁的放大器（停摆的钟、半杯还温的水）。让主角犯合理的错，读者比主角早半步看到危险时张力最大。',
      importance: 8,
    },
  ],
  玄幻: [
    {
      topic: '力量体系规则感',
      content: '遵守已确立的境界、功法与能力边界；越级胜利要有可信的能力、策略或条件依据。觉醒与突破可以带来清晰收益，不必额外编造惩罚；已有代价不能遗忘。力量变化应让读者理解新的机会和敌我关系。',
      importance: 10,
    },
    {
      topic: '爽点节奏',
      content: '玄幻可承担冒险、成长、奇观、悬疑或爽感，先服从作者本次承诺。若要求爽感，优势与阶段收益应明确，反应要有具体对象与原因；不规定憋屈章数，不把所有玄幻都改成打脸模板。',
      importance: 9,
    },
    {
      topic: '战斗描写',
      content: '战斗让读者看懂目标、攻防与胜负依据，光效和强烈情绪可以服务体验。胜负手承接已知条件，节奏随压力变化，不规定招数、回合或视角切换。',
      importance: 8,
    },
  ],
  都市: [
    {
      topic: '生活质感',
      content: '都市只是环境，不等于日常琐碎或低情绪。生活、职场、财富与圈层细节按当前情节需要选择，人物行为符合其资源与已知信息；都市异能或爽文应让生活压力衬托机会与收益，不用房租和通勤细节淹没主线。',
      importance: 10,
    },
    {
      topic: '口语化对话',
      content: '对话贴近真实口语：有省略、有打断、有话里有话。职场、圈层用语要准（甲方、对齐、走流程），但密度控制在提味即可。潜台词优先：让人物说「没事」的方式暴露他有事。',
      importance: 9,
    },
  ],
  言情: [
    {
      topic: '情感递进层次',
      content: '言情的承诺是心动、关系变化与情感回应。递进要有人物经历和选择依据，重逢、先婚后爱、快节奏或慢热按作者要求展开，不套固定四阶段；允许直接承认心动，也可以用行为与感受呈现。',
      importance: 10,
    },
    {
      topic: '张力与误会',
      content: '关系张力来自成立的欲望、立场、顾虑和选择；误会要有可信依据与发展，不靠无理由拒绝交流拖延。甜、虐、平静相处按作者承诺决定，不强制虐后立刻甜，也不把关系推进改成力量碾压。',
      importance: 9,
    },
  ],
}

/** 按重要性取通用卡 top N，拼成常驻注入段（≤300 字目标） */
export function buildGeneralWritingDigest(limit = 2): string {
  const cards = [...GENERAL_WRITING_CARDS].sort((a, b) => b.importance - a.importance).slice(0, limit)
  return `写作软质量信号（仅在原文有证据时使用，作品自身风格优先）：\n${cards
    .map((card) => `[${card.topic}] ${card.content}`)
    .join('\n')}`
}

/** 按作品标签匹配题材文风卡：命中多个题材时按卡片重要性混排取 top */
export const WRITING_REQUEST_GUIDANCE = '本次完整原始作者请求是创作与点评的首要依据：题材、情绪承诺、节奏、人物身份、剧情顺序、篇幅、精确停笔位置及输出格式均须保留。作品标签、旧文风、知识卡、Skill 和场景建议是次级背景，不能覆盖本次明确要求；否定某类型或本次改换风格时，不沿用旧标签的相反承诺。逻辑严谨指人物知识、因果、时空与已确立世界规则自洽，不等于审美克制或压低情绪。'

const genreAliases: Record<string, string[]> = { 言情: ['言情', '爱情'], 慢热: ['慢热', '舒缓', '慢节奏'], 现实: ['现实', '写实'], 幽默: ['幽默', '喜剧', '搞笑'], 爽文: ['爽文', '爽感'] }

/** Small soft-card recall only; the unabridged request remains the model's authority. */
export function buildGenreWritingDigest(tagNames: string[], limit = 3, originalRequest = ''): string | null {
  const clauses = originalRequest.split(/[。！？!?；;，,\n]+/u).map(clause => {
    const change = clause.search(/现在|这次|本次|改成|改为|改写成/u)
    return change >= 0 ? clause.slice(change) : /以前|原来|原先|之前|曾经/u.test(clause) ? '' : clause
  })
  const denied = new Set<string>()
  const requested = new Set<string>()
  for (const genre of Object.keys(GENRE_WRITING_CARDS)) {
    for (const alias of genreAliases[genre] ?? [genre]) {
      for (const clause of clauses) {
        if (!clause.includes(alias)) continue
        if (new RegExp(`(?:不要|不写|非|不是|不走|拒绝|禁止|不需要|别写|不用)[^。！？；，\\n]{0,12}${alias}`, 'u').test(clause)) denied.add(genre)
        else requested.add(genre)
      }
    }
  }
  const matched: WritingKnowledgeCard[] = []
  for (const [genre, cards] of Object.entries(GENRE_WRITING_CARDS)) {
    if (!denied.has(genre) && (requested.size ? requested.has(genre) : tagNames.some((tag) => (genreAliases[genre] ?? [genre]).some(alias => tag.includes(alias))))) {
      matched.push(...cards)
    }
  }
  if (matched.length === 0) {
    return null
  }
  const top = matched.sort((a, b) => b.importance - a.importance).slice(0, limit)
  return `题材阅读体验参考（${requested.size ? '本次作者请求优先' : '作品标签次级参考'}，不是硬性模板）：\n${top.map((card) => `[${card.topic}] ${card.content}`).join('\n')}`
}
