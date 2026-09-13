# CI artifact → production image identity（只读证据映射）

本说明修正“不同 Docker image store 的 `.Id` 必须字面相同”的部署要求，不放宽镜像白名单。只允许提升成功 CI 实际导出的同一 payload；不 rebuild、不 pull、不转换文档、不额外运行测试。已有同版本 native/launcher CI 验收仍是前提，本说明不能替代失败或缺失的验收。

## 为什么两个 SHA256 可以不同

须先识别被哈希的对象，不能只凭 Docker 版本或摘要前缀判断。OCI manifest 的摘要标识 manifest 字节；其 `config` descriptor 指向另一份配置 JSON。[OCI manifest 规范](https://github.com/opencontainers/image-spec/blob/main/manifest.md)

配置原始字节的 SHA256 是 config ImageID；配置包括运行参数及有序 `rootfs.diff_ids`。DiffID 哈希的是**未压缩的层 tar 字节**，不一定等于压缩层 blob digest。[OCI config 规范](https://github.com/opencontainers/image-spec/blob/main/config.md)

因此 CI 记录 manifest/index digest，而目标 classic Docker 返回 config ID 时，可以通过下述证据链证明执行 payload 相同。`docker-save` 的 `manifest.json` 是导出目录清单，**不是** OCI image manifest；不能哈希该清单来冒充 CI manifest digest，也不能重新序列化 JSON 后计算配置摘要。

目前收到的 `sha256:7305110...` / `sha256:17f52b9...` 只是问题描述中的短前缀；本文件**没有核验实际 artifact 或确认这两个具体镜像等价**。

## Operator 静态核验步骤

1. 固定同一成功 run 的完整 run ID、attempt、head SHA、workflow、两个 artifact ID/name：native evidence 与 worker tar。核对 evidence 对应的测试镜像就是该 workflow 导出的镜像，不能混用不同 run/attempt 的同名文件。保留可信下载来源及 GitHub artifact digest；如提供签名/attestation，验证其签名、仓库/workflow 身份与 subject digest。普通 artifact 上传不自动等于签名证明。仅自己计算一个 SHA256 不能认证来源。
2. 在可信下载端记录 `document-import-worker.tar.gz` 的完整 SHA256，传输后核对相同文件 SHA256。GitHub 外层 artifact ZIP digest 与内层 tar.gz digest 是不同对象，不要求彼此相等。保留 ZIP 到 tar.gz 的成员关联。不要重新打包、重压缩或重新 `docker save` 来代替收到的证据文件。
3. 以非 root 身份只读遍历已认证 tar.gz，读取唯一的 `manifest.json`。按已验收平台（当前 `linux/amd64`）和证据选中明确的一项，记录其完整 `Config` 成员路径及有序 `Layers`。不能默认多镜像清单第一项或凭 tag 选中；无法唯一绑定则停止。
4. 流式读取该 `Config` 成员的**原始字节**并计算 SHA256，记录为 `CONFIG_ID=sha256:<完整64位hex>`。随后才解析 JSON，保存 `os`、`architecture`、可选 `variant`、`rootfs.type` 和有序 `rootfs.diff_ids`。内容 digest 必须与任何已有 config descriptor/内容寻址成员名一致；成员名本身不是校验。
5. 按 `Layers` 顺序流式校验每一层；对未压缩层 tar 直接 SHA256，对压缩层先按实际声明格式有界解压再 SHA256。数量与每项必须精确等于配置 `rootfs.diff_ids`，不排序、不忽略重复层、不用重新打包的目录计算。OCI 压缩 blob 的 descriptor digest/size 如存在，也须核对。
6. 如归档含 OCI index/manifest blobs，从 CI 记录的完整 digest 对应的**原始 blob**开始验证 SHA256。index 则逐级检查 descriptor digest/size，选择明确的 `linux/amd64` image manifest（不是 provenance/attestation manifest）；image manifest 的 config digest 必须等于步骤 4，其有序 layers 必须与步骤 5 对应。记录完整 `CI index? → manifest → config` 链。
7. 若 docker-save 没保留原 OCI manifest，**不能声称已直接验证 CI manifest digest → config 的哈希链**。可记录“同一可信成功 CI 导出 artifact 的 config/layer payload 映射”，前提是步骤 1–5 的认证与导出关联完整。缺少这种来源绑定时停止交接，请求原有 run 的证据；不因摘要前缀符合预期而放行，也不通过 rebuild 补证。
8. 对已经加载的目标本地镜像做下面只读 inspect。`.Id` 必须等于步骤 4 的 `CONFIG_ID`，平台与步骤 4 一致，`.RootFS.Layers` 必须逐项等于其 `rootfs.diff_ids`。Docker daemon 必须是既定可信本机 daemon；不能使用继承的远程 context。如果目标 store 仍返回其他种类 ID，本流程的 classic config ID 分支不成立，应先明确其对象与本地选择器，不能跳过校验。

归档读取不执行镜像，也不提取层文件。使用确切成员名，拒绝重复/歧义名称、绝对路径、`..`、链接或非普通文件引用；不 `extractall`，不以 root 解包。设置有限成员数、元数据大小和流式总字节/解压上限；超过预先批准的发布包预算则停止。读取失败、缺层、未知压缩格式、摘要/平台/顺序不符均失败关闭，不尝试“修复” artifact。

以下命令仅供已获授权 operator 使用；`<CONFIG_ID>` 必须替换为步骤 4 的完整 `sha256:...`，不是短 ID/tag。身份校验不要求新增服务账号权限；只读 Docker 命令不加入 launcher sudoers。

```sh
sha256sum /exact/download/path/document-import-worker.tar.gz
docker --host unix:///var/run/docker.sock image inspect --format '{{.Id}}' <CONFIG_ID>
docker --host unix:///var/run/docker.sock image inspect --format '{{.Os}}/{{.Architecture}}' <CONFIG_ID>
docker --host unix:///var/run/docker.sock image inspect --format '{{json .RootFS.Layers}}' <CONFIG_ID>
```

## 通过后的唯一配置与留档

将**已证明的生产本地完整 config ID**同时写入 root-owned `/etc/chevoink-document-import/launcher.json` 的 `image` 和 `DOCUMENT_IMPORT_WORKER_IMAGE`。两者必须完全一致。不修改业务代码，不允许 tag/通配 digest，不扩大 sudoers；wrapper 固定 `/usr/local/bin/chevoink-document-import-docker`，root config 的 `uid` 仍取实际 `id -u ubuntu`。原 CI ID 保留在验收证据中，不覆盖成生产 ID。

随 release 保存：run/attempt/SHA、artifact IDs、来源/签名核验结果、外层 artifact digest、tar.gz SHA256、CI ID 及对象类型、Config 完整成员路径、原始 config SHA256、平台、有序层 DiffIDs、可用的 OCI descriptor 链、生产 inspect 输出、核验方式（直接 descriptor 链或可信同 run 导出关联）、操作者与时间。成功结论是“同一已验收执行配置与文件系统 payload”，不是不同格式 manifest/压缩包字节相同，也不证明生产 runtime 测试通过。

仅身份映射文档变化不要求重新构建或再跑一轮 CI。生产原生健康检查仍只允许内部版本/语言包/工具自检：**零文档转换、零 OCR、零合成文档处理**。本步骤不执行 health、测试或部署。
