<p align="center">
  <a href="https://chevoink.chevolink.com">
    <img src="docs/assets/chevoink-readme-banner.png" alt="Chevoink 启创墨域 — AI writing and reading platform" width="1200">
  </a>
</p>

<h3 align="center">A spark of inspiration. A world in words.</h3>

<p align="center">
  Your AI creative partner, connecting ideas, stories, and readers.<br>
  Research, plan, write, and revise with Chevoink Agent — a home for creating novels and discovering, reading, and sharing stories.<br>
  <sub>Web · Windows · Android</sub>
</p>

<p align="center">
  <a href="https://github.com/Xcy8010/chevoink/releases"><img src="https://img.shields.io/github/v/release/Xcy8010/chevoink?label=Release&amp;color=14b8a6" alt="Latest release"></a>
  <a href="https://github.com/Xcy8010/chevoink/actions/workflows/ci.yml"><img src="https://github.com/Xcy8010/chevoink/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/Xcy8010/chevoink/stargazers"><img src="https://img.shields.io/github/stars/Xcy8010/chevoink?style=flat&amp;logo=github&amp;label=Stars" alt="GitHub Stars"></a>
  <a href="#license"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue" alt="License AGPL-3.0"></a>
  <a href="#community"><img src="https://img.shields.io/badge/QQ-158443235-14b8a6" alt="QQ group 158443235"></a>
</p>

<p align="center">
  <a href="https://chevoink.chevolink.com"><strong>Try Online</strong></a> ·
  <a href="#product-preview">Preview</a> ·
  <a href="#feature-overview">Features</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="https://github.com/Xcy8010/chevoink/releases">Download</a> ·
  <a href="#community">Community</a>
</p>

<p align="center"><a href="./README.md">简体中文</a> · <strong>English</strong></p>

---

## Product Preview

**Desktop**

<table>
  <tr>
    <td align="center"><img src="public/PCdemo1.png" alt="Desktop demo 1" width="420"><br>Bookstore & reading experience</td>
    <td align="center"><img src="public/PCdemo2.png" alt="Desktop demo 2" width="420"><br>Studio & AI writing Agent</td>
  </tr>
</table>

**Mobile**

<table>
  <tr>
    <td align="center"><img src="public/MOBILEdemo1.jpg" alt="Mobile demo 1" width="420"><br>Home & community</td>
    <td align="center"><img src="public/MOBILEdemo2.jpg" alt="Mobile demo 2" width="420"><br>Studio & reading</td>
  </tr>
</table>

## Chevoink Agent 4.0

Chevoink Agent is an AI writing partner built around your work. It helps authors research, develop story settings, plan plots, draft chapters and revise manuscripts.

- **Creative workspace**: manage works, chapters and tasks in Work, IDE and on mobile.
- **Project knowledge and skills**: write with story settings, knowledge collections and creative skills, including personal skills.
- **Review and revision**: use continuity and writing-quality checks to locate issues, revise passages and save versions.
- **Visible progress**: view model-provided thinking, tool activity and workspace changes, and review the results.

Use built-in models, custom OpenAI-compatible services, or a local connector for LM Studio and Ollama. The computer hosting a local model must stay online. See [local model setup](docs/LOCAL-MODELS.en.md).

### Runtime flow

The Agent works within the current project, chooses tools as needed, and uses actual execution results to decide the next step.

```mermaid
flowchart TD
  A[Author request or source material] --> B[Read relevant project context]
  B --> C[Select creative skills and plan steps]
  C --> D[Model advances the current step]
  D --> E{Are tools needed}
  E -->|Yes| F[Use the required tools<br/>Research / read and write / review as needed]
  F --> G[Record actual results<br/>Update context and progress]
  G --> D
  E -->|Ready to respond| H[Summarize actual results and remaining work]
  D -->|Missing information or confirmation| I[Ask the author]
  I -->|Author responds| B
  F -->|Unable to continue| J[Keep existing work and explain the blocker]
  J --> H
```

Drafts and revisions are saved through actual write operations; reviews follow the task's requirements. Chat, research and planning do not have to enter chapter writing or review. The final reply explains **what was created or changed, where it was saved, and what remains unfinished**. Execution progress is visible in the task window.

### System architecture

