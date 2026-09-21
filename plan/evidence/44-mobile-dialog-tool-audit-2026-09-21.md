# 手机弹窗与当日工具失败 / Mobile dialogs and tool failures

## 生产只读调查 / Read-only audit

Asia/Hong_Kong 2026-09-21 00:00–17:32:54。按 runId + callId 去重，当日 250 次 tool.result，231 成功、19 未成功（7.6%）、0 未知；原始事件与去重数一致。不含未返回调用。以下包含保护性拦截与作者取消，不是实际程序故障率；统计未回写。

| 工具 / Tool | 成功/返回 / Success | 成功率 / Rate | 已核实原因 / Verified cause |
|---|---:|---:|---|
| chapter_bridge_commit | 9/15 | 60% | 4次缺质量检查，1次其他前置未满足，1次失效编译编号 |
| quality_analyze | 14/19 | 73.7% | 4次免费lite任务错误请求默认付费检查模型，1次错误章节目标 |
| continuity_validate | 21/25 | 84% | 1次BYOK传输失败667434ms，1次作者中断，2次编译/前置拦截 |
| scene_task_build | 13/15 | 86.7% | 1次非法JSON，1次供应商输出截断 |
| todo_write | 9/10 | 90% | 初建清单携带8个模型自造id，当前任务此前无成功清单 |
| memory_save | 1/2 | 50% | 唯一失败的48字符引用：所属章节存在，去除空白后匹配，但逐字匹配失败；样本仅2 |
| plan_save | 10/10 | 100% | 今日未发现失败 |
| plan_read | 6/6 | 100% | 今日未发现失败 |

仅使用汇总、协议状态和长度定位；不提交作者原文、引用、用户或作品标识、密钥及生产日志。667秒失败在日志确认代码为 AI_PROVIDER_TRANSPORT，不猜测为具体429/500，也不视作已成功检查。用量日志确认先执行agent3ContinuityCritic（16384输出tokens），随后agent3ContinuityCriticOutputRecovery处于pending_usage；属于原检查加恢复共用时间预算缺失，不自动重发未知结果。

## 手机弹窗与空状态 / Mobile dialogs and empty state

- 作品封面及通用图片裁切弹窗使用动态视口高度上限、可收缩的纵向滚动内容区，隐藏滚动条并保留滚动。作品预览在窄屏同比缩放，裁切及输出坐标保持原尺寸；删除用户指定的“拖不动没关系”提示区域。
- 写作样章弹窗补足手机端确定高度；发布弹窗整体可滚动，避免权限选项挤没列表；确认弹窗长说明也限制高度并可滚动。导出、发布、样章、风格学习与技能管理弹窗隐藏滚动条（包括相关嵌套列表）。
- 右侧任务状态外容器按实际正文变更、未取消待办或待审项决定显示；原始操作记录或仅已取消待办不再撑出空卡片。
- Playwright 使用真实组件和合成封面验证：320×568作品裁切，滚动区clientHeight386/scrollHeight722，滚动后scrollTop336，确认按钮位于y487–527并成功触发；scrollWidth/clientWidth同为286，scrollbar-width为none。通用裁切568×320横屏，滚动区210/293，无横向溢出、滚动条隐藏。未使用生产作品或真实上传。

## 后端修复 / Backend changes

- Legacy当前免费或BYOK模型完整继承到质量初检、证据校正、自动修订、连续性及关联辅助文本调用，包含原凭据和能力参数。付费任务保持原复核模型策略；平台图片/联网收费规则不变。质量未完成仍不得提交为通过。
- 连续性/质量generateReviewCompletion增加最多180秒总截止时间（配置更短则遵循配置），包含一次有依据的输出截断恢复；取消信号贯穿，不因恢复刷新时间，取消与超时分别处理，迟到结果不当作成功。未知传输结果不自动重复收费请求。
- 记忆引用仅对可唯一定位的空白排版差异提供匹配。保留拉丁文字/数字间的词边界，不修正标点或文字，不拼接片段；仍校验用户、作品和revision。保存的span及hash绑定原文章节实际连续字符，未使用改写引文hash。
- 新建空待办清单时丢弃模型自造id并分配稳定服务端id；已有清单的外来id仍拒绝，已完成/取消与任务谱系规则保留。
- 场景参数损坏/截断继续保留现有明确纠正指导，不补括号执行残缺参数。失效目标、缺少质量门及作者中断不能靠改成功状态“提高成功率”。

## 验证及边界 / Verification and limits

后端定向48项测试通过（记忆13、复核10、待办17、免费/BYOK辅助模型8）。全部使用合成数据/mock；未付费调用真实模型，未修改生产作者作品。发布四闸、同SHA CI零skip与部署事实按本次发布记录确认。

已知独立风险：独立的durable冻结辅助调用协议仍固定speed价目；本轮失败均engine=loop。本次没有改写历史冻结路由/价格，不能声称durable这条独立协议已完成免费模型迁移。

## English

The read-only UTC+8 daily audit found 250 returned tool calls, 231 successes and 19 unsuccessful outcomes, including valid protective refusals and cancellation. No private source content is committed. Legacy free/BYOK auxiliary text calls now retain their selected runtime; review and one confirmed-truncation recovery share a bounded deadline. Whitespace-only memory evidence resolves to a unique original source span and hash, preserving word boundaries and authorization. New todo lists receive server-generated identities, while foreign IDs in existing lists remain rejected. Invalid/truncated executable arguments and unmet quality gates are not converted to success. Durable frozen auxiliary pricing is a separate known limitation, not changed by this patch.
