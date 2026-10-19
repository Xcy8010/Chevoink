# 质量检查与联网工具验收 / Quality and web-tool acceptance

## 行为与版本 / Behavior and versions

- 人类感检查保留十三类信号、逐字证据、作者声音与一次集中修订。新上下文协议 2 为 Critic 加入最近三章身份、版本和正文（每章最多末尾 12,000 字符，明确标出省略）；修订器取得作者要求、声音参考和每个补丁前后各 600 字符。正文仍完整输入；模型窗口不足必须明确失败，不截掉正文后宣称整章已检。
- Humanity review keeps its thirteen signals, verbatim evidence, author voice and one concentrated repair. Context protocol 2 adds the three preceding chapters with identities/revisions and prose (at most the final 12,000 characters each, explicitly marked when partial). Repairs receive author intent, voice references and 600 characters on each side of the evidence. The current chapter stays complete; an insufficient model window must fail explicitly.
- 新 durable quality 工作版本为 9；原 1–8 的冻结输入、来源投影、付费结果与解析规则保持。Skill 资源仍为 3.5.0；新路由 3.6.0 统一内置技能的“AI味 / AI 味 / AI痕迹 / 机器味”等触发，旧路由与作者自定义表达式不改。默认通用知识包含 AI 痕迹卡。不会自动重启旧任务。
- New durable quality work uses version 9, preserving frozen versions 1–8 and their original inputs, source projections, paid results and parsing. Skill resources remain 3.5.0; router 3.6.0 normalizes equivalent built-in style triggers without rewriting saved routers or author-defined patterns. Default writing knowledge includes the AI-trace card. Old tasks are not restarted.
- 新报告以 `criticPromptProtocol: humanity-context.v2` 标识本次提示词与邻文规则；`humanity-critic.v5` 继续表示 finding 数据合同。旧冻结工作不补贴新提示词标记。
- New reports record `criticPromptProtocol: humanity-context.v2` for these prompt/context rules; `humanity-critic.v5` remains the finding contract. Frozen older work is not relabeled as having used the new prompt.
- 连续性 PREPARE 只复用与前章当前 revision 匹配的已提交桥；COMMIT 未传终态时记录未知与正文摘录，不从场景计划推导事实。独立检查上下文协议 3 标注当前章与前三章的身份、版本、顺序及来源范围；旧 durable 输入保持原协议。覆盖范围不等于全书。
- Continuity PREPARE only reuses a committed bridge matching the preceding chapter revision. Omitted COMMIT terminal state remains unknown; defaults use prose excerpts, never planned scene outcomes. Standalone context protocol 3 labels identities, revisions, ordering and source ranges for the current and three preceding chapters. Frozen work keeps its original protocol. This is not whole-book coverage.
- 平台、BYOK、免费及本地模型继续使用已选完整运行时；不自动改用收费 Critic。未知供应商的 thinking-off、身份冲突、上下文不足及格式失败仍可明确不支持或未完成。适配协议不保证所有模型的文学效果相同。
- Platform, BYOK, free and local models retain their admitted runtime. There is no automatic paid critic substitution. Unsupported thinking control, identity drift, window limits and invalid responses remain explicit failures. Protocol support does not establish equal literary quality across models.

## 空作品短场景回归 / Empty-book short scene regression

新任务中，明确要求“写一个短场景”不会因为同时说“不要扩写大纲”而被归为规划。空作品缺少章节落点时只询问一次；真实作者确认“作为第一章写入”后，服务端以独立凭据补全第一章目标。原始任务、哈希、字数与停笔要求、模型、预算及检查门禁不变。否定、不确定、仅讨论、超时、取消、已暂停任务和旧任务不取得新写作权限；重复回答不产生新的进展或预算。

For new tasks, an explicit short-scene request stays writing even when another clause prohibits outlining. An empty book asks once for the missing chapter destination. An authenticated affirmative answer creates a separate first-chapter receipt, preserving the original task/hash, length/ending constraints, model, budgets and review gates. Negative/uncertain answers, discussion-only requests, timeout, cancellation, paused runs and old tasks do not gain writing permission; duplicate answers add no new progress or budget.

验收：新建空测试作品，请求约 500 字、最多 800 字、一个完整冲突、写完停止；选择作为第一章写入。应只有第一章，原回答后继续准备、写作与原有检查/提交；不能把空正文或只建章当作完成，也不能自动续章。保留原失败任务作为对照，不重新激活。

