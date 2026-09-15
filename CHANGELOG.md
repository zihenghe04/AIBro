# Changelog

## [0.7.0](https://github.com/zihenghe04/AIBro/releases/tag/v0.7.0) — 2026-09-15

### 原生桌面与交互

- 发布原生 SwiftUI / AppKit Mac 工作台，集成 WKWebView 文档与编辑界面；macOS 26 使用系统 Liquid Glass。
- 重做侧边导航、选择控件、悬浮与点击反馈，改善深浅主题、颜色层次、弹窗与页面切换。
- 项目文件树固定在阅读区左侧，支持分区调节和独立滚动；补齐文件右键“在 Finder 中显示”。
- 改进进度图表、甘特时间轴与日期轴；修复水平滚动及阅读区分隔条问题。

### 文件上下文与修改审阅

- 支持拖放、粘贴与 `@` 引用工作区资料；文件引用随会话保留，续聊与重试继续使用。
- 对话展示本轮文件修改卡片；阅读区支持 Diff、修改后源码和 Markdown 排版预览。
- 授权目录中的文本生成与修改保留前后快照，支持逐项保存、版本冲突检查及撤销。
- 增加基础 Office 文件生成与定位修改，补充文档预览、来源定位和文件处理流程。

### 项目、对话与持续工作

- 新增对话文件夹，以及对话和文件夹的重命名、移动、归档、恢复与回收站操作。
- 项目会话归入对应项目；计划文档、任务看板、排期、依赖和产出索引共同组织长期工作。
- 项目长期记忆与按日日志为后续对话提供上下文；自动任务记录执行结果和待继续事项。

### 科研 Wiki 与随记

- 将科研 Wiki 整合进科研空间，以真实 Markdown 目录组织论文、概念、方法、数据集、实验、失败经验与问题。
- 增加来源证据、双向链接、版本记录、更新合并审阅和便携导出。
- 新增随记：收集文字、链接、图片与文件，支持标签、筛选和批次整理。
- 随记可通过 AI 寻找关联、形成研究想法，并提炼任务或日程草稿。

### 日程、检索与 Agent

- 新增日程中心，支持 ICS 课表导入、重复日程、提醒，以及点击日期查看当天安排。
- 接入本地 BM25、可单独配置的向量模型、混合检索与重排，支持章节和邻域读取。
- 增加资料分批分析队列与失败恢复，展示检索范围、命中片段和来源。
- 统一文件、搜索、网页、终端和研究子代理的活动记录；增加命令审批、固定检查授权及 Skills 工作流。

### 问题修复

- 修复任务标题写法不一致时难以定位的问题：先读取实时任务目录，召回数字写法等变体，由模型选择真实任务 ID。
- 修复项目对话找不到同空间未归属任务，以及删除工具未明确暴露给模型的问题。
- 修复从执行历史打开任务详情时弹窗偶发叠加、背景内容透出的情况。
- 补齐英文项目描述、任务依赖、源码控件与原生日期轴本地化，保持用户原文不被翻译。

### 官网、文档与发行

- 重做中英文 README，以产品特色和真实操作 GIF 介绍工作方式。
- 官网加入九段独立实录，采用左右交替图文、滚动浮入、可视区循环播放与离屏暂停；修复视频比例和黑边。
- 中文提供完整产品实录，英文使用独立英文界面素材；移除画面上的常驻录制标签与播放按钮。
- 发布原生 macOS DMG / ZIP，内置 Python 与 PDF 运行时，并提供对应源码、依赖源码、构建清单和 SHA-256 校验值。

### English summary

- Native SwiftUI / AppKit desktop with system Liquid Glass on macOS 26, refined navigation and resizable reading panes.
- Persistent file context, per-turn change cards, diffs, source/preview switching, version checks and undo.
- Conversation folders, project plans, task dependencies, schedules, long-term memory and daily logs.
- Research Wiki with Markdown folders, evidence links, versions and reviewed merges; captures connected to tasks and calendar drafts.
- Calendar and ICS timetables, reminders, hybrid retrieval, resumable analysis queues, tool activity, command approval and Skills.
- Fixes for task-name variations, unassigned task lookup, deletion-tool discovery, overlapping history/task dialogs and English localization.
- New bilingual product documentation, actual ScreenCam demos, a refreshed website and bundled native Mac distributions.

Installation and checksums: [distribution guide](docs/DISTRIBUTION.md).

## Earlier versions

See the [GitHub release history](https://github.com/zihenghe04/AIBro/releases) for v0.6.5 and earlier.
