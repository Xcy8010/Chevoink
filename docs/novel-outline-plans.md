# 大纲与细纲

[English](./novel-outline-plans.en.md)

大纲管理全书主线、阶段目标、主要转折和结局方向；细纲把大纲落实为某一章的行动、冲突、结果、人物、场景、伏笔与前后衔接。细纲可以滚动完善，不要求提前生成全书每章的细纲，也不把规划权限扩大为正文写入权限。

作者手工新建和 Agent 的 `plan_save` 都可指定 `planKind=outline|detail`。原计划没有类型时以 `legacy` 展示，保留内容与原来的兼容路径，不自动分类或改写。分型计划按真实 ID 保留，同名大纲与细纲不会互相折叠；旧计划沿用历史同名去重。无 ID 的 Agent 同名匹配限定在相同类型、父计划和目标内；多份匹配拒绝猜选。持久任务仍须先读取并明确 ID 才能修订已有产物。

细纲可以先保存未关联草稿。执行时必须关联同作品有效大纲，并绑定一个真实章节 ID，或尚未创建章节的全书序号 `target={kind:'future',targetOrderIndex}`。已有章节用 `target={kind:'chapter',chapterId}`；归档、缺失或外部章节不能用相同序号替代。未来目标允许远期规划，但这不扩大原写作任务允许的建章范围。

关联时提交读取到的 `expectedParentPlanHash`。`reviewState=current` 只表示父大纲版本匹配，不表示文学语义已经检查。父大纲内容变化后细纲变为 `stale`，移除或改为其他类型后为 `missing_parent`，不会级联删除细纲。读取不会自动刷新关联版本；作者或 Agent 明确核对后才能重新关联。

`planHash` 包含正文、类型、父 ID、已核对父版本和目标，排除标题、排列位置及时间等展示字段。分型计划的语义修改需要 `expectedPlanHash`；同事务内使用现有作品锁并做条件更新，拒绝覆盖并发修改。显式把旧计划转型也需要当前 hash。纯改名或排序不改变语义 hash。原任务的读取基线、审批、版本、取消与持久回执检查继续生效。

章节 PREPARE 在原授权目标内选择有效细纲；多份细纲时明确 `detailPlanId`。作品已有分型大纲却没有本章有效细纲时要求先补齐。大纲与细纲的完整正文、ID、hash 和目标冻结到 `preparedContext.planContext`，准备回执与章节桥读取提供全文，场景任务沿用同一冻结依赖。创建未来章节时，在原创建事务中把序号目标升级为真实章节 ID，并更新本次冻结快照；以后章节重排不重新猜选。场景保存、正文效果、提交与完成读取校验依赖是否仍为当前版本。没有冻结提纲的历史编译保留原合同，不追溯加上新依赖。提纲变更后，只读恢复摘要显示待复核并保留读取、重新准备入口，旧章节终态不可复用；写入与提交仍硬性拒绝旧依赖。新建Agent计划必须明确类型，仅已核验的旧冻结操作可沿原回执保留legacy创建兼容。

语义复核加入既有连续性请求的版本化 `planAlignment`，不增加新的供应商或计费通道。它分别检查：

- `outline_to_detail`：本章大纲义务是否在细纲中遗漏或冲突。遗漏引用大纲原文；冲突需大纲与细纲双方证据。
- `detail_to_chapter`：本章细纲义务是否在正文中遗漏或冲突。遗漏引用细纲原文；冲突需计划证据与当前正文的真实 `sourceId`。

仅检查明确属于本章或当前阶段的义务。不能把远期事件未出现在本章视为漏写，落实章节不明确时保留 `unknown`。计划是意图，不作为前文事实来源，也不自动写入事实记忆。报告绑定冻结提纲 hash 和正文版本；缺失、旧版、不完整或引用无效的结果不升级为 `reviewed`。有效意见进入原有章节审查决定流程，保留意见不等于已修复。

原请求需要连续性审查时，提纲复核也必须取得有效结果；作者原请求明确豁免该项检查时，不因此新增强制付费检查，依赖版本仍须有效，语义状态保留为未验证。代码保证的是归属、版本、证据引用与执行边界，不能保证所有文学语义绝无矛盾或遗漏。

实现复用 `AgentArtifact.metadata` 和 `StoryCompilation.preparedContext`，无需数据库迁移。新增单元回归覆盖兼容、hash、父版本、同名身份、目标归属、冻结依赖、未来目标升级及两层证据；新增 PostgreSQL 集成回归覆盖持久化、并发保存和编译依赖，必须在经过校验的隔离数据库中执行。四闸、零跳过 PostgreSQL 集成、Agent eval 与两项审计仍由同 SHA CI 验证。

设计参考（表达职责分工，不复制第三方代码或内容）：[酒徒谈大纲与创作](https://www.chinawriter.com.cn/n1/2021/1015/c441011-32254266.html)、[猫腻谈整体大纲与滚动细纲](https://image.chinawriter.com.cn/n1/2025/0228/c404024-40428143.html)、[番茄作家专区](https://fanqienovel.com/writer/zone/article/7553614721300037657)。

Openwrite 固定版本设计参考：[大纲父子模型（native-core）](https://github.com/LiPu-jpg/Openwrite/blob/d75093dadd28c1f8f33355079f1ac49d0d2b1555/models/outline.py)、[大纲契约](https://github.com/LiPu-jpg/Openwrite/blob/d75093dadd28c1f8f33355079f1ac49d0d2b1555/tools/outline_contract.py)、[章节上下文槽位（main）](https://github.com/LiPu-jpg/Openwrite/blob/a8b9e782a9d27c50edbea1e9beb36b8d45d47f5b/docs/CONTEXT_SLOTS.md)。仅参考分层、关联与章节上下文的职责设计，未复制代码。