Acceptance: create a new empty test book; request one complete scene of about 500 and at most 800 Chinese characters, then stop. Confirm writing into chapter one. Verify one chapter, preparation/writing and the existing review/commit workflow after the answer. Empty prose or a created heading alone is not completion, and chapter two must not start. Preserve the earlier failed run without reactivating it.

## 可复现文学验收 / Reproducible literary review

使用自制或明确获准的样例，记录代码 SHA、输入/来源 revision 与哈希、模型实际映射、参数、完整报告、正文改前改后、真实 usage/缓存和结算状态。不能以确定性 n-gram 检测或合成评分冒充真实文学评价。真实模型调用须有单独预算；没有凭据/预算时记 `not-run`。

Use synthetic or explicitly permitted texts. Record source SHA, input/source revisions and hashes, actual model identity, parameters, complete report, before/after prose, real usage/cache and settlement. N-gram detection and synthetic scores are not literary evidence. Live calls require a separate budget; missing credentials or budget mean `not-run`.

| 样例 / Case | 预期观察 / Expected observation |
| --- | --- |
| 同义复述：人物锁门后，连续三句换词解释“他不信任来客”，没有新动作信息 / Paraphrased distrust after locking a door | Critic 须给当前章逐字证据并解释重复关系；不能只报字词重合 / Verbatim current evidence and semantic duplication rationale |
| 合理反差：“他不是来讨债的，而是来还那把伞。”后续动作证实 / Meaningful contrast followed by action | 单次句式不应被当成禁用模板 / No automatic penalty for one contrast construction |
| 声音变化：前章人物只用短问句回避秘密，本章无缘由长篇解说 / Unmotivated change from evasive questions to exposition | 提及具体邻章版本与语境；修订保留秘密和作者停笔位置 / Compare actual neighboring context, retain knowledge boundaries and ending |
| 有意母题：每次灯亮都带来不同事件信息 / Recurring light motif with new consequences | 不为消除重复机械换词 / Preserve meaningful recurrence |
| 计划已入室，正文仍在门外；改稿后旧桥存在 / Plan says entered, prose remains outside, old bridge survives revision | 不把计划或旧桥认证为事实；新版本重新检查 / No planned/stale facts; recheck actual revision |

盲审时随机隐藏“原稿/修订稿”标签，至少由两位审阅者分别记录：事实保持、人物声音、语义冗余、节奏与作者意图。保留分歧与例句，逐样例比较；有真实样本才汇总偏好，不能填造聚合分数或声称全模型通过。用户本人文学验收与协议/CI通过分开记录。

For blind review, randomize and hide original/revised labels. At least two reviewers independently assess factual preservation, voice, semantic redundancy, pacing and intent. Retain disagreements and examples. Aggregate only real observations; never fabricate scores or claim every model passed. Human literary acceptance is separate from CI/protocol success.

## Search / Fetch

后台模型管理的 Search 和 Fetch 独立配置。Search 支持 `bocha`、`deepseek`；Fetch 为可选 `deepseek`，未启用仍走现有直读及已有后备。DeepSeek 可填公开服务根地址或各自完整 `/v1/tools/search`、`/v1/tools/fetch` 地址；聊天接口不是工具接口。新 Fetch 行默认禁用，不迁移任何密钥。配置、超时、限流、鉴权、无正文与协议失败需要真实区分；读取失败不证明目标网页不存在。

Search and Fetch have separate admin configuration. Search supports `bocha` and `deepseek`; optional DeepSeek Fetch defaults off, retaining existing direct/fallback reading. Use a public service root or the respective `/v1/tools/search` and `/v1/tools/fetch` endpoints, not a chat endpoint. The new disabled Fetch row contains no key. Distinguish configuration, timeout, rate-limit, authentication, missing-content and protocol failures; a provider failure does not prove the target page is missing.

合同来源 / Contract source: [DeepSeek 官方 Search/Fetch 文档](https://api-docs.deepseek.com/zh-cn/guides/search/)。离线合同测试、真实供应商测试、生产配置生效三项必须分别记状态。不得把 mock 响应称为真实 DeepSeek 可用性验证。

Record offline contracts, live provider tests and production configuration separately. Mock responses do not establish live DeepSeek availability.
