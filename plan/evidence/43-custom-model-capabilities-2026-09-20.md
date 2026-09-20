# 自定义模型能力校验与历史工具参数兼容

## 问题与修复

- 自定义模型原先信任用户声明的推理档位、默认档位和图片输入开关。界面移除三项手工能力配置，保存改为“校验并保存”。保留供应商、名称、模型 ID、地址、密钥、上下文窗口和启用状态。
- POST/PATCH 保存前使用当前用户提供的实际账号、端点和模型进行有限合成探测。请求中的旧能力字段不能覆盖服务端结果；失败不写配置。更新使用 owner/id/updatedAt 条件，避免慢探测覆盖期间发生的修改；同一进程限制每用户同时一轮探测。
- 推理参数只记录实际接受的 low/medium/high/max 候选；明确不支持时自动省略该参数。请求不存在的强度映射到最近可用档位，已有同名有效档位优先，例 max → high；不切换账号、供应商或模型。能力接受不等于能够证明中转站内部真正执行某种推理深度。
- DeepSeek 显式协议单独验证 thinking 开关，保存后复现实际验证的开关。不可调档不等于关闭推理。明确要求 max_completion_tokens 的端点自动采用该输出上限字段；校验过的模型使用供应商默认 temperature，与探测一致。
- 视觉探测使用随机四色合成图片，逐项核对输出。只有确认识图才启用直接图片输入；未支持或无法确认时保持现有平台视觉工具路径。工具探测仅检查合成原生调用格式，不执行工具，不代表完整 Agent 兼容验收。
- 保存最多 7 个请求、总 50 秒、单次 12 秒、每次最多 256 输出 tokens、响应 64 KiB；所有协议重试计入同一上限。无作品原文、无平台 Credits 扣款，供应商可能正常计费，界面已有说明。HTTPS、公网 DNS 连接限制、不跟随重定向、错误脱敏、断开取消。
- 主循环、收尾、子 Agent、辅助文本生成和导入建议携带已验证的参数模式。导入报价指纹包含参数模式变化。存量配置保留，重新保存时校验；未自动使用旧密钥进行批量收费探测。

图中 400 的直接信息是历史工具调用 arguments 非法 JSON，不能认定由推理强度造成。请求编码和计费摘要前隔离非法、不完整、非对象、重复或无法配对的原生调用，将原始回执保留为独立只读历史数据；不补齐参数执行，不抹去真实成功结果，不伪造成功。合法调用仍与唯一回执配对。

## 验证与限制

- 定向初次检查：6 文件 104 测试通过（能力模块当时 29 项）；后续 DeepSeek 开关与超时边界补丁的模块 37 项通过。
- 测试覆盖实际请求体、非法历史 JSON、混合合法/非法批次、真实成功回执保留、能力声明防覆盖、保存失败不写、跨用户拒绝、慢更新冲突、并发探测、隐藏控件、参数兼容及校验中禁用表单。
- 未调用真实供应商密钥，未用生产作品测试，未进行真实浏览器或所有中转站逐一验收。不声称所有中转站支持流式原生工具或能够被完全探测。
- 既有创建数量上限 count/create 非原子，本轮不将进程内探测互斥宣称为数据库跨进程数量锁。
- 无数据库结构迁移。四闸、精确提交 CI 和部署结果由发布记录追加，代码完成不代表已上线。

## English

Custom model capabilities are now server-validated on save instead of manually declared. Bounded synthetic probes verify accepted reasoning parameters, the explicit DeepSeek thinking switch, output-token parameter compatibility, and image recognition. Unsupported and inconclusive capabilities remain distinct; authentication failures, rate limits and timeouts are not treated as unsupported reasoning. Existing configurations are checked when saved again, without unsolicited paid migration probes.

Malformed historical tool-call arguments are isolated before provider serialization and billing request encoding. Native calls retain unique matching receipts; invalid records keep their actual outcomes as inert historical data rather than executable repaired arguments. No credentials or production manuscript text are included in this evidence.
