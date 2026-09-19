# 连续性复核输出上限 / Continuity output ceiling

## 只读诊断 / Read-only diagnosis

2026-09-20 香港时间约 02:50，同一章节修订后两次复核（02:49:20、02:50:08）均由 DeepSeek Flash / speed 执行；供应商报告输入均为 2838 tokens，输出均为 8192 tokens，账单为 settled/reported。此前一次复核输出 7037 tokens。生产未显式配置 `AI_TEXT_MAX_OUTPUT_TOKENS`，实际代码默认 8192。截图中的提交失败是当前 revision 缺少完成的连续性复核时的正确保护；不解除该保护。

DeepSeek documents that the output budget is shared by reasoning and final content: https://api-docs.deepseek.com/api/create-chat-completion/

The two reported checks hit exactly the configured 8192-token ceiling, with identical 2838-token input. The earlier check used 7037 output tokens. The commit rejection correctly protected an unverified revision. Diagnostics inspected metadata only; no manuscript, credentials or production writes were used for testing.

## 改动与边界 / Changes and boundaries

- 连续性工具使用单独的 16384 输出预算，给思考和最终 JSON 留空间；仍有硬上限，不截正文，不切换模型或降低思考档，不自动重发截断的付费请求。
- 新 durable 操作冻结新预算，既有操作继续读取原快照及供应商回执，不改写旧请求。
- legacy 首次明确 OUTPUT_LIMIT 就停止后续提交及同批重复调用，保留已保存正文并以未完成收尾；临时网络故障仍沿用最多两次策略。
- 用量仍按实际供应商用量结算；提高请求上限同时提高最大预留，并不固定扣除该上限。没有进行真实付费模型或生产正文写测试，不能保证所有模型都不会再截断。

Continuity now has a finite 16384-token completion allowance. Existing durable snapshots retain their original request identity. Legacy output-limit failures immediately stop the batch and finish as incomplete, while transient failure handling is unchanged. Actual reported usage remains authoritative; the higher cap also affects maximum credit reservation. No dependency or schema changes.

Targeted tests cover the real loop's skipped commit/repeated calls, provider request budget and reported usage, and both legacy and durable continuity paths. Release validation is tracked by exact-commit CI.
