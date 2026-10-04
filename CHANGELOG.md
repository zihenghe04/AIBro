## 0.9.1 — 2026-10-04 · Mac 预览版

- 首次启动默认显示灵动岛；保留主动关闭的偏好。
- 主设置加入灵动岛开关、显示位置和详细设置入口，重新启用时恢复上次的位置。

## 0.9.0 — 2026-10-04 · Mac 预览版

- 灵动岛集中处理待办、日程、随记、录音、剪贴板和文件暂存；补充同岛文件预览与 Spotify 启动状态，改善展开、滚动和返回。
- 对话按真实顺序展示模型返回的思考、中途回复及工具输入输出，可展开核对；长回复减少重复渲染，向上阅读时保留位置和选区。
- 改善已保存资料的检索、来源跳转、课程整理和科研笔记复用，修复日程查询与时区参数兼容问题。
- 修复分叉成果相互覆盖、排队补充可能丢失、协议选项未保存和多请求用量统计不完整等问题。
- 语音指令与录音共用可配置的语音服务，支持确认、取消及回到处理对话；API 凭据保存在本机加密存储。

## 课程任务短片更新 — 2026-10-03

- 优化灵动岛待办、课程任务与检查清单之间的衔接，更新真实任务详情画面。沿用 84 秒时长与已选配乐，本次不替换 App 下载包。

## 资料查询短片更新 — 2026-10-03

- 优化中英文宣传片的资料查询与原文核对流程，让回答、引用和原文表格的衔接更清楚。沿用 84 秒时长与已选配乐，本次不替换 App 下载包。

## 官网场景展示 — 2026-10-03

- 新增课程、研究、随记三组实际成果展示，可放大原图并跳到对应影片章节。
- 改善中英文窄屏布局、键盘导航与图片加载反馈。沿用 84 秒宣传片，本次不替换 App 下载包。

## 文案与宣传片改版 — 2026-10-02

- 优化片头说明与原文核对的衔接，减少字幕切换，保留完整操作和已选配乐。
- 改写中英文官网与 README，直接说明课件阅读、笔记编辑、资料查询和日程等用途。
- 重做 84 秒短片的功能说明、运镜和转场，换用轻快配乐；公开对应动画源码与虚构演示素材。本次不替换 App 下载包。

## 工作流短片更新 — 2026-10-02

- 重做为 84 秒中英文工作流短片，串起课件导入、AI 处理、文档审阅、日程、研究回溯与灵动岛。
- 官网与 README 更新视频、海报、章节跳转和下载。仅使用虚构资料；画面为开发预览，公开 App 下载仍为 0.8.0。

## 产品宣传片 — 2026-10-01

- 新增 React + Remotion 制作的 42 秒中英文产品宣传片，使用真实 App 画面、文字动效与原创配乐。
- 官网增加独立影片舞台、章节跳转与下载，公开可复现的动画工程。

## 官网与文档更新 — 2026-10-01

- 恢复大幅首屏与交错工作流布局，使用 0.8.0 原生 App 的真实截图和虚构演示资料。
- 新增阅读、编辑审阅、日程三组动图与工作流短片，支持放大、暂停和中英文浏览。
- 更新中英文 README，改善窄屏排版、媒体加载和辅助文字可读性。本次为官网与文档更新，App 版本仍为 0.8.0。

## 0.8.0 — 2026-10-01 · Mac 预览版

- 统一项目中的对话、资料、成果、任务与排期入口，改进文件夹层级、来源返回和成果查找。
- 扩展 PDF 阅读与 Markdown 写作：可调阅读区、多文档标签、可视与源码编辑、图片、公式、表格及会话内连续撤销。
- 完善文件差异与草稿审阅：按文件保留视图和阅读位置，支持并排查看、长行换行与逐块处理，保存后继续编辑。
- 改进对话输入、执行过程、来源核对和失败重试，减少长对话刷新与阅读区拖动的重复计算。
- 完善课程资料整理、科研 Wiki 草稿审阅、任务与日程保存，保留来源、历史和冲突保护。
- 改善本地加密凭据与自托管同步的配置和状态说明；SSH 用于推送、拉取工作区内容。

