# 路线图逐项验收

复核日期：2026-09-15。当前未暂缓项均有实现路径与对应验证。此页记录本机产品范围，不把真实模型分析质量、硬件手势体验或企业部署当成已验证结果。

## 最新安装与回归

- 本机正式 App 代码检查点：`90df7d2`，2026-09-15 11:15 更新并重启就绪。
- 默认测试：1072 项 JavaScript 检查通过，3 项旧 Electron 扩展检查跳过；25 组后端检查通过（含已有条件跳过）；135 项资源契约通过。
- 原生检查：Swift 凭据兼容、日程核心/存储、桥接集成与完整隔离工作流通过。模型替身只验证执行和持久化，不代表真实模型质量。
- 安装签名、原生二进制和资源一致；原有 298 条实体、42 份原件、日程存储保持一致。
- 回退应用与数据：`../.aibro-baselines.noindex/before-roadmap-hardening-20260915-111520/`。

## 功能与证据

| 需求 | 实现入口 | 验证证据 |
|---|---|---|
| 项目会话、文件夹、重命名、归档与恢复 | `native/Resources/conversation-library.js`、`ConversationLibrary.swift`、`conversation-web.js` | conversation-library / project-conversation 测试；原生隔离工作流 |
| 拖拽、粘贴、@ 文件引用，续聊及重试保留输入 | `file-context.js`、`file-context-ui.js`、`conversation-continuity.js` | file-context / attachment-context / conversation-continuity 测试；实际文件选择和发送流程 |
| 文件身份、授权目录、版本与长文件分页 | `local_projects.py`、`file-context.js`、`knowledge-access.js` | local-projects / local-file-context / knowledge-access；真实文件系统 |
| 文件生成、修改、新建目录、Diff、保存及撤销 | `local_file_edits.py`、`local-file-edits.js`、`note-editor.js` | local-file-edits / file-review / note-editor；原生保存、冲突及原字节撤销 |
| Markdown 源码与预览、PDF / 图片、基础 Office 读写 | `note-editor.js`、PDF 预览服务、`office_documents.py` | Office 独立读取器验证；PDF/Office 后端；原生 Word 保存/读取/撤销 |
| Finder 定位及左侧项目文件树 | `NativeDesktop.swift`、`local-projects-ui.js`、`workspace-layout.js` | 原生 Finder 选中、阅读区与布局检查 |
| 统一工具日志、停止、失败与超时 | `tool-scheduler.js`、`terminal-tools.js`、`agent-progress.js` | tool-scheduler / terminal-tools；真实进程、取消、超时与失败恢复 |
| 联网搜索、网页读取及只读研究子代理 | `tool-scheduler.js`、`knowledge-access.js`、`agent-transport.js` | URL / web-search / tool-scheduler；隔离子模型循环及取消传播 |
| 权限模式、具体命令审批与有限白名单 | `terminal-tools.js`、本机命令服务 | local-commands 后端；原生审批后执行、归属与参数校验 |
| 项目计划、看板、依赖、排期与产出 | `project-memory.js`、`project-board.js`、`AgendaView.swift` | project-memory / project-board / task-dependencies；原生状态变更及持久化 |
| 项目长期记忆、按日日志、下一次继续读取 | `project-memory.js`、`app.js` | project-memory；原生新对话读取、草稿采纳与 Markdown 回读 |
| Skill、自动任务、持久化与重启恢复 | `skills-core.js`、`project-automation.js`、`project_jobs.py` | skills-core / project-jobs；实际任务表单、租约、Agent 调度与日志 |
| 课程表导入、日程详情、循环及时区 | `AgendaCore.swift`、`AgendaStore.swift`、`AgendaImportView.swift` | 原生 agenda core/store；日程隔离流程。系统通知不在合成测试中申请权限 |
| Wiki 文件目录、类型化科研记忆、原件与实体 Markdown | `research-wiki.js`、`wiki_vault.py`、`wiki_migration.py` | research-wiki / wiki-vault / wiki-migration；物理目录迁移与新对话读取 |
| Wiki 链接、版本、人工编辑/合并/删除、便携导出 | `wiki_links.py`、`wiki-merge.js`、`wiki_bundle.py` | wiki-maintenance / wiki-merge / wiki-bundle；原生移动链接修复、审阅采纳和 ZIP |
| 随记文字/链接/图片/文件，批次整理与研究想法 | `capture-notes.js`、`research-wiki.js` | capture-notes；原生上传、筛选、批量整理、实验提案与原文保留 |
| 随记任务/日程联动与来源回链 | `capture-agenda.js`、`agenda-proposals.js`、`AgendaQA.swift` | agenda-proposals；实际草稿、循环事件保存、幂等及双向导航 |
| BM25 / 可选向量、配置、手动与自动更新 | `context-retrieval.js`、`vector-index.js`、`vector-knowledge-ui.js` | indexed-retrieval / vector-index / context-retrieval；实际本地检索试验 |
| WeKnora 借鉴：章节、邻域、知识检查及真实关系 | `research-inspector.js`、`wiki-maintenance.js`、检索模块 | research-inspector / knowledge-access；原生查找、邻域、零结果及来源关系 |
| 百篇资料的分项目队列、失败暂停和可恢复结果 | `research-queue.js` | 101 份来源分批测试；原生真实 Agent 调度与结果持久化（模型替身） |

表中 Swift 源码均在 `native/Sources/AIBro`，其余实现默认在 `app`。测试在 `tests`；原生综合流程为 `native/Resources/qa-workflow.js`、`WikiQA.swift` 和 `AgendaQA.swift`。

## 本次补齐的边界

1. 刷新项目计划时优先维护待审阅副本，仅替换自动任务索引，保留草稿说明、来源和完整前一版。已批准正文不被覆盖；用户移除索引后不自动加回。更新幂等，任务标题中的 `$&` 等字符按字面保留。
2. 资料队列按项目检查分析产物；别的项目的笔记、不可读 Wiki、已移走资料、草稿已撤销的来源和无关旧草稿不算本批产出。队列弹窗会刷新持久状态，不必反复关闭重开。
3. 默认 `npm test` 纳入此前遗漏的全部 `.test.cjs` 原生桥接测试。补可见性事件回归，并增加 `npm run test:native` 执行 Swift 日程、存储、凭据及原生集成检查。

## 验收边界与暂缓项

- SQLite 只读查询、音视频解析：用户要求暂缓。
- App 关闭后的系统守护任务、企业多用户部署、默认额外付费重排、大规模推断关系图、静默合并/删除：沿用既定暂缓决定。
- Office 仅基础生成、定位文字/非公式单元格修改，非完整版式编辑器；PDF 可读与预览，不改写原始 PDF。
- 模型环节用隔离替身验证实际调度、权限、文件和持久结果；没有向外部模型发送用户材料，不能据此声称真实推理质量已验收。
- 日程轨迹滚动条已验证；物理触控板手势仍需实际设备使用确认，见 [TIMELINE_SCROLL_QA.md](TIMELINE_SCROLL_QA.md)。
- 本页的“实现完成”不等于以后不会出现缺陷；新问题继续按回归修复处理，不将暂缓项偷偷改成完成项。