```mermaid
flowchart LR
  subgraph Client[Clients]
    WEB[React Web<br/>Work / IDE / Reader]
    APP[Android Capacitor]
  end
  subgraph Edge[Edge]
    NGINX[nginx<br/>HTTPS·enforced CSP·static cache]
  end
  subgraph Service[Chevoink services]
    API[Express API<br/>auth·works·community·Credits]
    LOOP[Agent 4.0 Runtime<br/>research·planning·writing·revision]
    SKILL[Skill OS 4.0<br/>creative skills·on-demand loading]
    STORY[Story Compiler<br/>Memory·Quality Gate·Craft Retrieval]
    SSE[SSE Event Stream<br/>persistence·resume·replay]
  end
  subgraph Data[Data]
    PG[(PostgreSQL<br/>schema·migrations)]
    FILES[(Managed uploads and exports)]
  end
  subgraph Providers[Providers]
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

### Continuing work and choosing models

Tasks retain project context and creative material. Use Continue to return to a paused task, and view progress and history in the task window.

Studio settings let you assign built-in or custom models and reasoning efforts to different kinds of work, globally or per novel. You can also request a model or writing-mode change in chat. Model usage and tool charges are available on the account usage page.

## Quick Navigation

| What you want | Where to go |
| --- | --- |
| Try the product now | [Live site](https://chevoink.chevolink.com) (web, no install needed) |
| Install the Android app | [Download & install guide](#download--install-android-app) · [Releases page](https://github.com/Xcy8010/chevoink/releases) |
| Windows client development | [Build instructions](desktop/windows/README.md) · [Development status](docs/WINDOWS_DESKTOP.md); internal candidate, not yet a signed public release |
| Learn how to use it | [User guide](#user-guide) |
| Explore features | [Feature overview](#feature-overview) |
| Understand Agent 4.0 | [Runtime flow](#runtime-flow) · [System architecture](#system-architecture) |
| Run it locally | [Quick start](#quick-start) |
| Understand the architecture | [Tech stack](#tech-stack) · [Directory structure](#directory-structure) |
| Deep engineering details | [Engineering Documentation](./docs/ENGINEERING.en.md) ([中文](./docs/ENGINEERING.md)) · [Development Standards](./docs/DEVELOPMENT-STANDARDS.en.md) ([中文](./docs/DEVELOPMENT-STANDARDS.md)) · [Agent evaluation guide (Chinese)](./tests/agent-evals/README.md) |
| Deploy to production | [Deployment & releases](#deployment--releases) · [Environment variables](#environment-variables) |
| Chat with us | [QQ group 158443235](#community) |

## Download & Install (Android App)

Pick either channel:

1. **GitHub Releases (recommended)**
   - Open the [Releases page](https://github.com/Xcy8010/chevoink/releases) and enter the latest version (e.g. `v1.50`);
   - Download `chevoink-vX.XX.apk` from the Assets section;
   - Tap to install. If the system warns about "unknown sources", allow "install anyway" in the dialog (the APK is signed with the release key).
2. **Direct download from the official site**
   - Visit <https://chevoink.chevolink.com/download/chevoink.apk> in a mobile browser and install directly.

No manual upgrades needed afterwards: the app checks for new versions on launch, and the in-app banner / settings page will prompt and guide the update. Web users always get the latest version by opening the live site.

## User Guide

### Readers

1. **Sign in**: phone number + SMS verification code — no registration flow; the account is created on first login;
2. **Find books**: the bookstore home offers carousels, rankings and category recommendations, plus title/author search;
3. **Read**: page-flip navigation inside the reader; tap the center to summon the menu for font size, typeface, paper theme and flip mode; reading progress and bookshelf sync to the cloud, so you can continue on another device;
4. **Listen**: enable TTS narration in the reader, with selectable voices and speeds; flip mode shows a bottom playback capsule;
5. **Interact**: comment, like and bookmark on the book detail page; post, join topics, follow authors and chat in the community.

### Authors

1. Open the **Studio** to create a work or describe your story idea to the Agent.
2. Write in the chapter editor or ask **Chevoink Agent 4.0** to help with research, settings, outlines, chapter drafts and revisions.
3. Browse built-in skills and manage personal skills in **Work Skills**.
4. Attach **images (up to 6) and files (up to 3, pdf/docx/txt/md)** to a prompt and view attachments in the conversation.
5. Create cover art with **AI cover generation**, or ask the Agent to view your current cover.
6. **Export your work** from the toolbar or More menu, choosing plans, contents, chapters and work information.
7. Search, pin or archive tasks and manage work versions and creative records in the **Agent Operations Center**.
8. Publish chapters or schedule updates through chapter management.

### Public-beta Credits

- Public-beta accounts receive **450 Credits per day**, resetting at **15:00 UTC+8**. Referral rewards live in a separate balance and survive daily resets.
- Text uses a bundled allowance: **at base multiplier m=1, 1 Credit includes both 10,000 input tokens and 1,000 output tokens**. Charging uses the larger utilization ratio instead of adding input and output charges. Image generation costs 6 Credits per invocation and web search costs 2 Credits per invocation.
- Every user gets a unique referral URL. Only a brand-new account can redeem it on first registration: the inviter receives 300 Credits and the invitee receives 120 Credits; each invitee can redeem exactly once.
- Studio warns at 20%, 10%, and 5% remaining. Exhaustion safely stops the task; [`/account/usage`](/account/usage) shows the plan, balances, and itemized ledger.
- Models expose supported reasoning efforts only and use their configured default strength. BYOK text has no platform text charge; keys are encrypted and never returned. Other platform tool fees remain separate.

## Feature Overview

- **Reading**: bookstore home (carousels, rankings, category picks), cloud-synced bookshelf & reading progress, immersive reader, TTS narration
- **Studio**: Codex-inspired Work/IDE workspace; Agent 4.0 with Research Dossier, Skill OS, Story Compiler, Chapter Bridge, human-quality gate, licensed craft retrieval, work-private Style DNA, first-three-chapter prototyping, and blind-review pipeline; cross-novel task search/pin/archive; branch/diff/conflict-safe merge; embedded subagents; schedules; permission sandbox; replay; multimodal attachments; web/in-platform research; cross-session memory; relationship graph; AI covers; and scoped ZIP export
- **Community**: posts & topics, recommendation algorithm, comments/likes/bookmarks, follows & fans, direct messages with online presence
- **Accounts**: phone + SMS-code login (Tencent Cloud SMS), HttpOnly Cookie session + Bearer fallback channel (survives Android shell process kills), public-beta Credits, and one-time referral rewards
- **Admin console**: data dashboard, user/novel/content governance, encrypted built-in-model configuration, single-user and bulk Credits reset/pause controls, token ranking with user/novel/task drill-down, web-search and image-generation call counts, mobile-friendly
- **Android client**: Capacitor shell loading the remote site, in-app update checks and APK distribution

## Tech Stack

| Layer | Technology |
| --- | --- |
| Frontend | React 18 · Vite 6 · TypeScript · TailwindCSS · React Query 5 · Zustand 5 · React Router 7 |
| Backend | Express 4 · Prisma 6 · PostgreSQL · Zod |
| AI | DeepSeek text generation · Zhipu GLM-4.1V image understanding · OpenAI-compatible image generation · Edge TTS speech synthesis · Bocha web search (multi-engine fallback) |
| Agent | Agent 4.0 Runtime (`api/lib/agent`): creative skills, project memory, chapter planning, research, review and real-time events |
| Testing | Vitest + Supertest + Testing Library (unit, PostgreSQL integration and UI interaction) |
| Deployment | PM2 + nginx (production) · GitHub Actions CI (type check / lint / unit / integration tests on push) · Android Capacitor shell project (separate directory) |

## Directory Structure

```
├── api/               # Express backend (routes, lib business modules, config)
├── src/               # React frontend (app shell & routes, feature domains, shared components)
├── shared/contracts/  # Type contracts shared by frontend & backend
├── prisma/            # Data model schema, migrations, seed data
├── tests/             # Unit, PostgreSQL integration, UI interaction, Chevoink-CN-Fiction-Eval
├── docs/              # Engineering docs (ENGINEERING & DEVELOPMENT-STANDARDS, both bilingual)
├── plan/              # Design proposals and roadmap
├── deploy/            # nginx config & server deployment scripts
├── scripts/           # Deployment / push / data cleanup scripts
└── public/            # Static assets
```

## Quick Start

```bash
# 1. Use pinned Node 22.23.2 / npm 10.9.8, then install locked dependencies
npm ci

