# 下一章目标与审核恢复 / Next-chapter targeting and review recovery

## 可验证诊断 / Verified diagnosis

2026-09-20 香港时间 03:22:41 开始的“写下一章”为新任务合同，03:25:04 失败。只读元数据证实它却给上一任务的旧章重新建立编译：03:23 连续性调用输入 2788 / 输出 14168 tokens，成功；03:24 质量审核输入 3359 / 输出 8192 tokens，供应商报告 settled/reported，达到旧质量审核上限。

The earlier continuity fix worked; the quality critic still inherited the generic 8192-token allowance. The new request had a new task contract but the context digest and bridge lookup exposed a historical active compilation, while preparation fell back to the editor's old chapter.

## 修复边界 / Implementation boundaries

- 编译摘要与章节桥按任务身份隔离。新“写下一章”不沿用编辑器旧章，也不将错误历史编译的存在当作新任务授权；同合同合法新章可继续，明确修订旧章仍允许。
- 编译缺失的连续性调用明确失败，不能显示检查完成。
- 审核默认输出空间 16384。legacy 连续性/质量 critic 仅在供应商明确 OUTPUT_LIMIT 时做一次 32768 恢复，完整输入保留，原截止时间/取消不重置；恢复前重核正文与任务，其他未知响应和额度错误不自动派发第二次。
- 既有 durable 操作沿用原冻结请求，新质量操作采用 16384。没有迁移、依赖变化或生产正文测试；发布不会自动续跑作者的失败任务。
- 扩大上限提高最大额度预留，实际按供应商用量结算；外部模型持续失败时仍保留未完成状态，不能用“不中断”要求伪造通过或无限付费。

Compiler reads and preparation now honor task identity and next-chapter intent. Missing compilations produce failed observations. Legacy critics permit one explicitly bounded output-limit recovery, while stale inputs, cancellation, unknown responses and credit errors prevent redispatch. Current revision and completion checks remain mandatory. No dependency or database migrations; no paid model or production manuscript write tests were performed.

Targeted tests and exact-commit CI cover task isolation, legitimate continuation, stale/cancelled recovery and output budgets. Deployment verification is reported separately.
