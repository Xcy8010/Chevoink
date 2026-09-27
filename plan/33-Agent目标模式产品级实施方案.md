# Agent 目标模式（/goal、/目标）产品级实施方案

日期：2026-09-27。状态：**方案，未实施**。项目基线：`4feeb4ce8d61156f55401d22bc792b4a1300aea0`。

本轮交付为产品与工程可执行方案，不包含业务代码、数据库迁移、提交、推送或部署。本文的状态、接口、表名和验收指标，除明确标注“已有”者外，均为拟实施设计。

## 1. 产品定义与交付范围

目标模式让同一任务窗口持续推进作者指定的结果：每轮执行后核对真实成果，未完成则在既有授权与预算内接着做，直到完成、作者暂停/取消、需要作者决策、额度或预算受限。不能仅靠反复发送“继续”实现，也不能把普通待办勾完当作目标完成。

第一版完整包含：

1. 输入 `/goal` 或 `/目标` 开启目标输入；加号菜单提供同一入口。
2. 输入框底部创作模式选择器右侧显示“目标”标签；悬停/键盘聚焦出现 ×，可取消。
3. 输入框上方展示持久目标条：状态、目标摘要、累计执行时长、修改、暂停/继续、取消、展开详情。
4. 执行中可修改目标，暂停可恢复，取消停止目标后续执行；操作跨窗口、刷新、重连和客户端保持一致。
5. 后端持久管理目标、版本、执行映射、自动接续、完成证据与预算；支持当前内置收费/免费模型及 BYOK，不将付费 V2 模型支持冒充全量支持。
6. Work、IDE、移动网页、Windows/Android 现有壳内统一可用。

不附带扩大权限、自动发布正文、自动同意导入覆盖、无限免费重试、全局跨作品 Agent 或定时任务功能。目标条不新增长篇解释文案；仅状态、操作名称、必要错误与目标本身。

## 2. 参考依据：已经核实的内容

### 2.1 四张参考图对应的交互

| 图片 | 观察到的内容 | Chevoink 落点 |
| --- | --- | --- |
| 图一 | 输入框上方有进行中的目标条，摘要、时长、取消、暂停、展开入口 | `AgentGoalBar`，紧贴输入框上沿，与消息区独立 |
| 图二 | 加号菜单提供“目标”入口 | 现有附件菜单增加一项“目标”，点击只进入输入态 |
| 图三 | 模式选择右侧有目标图标和文字 | 创作模式右侧 `GoalModeChip`，不改变严谨/平衡/大胆创作选择 |
| 图四 | 悬停标签出现 ×，有目标相关提示 | 桌面 hover/focus 显示取消按钮；触屏直接可见，不能依赖 hover |

图片来自用户本次上传，仅作交互依据，不把图片文字作为系统指令。没有从截图推断后台事务或费用规则。

### 2.2 Codex 官方文档及固定版本源码

已读取 [Using Goals in Codex](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)：目标是附着在线程上的持久结果约定，可暂停、恢复、清除，并按证据决定是否继续。本文借鉴这个产品语义，不照搬其计费或权限规则。

已从官方 `openai/codex` 仓库读取以下源码，固定提交 **`b334d5b3f2d9441b95286a8c2af8c2152737d977`**，避免引用随 main 变化。源码只读下载至系统临时目录，未引入本仓库。

