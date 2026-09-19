# ZIP 默认卷归位与未完成任务替换证据

基线：`762c4cf2ac114fa79db3a0f039b1316c0bd513f6`。验证在隔离工作树完成，原目录未修改；私有用户 ZIP 仅本地读取，未暂存、未上传服务器或 CI，本文不含正文。

## 真实 ZIP 结构复现

- 固定 Node/npm 运行时使用 Node `v22.23.2`；输入文件大小 `142579` bytes。
- `parseNovelImportFile` 得到 1 个卷，卷名 `淬火`，4 章，4 章非空，`sourceChars=12099`。仅记录解析 warning code，不记录正文或文件成员正文。
- 首轮旧 placement 复现：已有空默认卷 `第一卷` 时，未识别无卷序前缀的 `淬火`，新建卷并留下空默认卷。
- 修复后 synthetic 默认卷包含真实持久化字段 `revision=1`、`summary=null`：placement 将 `existing-default-v1` 从 `第一卷` 重命名为 `淬火`，不新建卷，`volumeCount=1`，该卷承载 4 章，`archivedChapterCount=0`。这是本轮实际结构证据，不含正文。

## 边界与替换

- 只有唯一、空的默认第一卷且 revision/summary 均匹配时才允许无卷序前缀来源复用；已有章节、多卷、非默认 revision 或非空摘要不会被猜测重命名。
- 未完成导入任务的自动替换保留归属、版本、lease、取消和幂等保护；旧任务未完成时不直接覆盖其持久化来源，替换路径需通过同一任务状态与目标校验。
- 历史双卷数据不由本修复自动重排；已有空卷可由现有删除空卷操作处理，正文 ID 保持，原导入恢复 hash 会失效。

## 验证

- `npm run check`：通过。
- `npm run lint`：0 errors；2 个既有 Fast Refresh warnings。
- 导入定向 5 files：170/170 tests passed，包含 service 78、placement 15、auto 16、UI 49、API 12；本地无数据库集成测试未作为发布证据，完整隔离 PostgreSQL 结果以同 SHA CI 为准。
- 真实 ZIP 复验脚本保存在系统临时目录，不在仓库：`chevoink-zip-repro-20260920/parse-placement-repro.mts`。
