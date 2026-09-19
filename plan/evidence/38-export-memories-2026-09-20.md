# 一键导出创作记忆 / Export creative memories

- 一键导出新增默认勾选的“创作记忆”；可以取消，也可以单独导出。网页下载与客户端临时链接共用契约。
- 新接口参数 `includeMemories`；旧调用省略时保持原范围。Agent 导出工具可显式选择记忆。
- 按当前作品记忆面板范围导出全部有效卡片，不受分页限制，不查询运行/会话记忆。逐条 UTF-8 TXT 保留正文，文件名清洗并加唯一序号防同名覆盖。
- 无依赖或数据库迁移变化。验证与发布结果以本次同 SHA CI 和部署核验为准。

The export dialog now includes a selected-by-default creative memories option, including memory-only exports. Web and native download paths share the request contract. Older callers retain their existing scope unless they explicitly enable `includeMemories`; the Agent export tool supports that option too.

The archive includes all effective cards visible in the current novel's memory panel, without pagination or runtime/session memories. Each UTF-8 TXT preserves the original content; sanitized numbered filenames prevent collisions. No dependency or schema migrations were introduced. Check and release results are recorded by the exact-commit CI and deployment verification.
