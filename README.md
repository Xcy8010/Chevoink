<p align="center">
  <a href="https://chevoink.chevolink.com">
    <img src="docs/assets/chevoink-readme-banner.png" alt="Chevoink 启创墨域 — AI 创作与阅读平台" width="1200">
  </a>
</p>

<h3 align="center">一念启创，落墨成域。</h3>

<p align="center">
  以 AI 为创作伙伴，连接灵感、作品与读者。<br>
  与 Chevoink Agent 一起研究、规划、写作与改稿，在这里创作小说，也发现、阅读与分享故事。<br>
  <sub>Web · Windows · Android</sub>
</p>

<p align="center">
  <a href="https://github.com/Xcy8010/chevoink/releases"><img src="https://img.shields.io/github/v/release/Xcy8010/chevoink?label=Release&amp;color=14b8a6" alt="最新 Release"></a>
  <a href="https://github.com/Xcy8010/chevoink/actions/workflows/ci.yml"><img src="https://github.com/Xcy8010/chevoink/actions/workflows/ci.yml/badge.svg" alt="CI 状态"></a>
  <a href="https://github.com/Xcy8010/chevoink/stargazers"><img src="https://img.shields.io/github/stars/Xcy8010/chevoink?style=flat&amp;logo=github&amp;label=Stars" alt="GitHub Stars"></a>
  <a href="#license"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue" alt="License AGPL-3.0"></a>
  <a href="#交流群"><img src="https://img.shields.io/badge/QQ-158443235-14b8a6" alt="QQ 交流群 158443235"></a>
</p>

<p align="center">
  <a href="https://chevoink.chevolink.com"><strong>在线体验</strong></a> ·
  <a href="#产品预览">产品预览</a> ·
  <a href="#功能一览">核心能力</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="https://github.com/Xcy8010/chevoink/releases">客户端下载</a> ·
  <a href="#交流群">社区交流</a>
</p>

<p align="center"><strong>简体中文</strong> · <a href="./README.en.md">English</a></p>

---

## 产品预览

**桌面端**

<table>
  <tr>
    <td align="center"><img src="public/PCdemo1.png" alt="桌面端演示 1" width="420"><br>书城与阅读链路</td>
    <td align="center"><img src="public/PCdemo2.png" alt="桌面端演示 2" width="420"><br>创作区与 AI 写作 Agent</td>
  </tr>
</table>

**移动端**

<table>
  <tr>
    <td align="center"><img src="public/MOBILEdemo1.jpg" alt="移动端演示 1" width="420"><br>手机端首页与社区</td>
    <td align="center"><img src="public/MOBILEdemo2.jpg" alt="移动端演示 2" width="420"><br>手机端创作与阅读</td>
  </tr>
</table>

## Chevoink Agent 3.5

Agent 3.5 围绕一部作品持续研究、规划、写作与修订，按任务和阶段加载技能，保留完整作者要求、作品事实和真实执行结果。Work 与 IDE 的任务窗口用中文显示核对前文、撰写、修改、复查和保存；模型实际返回的思考支持流式查看、折叠及历史恢复，复制回答只包含正文。思考展示与执行协议分开，工具实际开始执行后才显示操作卡片。

### 3.5 的写作边界与技能