# 2. Configure environment variables (see .env.example; fill in DB connection, AI keys, etc.)
copy .env.example .env   # or: cp .env.example .env on Unix

# 3. Initialize the database
npm run prisma:generate
npm run prisma:migrate:deploy
npm run prisma:seed   # optional: seed data

# 4. Start development (Vite frontend + nodemon backend in parallel)
npm run dev
```

Common scripts:

| Command | Description |
| --- | --- |
| `npm run dev` | Frontend + backend parallel development |
| `npm run check` | TypeScript type check |
| `npm run test` | Run tests (Vitest) |
| `npx vitest run --coverage` | Run tests with local/CI dual-baseline coverage gates |
| `npm run agent3:eval` | Emit a versioned Agent 4.0 deterministic eval snapshot with hashes and code SHA |
| `npm run lint` | ESLint check |
| `npm run build` | Production build |
| `pwsh -NoProfile -File scripts/deploy-production.ps1 -ExpectedCurrentRevision <full-live-SHA> -CiRunId <CI-run-ID>` | Authorized same-SHA CI deployment through PowerShell 7 |

## Deployment & Releases

- **Web/API**: use the `scripts/deploy-production.ps1` entrypoint above with the full live SHA and a passing CI run for the candidate commit. See [engineering](docs/ENGINEERING.en.md) and [cloud development](docs/CLOUD-DEVELOPMENT.md) for configuration.
- **Android**: build the separate Capacitor shell project and distribute APKs through [Releases](https://github.com/Xcy8010/chevoink/releases).
- **Windows**: see the [Windows client guide](desktop/windows/README.md) for development and packaging.

## Environment Variables

All secrets are injected via `.env` (database, session signing, Tencent Cloud SMS, AI services, etc.); the template is at [.env.example](.env.example). Model API keys are encrypted at rest with AES-256-GCM. Production must use a dedicated `MODEL_CONFIG_ENCRYPTION_KEY`; back it up and rotate it deliberately, because losing it makes stored keys undecryptable. Sensitive files such as `.env`, certificates and keystores are excluded by `.gitignore` and never enter the repository.

## Community

Join the **Chevoink community group** (QQ group: `158443235`) to discuss the experience, report issues or contribute:

[Join the QQ group](https://qun.qq.com/universal-share/share?ac=1&authKey=O%2Bhtn0O51Qt5fW67Pj%2BSV7v0QI1%2FESTce7xHduNryLjTadVyekW9TMJcs0Wd5Qap&busi_data=eyJncm91cENvZGUiOiIxNTg0NDMyMzUiLCJ0b2tlbiI6ImdkU3I4ckRWR1M1L3hjTklTTGxHUnVYdVJ6bFNJeXN0c2ozbk1qd0pEeXpZb0JrdkZsbVNyUGtXY3lHZUFGYXQiLCJ1aW4iOiIyNDQ5MTI5ODYyIn0%3D&data=ys8RFeB2nMSORLKaLMkGLLRE8N8WU2t9WCjktU9Dg5YogAZktMZLLLMTj5t2KvcXA8K4p4J2NLPUEV0FO9OpRw&svctype=4&tempid=h5_group_info)

## License

This project is open-sourced under the [GNU AGPL-3.0 License](LICENSE): free to use, modify, and distribute. **If you provide it as an online service (SaaS / web server), you must offer the corresponding, modifiable source code to that service's users.** Closed-source commercial deployment requires a separate [commercial licence](./docs/COMMERCIAL-LICENSE.md) from the original author.

## Special Thanks

Chevoink is independently designed and implemented. The following open-source projects provided important references during the evolution of Agent 4.0, the novel domain model, and the Studio experience:

| Open-source project | Referenced area in Chevoink | What we learned from it |
| --- | --- | --- |
| [OpenAI Codex](https://github.com/openai/codex) | Writing Agent Loop, Work mode, task/tool execution, context organization | Agent-first workflows, traceable tool calls, continuous long-running tasks, context compaction, restrained workspace hierarchy, and collapsible sidebars |
| [OpenFic](https://github.com/syrizelink/OpenFic) | IDE mode, work tree, volume/chapter structure, novel retrieval, and writing Skills | Novel-focused IDE information architecture, the `Volume → Chapter` domain model, persisted panel layouts, chapter retrieval flows, and open-ended writing capabilities |
| [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) | Long-form Agent story memory, character relationships, events, and conflict review | Layered memory, provenance and revision tracking, hybrid retrieval, memory updates, and conflict-governance patterns |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | Reasoning and tool-activity UI in Work / IDE | Progressive disclosure of reasoning, execution-state communication, and compact visual hierarchy for tool-call history |
| [React Flow / xyflow](https://github.com/xyflow/xyflow) | Story-memory relationship graph | Chevoink directly uses `@xyflow/react` for viewport panning, zooming, fit-to-view, controls, and minimap navigation |

These projects primarily informed architecture research, product interaction, and engineering principles. Except for third-party software explicitly declared in the dependency manifests, Chevoink's business code is redesigned and implemented for its own stack and novel-writing use cases. Our sincere thanks go to their maintainers and contributors for advancing the open-source Agent and creative-tool ecosystem.
