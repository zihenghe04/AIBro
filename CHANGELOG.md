## 0.7.4 — 2026-09-17

- 修复较大工作区启动时一直显示“正在启动本地工作区”的问题：旧启动路径将完整执行记录写入 WebView 缓存，超出容量后未继续完成加载。
- Mac 原生版以本地数据库为准，不再将完整工作区重复写入临时浏览器缓存；保留全部资料、对话和执行记录。
- 浏览器缓存不可写时，仍可完成从本地服务的加载、关系修复与冲突恢复；数据库保存和修订号检查保持有效。
- 增加大工作区、缓存超限与完整数据库保存回归；本机启动诊断仅记录版本、就绪状态和数量，不包含资料正文或凭据。

## 0.7.3 — 2026-09-17

### 对话上下文与按需检索

- 对话先提供空间、项目和资料类型的轻量概览；不再默认检索并塞入 20 段知识库正文。
- Agent 可自行选择不检索，或分批搜索、改写查询、读取原文、相邻片段和 PDF 页面；保留已有 embedding，继续使用向量与 BM25 混合检索。
- 搜索按单次上下文预算分页，取消默认的累计读取轮数上限；通过来源分散排序减少长文档的连续片段占满前排结果。
- 操作规则按需加载；“查课程要求并设置提醒”可以先取得证据再生成操作，保留现有来源、权限和范围校验。
- 长对话支持带原消息来源的增量摘要、历史搜索和分页原文读取；完整对话保留，过时摘要会失效。
- 读取过程保留工作摘要和完整账本，移出上下文的证据可以再次读取；重复请求仍会检测并停止无进展循环。
- 界面区分等待模型响应、模型思考和接收结果，不再将网络等待全部显示为思考。
- 修复 Mac 原生版向量索引依赖临时 WebView 存储的问题，改为工作区 SQLite 持久保存，重启后继续增量更新。

### 日程

- 可直接从对话生成单次或重复日程提案，例如每周四 14:30 的组会，并保留会议号。
- 日程在原生编辑器确认后保存；未指定结束时间时明确显示默认 1 小时时长供调整。

### English

- On-demand knowledge retrieval with a compact library map, existing hybrid embeddings/BM25 search, budgeted pagination and no default productive-read round limit.
- Progressive loading of operation schemas, recoverable conversation history, source-validated compaction checkpoints and durable read ledgers.
- Direct conversational recurring-event proposals, reviewed and saved in the native calendar.

## 0.7.2 — 2026-09-16

- Mac 总览「今天与接下来」和日常、课程、科研的任务列表支持直接点击左侧圆圈完成任务；点击任务文字仍打开详情。
- 已完成任务显示勾选圆圈，可再次点击恢复为待开始；同步更新完成时间、待办数量、空间进度和系统提醒。
- 完成与恢复操作按目标状态执行，连续点击同一按钮不会误切换回原状态。
- 保留 0.7.1 的对话提醒、逐任务提醒设置与跨端提醒参数同步。
- 验证：原生任务操作桥接回归、Swift 编译，以及独立测试 App 的系统通知送达、改期和完成后撤销验证。

## 0.7.1 / iOS 0.1.3 — 2026-09-16

### 日程与任务提醒

- 对话中的明确提醒请求支持到点提醒，例如“明天晚上 8 点提醒我买熨斗、洗衣液、护发素、袜子”；购物清单保留在一条任务中。
- 任务可单独选择到点、提前 15 分钟、1 小时、1 天或关闭提醒；未单独设置的任务使用本机统一设置。
- Mac 首次允许通知时开启普通任务提前 1 小时提醒；仅填写日期的任务按本地当天 09:00 计算。
- 创建或修改任务时若提前时间已过、截止时间未到，改为到点提醒；已完成、删除或改期的任务会更新系统待投递通知。
- iOS / Web 使用同一任务提醒字段，手机端明确时间提醒可直接从对话创建。提醒参数随任务同步，系统通知权限仍由各设备设置。

### 本轮累计改进

- 总览按空间显示待办、今日、逾期与后续任务，并保留原有渐变主视觉。
- Agent 支持将重复附件移入回收站；改进重复检索处理、任务依赖与资料读取。
- Finder 查看附件时使用可识别的原始文件名和扩展名。
- Mac 同步服务器配置可修改，增加 SSH 同步部署配置与数据路径说明。
- 网页版课程助手可独立连接学校账号，无需先连接云同步；完善浏览器持久化、私有网络与跨域提示。

# Changelog

## iOS 0.1.2 — 2026-09-16

- 发布移动端完整源码、iPhoneOS ARM64 安装包、分享扩展和日程小组件；提供构建、签名与跨设备连接说明。
- 明确区分云同步密码、SSH 服务器密码和学校账号密码；密码不匹配与会话失效分别给出可执行提示。
- 延续 0.1.1 的 Tailscale 私有连接修复：私有域名使用直连会话并保持 HTTPS 证书校验；区分 DNS、连接、TLS 和超时错误。
- 提供手机端随记、项目与知识阅读、Markdown 编辑及 AI Diff 审阅、任务与日程、国科大课程助手。学校登录和签到已由用户验证可用。
- 补齐源码中的 Mac 原生日程适配器，支持移动日程格式、重复规则、持久化基线和冲突处理；原有 0.7.0 Mac 二进制保持不变。
- 官网新增 iOS 介绍、下载入口和 3 张独立模拟器实截图；中文与英文 README 增加移动工作流说明，全部截图使用虚构数据。
- 验证：31 项移动端业务与协议测试通过；iPhoneOS Release archive 和 IPA 结构校验通过。

### English

- Publish the iOS source, ARM64 IPA, share extension and widget, plus signing and sync documentation.
- Clarify cloud-sync credentials and distinguish rejected passwords from expired sessions; retain the private-network TLS routing fix.
- Introduce iOS workflows on the website and in both READMEs. All three Simulator screenshots use isolated fictional data.
- Add the Mac agenda adapter source for mobile recurrence and conflict handling. Existing Mac release binaries are unchanged.


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