- 编辑器选区与明确的自然语言局部修改在新任务入场时冻结范围。可定位的局部要求使用精确片段修改；无法唯一定位时先请求准确片段或选区。批量修改全批校验、一次版本比较写入，重复恢复复用回执，无变化不新增正文版本。
- 正文修改后，本任务要求的检查必须对应最终当前版本。严谨模式逐项实际应用或记录有依据的保留理由；事实硬伤与作者明确要求的全部检查通过仍独立把关。普通作者编辑和自动修订次数分开，没有检查义务的手动编辑不额外强制付费检查。
- 本次内置技能包为 **3.5.0**，路由契约为 **3.5.0**，技能稳定 ID 保持兼容。作品技能区显示新任务实际使用的内置版本；旧资源、已保存任务的技能/路由版本和付费回执保留。作者与第三方技能继续使用各自版本，不随产品版本自动升级。
- 已发送但结果不明的模型请求保持待核，不自动重发或补零费用。只读状态、保存成功、检查完成、有限交付与原目标全部完成分别表达。
- 工具参数在统一入口按声明的类型处理传输编码：对象或数组被完整 JSON 字符串包裹时可解码，再执行原严格校验。合法字符串、未知字段、权限、章节范围与旧执行回执保持原语义，不自动补造卷决定或章节身份。
- 思考流接回原有紧凑思考栏，保留原展开、滚动和收起交互。结构化检查在已确认支持的 MiMo 官方端点使用 JSON 输出模式，仍校验完整报告、引用和版本；旧冻结请求不补加参数，模型选择与 Credits 倍率不变。
- 上下文记录匿名类别的估算 tokens 和组装耗时，逐轮复用固定工具定义的估算，保留作者要求、原文背景和检查证据。模型实际用量仍是结算依据；估算和界面思考均不代表写作质量已通过验收。

这些规则保护执行与恢复，不代表文学质量、真实模型速度或原生设备验收已经通过。真实 provider 配对、完整稿与修改差异盲评、Android/Windows 真机验收仍需对应授权与实测；不承诺零失误或 99.99% 可靠性。原生壳加载同一线上站点，本次网页版本更新不等于新 APK/Windows 安装包验收。

### 运行流程

```mermaid
flowchart TD
  A[作者提示词 / 图片 / 文件 / 作品引用] --> B[任务与作品范围识别]
  T[定时任务 / 子 Agent 触发] --> B
  B --> C[上下文装配<br/>作品·卷章·记忆·当前光标·用户硬约束]
  C --> C1[(会话·版本·记忆·用量)]
  C --> D[权限与预算闸门<br/>网络·写入·发布·破坏性操作·Credits]
  D --> E[两级 Skill Router<br/>确定性触发 + 语义裁决]
  E --> F[按需加载 2–3 个 Skill<br/>版本锁定·正负触发·作用域过滤]
  F --> F1[Style DNA / 合法技法检索<br/>只返回技法与统计特征，不回传原文]
  F --> G{任务类型}
  G -->|新书 / 换题材 / 事实依赖| H[Research Dossier<br/>搜索·深读·来源记录·缓存 TTL]
  G -->|规划 / 写作 / 改稿 / 续写| I[Story Compiler<br/>Charter → Promise → Scene Task → Chapter Bridge]
  G -->|检索 / 管理 / 导出| J[Agent Tool Loop<br/>116 个受治理工具·附件·封面·导出]
  G -->|复杂协作 / 定时巡检| K[子 Agent / Schedule<br/>独立会话·预算·工具白名单·可取消]
  H --> I
  I --> L[模型执行<br/>流式思考·正文·工具参数]
  J --> L
  K --> L
  L --> M[连续性 + 人类感 + 版权质量门<br/>证据化 finding·有界事实修订·版本复核]
  M --> N{是否需要写入?}
  N -->|否| O[整理答复与工具结果]
  N -->|是| P[revision 乐观锁 + ChangeSet<br/>原子写入·回滚快照]
  P -->|成功| O
  P -->|版本冲突| Q[不覆盖新内容<br/>刷新上下文·请求重试或交给作者选择]
  Q --> O
  O --> R[SSE 流式回复<br/>事件持久化·断线续传·完整回放]
  R --> S[作者审阅 / 回滚 / 分支 / 发布]
  R --> U[Credits 与 AiUsageLog<br/>输入·输出·缓存 Token·工具次数·失败原因]
  S --> V[反馈 / 盲评 / 留存 / 成本指标<br/>驱动 Skill、质量门与模型路由迭代]
```

### 系统架构

