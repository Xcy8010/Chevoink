# 待办身份与作者结束任务 / Todo identity and author termination

## 已核实故障 / Verified incident

2026-09-20 香港时间 04:11–04:17，管理员恢复“写下一章”任务后，下一章正文、连续性、质量与章节终态已成功提交。待办以完整文案作为身份，恢复时改写文案被当作新增，漏带旧项又被保留，清单从 2 项增长至 6 项。最后提交三项总结被拒绝，因为新文案被视为新建 completed 项；UI 显示持久化六项，模型口述三项。作者真实问答要求结束，但循环仅把答复发回模型，仍以未完成待办触发反复收尾，最终写入 failed。

Read-only persisted conversation, tool receipts and chapter revision/commit metadata confirm a bookkeeping/termination defect, not a failed final chapter write. The original text and billing are not modified by the code fix.

## 修复 / Changes

- 待办提供稳定 id，改名、进度更新沿用同一项并保持原顺序。已有清单追加工作必须说明范围变化，未知 id、重复 id 及伪造完成项明确拒绝并回传真实清单。
- 取消项附原因，不算完成；取消和完成均为终态。模型、循环与 UI 对 pending/in_progress 使用一致语义。
- 传统运行路径仅接受本次成功 ask_user 的真实明确结束答复；立即截断同批后续调用，不再为收尾继续付费调用模型。成果核验满足才 completed，否则标记作者结束，不冒充交付。普通停止仍可继续。
- authorEnded 与最终待办快照落库并随事件/查询返回，刷新后也能恢复正确清单及结束状态。
- 副本和成功消息按更新时间选取当前任务的最新清单，防止同批更新尚未写回消息时读旧状态。
- 两处待办共用运行状态和当前项动画，取消记录与有效计划分开呈现。

Stable task-local IDs replace title-based identity. Explicit cancellations remain distinguishable from delivered work. Legacy author termination is based on the fresh authenticated answer, never model prose. Durable todo receipts accept IDs/cancellations while retaining lease/receipt verification; durable question termination is not changed by this patch. No schema migration, dependencies or live paid-model tests are needed.

## 验证边界 / Validation

Targeted regressions cover renaming, order, duplicate/foreign IDs, justified additions, cancelled states, newer artifacts, task isolation, actual full author reply, conditional/negative replies, stopping the remaining tool batch, verified delivery, refresh and stream state. Full gates and exact-SHA CI/deployment are reported after execution. Historical incident metadata repair requires fresh ownership, author-answer, inactive-run and current committed-chapter checks; it must preserve manuscript, billing and original audit history.