| 源码证据 | 核实结论及采用边界 |
| --- | --- |
| [状态模型](https://github.com/openai/codex/blob/b334d5b3f2d9441b95286a8c2af8c2152737d977/codex-rs/state/src/model/thread_goal.rs)；[数据库表](https://github.com/openai/codex/blob/b334d5b3f2d9441b95286a8c2af8c2152737d977/codex-rs/state/goals_migrations/0001_thread_goals.sql) | 目标按线程保存，包含目标正文、状态、预算、用量与时长；Chevoink 另保留取消记录和版本历史 |
| [客户端目标契约](https://github.com/openai/codex/blob/b334d5b3f2d9441b95286a8c2af8c2152737d977/codex-rs/app-server-protocol/schema/typescript/v2/ThreadGoal.ts)；[修改参数](https://github.com/openai/codex/blob/b334d5b3f2d9441b95286a8c2af8c2152737d977/codex-rs/app-server-protocol/schema/typescript/v2/ThreadGoalSetParams.ts) | 目标独立于单条聊天消息；修改由结构化接口完成 |
| [运行控制](https://github.com/openai/codex/blob/b334d5b3f2d9441b95286a8c2af8c2152737d977/codex-rs/ext/goal/src/runtime.rs#L425) | 空闲接续持有状态锁，重新读目标和状态，再请求仅空闲时启动；防止 set/clear 与启动竞态 |
| [目标变更处理](https://github.com/openai/codex/blob/b334d5b3f2d9441b95286a8c2af8c2152737d977/codex-rs/ext/goal/src/runtime.rs#L164) | 外部变更先归集进度；目标变更可注入正在执行的轮次。Chevoink 写作副作用采用更严格的版本隔离边界，见第 7 节 |
| [工具实现](https://github.com/openai/codex/blob/b334d5b3f2d9441b95286a8c2af8c2152737d977/codex-rs/ext/goal/src/tool.rs) | create/get/update 分开；模型不能自行恢复目标或改为系统预算状态。不能把任意模型陈述当作控制 API |
| [接续上下文](https://github.com/openai/codex/blob/b334d5b3f2d9441b95286a8c2af8c2152737d977/codex-rs/ext/goal/src/steering.rs)；[接续模板](https://github.com/openai/codex/blob/b334d5b3f2d9441b95286a8c2af8c2152737d977/codex-rs/ext/goal/templates/goals/continuation.md) | 用内部目标上下文承载接续；区分真实进展、已验证等待、无进展，并要求完成审计。目标文字仍是用户数据，不升级成系统权限 |
| [用量累计](https://github.com/openai/codex/blob/b334d5b3f2d9441b95286a8c2af8c2152737d977/codex-rs/ext/goal/src/accounting.rs#L508) | 使用用量增量和归属记录；该实现目标 token 口径包含扣除缓存输入的处理，Chevoink 不照搬，必须维持自己的 Token 与 Credits 账务口径 |
| [TUI 目标菜单](https://github.com/openai/codex/blob/b334d5b3f2d9441b95286a8c2af8c2152737d977/codex-rs/tui/src/chatwidget/goal_menu.rs)；[通知处理](https://github.com/openai/codex/blob/b334d5b3f2d9441b95286a8c2af8c2152737d977/codex-rs/app-server/src/request_processors/thread_goal_processor.rs) | 编辑、暂停/恢复、清除和有序更新独立于普通输入；参考其生命周期，不声称 TUI 源码就是截图里的桌面 React 实现 |

公开仓库中本次核实的是 core、app-server、state 与 TUI；没有核实截图中桌面 Goal 组件的具体实现。桌面布局以用户四张图为准，Chevoink 技术方案以下文为准。

## 3. Chevoink 现状与必须复用的能力

| 已有代码 | 已有事实 | 本次接入要求 |
| --- | --- | --- |
| `src/features/studio/agent/components/AgentComposer.tsx` | 加号、创作模式、发送/停止、附件和技能共用输入框 | 增加命令解析与目标标签，不复制输入框 |
| `AgentPanel.tsx`、`agentStore.ts`、`composer-drafts.ts`（同 agent 目录） | 任务草稿隔离；本地任务窗口提升为 session 时迁移草稿 | 目标输入草稿使用同作用域，不以 novelId 代替窗口 ID |
| `api/lib/agent/run-service.ts` | 启动、停止、继续分别存在；继续读取原始请求，不用历史摘要猜任务 | 自动目标接续走单独内部入口，不能冒用手动继续的预算授权 |
| `api/lib/agent/request-queue.ts`、`api/server.ts` | 待发需求与后端调度已存在；当前队列按 latest run 状态判定 | 统一会话调度，目标接续必须让位于作者控制和待发需求 |
| `prisma/schema.prisma` 的 AgentTaskRoot / AgentRun / AgentRunLease | taskRoot 原始作用域与请求冻结；run 可更替；租约有 epoch | Goal 是上层目标，不改写旧 taskRoot 的原始请求/授权 |
| `runtime-operations.ts`、`runtime-settlement.ts`、`runtime-event-projection.ts` | 操作回执、账务、事件投影已有幂等机制 | 目标关联这些真实操作，不建第二套扣款系统 |
| `runtime-continuation.ts`、`runtime-completion-evidence.ts`、`runtime-lifecycle.ts` | 已有未完成事项续跑和证据终态；连续无进展提醒有上限 | Goal 监督目标总结果，内部续跑只执行一次，不叠两层提醒死循环 |
| `context-budget.ts`、`runtime-checkpoint-step.ts`、`checkpoint.ts` | 历史压缩、检查点、Token 与轮次预算已有实现 | 每次恢复重注入当前目标版本，不将压缩当作目标完成或预算清零 |

**当前缺口**：没有独立目标实体、目标版本、会话目标事件及跨轮目标监督器。持久执行器 `runtime-executor.ts` 目前还限制自定义模型及非 V2 计费；不能通过“目标只走 durable”直接覆盖所有用户。第一版必须完成 legacy 与 durable 两条执行路径的目标准入、停止与写入隔离，禁止静默换用户模型。

## 4. 用户交互规格

### 4.1 命令与加号

| 输入/操作 | 无未结束目标 | 有未结束目标 |
| --- | --- | --- |
| `/goal`、`/目标` 后按空格或选择命令建议 | 开启目标草稿；命令从编辑器显示内容移除，正文保留 | 打开当前目标详情，不创建第二个目标 |
| `/goal <正文>`、`/目标 <正文>` 后发送 | 原子创建目标与首轮；正文是目标内容 | 打开修改态并填入正文；点击“保存目标”才修改，避免发送即覆盖 |
| 加号 → 目标 | 与裸命令开启草稿完全相同，聚焦输入框 | 打开当前目标详情/编辑入口 |
| `/goal edit`、`/目标 修改` | 提示无目标，不发模型 | 打开目标编辑弹窗 |
| `/goal pause`、`/目标 暂停` | 不调用模型 | 执行暂停 API |
| `/goal resume`、`/目标 继续` | 不调用模型 | 显式恢复；受限状态先满足恢复条件 |
| `/goal clear`、`/目标 取消` | 关闭草稿模式 | 取消当前目标，保留成果与审计 |

命令只识别输入最前面的独立 token，`/goalkeeper`、网址、代码块、引用、附件正文里的 `/goal` 不触发。英文命令大小写不敏感；中文输入法 composing 期间不消费 Enter/Space。粘贴多行以首个命令 token 为界，后续正文原样保存；`/goal edit 某目标` 等未定义控制命令组合在命令建议中提示，不猜测执行。未知 `/命令` 按普通正文发送，不静默丢字。

创建只在显式点击发送/发送快捷键时发生；开启模式、打字、恢复草稿不请求模型、不预扣 Credits。空白目标禁用发送，附件不代替目标正文。目标正文最多 12,000 个 Unicode 字符，前后空白 trim，内部格式不改；前后端按同一字符计数校验，超限不截断。

### 4.2 目标标签与取消

- 位置固定在创作模式选择器右侧、模型选择区左侧。目标模式是执行持续性开关，与 plan/build/review、创作自由度、质量模式均正交。
- 未发送草稿显示 `[靶心 目标]`；hover/focus-within 显示 ×，tooltip“取消目标模式”。点击 × 只退出模式，保留正文、附件、引用和光标位置。
- 存在持久目标时同一标签表示当前目标；点击主体打开详情，× 的 tooltip 为“取消目标”。点击 × 直接发取消请求，保留已保存作品，不额外弹审批。取消是终态；误取消后可从详情复制为新目标，不能偷偷复活。
- 活跃目标取消请求期间显示“正在取消”，立即禁用重复按钮。以服务端回执确认取消，失败恢复原状态并显示简短重试提示，不能仅删本地标签。
- 手机端 × 始终可触达；图标可小但命中区域至少 44×44，桌面键盘 Tab 可定位，Enter/Space 执行；Esc 仅关闭菜单/编辑层，不误取消目标。

### 4.3 目标条和详情

```text
┌ 🎯 进行中的目标  完成第一卷大纲并写好前三章…  12分32秒  ✎ Ⅱ × ⤢ ┐
│ 告诉我接下来要调整什么…                                          │
│ ＋  严谨创作 ▾  [🎯 目标 ×]                    模型 ▾   🎙   ■ │
└───────────────────────────────────────────────────────────────┘
```

- GoalBar 在输入框上沿、待办摘要下方；不固定到整个页面顶部，不覆盖任务状态栏、正文或发送按钮。正文目标摘要单行省略；展开查看全文。
- 状态文案：进行中的目标 / 正在更新目标 / 已暂停的目标 / 等待你的回复 / 等待确认 / 等待服务恢复 / 需要处理 / 额度受限 / 预算已用完 / 目标已完成 / 目标已取消。
- 时长采用后端累计活动执行时长，前端仅在正在执行时按服务器时间锚点补间；不计等待作者、暂停和断线的空档。详情补充 Token、Credits、状态原因、验收项、成果入口与版本历史，不在主条塞满技术数据。
- 暂停按钮暂停目标以及其当前执行；暂停后显示继续。普通输入框停止按钮在 goal-owned run 下等价于暂停目标，避免“停止后自动又启动”。非目标 run 仍使用原行为。
- 完成后主条保留静态完成摘要，可收起；取消后主条和标签隐藏，详情历史保留。完成/取消不显示运行 spinner，不显示旧“继续任务”按钮。
- 窄屏第一行摘要、第二行必要操作；编辑/详情弹窗使用 `max-height: calc(100dvh - safe-area - 24px)`、`min-height:0` 与正文 `overflow-y:auto`，隐藏滚动条但保留触摸/键盘滚动；底部操作区可见。软键盘弹起不裁切保存按钮。

### 4.4 输入新消息与编辑目标

- 目标执行中普通输入视为当前目标的补充/提问，默认不替换目标，也不重建整个待办。显式要求换目标通过“修改目标”操作，或者模型提出修改草案供作者点击保存，不能由模型直接替换。
- 运行中补充进入既有 steer/队列体系，在下一安全边界消费一次；作者消息优先于自动接续。普通提问回答后仍保留原目标；不能把它误判成新的总目标完成条件。
- 点击“修改”打开可滚动自定义弹窗，字段只有“目标”、可展开的“执行限制”，底部“取消 / 保存目标”。打开时复制当前版本，编辑草稿不影响执行；保存才进入 updating。
- 保存目标不清零 Token、Credits、活动时间或已产出内容。已暂停的目标修改后仍暂停，需点击继续；原活跃目标修改成功后继续。受限状态不会因为修改正文解除。
- 用户同时修改且发消息时，以服务端接受顺序与 revision 为准；409 冲突保留本地草稿并提供读取新版/重新编辑，不能静默最后写入覆盖。
- 首次开启时不自动接管正在执行的普通任务：保留目标草稿，等待该轮结束，或由用户明确停止原任务再发送。暂停的旧普通任务也不得被目标悄悄接管；新目标只以其自身正文及显式附件/引用为授权。

## 5. 领域模型与状态机

### 5.1 三种身份必须分开

- `goalId`：一个窗口中的持久目标，跨修改版本与多轮执行累计用量。
- `goalRevision`：作者批准的目标内容及验收范围版本；目标改写增加版本。
- `taskRootId/runId`：现有不可变任务合同与具体执行尝试。每个 run 必须能追溯其 goalId、goalRevision、目标 epoch；同作品其他窗口没有这种关系就不能被接管。

一窗口最多一个未终结目标（active、updating、paused、waiting、blocked、受限均占位），数据库部分唯一索引保证；completed/cancelled 历史可有多个。草稿是本地编辑状态，不计入数据库活跃目标。

### 5.2 状态和执行相位

持久状态 `status`：`active | updating | paused | blocked | usage_limited | budget_limited | completed | cancelled`。

独立 `phase`：`idle | queued | executing | awaiting_input | awaiting_approval | awaiting_provider | reconciling | reviewing`。等待不是失败，active 不等于当前有模型请求。UI 根据 status + phase + reason 展示，不再仅映射最近 run.status。

| 触发 | 状态变化 | 强约束 |
| --- | --- | --- |
| 作者发送目标 | 无 → active/queued | 原子创建、目标版本、首轮排队；幂等重放不创建第二个目标 |
| 中间回复结束 | active/executing → active/reviewing | 先核验成果，再继续或完成 |
| 作者修改活跃目标 | active → updating → active | 先隔离旧版本写入；修改期间不得派发新模型操作 |
| 作者修改已暂停/受限目标 | 原状态暂存修改 → 恢复原状态 | 不隐式恢复，不解除预算限制 |
| 作者暂停/停止 | 任一非终态 → paused | DB 控制隔离先提交，再中断本机/远端执行 |
| 作者取消/点 × | 任一非终态 → cancelled | 停止接续和旧执行；不删成果或账本 |
| 问题/工具确认 | active → active/awaiting_* | 相同 requestId 等待，不反复问模型；回答/批准后受当前目标版本校验 |
| 确认完成 | active/reviewing → completed | 验收证据版本一致、无未知操作、无未完成必需项 |
| 同一阻碍连续三次核实无进展 | active → blocked | 记录原因 fingerprint；不能以改写措辞重置计数 |
| 账户余额不足/服务明确额度耗尽 | active → usage_limited | 不新建计费请求；用户处理额度后显式恢复 |
| 目标或平台预算到顶 | active → budget_limited | 不自动开新 taskRoot 绕过；显式追加预算才允许恢复 |
| 作者继续 | paused/blocked/受限 → active | 重新鉴权、校验可恢复性与版本，所有历史计数保留 |

completed/cancelled 不自动恢复；创建新目标必须有新的显式用户发送。暂停/取消优先于自动接续与模型完成建议；若数据库已经提交完成，迟到暂停返回已完成状态，不能把已完成降回暂停。

## 6. 数据、API 与事件契约

### 6.1 新增持久数据（建议名称）

| 表/字段 | 最小字段与约束 |
| --- | --- |
| `AgentGoal` | id、userId、novelId、sessionId、currentRevision、status、phase、stateVersion、epoch、currentRunId、reasonCode、nextEligibleAt、createdAt/updatedAt/finishedAt；三个归属同时验证 |
| `AgentGoalRevision` | goalId + revision 主键；objective、attachments/references 快照、验收清单、授权策略 hash、来源用户消息/操作 ID、createdAt；只追加，不修改历史 |
| `AgentGoalExecution` | goalId、goalRevision、taskRootId、runId、epoch、continuationIndex、trigger、sourceEventId；runId 唯一，goalId + continuationIndex 唯一；允许同 root 多个 run |
| `AgentGoalBudget` | goalId 主键；Token 上限/已用/预留、Credits 限制可空、活动时间、平台硬顶快照、已核实用量水位；BigInt/定点，不用浮点扣款 |
| `AgentGoalEvent` | goalId、sessionId、sequence、type、stateVersion、goalRevision、payload、idempotencyKey；goalId + sequence 唯一，用户操作幂等键唯一；同事务作为目标 outbox |
| `AgentGoalEvidence` | goalId、goalRevision、criterionId、目标对象 ID、revision/hash、原工具回执 ID、pass/fail/unknown、verifiedAt；无对象证据不能填 pass |

目标状态更新与目标事件同事务；执行启动映射与现有 run 创建也需同事务，不能先写“已启动”再异步碰运气创建 run。已完成目标历史可按现有会话保留规则归档；取消为逻辑状态，不能级联删除账务/操作回执。

目标详情只返回该用户该窗口的数据；目标正文、附件和证据正文禁止进公共日志。`userId` 从会话登录态取，不接受客户端指定。原始 objective 是作者文本，不从助手摘要自动生成替代。

### 6.2 拟新增接口

统一前缀 `/api/agent/sessions/:sessionId`，使用现有成功/错误信封。

| 方法与路径 | 参数 | 结果 |
| --- | --- | --- |
| `GET /goal` | 无 | 当前非终态目标或最近终态摘要；没有时 data.goal=null |
| `POST /goals` | requestId、objective、attachments/references、模型及模式选择、可选 budget | 原子创建 goal + revision + 首轮队列；同幂等键异参返回409 |
| `PATCH /goals/:goalId` | requestId、expectedStateVersion、expectedGoalRevision、objective | 返回已接受的新版本或 updating；最终生效由事件确认 |
| `POST /goals/:goalId/actions` | requestId、expectedStateVersion、action=pause/resume/cancel、可选显式 budgetChange | 返回权威快照；重复同操作返回原回执 |
| `GET /goals/:goalId` | 可选 revisions/evidence 分页游标 | 详情、历史、证据，分页上限50 |
| `GET /goal-events` | afterSequence / Last-Event-ID | 会话目标 SSE；游标过旧返回重新抓快照信号 |

新窗口尚无 sessionId 时，把 session 创建、首个 goal 创建与首轮入队整合到现有启动事务；不得先将目标绑定临时窗口 ID 入库。前端沿用 `promoteComposerDraft` 将本地目标草稿原子提升到真实 session。

关键错误：`GOAL_CONFLICT`、`GOAL_VERSION_CONFLICT`、`GOAL_SCOPE_MISMATCH`、`GOAL_BUDGET_REQUIRED`、`GOAL_RECONCILIATION_REQUIRED`、`GOAL_NOT_RESUMABLE`。跨用户一律遵循现有不泄露存在性的404策略。

### 6.3 事件与前端一致性

事件类型：goal.created / revision.accepted / revision.applied / state.changed / usage.updated / evidence.updated / continuation.scheduled / completed / cancelled。

每条事件带 goalId、sessionId、stateVersion、goalRevision、sequence；前端只向匹配窗口合并，只接受更高版本。GET 与 SSE 竞态时以版本判断，过期 GET 不覆盖新事件。目标事件跨 run 连续，不能仅挂在当前 run SSE 上，否则空闲/结束后无法同步修改。

前端重连先读快照再补事件；重复投影幂等。一个 selector 派生左栏状态、任务头、目标条、停止/继续按钮，避免三个组件各自猜运行状态。运行状态和目标状态保留各自含义：目标等待作者时不冒充 running 模型请求。

## 7. 后端执行与修改目标的安全边界

### 7.1 Goal Supervisor

在现有单体后端增加 `goal-service.ts`（事务/状态）、`goal-supervisor.ts`（调度）、`goal-evidence.ts`（验收），不另起服务。接入现有服务启动恢复和后台调度，浏览器关闭不影响已授权 active 目标；服务器停机期间不执行，恢复后先核对未知操作再调度。

```text
run/工具回执提交
  → 目标事件入库
  → 会话调度锁：控制操作 > 作者消息/审批回复 > 自动目标接续
  → 读取最新 goal/revision/epoch、预算、真实 run/operation 状态
  → 有活跃 owner 或未知结果：等待/对账，不能重复启动
  → 验收证据满足：原子提交 completed + 事件
  → 未满足且可执行：恢复相同合同，或建立已批准目标范围内的执行分段
  → 确实需要作者/受限/阻塞：持久记录原因并停止自动派发
```

调度检查与 run 创建在同一准入锁/数据库事务中，不能依赖进程内 `ticking` 防并发。统一锁顺序：用户准入锁 → 作品写锁 → session/goal 行锁 → root/lease；实现时核对现有锁顺序并统一，禁止交叉反序。长网络请求不持有事务锁。

每次接续唯一键 `goalId:revision:continuationIndex`；后台轮询只是查数据库到期项目的兜底，不是每两秒请求一次模型。已在运行且输出活跃时不发下一轮；真实等待不计无进展。可恢复供应商限流遵循现有 Retry-After、路由池、尝试与费用上限；额度、认证、未知计费不可盲重试。

### 7.2 legacy 与 durable 适配

- durable：沿用 frame、operation、receipt、lease、completion 审计；在派发、写入、终态处加入 goalRevision/epoch 校验，目标接续事件去重。
- legacy：沿用 loop 与原始输入恢复，但所有 goal-owned 写工具的业务事务及模型派发入口必须增加 GoalFence（goalId/revision/epoch/status）；仅检查 AbortSignal 不足以挡住跨进程迟到写入。
- `continueLoopRun` 当前手动恢复语义不可直接给自动监督器调用。新增内部 `continueGoalExecution`，显式 `trigger=goal_auto`，禁止扩预算；用户按“继续”的额度追加也必须是独立显式参数，不能默认送一片预算。
- 普通任务不带 goalContext，路径和默认行为不变。禁止把 legacy 目标启动失败静默换成另一个模型，或强迫免费/BYOK 使用不兼容的 durable 价格。
- 子 Agent 继承只读 goalId/revision/epoch 与预算归属，不能创建或完成父目标；父目标暂停/取消必须阻止子任务新派发与迟到写入，已知用量照常结算。

### 7.3 执行中修改：两阶段提交

1. 作者保存时校验 expectedStateVersion，事务保存 pending revision，将状态设为 updating，epoch+1，撤销旧目标版本的新操作准入；事件显示“正在更新目标”。
2. 通知执行器停止旧模型请求及子执行。已经原子提交的内容保留；尚未写入的旧工具结果不能再落库。未知供应商结果进入 reconciling，核对用量后再行动，不能为了换目标重发相同付费操作。
3. 不修改旧 AgentTaskRoot 的 requestSnapshot/specSnapshot。新版本建立新的执行合同，绑定同 goalId、新 revision 与累计预算；明确记录旧合同停止原因和可复用成果引用。
4. 对旧目标成果按新验收项重新核验；只复用同作品、当前 revision/hash、允许范围内的成果，不能继承旧未完成待办作为新授权。新目标不得误称旧未完成项已完成。
5. 新版本与合同绑定提交成功后 revision.applied；根据原状态继续或保持暂停。中途进程崩溃，由持久 pending revision 恢复同一转换，不生成第二个新版本。

同一目标内未修改正文的执行分段也必须关联同一个 GoalBudget；只有已批准 scope 下的工作可新建分段。现有任务合同不支持某动作时不能静默扩大授权，应返回具体需要作者补充的范围。

### 7.4 暂停、取消与晚到结果

暂停/取消先在数据库提交状态和 epoch 隔离，再 abort 活跃请求；API 确认表示不会再批准新的副作用，不能声称远端请求已零成本撤销。无法立即中断的供应商调用保留待核用量，但不得写正文或提交完成。

暂停保留目标可恢复；取消保留目标历史但不恢复。两者都只影响该 goalId 下的执行，不能扫停同作品其他窗口。暂停或取消后队列中旧 epoch 的自动接续全部作废；后台重启也不能重启它们。

## 8. 完成标准、无进展与创作质量

创建后把目标拆成内部验收项，每项有稳定 criterionId、目标描述、验证类型、可核验对象和证据状态。作者原文是最高范围依据；模型只能补齐执行分解，不能删减明确需求或降低标准。详情可查看验收清单，主界面不新增长说明。

| 目标类型 | 可接受完成证据 | 不接受的替代 |
| --- | --- | --- |
| 写三章 | 三个目标章节非空、当前 revision 的必要检查和章节终态回执，原文规定字数/范围满足 | 三个 todo 打勾、模型说“写好了”、旧章节借来凑数量 |
| 制定大纲 | 对应计划已保存、正文完整、包含作者明确要求的结构 | 只保存首节、只给标题、把待办作为计划 |
| 调研并整理 | 可读来源及引用与交付文档，已标注不可核实项 | 搜索摘要冒充全文、未读取就称已研究 |
| 导入作品 | 真实导入成功回执，已批准来源与目标一致 | 仅解析成功、打开面板或准备链接 |
| 设置封面 | 本作品 coverAssetId 与应用回执一致 | 只有图片候选、旧图 ID 或生成成功 |

“好看”“精品”等主观要求不伪造数值达标；按已约定检查规则交付，并说明证据边界。没有确定性验证器的自定义目标，采用正文与工具证据核对，无法证明的重要项进入待作者确认，不用自评分通过。

一般写作目标保持先明确范围/计划再正文的既有节奏：“写一本小说”不能授权无边界连续写章；需要选定大纲、篇幅或批次时进入 awaiting_input。目标模式不会绕过原来的质量门、审批、记忆审核和导入覆盖确认。

有效进展包括新证据、真实写入、通过检查、已提交终态；todo 改字、重述计划、重复读取同一未变对象不算进展。连续三个可执行回合出现同一阻碍且没有新证据，才转 blocked；次数由服务端按 fingerprint 和 operation 水位记录，模型不能靠换词重置。明确缺少作者决策直接进入等待，不花三轮 Token 重复追问。模型/工具失败有既有短重试边界；不能每次重新启动 Goal 重置失败熔断。

完成由服务端在锁内核对 goalRevision、证据、未确认操作和当前状态，再提交 completed；模型提供的“完成建议”不是终态。任何证据绑定对象被并发修改，完成提交必须重新核验。完成后不自动开启下一个目标。

## 9. 预算、上下文、模型选择

- 第一版不强迫用户配置预算；高级限制默认折叠。未填写个人限额时仍受平台现有硬顶、账户额度及并发限制，不能把“未指定”显示为无限免费。
- goal 总 Token 使用既有用量规范：input + output；缓存输入已包含在 input，推理若包含在 output 不再重复加。每个 provider attempt 的递增用量只累计一次，子 Agent 和质量等辅助调用计入该 goal。未知用量保持 unknown 并阻止扩额，不补零。
- GoalBudget 总量跨 run、taskRoot 分段、模型变更、暂停恢复、目标改写持续累积；执行前预留，结算释放。任务级上限仍有效；自动接续不能以新 root 绕开目标总硬顶。用户明确增加预算记录批准事件与新上限，不清零历史。
- Credits 使用现有不可变请求价格、预留、结算和退款逻辑；目标仅汇总，不再次扣款。免费/BYOK 的 Token 仍累计；BYOK 不把供应商账单猜成平台 Credits。模型促销到期按已有新请求规则执行，旧操作不改价。
- token 达阈值压缩只处理允许归档的旧上下文；当前目标完整原文/版本、授权、验收项、剩余事项、当前调用对和对象证据索引必须可恢复。再次接续从服务端读取，不信任助手写的“目标摘要”。
- 若原始目标/附件不可压缩部分自身超过窗口，明确提示调整模型或输入，保留目标，不进入无限压缩循环；不能删需求迎合窗口。
- 模型切换沿用用户现有模型选择，下一次新请求生效，不能追溯改已发请求；账户受限后换免费/BYOK可显式继续，但仍检查目标预算与能力。goal运行期间修改模型按现有安全接续边界处理，不自动降低模型。
- 活动时间按服务端执行区间的并集累计（主/子 Agent 并行不能双倍计时），暂停/人工等待排除；与任务安全墙钟策略分开，不能把 UI 时长当作预算真值。

## 10. 文件级实施清单

以下新文件为建议拆分，不能把所有逻辑堆进 AgentPanel 或 run-service。

| 模块 | 文件 | 工作及交付 |
| --- | --- | --- |
| 契约 | 新 `shared/contracts/agent-goal.ts`、现有 contracts/index 与 agent-events | 状态、phase、revision、动作、API、事件schema；前后端共享 |
| 数据 | `prisma/schema.prisma` + 新迁移 | 第6节表与外键、唯一/部分索引、预算定点字段 |
| 生命周期 | 新 `api/lib/agent/goal-service.ts`、`goal-fence.ts` | 创建/更新/暂停/取消/恢复；事务隔离与幂等 |
| 调度 | 新 `goal-supervisor.ts`；`request-queue.ts`、`run-service.ts`、`api/server.ts` | 统一会话准入、自动接续、启动恢复、作者消息优先 |
| 执行 | `loop.ts`、`subagent-runner.ts`、`runtime-executor.ts`、`runtime-lifecycle.ts`、工具写入入口 | 两执行引擎传播 GoalFence，派发/副作用/完成三边界校验 |
| 完成与预算 | 新 `goal-evidence.ts`、`goal-budget.ts`；现有 completion/budget/settlement 模块 | 复用证据，goal级累计及跨分段硬顶，不改变旧回执 |
| API/SSE | 新 `api/routes/agent-goals.ts`，挂入既有鉴权 agent 路由 | 第6节接口、序列化事件、恢复快照、访问控制 |
| 草稿 | `agentStore.ts`、`composer-drafts.ts`、新 `goal-command.ts` | goalDraftEnabled/editIntent 按窗口保存；统一斜杠解析与IME行为 |
| UI | 新 `AgentGoalBar.tsx`、`GoalModeChip.tsx`、`GoalEditorDialog.tsx`；AgentComposer/AgentPanel | 四图交互、触屏操作、状态一致性；不增加解释段落 |
| 跨窗口状态 | StudioWorkspace、现有会话列表与 use-run-controls | 权威 selector，旧run事件不得覆盖目标终态 |
| 测试 | 新 tests/unit/agent-goal-* 与 tests/integration/agent-goal-*，浏览器场景 | 覆盖下一节矩阵，集成使用隔离数据库 |

模型工具建议只增加 `goal_read` 与 `goal_report`：前者读取当前目标/验收；后者报告证据或需输入/阻塞建议，由服务端决定状态。用户控制创建、改目标、恢复和预算；不能给子 Agent 或网页内容同等权限。显式目标入口已足够创建目标，不必为了模仿 Codex 再开放模型任意 create_goal。

## 11. 实施阶段与上线顺序

| 阶段 | 可审查结果 | 进入下一阶段条件 |
| --- | --- | --- |
| A 契约和存储 | 数据迁移、状态 reducer、所有 API、并发与归属用例 | 状态转移、重复请求、跨用户与跨窗口均通过真实DB测试 |
| B 调度和执行 | Goal Supervisor、两引擎 GoalFence、预算/未知结果恢复、证据完成 | 暂停/取消/修改的迟到副作用为0；免费/收费/BYOK可接续 |
| C 四图 UI | 命令、加号、标签、目标条、编辑、移动弹窗、事件投影 | Work/IDE/mobile同语义，草稿与状态隔离用例通过 |
| D 故障与发布 | 全矩阵、四闸、CI、受控灰度与回滚演练 | 所有P0用例通过，无账务/数据破坏问题；才公开入口 |

后端功能开关建议 `AGENT_GOAL_ENABLED`（默认 false）；关闭时禁止新建/自动接续，但目标查询、暂停、取消仍可用，已运行目标先隔离并转系统暂停。不能只关前端按钮留下后台自动写作。

迁移只增表与可空关联，不自动把历史任务/todo迁成目标。灰度先测试账号与合成作品，再受控开放；不得用生产作者作品跑写测试。最终发布执行项目四闸、同提交 CI 隔离DB检查、授权部署与版本/健康核验。

回滚先停止新接续并隔离当前目标，结清或记录未知操作，再撤回前端入口/后端调度；保留新表和审计，禁止 down migration 删除数据。旧服务不得通过普通恢复路径绕过目标已暂停状态；无法证明兼容时使用保留 GoalFence 的回退版本。

## 12. 产品级验收矩阵（实施必须逐项留证）

| ID | 场景 | 必须观察到的结果 | 验证方式 |
| --- | --- | --- | --- |
| G01 | 两个斜杠别名与加号开启 | 同一目标输入态；开启不产生模型请求 | 单元 + 浏览器网络断言 |
| G02 | `/goalkeeper`、代码/引用、IME、粘贴 | 不误触发，不吞字，不重复发送 | 编辑器交互 |
| G03 | 草稿×与已运行目标× | 前者保留草稿；后者服务器取消且停止接续 | 浏览器 + DB |
| G04 | 创作模式右侧目标标签 | 位置符合图三；hover/focus ×；触屏可取消 | Work/IDE截图与触屏 |
| G05 | 活跃目标条、时长、展开 | 对应图一，全文可读，无虚假百分比 | 桌面 + 移动 |
| G06 | 空白/超限目标和重复发送 | 禁止空白/截断，重复键只产生一个目标/首轮 | API + DB |
| G07 | 同作品A/B窗口切换与刷新 | 标签、草稿、目标、事件分别归属，不串窗 | A→B→A + 重连 |
| G08 | 本地窗口提升为session | 草稿内容/附件/目标开关完整迁移一次 | 浏览器 + API |
| G09 | 多轮目标中一轮回复结束 | 核验后自动接续；不显示整体已完成或伪造用户“继续” | 可控模型桩 + DB |
| G10 | 所有todo完成但章节未提交 | 目标不得完成 | 真实领域回执用例 |
| G11 | 目标已完成但旧run迟到事件 | 左栏/头部/底部不回到运行中或显示继续 | SSE乱序重放 |
| G12 | 运行中改目标，旧工具晚到 | 旧版本不写入；新版本生效后接续 | 两worker栅栏竞态 |
| G13 | 修改保存时崩溃/重启 | 恢复同一pending revision，无双重合同/扣费 | 故障注入 |
| G14 | 两客户端同时改目标 | 一方成功，另一方409且草稿保留 | 并发API |
| G15 | 暂停、取消与自动启动竞争 | 控制生效后新派发和旧副作用均为0 | DB事务 + worker竞态 |
| G16 | 点输入框停止 | 同时暂停目标，不自动又开始 | 浏览器 + 后端 |
| G17 | 重启/断网/关闭页面 | active按保存位置恢复；paused/cancelled不恢复 | 重启演练 |
| G18 | 问题/工具审批/导入等待 | 不空转模型；回答只消费一次，旧版本批准失效 | 集成 + 回执核对 |
| G19 | 目标运行时收到新消息 | 消息优先、只消费一次；普通提问不覆盖总目标 | 队列竞争 |
| G20 | 改目标/恢复/切模型/分段 | 累计用量不归零、不重算旧价格 | 账本与预算断言 |
| G21 | 额度耗尽与硬顶 | 明确受限，停止派发；只在条件满足后显式恢复 | 平台额度/目标预算桩 |
| G22 | 免费/BYOK与收费模型 | 同等目标能力，不强制V2或替换模型 | 两引擎参数化集成 |
| G23 | 压缩、超长原请求 | 目标完整版本可恢复；不可压缩时可解释停止，无无限循环 | 上下文单元 + 集成 |
| G24 | 未知供应商结果/计费 | 保留待核，不重复付费请求，不伪造完成 | 超时/回执丢失故障注入 |
| G25 | 同一阻塞改写措辞三轮 | fingerprint连续计数，转blocked；真实新证据才重置 | 监督器单元 |
| G26 | 正在等待真实任务结果 | 核实活跃handle，不计无进展或重复启动 | worker等待用例 |
| G27 | 子Agent持续执行时父目标取消 | 子执行不再派发/写入，已知费用保留 | 并行执行测试 |
| G28 | 跨用户/跨作品goalId、附件 | 无权读取修改，审计无正文泄漏 | 权限集成 |
| G29 | “写一本书”无范围或大纲 | 需要时询问/规划，不无边界连写章 | 创作场景评测 |
| G30 | 320/375/768宽、软键盘、200%缩放 | 按钮可达，正文可滚动，隐藏滚动条，无裁切 | 浏览器 + 原生壳真机 |
| G31 | 读屏/键盘/reduced-motion | 名称、焦点、状态播报正确，无hover唯一入口 | 可访问性检查 |
| G32 | 关闭开关与回退版本 | 不再自动接续，查询/暂停/取消可用，数据保留 | 灰度/回滚演练 |

建议性能门槛（目标值，尚未实测）：控制 API 在正常负载下 P95≤1秒完成数据库隔离；终态事件收到后100ms内刷新相关UI；事件到达客户端端到端P95≤2秒；空闲可继续目标P95≤3秒进入排队（排队等待资源另计）。验收记录负载、样本量、客户端及测量方法，不把这些目标写成已达成事实。

## 13. 完成定义与交付物

实施完成需要同时交付：契约与前向迁移、两引擎可用的目标状态/调度/预算/证据链路、四图交互、32项矩阵证据、四闸与同提交CI、灰度和回滚记录、双语工程现状说明。任何无法覆盖的模型类型或运行边界必须明确列为未完成，不能仅凭目标标签出现就宣布上线。

本方案撰写已完成的核对：四图逐张查看；官方文档实际读取；固定提交的 Codex 目标源码读取；Chevoink 当前输入、草稿、队列、任务根、租约、续跑、预算、完成机制查验。尚未实施上述功能，未运行功能测试，未修改生产。