```mermaid
flowchart LR
  subgraph Client[客户端]
    WEB[React Web<br/>Work / IDE / Reader]
    APP[Android Capacitor]
  end
  subgraph Edge[接入层]
    NGINX[nginx<br/>HTTPS·强制 CSP·静态缓存]
  end
  subgraph Service[Chevoink 服务]
    API[Express API<br/>认证·作品·社区·Credits]
    LOOP[Agent 3.5 Runtime<br/>Loop·116 Tools·权限沙箱]
    SKILL[Skill OS 3.5<br/>Router·Loader·版本/测试/回滚]
    STORY[Story Compiler<br/>Memory·Quality Gate·Craft Retrieval]
    SSE[SSE Event Stream<br/>持久化·续传·回放]
  end
  subgraph Data[数据层]
    PG[(PostgreSQL<br/>schema·migrations)]
    FILES[(受管上传与导出)]
  end
  subgraph Providers[外部能力]
    LLM[OpenAI-compatible LLM]
    VISION[Vision / Image]
    SEARCH[Web Search / Reader]
    TTS[TTS]
  end
  WEB --> NGINX
  APP --> NGINX
  NGINX --> API
  API --> LOOP
  LOOP --> SKILL
  LOOP --> STORY
  LOOP --> SSE
  API --> PG
  LOOP --> PG
  API --> FILES
  LOOP --> LLM
  LOOP --> VISION
  LOOP --> SEARCH
  API --> TTS
  SSE --> WEB
  SSE --> APP
```

自动评测覆盖 24 个冻结中文网文场景、6 类题材、9 类任务和 12 类质量信号；CI 会保存带数据集 Hash、代码 SHA、模型与 Skill 版本的评测快照。自动指标用于回归定位，不能替代真实作者数据和至少三位目标题材读者/编辑的匿名盲评。

### 长任务连续执行

Agent 支持有预算和进展校验的长任务续跑；暂停后恢复原任务请求与目标。达到硬上限、缺少可核对结果或质量检查未通过时会明确停止，不保证一次自动完成整本书。

### 模型分工

在创作区设置的「模型分工」中，可为正文写作、导入识别等工作选择内置或自定义模型及推理强度。选择「全局」应用于所有作品，或选择「当前作品」覆盖单部作品。新发起的连续性与质量检查及关联修复使用对话中当前选择的模型，按该模型实际用量与 Credits 倍率计费，不增加独立检查费。已发送的检查保留原模型和费用记录，切换模型不会重发结果未确认的请求。

点击「继续」即可恢复原任务。Agent 复用当前版本已完成的检查，完成仍需进行的检查与修补，然后继续推进任务；无需单独购买检查或再次点击继续。主模型与检查工具产生的真实模型用量均按当前选择模型的正常 Credits 倍率结算。历史请求和费用记录保留，恢复过程不会把未完成检查当作通过。

章节复查记录首次确认的问题及实际修改，进入核验后由服务端约束 Agent 的继续改稿：只处理有准确定位、尚未尝试的原问题，或当前完整报告中有证据的错误；新增文风建议需要明确取舍，不能通过普通修改工具反复开启润色。作者直接编辑及新发起的明确改稿任务保留原权限，最终检查仍须覆盖当前正文。连续性检查的新请求会独立保留原响应和实际用量；格式或判断证据无效时，在同一次工具调用内使用当前模型进行一次有界重评，逐项说明原意见的确认、替换或撤回，不要求修改正文来重新触发检查。结果与用量未确认的请求不会自动重发。工具活动统一显示为「复查章节」和「修改章节内容」，尚未执行的内部步骤调整不会显示成一次工具执行失败。

也可以直接要求 Agent 更改创作模式、切换当前模型，或指定某项工作的模型。切换在工具完成后的下一轮生效，保留当前任务和上下文；明确指定模型但未指定推理强度时，使用该模型配置的默认强度。

## 快速导航

