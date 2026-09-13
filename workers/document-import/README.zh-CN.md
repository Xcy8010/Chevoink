# 隔离文档导入 Worker 与业务解析管线

[English 与完整接口/命令/官方来源](./README.md)

范围为 plan32 的 DOC 转换、离线 PDF/图片 OCR、隔离解析与业务适配；鉴权、私有持久化、人工决定、计费及提交由应用服务负责。**原生验收以实际同 SHA 的专用 CI 结果为准；新增工作流不等于已通过。** 本工作未提交、部署或执行生产文档测试。

## 本轮接线与精确镜像交接（2026-09-14）

部署账号无 Docker socket 权限时，使用 [root-owned 受限 sudo launcher](./privileged/README.md)，不授予 Docker 组或泛用 Docker sudo 权限。须先通过新增 CI，再按文档安装固定 helper、root 配置及精确 sudoers。

- 服务入口：`api/lib/novel-import/runtime.ts` 的 `parseConfiguredNovelImportDocument(buffer, filename, {sourceId, sourceHash?, encoding?, signal?, deadlineAt?})`；`deadlineAt` 是持久任务截止时间的 Unix 毫秒，恢复后不可重新给 30 分钟。返回 `{parsed, report, artifacts}`，图片字节仅交私有存储；只有服务证明全部资源归属/摘要正确且已保存，才能清除 `IMPORT_IMAGE_STORAGE_REQUIRED`，人工不得豁免。
- DOC/PDF 及 ZIP 内同类成员走受控 native worker；DOCX/ZIP 图片安全转为 PNG 后做离线 OCR，文字放“图片正文（待归章）”，不替换已有段落。图片/封面只产生候选，须人工确认用途及顺序。
- 原生总期限 30 分钟，TXT/MD 120 秒，单转换进程 120 秒，每页各 OCR 区域合计 60 秒。服务负责持久租约、fencing 与全局有界 claim；runtime 同进程最多一个 native 任务。
- 专用 CI：`.github/workflows/document-import-native.yml`，缺 Linux/镜像时 required 模式失败而非 skip。包含真 OLE DOC 且检查转换正文、混合 PDF、PNG、无文字层中文扫描 PDF、真实客户端 hash/取消/清理及健康自检。中文金标准是自有固定干净印刷文本，去 Unicode 空白的 CER 必须 ≤2%；同时输出 raw CER、规范化口径和原文/识别/source hashes，不宣称手写/所有恶意样本已验收。

最终交接必须取同一成功 CI 运行的两份 artifact：`document-import-native-evidence-<SHA>`（镜像 ID 与验收 JSON）和 `document-import-worker-<SHA>`（`document-import-worker.tar.gz`）。以下是获准发布时由主 agent/operator 执行的说明，本任务没有执行：

1. 应用全量 CI 与专用 native CI 同 SHA 全部成功。
2. `docker load --input <下载的document-import-worker.tar.gz>`，不在服务器重新构建。`docker image inspect --format '{{.Id}}' <CI记录ID>` 必须等于 `document-import-image.id` 中完整 `sha256:...`，不能改用 tag 或基础镜像 digest。
3. 创建 `/opt/chevoink/shared/document-import-staging`，归 API 服务账号，权限 `0700`；必须在 uploads/public 以外。容器不挂 Docker socket；只有监督端以获批权限使用同机 daemon。
4. 配置独立 operator 环境：

   ```dotenv
   NOVEL_IMPORT_NATIVE_ENABLED=true
   DOCUMENT_IMPORT_WORKER_IMAGE=sha256:<成功CI的精确镜像ID>
   DOCUMENT_IMPORT_WORKER_STAGING_ROOT=/opt/chevoink/shared/document-import-staging
   ```

5. 在发布 checkout 使用已配置的服务环境运行内部命令 `node --import tsx workers/document-import/health-cli.ts`。退出 0 且 `ready:true` 代表真实沙箱内版本、工具、Python bridge 和语言包自检通过；**零文档转换、零 OCR、零合成文档处理**，不公开 HTTP health 接口。用户禁止的服务器 DOC/OCR 文档测试依旧禁止。

