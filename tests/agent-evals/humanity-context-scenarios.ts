/** Invented micro-scenes only. Expectations are editorial labels, not a regex
 * detector or measured model results. Paid evaluation keeps responses private. */
export const HUMANITY_CONTEXT_CORPUS_VERSION = 'humanity-context-corpus.v1'
export const HUMANITY_CONTEXT_SCENARIOS = [
  { id: 'same-sentence-cause', issue: true,
    content: '撤离名单最后一栏空着。韩青把女儿的号码又拨了一遍。她指尖发麻，是因为女儿还没上车这件事让她害怕。',
    target: '她指尖发麻，是因为女儿还没上车这件事让她害怕。', preserve: ['女儿还没上车'],
    rationale: '名单、拨号与身体反应已支持担忧，最后再次命名原因可减少。' },
  { id: 'cross-sentence-crisis', issue: true,
    content: '备用氧降到红线，阀门仍拧不动。齐遥把扳手咬住，空出一只手扯断封条。氧气耗尽后舱门会自锁，救援艇要六天后才能到，所以他现在很着急。',
    target: '氧气耗尽后舱门会自锁，救援艇要六天后才能到，所以他现在很着急。', preserve: ['舱门', '自锁', '六天'],
    rationale: '自锁条件与六天是新事实，不能整句删掉；可以减少末尾情绪释因。' },
  { id: 'necessary-new-fact', issue: false,
    content: '石岚停在黄线外。屋里的空气看不出异样。值班员说：“别进，消毒结束后还得通风四十分钟。”石岚把脚收了回来。',
    target: null, preserve: ['四十分钟'], rationale: '未见的风险和时限改变行动，是有交际目的的新信息。' },
  { id: 'intentional-contrast', issue: false,
    content: '“我不是来求你原谅的，”叶敏把收据压在杯底，“我是来还钱的。数清，往后两清。”',
    target: null, preserve: ['还钱'], rationale: '有意否定对照在划清关系、纠正对方预期。' },
  { id: 'character-distinction', issue: false,
    content: '顾平把酒杯推回去。“你以为我怕他？我怕的是我弟又替我担事。上回拘留，进去的是他。”',
    target: null, preserve: ['弟', '拘留'], rationale: '人物解释此前未知的顾虑与经历，不能仅因直述删掉。' },
  { id: 'robot-procedure', issue: false,
    content: '巡检机挡住升降梯：“授权不足。请出示橙色工牌。”门卫晃了晃蓝牌。它又说：“授权不足。请出示橙色工牌。”门卫回屋取卡。',
    target: null, preserve: ['授权不足', '橙色工牌'], rationale: '重复程序声口有规则与冲突功能。' },
  { id: 'unknown-rule', issue: false,
    content: '阿澄第一次参加交接。师傅指着两枚印：“白印只记到货，红印才准开箱。印错了，整批退回。”阿澄把拿起的白印放下，换了红印。',
    target: null, preserve: ['白印', '红印', '退回'], rationale: '读者和新人都未知的规则解释导致选择变化。' },
] as const