同时重整中英文 README、安装说明与官网页面，补强原生发行的对应源码完整性检查。此处记录版本内容，不表示安装包已上传或官网已部署。

**预览边界：** 面向 Apple Silicon Mac、macOS 14 及以上，采用 ad-hoc 签名，尚未 Apple 公证。完整 VoiceOver、输入法和超长文档/大资料库场景仍未全部覆盖；Markdown 可视编辑仅覆盖支持的结构，完整源码模式继续保留。SSH 不提供远端文件管理或 Agent 执行。具体安装与限制见 [安装说明](docs/DISTRIBUTION.md)，版本摘要见 [0.8.0 发布说明](https://github.com/zihenghe04/AIBro/blob/v0.8.0/docs/RELEASE_NOTES.md)。

**English:** Mac preview with clearer project navigation, a richer document workspace, persistent review views, and improved research, task and sync workflows. Apple Silicon / macOS 14+; not Apple-notarized. Accessibility and large-workspace coverage remain incomplete.

## 0.7.9 — 2026-09-17

- 按需加载操作能力时直接返回完整字段与约束，并明确当前已加载能力，避免只有“已加载”回执导致模型反复索要同一操作说明。
- 明确 OpenAI 账号连接中的 AI Bro 操作协议：模型可提交读取请求与操作提案，进度说明与实际执行的最终 JSON 分开处理。
- 保留无进展循环保护；重复请求操作说明时展示具体能力名称，便于区分能力加载与资料读取问题。
- 支持 YAML、YML 和 TOML 附件文本解析；旧版已保存但未提取文字的此类附件，再次使用时可直接读取原件，无需重新上传。

## 0.7.8 — 2026-09-17

- 修复课程 CSV 导入混用电脑时区与课表时区的问题：学期首日、周次与星期判断统一使用课表时区，避免北京时间周一在 UTC 电脑上被误判为周日。
- 日期选择器与导入校验使用同一课表时区；修改日期或时区后重新生成预览。
- 日程核心测试固定覆盖 UTC、上海与洛杉矶三种系统时区，防止仅在开发机通过、在 GitHub 构建中失败。

## 0.7.7 — 2026-09-17

- 修复公开飞书思维笔记链接反复重定向、无法读取的问题：下载期间保留匿名访客 Cookie，并从页面提供的结构化数据提取笔记层级与正文。
- 链接不可读取时明确记录失败原因，继续处理同条消息中不依赖该链接的请求；不再直接终止整个对话，也不将未读取的网页冒充资料。
- 新对话沿用最近一次选择或使用的服务提供方、模型与推理强度，重启后仍保留；已有对话和正在执行的请求保持自己的配置。
- 连续点击“新对话”复用同一空间、项目中的空白会话，避免生成多条空记录；保留已有消息、草稿、附件和文件引用。

## 0.7.6 — 2026-09-17

- 修复对话中建议日程卡片的标题贴边、引用缩进不一致和按钮布局问题。
- 分开显示日程名称、时间、时区与重复说明，统一卡片内边距；长标题和引用可自然换行。
- 窄窗口自动将审阅按钮移到卡片下方，深色模式保持按钮文字清晰。
- 保留日程审阅、保存、打开已有日程及重复规则。

## 0.7.5 — 2026-09-17

- 修复使用支持联网搜索的模型时，明确的重复日程请求仍被误送入完整上下文流程的问题。模型具有联网能力，不再等同于当前请求需要联网。
- 每周组会等信息明确的请求直接生成待审阅日程，保留时间、每周重复规则和会议号；实际需要查资料的混合请求继续按需检索。
- 明确日程提案的独立输出字段，修复模型将提案嵌套进任务动作后回退的问题；格式修复或补充上下文时继续保留日程能力说明。
- 能力说明以当前运行环境为准，避免沿用历史对话中旧版本“不支持重复日程”的答复。
- 验证涵盖旧拒绝回复、支持联网的模型、混合检索与重复日程、格式回退，以及原生编辑器保存和每周日程展开；使用真实模型与虚拟资料验证生成结果。

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