Docker 客户端只连接 `unix:///var/run/docker.sock`，不继承远程 context/config/密钥。native 关闭时走确定性解析；显式开启但健康失败不会静默换解析器。健康仅代表依赖就绪，不代替 CI 字准率验收；此开关也不授权归档/恢复/发布/Agent 写入。

## 接入约定

从 `api/lib/novel-import/worker-client.ts` 导入 `createDocumentImportWorker`。配置专用、API 所有、0700 的 `stagingRoot` 和审核过的 worker 镜像 digest；每个监督进程复用一个实例，最多同时运行一个任务。只支持 Linux API 与同机 Linux Docker，不继承远程 Docker 环境，不回退到宿主 LibreOffice/Python。

`run({sourceId,sourceHash,format,bytes,signal?,timeoutMs?,ocrLanguages?})`：

- `sourceId` 为 1–80 位字母/数字/下划线/连字符的内部 ID；`sourceHash` 为原始字节 SHA256。
- `format` 为 `doc/pdf/image`；图片仅 PNG/JPEG。`bytes` 为 `Uint8Array`，不接收文件路径、命令、URL、密钥或任意环境。
- `timeoutMs` 为 1 秒至 30 分钟，默认 30 分钟；语言为 `chi_sim+eng/chi_tra+eng/eng`。
- 返回 `outcome=converted/parsed/needs_review/failed`。返回值也可能是失败，必须检查 `error`；基础设施、协议、取消错误抛出含稳定 `code` 的 `DocumentWorkerError`。
- `artifacts` 为 `{id,mediaType,sha256,byteLength,bytes,width?,height?}`；线上协议使用有界 base64，客户端校验后返回字节。无容器指定的宿主输出路径。
- DOC 的 `convertedArtifactId` 指向 DOCX，交现有受限 DOCX parser 继续处理，并保留转换警告；转换成功不等于正文完整，DOC 不伪造页码。
- PDF 的 `pages` 保留每页状态、尺寸、警告、`blocks`、`regions`。块包含原生/OCR 方法、文本、位置、置信度、区域 ID 与 `duplicateOf`。坐标是未旋转 PDF 左上角点数；图片模式使用内部单页 PDF 坐标。
- `duplicateOf` 仅记录精确文本与空间重叠证据。保留原块，默认正文拼装跳过已标注 OCR 重复块，不直接把原生文字与 OCR 拼接。
- `coverage` 的互斥分类计数与总页数守恒；所有 OCR 页均待复核，不凭高置信度自动通过。`complete` 只代表处理覆盖，不代表字准率、用户批准或允许写入。

原文件必须由 API 独立持久保存；本地 staging 是临时目录，不是原文仓库。API 继续负责归属、配额、租约 fencing、私有附件存储、完整性确认、显式排除与提交。图片必须鉴权访问；DOCX 再做容器安全检查。PNG 客户端仅检查长度/摘要/头部尺寸，不冒充完整图像净化。缓存须包含用户、原 hash、实际镜像 digest、语言与选项。

## 隔离与能力边界

调用固定为非 root UID/GID 10001、只读根、断网、移除 capabilities、禁止提权、保留 Docker 默认 seccomp；1 CPU/1 GiB、无 swap、96 PID、关闭 core。唯一 `/input` 只读挂载只有源文件与请求；`/work` 256 MiB、`/tmp` 64 MiB 为 noexec/nosuid/nodev tmpfs。不挂应用目录、宿主输出目录、Docker socket、密钥或业务数据库。

DOC 检查 OLE/WordDocument/FIB/table stream 与加密位，用独立 LibreOffice profile 和本地 UNO pipe；加载时禁止宏、链接更新及交互批准，断网阻止远程模板。输出 DOCX 有大小/ZIP 基础安全检查，复杂对象/修订等仍由后续 parser 与用户复核。

