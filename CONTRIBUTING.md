# 参与改进 / Contributing

欢迎提交可复现的问题、文档与翻译建议、交互改进方案。项目仍处于 macOS 开发预览阶段，许可证与代码贡献条款正在确认中；本指南不另行指定许可证。

We welcome reproducible reports, documentation and translation improvements, and interaction proposals. AI Bro is a macOS developer preview. The project license and code-contribution terms are still being finalized; this guide does not assign a license.

## 先从一个具体问题开始 / Start with a concrete problem

在 [Issues](https://github.com/zihenghe04/AIBro/issues) 描述预期行为、实际行为和最短复现步骤。较大的流程、数据结构或依赖变更，先写明使用场景与方案，便于维护者判断范围。

For an issue, include expected behavior, actual behavior, and the shortest reproduction. Explain the use case before proposing a major workflow, data-model, or dependency change.

建议附上 / Useful context:

- App 版本、安装方式、macOS 版本与 CPU 架构。App version, installation method, macOS version, and CPU architecture.
- 涉及模型时，注明连接类型与模型名称，不提供 Key 或令牌。For model issues, include the connection type and model name, never keys or tokens.
- 合成的最小文件或脱敏日志，以及相关截图。A minimal synthetic file or redacted log, plus relevant screenshots.
- 是否涉及重启、删除恢复、同步或会话切换。Whether restarting, recovery, sync, or switching conversations is involved.

不要把真实知识库、账号会话、授权目录中的源码或私人截图附进公开问题。安全敏感问题先通过仓库可用的私密安全报告入口联系维护者；若未启用，只提交不含利用细节的联系请求。

Do not attach personal workspaces, account sessions, local source trees, or private screenshots to public reports. Use the repository's private security-reporting channel if available; otherwise request contact without publishing sensitive exploit details.

## 开发环境 / Development setup

macOS、Node.js 22+（推荐 24）、Python 3.10+。云服务测试需要带 `hashlib.scrypt` 的 Python；常规 Python 3.12 安装可作为测试环境。原生玻璃的可选工具链见 [APPEARANCE](docs/APPEARANCE.md)。

```sh
git clone https://github.com/zihenghe04/AIBro.git
cd AIBro
npm ci
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

普通 `npm start` 会使用稳定的本机工作区与桌面配置。不要把自己的生产资料当测试数据；前端 Web 调试可以使用新建的临时工作区：

A normal `npm start` uses the stable local workspace and desktop profile. For isolated web development:

```sh
AI_BRO_DEV_DATA="$(mktemp -d -t ai-bro-dev)"
AI_WORKSTATION_DATA_DIR="$AI_BRO_DEV_DATA" \
AI_WORKSTATION_PORT=0 \
python app/server.py
```

使用控制台打印的地址，并在独立浏览器配置中打开。这个命令隔离的是后端工作区，不会改变已有 Electron 配置。需要桌面 UI 验证时，沿用对应 `tests/*-smoke.cjs` 的临时 appData、临时数据目录和模拟服务方案；先阅读脚本的输入与断言。

Use the printed address in a separate browser profile. This isolates backend data, not an existing Electron profile. For desktop UI checks, follow the relevant `tests/*-smoke.cjs` harness: temporary appData, temporary workspace, and controlled services. Read its inputs and assertions first.

## 验证改动 / Validate a change

先运行与变更相关的测试，准备提交前再运行完整检查：

Run focused tests while iterating, followed by the full checks before submission:

```sh
node --test tests/your-feature.test.js
npm test
npm run test:cloud
```

`your-feature.test.js` 是占位文件名，请替换为实际测试。`npm test` 包含 Node 测试、隔离的 Python 后端测试和资源清单验证；云测试另有独立入口。不要直接导入后端测试来代替隔离运行器，服务模块可能在导入时初始化存储。

Replace `your-feature.test.js` with a real test file. `npm test` runs Node tests, isolated Python backend tests, and the asset check. Cloud tests have a separate runner. Importing backend tests directly can initialize storage before isolation is configured.

以下边界对这个项目尤其重要 / Pay particular attention to:

- **数据生命周期**：稳定 ID、归属、共享原件、回收与恢复、重启后的持久化。Stable IDs, ownership, shared originals, recovery, and restart persistence.
- **异步一致性**：切换会话、取消、旧响应、保存冲突与编辑中的草稿。Conversation switches, cancellation, late responses, save conflicts, and drafts.
- **权限**：审批方式不能扩大支持的动作或目录授权；本机项目保持只读。Approval modes must not grant new capabilities or folder access; local projects remain read-only.
- **界面**：深浅色、中文/English、窄屏、键盘和减少动效；不能只用空数据截图验收。Both themes and languages, narrow layouts, keyboard use, and reduced motion; test populated views too.
- **翻译**：只标记固定 UI 文案，不能把用户标题、正文、文件名或内部空间 ID 翻译写回。Localize fixed UI text, never persisted user content or internal workspace IDs.

## 代码与资源 / Code and resources

| 入口 / Area | 位置 / Location |
| --- | --- |
| 对话与工作区动作 / Conversation and workspace actions | `app.js`, `workstation-core.js` |
| 主笔记、阅读与检索 / Notes, reading, retrieval | `note-*.js`, `reading-pane.js`, `context-retrieval.js` |
| 原件与持久化 / Sources and persistence | `attachment-*.js`, `server.py`, `sync_store.py` |
| 桌面、凭据与材质 / Desktop, credentials, materials | `electron-main.js`, `native-api-credentials.js`, `native-glass-*`, `liquid-glass.*` |
| 自托管同步 / Self-hosted sync | `cloud_sync.py`, `cloud_server.py`, `cloud/` |
| 宣传页 / Product page | `launch/` |

新增运行资源时同步检查 `asset-manifest.json`；Web、Python 服务与打包 App 使用同一份清单。测试与演示素材不要加入应用运行清单。保持锁定依赖和第三方许可信息，涉及打包的变更也要核对发行产物中的来源身份。

Keep `asset-manifest.json` current when adding runtime resources. Do not package test or demonstration assets as app runtime files. Preserve dependency locks and third-party notices, and verify source identity when changing distribution code.

## 提交说明 / Pull requests

保持一个 PR 解决一个清楚的问题。描述触发场景、修改后的行为、验证方式和仍未覆盖的情况。UI 改动附合成数据的深浅色截图；涉及存储或协议时说明兼容旧数据的方法。

Keep each PR focused. Describe the trigger, resulting behavior, validation, and remaining gaps. Include synthetic screenshots for UI changes and compatibility notes for storage or protocol changes.

不要提交密钥、工作区数据、个人文件、运行时下载、构建 App 或原生编译产物。发布标签、版本与 GitHub Release 由维护者统一处理。

Do not commit secrets, workspaces, personal files, downloaded runtimes, built apps, or compiled native artifacts. Maintainers coordinate versions, tags, and releases.
