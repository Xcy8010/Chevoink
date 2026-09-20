# 2026-09-20 工具失败调查与定向修复 / Tool failure audit

## 统计口径 / Scope

生产只读，Asia/Hong_Kong 2026-09-20 00:00–16:31:56；按 runId + callId 去重的 tool.result。384 次返回，39 次未成功（10.16%），345 次成功，无未知状态。统计包含保护性拦截、预算限制和当日早些时候旧版本的失败，不能当作当前版本真实故障率；不含尚未返回的调用。未输出或提交作者正文、密钥或用户标识。

Read-only production audit, UTC+8 midnight to 16:31:56. Deduplicated tool results: 384 returned, 39 unsuccessful (10.16%), 345 successful, zero unknown. Includes protective refusals, budget limits, and earlier deployments; this is not the current release's defect rate. Pending calls are excluded. No private manuscripts, credentials, or user identifiers are committed.

| 工具 / Tool | 未成功/返回 | 原因 / Cause |
|---|---:|---|
| chapter_bridge_commit | 7/15 | 当前版连续性/质量门未满足、旧编译状态缺失 / review gates or missing compilation |
| memory_save | 5/29 | 3 次孤立引用，2 次不兼容类型名 / orphan quotes and unsupported type aliases |
| continuity_validate | 4/26 | 模型输出上限（当日早期记录） / output limit, earlier release |
| web_read | 4/8 | 参数、预算、404、正文不足各1 / invalid args, budget, 404, insufficient content |
| plan_save | 3/19 | 参数输出截断 / truncated tool arguments |
| plan_read | 2/13 | 未指定目标的空计划目录 / empty folder without explicit target |
| ask_user | 2/19 | 空 question，不能凭选项伪造问题 / empty question |
| story_charter_save | 2/8 | 同轮参数输出截断 / truncated batch arguments |
| cover_generate | 2/4 | AI_PROVIDER_ERROR，约126秒；日志未保留上游HTTP细项 / provider errors, ~126s, upstream status unavailable |
| web_search | 2/14 | 搜索预算耗尽 / search budget exhausted |
| todo_write | 1/41 | 待办更新未接受 / rejected update |
| story_compiler_prepare | 1/14 | 旧任务作用域拒绝（已有修复背景） / historical task-scope rejection |
| quality_analyze | 1/13 | 模型输出上限（当日早期记录） / output limit, earlier release |
| reader_promise_save | 1/13 | 参数输出截断 / truncated arguments |
| novel_update_meta | 1/3 | 参数输出截断 / truncated arguments |
| directive_save | 1/4 | 参数输出截断 / truncated arguments |

## 根因与修改 / Changes

- 三次 plan_save 收到 4120、8109、5348 字符后供应商返回 length，并非数据库写入字数限制。其中一轮同时挤入四个写工具。原工具强制一次全文，使重试仍易截断。现在同一 plan_save 支持 mode=append；必须提供 planId 和 expectedContentHash，原子比较当前内容、标题、updatedAt，重复旧版本或并发改动不追加。回执提供新 hash；plan_read 可分页读取长计划尾部核对，不盲目重写。默认替换语义不变；完整小节分次写入，不能把一节宣称为全文完成。
- memory_save 兼容 setting/world_setting/world_building 等明确等价类型。未知类型仍拒绝；正文不截断。sourceQuote 参数明确只接受绑定章节的逐字证据。三次孤立引用未匹配作者消息或现存计划原文，不伪造来源、不删除证据后假装核验成功，仍保留来源拦截。
- 未指定 planId 的空目录是成功的空查询；明确指定失效/越权目标仍失败。
- 未增加付费模型重试、预算或自动放行质量门；未回写历史失败为成功，未修改生产作者作品。

The three plan failures were provider output truncations (4120/8109/5348 received argument characters), not database length failures. Added bounded-section append guidance and atomic content-hash/version guards; retries cannot duplicate sections or overwrite concurrent edits. Read pagination supports recovery. Added equivalent memory type aliases while preserving source checks and full content. Empty plan-folder queries are successful empty results; invalid explicit targets still fail. No new paid retries, budget increases, gate bypasses, historical status rewrites, or production manuscript mutations.

## 验证 / Validation

本地119项定向单测通过；类型构建通过。新增 durable append/replay/stale-hash 数据库回归等待同 SHA CI 隔离库运行。本地无测试数据库，未将跳过的集成检查计为通过。发布四闸与部署结果以对应提交的CI和发布核验为准。

119 targeted unit tests passed locally; TypeScript build passed. Durable append/replay/stale-hash integration cases require the same-SHA isolated CI database. No local database skips count as release evidence. Full gates and deployment are recorded by the matching commit's CI and release verification.