PDF 逐页子进程提取原生文本；即使存在原生页眉，也对图片区域 OCR。旋转、异常字符、阅读顺序、表单/注释和混合矢量内容均产生复核警告。OCR 使用固定 Debian Tesseract 5.5 CPU LSTM 与简/繁中、英语数据，不安装 Paddle/GPU、不运行时下载、不调用模型。选择理由是更轻的离线部署依赖，不是经实测证明中文精度优于 Paddle。

硬上限：源 50 MiB、1000 页、解码/渲染图像 20 MP、单 PNG 4 MiB、128 个附件/合计 32 MiB、每页 64 区域/10 万字符、任务 500 万字符/10 万块、响应 64 MiB；原生子进程 120 秒、单页 OCR 合计 60 秒、任务 30 分钟。超过 20 MP 的源图片直接失败。图片附件是渲染区域 PNG，非嵌入图片逐字节副本；原始文档仍是来源依据。

后页失败/超限时保留已完成页并列出其余失败页，不把部分结果称为整本成功。容器 OOM/死亡、外层超时或非法协议时没有持久增量检查点；API 保留源后另行重试，不承诺恢复内存中已完成页。

取消/超时终止 CLI，并按精确随机名称强制删除容器，只删除自建 staging 子目录。清理额外最多两次各 5 秒 Docker 调用；无法确认时返回 `IMPORT_CLEANUP_FAILED`。API/宿主死亡、Docker 失联或延迟创建竞态仍需运维基于 `org.chevoink.document-import=protocol-v1` 标签、年龄与持久任务租约做清理器，本原型未安装清理器。staging 必须在专用本地磁盘，文件系统调用未独立支持取消。

## 依赖与验证

Dockerfile 固定 2026-09-13 从 Docker 官方 registry 核验的 Debian trixie-slim OCI digest；`dependencies.lock` 固定 Debian 原生库/语言包版本，已核对官方包页面。构建时联网通过 apt 签名/摘要校验，运行时断网。镜像内生成完整已安装包清单和语言数据 SHA256；没有声称已锁定历史 apt 全部传递依赖。构建后必须扫描/SBOM、验收并固定实际 worker 镜像 digest；固定版本失效应停止构建，不擅自放宽。

完整构建、host-safe 测试与容器 smoke 命令见英文文档。不得把根目录作为 Docker build context，不带生产配置。Paddle 未引入；PyMuPDF 是 AGPL/商业双许可，LibreOffice、Tesseract、字体及其传递依赖的许可证需随镜像保留并在分发前审查，官方链接见英文文档。

2026-09-13 验证记录：最初本地在 Windows、Python 3.12.10、Node 24.12.0 下通过 25 项 TypeScript、11 项 Python 离线测试及定向严格类型检查/ESLint；随后父任务报告同一组 25 项 worker 协议/客户端 TypeScript 测试已在仓库固定 Node 22.23.2 下通过，这是当前 Node 验证证据，不是原生集成验收。本地仍无 Docker/soffice，1 项容器原生 smoke 继续明确跳过。**未构建容器、未实跑 LibreOffice/Tesseract worker、未验证 OS 沙箱、中文 CER、内存/CPU、攻击样本或生产部署。** 可选 mapper 与独立的整文件 parser 边界由各自负责人接入；本 worker 测试记录不代表完整应用集成或六格式交付已完成。原生开关仍关闭，后续原生验收与全仓闸门由父任务协调。

容器 smoke 在同一受限容器内生成自有原生 PDF、带页眉扫描区域 PDF、PNG，以及真正 OLE DOC 转 DOCX；代码已提供，未记录为通过。仍须补外部授权 DOC、密码/损坏/宏样本、旋转/双栏/低清中文金标准集、取消清理/崩溃恢复及 plan32 字符错误率闸门。文件清单见英文文档末尾，所有文件均在指定所有权范围内。