| 想做什么 | 去哪里 |
| --- | --- |
| 直接体验产品 | [线上地址](https://chevoink.chevolink.com)（网页端，无需安装） |
| 安装安卓 APP | [下载与安装教程](#下载与安装安卓-app) · [Releases 页面](https://github.com/Xcy8010/chevoink/releases) |
| Windows 客户端开发 | [构建说明](desktop/windows/README.md) · [验收状态](docs/WINDOWS_DESKTOP.md)；当前为内部候选版，尚未正式签名发布 |
| 了解怎么用 | [使用教程](#使用教程) |
| 了解功能 | [功能一览](#功能一览) |
| 了解 Agent 3.5 | [运行流程与系统架构](#chevoink-agent-35) · [历史 Agent 3.0 方案](./plan/23-Agent3.0中文网文人类化创作与技能生态升级方案.md) |
| 本地跑起来 | [快速开始](#快速开始) |
| 了解架构 | [技术栈](#技术栈) · [目录结构](#目录结构) |
| 深入工程细节 | [工程文档](./docs/ENGINEERING.md)（[English](./docs/ENGINEERING.en.md)）· [开发规范](./docs/DEVELOPMENT-STANDARDS.md)（[English](./docs/DEVELOPMENT-STANDARDS.en.md)）· [Agent 评测说明](./tests/agent-evals/README.md) |
| 部署上线 | [部署与发布](#部署与发布) · [环境变量](#环境变量) |
| 交流讨论 | [QQ 交流群 158443235](#交流群) |

## 下载与安装（安卓 APP）

两种方式任选其一：

1. **GitHub Releases（推荐）**
   - 打开 [Releases 页面](https://github.com/Xcy8010/chevoink/releases)，进入最新版本（如 `v1.50`）；
   - 在 Assets 中下载 `chevoink-vX.XX.apk` 到手机；
   - 点击安装。系统若提示「未知来源应用」，在弹窗中允许「本次安装」即可（APK 已使用发布密钥签名）。
2. **官网直装**
   - 手机浏览器访问 <https://chevoink.chevolink.com/download/chevoink.apk> 直接下载安装。

安装后无需手动升级：APP 启动时会自动检测新版本，站内条幅 / 设置页会提示更新并引导下载。网页端用户打开线上地址即是最新版。

## 使用教程

### 读者

1. **登录**：手机号 + 短信验证码，无需注册流程，首次登录自动建号；
2. **找书**：书城首页有轮播、榜单与分类推荐，也可搜索书名/作者；
3. **阅读**：进入正文后左右翻页，点击屏幕中央呼出菜单，可调字号、字体、纸色主题、翻页方式；阅读进度与书架自动云同步，换设备接着读；
4. **听书**：阅读器内开启 TTS 听书，支持切换音色与语速，翻页模式下有底部播放胶囊；
5. **互动**：书籍详情页可评论、点赞、收藏；社区区可发帖、参与话题、关注作者、私信聊天。

### 作者

1. 进入**创作区**即可直接与 Chevoink Agent 对话；零作品时会显示随机创作示例，点击只填入输入框，首次发送后 Agent 通过受作品范围校验的 `novel_create` 原子动作，把隐藏占位工作区完善为真实作品。新建任务对话为空时也会按当前作品随机推荐四个可继续构建的方向；
2. 在章节编辑器直接写作，或呼出 **Chevoink Agent 3.5**：默认最大权限自主执行（工具调用自动批准，保留追踪按钮），能按你的设定与知识集流式生成章节、改写润色，按需建立题材 Research Dossier，以 Story Charter、Reader Promise、Scene Task 和 Chapter Bridge 维持长篇因果与连续性，写后输出带原文证据的质量 finding；
3. 在 Work、IDE 或手机端的**作品技能**区管理 Skill OS 3.5：内置 Skill 按任务自动路由，私有 Skill 可由作者或 Agent 草拟，经过正/负触发测试后发布；私有及第三方技能保留独立的固定版本，可停用或选择历史版本；内置技能新任务使用当前代码发布版，已有任务保留冻结资源。共享安装需作者确认，第三方源码必须登记许可证、归属与固定版本；
4. 输入框可附加**图片（≤6 张）与文件（≤3 个，pdf/docx/txt/md）**随提示词发送；支持多模态的模型直接接收图片像素，纯文本模型自动走安全视觉旁路，文件统一先读取再行动；对话内文件可点击打开、长文件内容默认折叠；
5. 用 **AI 封面生成**一键产出封面图（远程直链自动落盘本站）；也可以让 Agent 直接「查看当前封面」核对画面效果；
6. **一键导出**：沉浸模式工具栏、「…」更多菜单与手机端「更多」均可发起，勾选导出范围（规划/目录/章节/作品信息以及发布建议，章节可逐章自选），服务端打包 zip 直接下载，附 AI 按番茄小说官方词表生成的发布建议；也可在对话里让 Agent 按需导出（只导出指定章节、排除某部分内容）；
7. 从 Agent 标题栏进入**操作中心**：跨作品搜索、置顶或归档任务；从当前章节/运行快照 Fork 小说版本并比较、合并；启动带 Token 预算、取消和轨迹回放的调研/一致性/质量/设定子 Agent；配置定时巡检、工具权限沙箱，并比较 2–4 次真实运行的模型、推理强度、Token 与耗时；
8. 章节写完点击发布，读者端即刻可见；支持定时追更与章节管理。

### 公测 Credits

- 公测账户每天获得 **450 Credits**，在 **UTC+8 15:00** 重置；邀请奖励为独立余额，不随每日重置清零。
- 文本采用同时包含两类额度的套餐口径：**基础倍率 m=1 时，1 Credit 同时包含 10,000 输入 Token 与 1,000 输出 Token**，按两者使用比例的较大值扣费，而不是输入、输出分别相加；生图每次 6 Credits，联网搜索每次 2 Credits。
- 每位用户都有唯一邀请链接。仅新用户首次注册可领取：邀请人获得 300 Credits，被邀请人获得 120 Credits；同一新用户只能兑现一次。
- 余额低于 20% / 10% / 5% 时创作区提醒；用尽后安全停止任务，并可在 [`/account/usage`](/account/usage) 查看套餐、余额和逐笔记录。
- 缓存折扣 V2：`min(C_v1, ceil(1000 × m × ((P − H + 0.25H)/10000 + O/1000)) / 1000)` Credits。H 为确认缓存输入；普通输入/输出单价不变，单次不超过原 V1。按生效费率卡与调用前冻结快照结算，旧请求不追溯改价，未知用量待核。2026-09-08 可选倍率：极速1.1、标准1.0、性能3.0、极致3.5。审批与限制见[工程文档](./docs/ENGINEERING.md)。
- 模型只显示自身支持的推理档位；默认使用对应模型配置的强度。BYOK 文本不收平台文本 Credits，密钥加密保存、不回显；其他平台工具费用独立。

## 功能一览

- **阅读区**：书城首页（轮播、榜单、分类推荐）、书架与阅读进度云同步、沉浸式阅读器、TTS 听书
- **创作区**：Codex 风格 Work/IDE 工作区、Agent 3.5（Research Dossier、Skill OS、Story Compiler、Chapter Bridge、人类感质量门、合法技法检索、作者私有 Style DNA、前三章试制与专家盲评链路）、跨作品任务搜索/置顶/归档、分支/差异/冲突安全合并、内嵌子 Agent、定时任务、权限沙箱、运行回放、多模态附件、联网与站内调研、跨会话记忆、作品关系网、AI 封面与范围化 ZIP 导出
- **社区**：帖子与话题系统、推荐算法、评论/点赞/收藏、关注与粉丝、私信与在线状态
- **账号体系**：手机号验证码登录（腾讯云短信）、HttpOnly Cookie 会话 + Bearer 备选通道（安卓壳杀后台不掉登录）、公测 Credits 与唯一邀请奖励
- **管理后台**：数据看板、用户/作品/内容治理、内置模型与加密密钥管理、Credits 单用户与批量重置/暂停、Token 用量排行与创作任务下钻、联网/生图调用统计、移动端适配
- **安卓客户端**：Capacitor 壳加载远程站点，应用内检测更新与 APK 分发

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | React 18 · Vite 6 · TypeScript · TailwindCSS · React Query 5 · Zustand 5 · React Router 7 |
| 后端 | Express 4 · Prisma 6 · PostgreSQL · Zod |
| AI | DeepSeek 文本生成 · 智谱 GLM-4.1V 图像理解 · OpenAI 兼容图像生成 · Edge TTS 语音合成 · 博查联网搜索（多引擎降级） |
| Agent | Agent 3.5 Runtime（`api/lib/agent`）：统一 Loop、116 个受治理工具、Skill OS 3.5、Story Compiler、分层记忆、质量门、内嵌子 Agent、长任务自动续跑与防失控保护、持久化 SSE 事件流 |
| 测试 | Vitest + Supertest + Testing Library（单元、PostgreSQL 集成、真实 DOM 交互与冻结 Agent 评测；2026-09-08：161 个测试文件 / 1,885 项测试通过；覆盖率门禁） |
| 部署 | PM2 + nginx（生产）· GitHub Actions CI（push 即跑类型检查/lint/单测/集成测试）· 安卓 Capacitor 壳工程（独立仓库目录） |

## 目录结构

```
├── api/               # Express 后端（routes 路由、lib 业务模块、config 环境配置）
├── src/               # React 前端（app 壳与路由、features 业务域、components 通用组件）
├── shared/contracts/  # 前后端共享的类型契约
├── prisma/            # 数据模型 schema 与迁移、种子数据
├── tests/             # 单元、PostgreSQL 集成、UI 交互与 Chevoink-CN-Fiction-Eval
├── docs/              # 工程文档（ENGINEERING 与 DEVELOPMENT-STANDARDS，均中英文双语）
├── plan/              # 已公开的阶段方案与执行清单（不代表全部验收完成）
├── deploy/            # nginx 配置与服务器部署脚本
├── scripts/           # 部署 / 推送 / 数据清理脚本
└── public/            # 静态资源
```

## 快速开始

```bash
# 1. 使用 .node-version 指定的 Node 22.23.2 / npm 10.9.8，再安装锁定依赖
npm ci

# 2. 配置环境变量（参考 .env.example，填入数据库连接、AI Key 等）
copy .env.example .env

# 3. 初始化数据库
npm run prisma:generate
npm run prisma:migrate:deploy
npm run prisma:seed   # 可选：种子数据

# 4. 启动开发（前端 Vite + 后端 nodemon 并行）
npm run dev
```

常用脚本：

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 前后端并行开发 |
| `npm run check` | TypeScript 类型检查 |
| `npm run test` | 运行全部 Vitest 测试 |
| `npx vitest run --coverage` | 运行测试并执行本地/CI 双基线覆盖率门禁 |
| `npm run agent3:eval` | 生成带版本、Hash 与代码 SHA 的 Agent 3.5 确定性评测快照 |
| `npm run lint` | ESLint 检查 |
| `npm run build` | 生产构建 |
| `pwsh -NoProfile -File scripts/deploy-production.ps1 -ExpectedCurrentRevision <线上完整SHA> -CiRunId <CI编号>` | 已授权的同 SHA CI 维护部署（PowerShell 7） |

## 部署与发布

- **生产部署**：完整四闸、确定性 Agent 评测与双依赖审计 → 简短中文提交并推送 → 原完整同 SHA CI 成功（核心 PostgreSQL 零跳过、覆盖率原门槛不变）→ 使用上表 PowerShell 7 维护入口。先核线上 SHA 与 journal，复用同 SHA CI 门禁；发布包来自 `git archive HEAD`，在独立目录安装、构建，核对后切换并正常重启 API，验证固定 Node、进程、健康与公开资源。前一目录保留；没有自动回滚，未知外部结果先核日志与版本，不重复整段发布。
- **恢复兼容**：新局部范围、审查和技能冻结标记的任务须由理解或拒绝这些标记的应用恢复；不能直接回退至忽略它们的旧代码。旧任务保留原冻结合同、资源、价格与回执；数据库不自动下迁移，不删除成果或清零预算/账目。
- **推送 GitHub**：`powershell -ExecutionPolicy Bypass -File scripts\push-to-github.ps1`，支持 `-Tag v1.50 -ReleaseAsset <apk路径>` 打 Tag 并发布 Release（附安卓 APK）
- **安卓 APK**：由独立的 Capacitor 壳工程构建，通过应用内更新条幅 / 设置页检测更新分发

## 环境变量

所有密钥通过 `.env` 注入（数据库、会话签名、腾讯云短信、AI 服务等），模板见 [.env.example](.env.example)。模型配置的 API Key 使用 AES-256-GCM 加密落库，生产环境应单独设置 `MODEL_CONFIG_ENCRYPTION_KEY`；该密钥只能备份和轮换，不能丢失。`.env`、证书、密钥库等敏感文件均已被 `.gitignore` 排除，不会进入仓库。

## 交流群

欢迎加入 **启创墨域交流群**（QQ 群号：`158443235`），讨论使用体验、反馈问题或参与共建：

[点击加入 QQ 交流群](https://qun.qq.com/universal-share/share?ac=1&authKey=O%2Bhtn0O51Qt5fW67Pj%2BSV7v0QI1%2FESTce7xHduNryLjTadVyekW9TMJcs0Wd5Qap&busi_data=eyJncm91cENvZGUiOiIxNTg0NDMyMzUiLCJ0b2tlbiI6ImdkU3I4ckRWR1M1L3hjTklTTGxHUnVYdVJ6bFNJeXN0c2ozbk1qd0pEeXpZb0JrdkZsbVNyUGtXY3lHZUFGYXQiLCJ1aW4iOiIyNDQ5MTI5ODYyIn0%3D&data=ys8RFeB2nMSORLKaLMkGLLRE8N8WU2t9WCjktU9Dg5YogAZktMZLLLMTj5t2KvcXA8K4p4J2NLPUEV0FO9OpRw&svctype=4&tempid=h5_group_info)

## License

本项目基于 [GNU AGPL-3.0 License](LICENSE) 开源：可自由使用、修改与分发；**若作为在线服务（SaaS / 网络服务器）对外提供，须向该服务用户提供对应、可修改的源代码**。需要闭源商业化部署时，请另行取得原作者的[商业授权](./docs/COMMERCIAL-LICENSE.md)。

## 特别鸣谢

Chevoink 是独立设计与实现的开源项目。在 Agent 3.5、小说工程结构和创作区体验的演进过程中，以下优秀开源项目提供了重要参考：

| 开源项目 | Chevoink 中的参考位置 | 主要参考内容 |
| --- | --- | --- |
| [OpenAI Codex](https://github.com/openai/codex) | 写作 Agent Loop、Work 模式、任务与工具执行过程、上下文整理 | Agent-first 工作流、可追踪工具调用、长任务连续执行、上下文压缩，以及克制的工作台信息层级与可折叠侧栏思路 |
| [OpenFic](https://github.com/syrizelink/OpenFic) | IDE 模式、作品树、卷章结构、小说检索与创作 Skill | 面向小说创作的 IDE 信息架构、`卷 → 章`领域模型、面板布局持久化、章节检索流程及开放式创作能力组织方式 |
| [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) | Agent 长篇作品记忆、人物关系、事件与冲突审核 | 分层记忆、来源与版本追踪、混合召回、记忆更新和冲突治理等工程思路 |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | Work / IDE 对话区的思考过程与工具活动 UI | 推理过程的渐进披露、执行状态表达，以及工具调用记录的紧凑视觉层级 |
| [React Flow / xyflow](https://github.com/xyflow/xyflow) | 作品记忆关系图 | 直接使用 `@xyflow/react` 实现关系图的拖拽平移、缩放、视口适配、控制器和缩略图导航 |

上述项目主要用于架构研究、产品交互与工程原则参考；除项目依赖清单中明确引入的第三方软件外，Chevoink 的业务代码均结合自身技术栈与小说创作场景重新设计实现。感谢这些项目及其贡献者推动开源 Agent 与创作工具生态持续发展。
