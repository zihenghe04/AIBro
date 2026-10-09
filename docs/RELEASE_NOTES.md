## 0.9.3 — 2026-10-09 · Mac 预览版

- 日程创建遵循当前会话的审批设置：信息明确且已获自动审批时直接保存，需要补充时间或明确要求审阅时保留确认。
- 多条日程可批量勾选、一次保存，也可逐条编辑；审阅完成后留在原对话。
- 修复追问后重复生成相同日程提案的问题，正确显示已保存数量，保留人工修改。

Apple Silicon / macOS 14+ 开发预览版，尚未 Apple 公证。安装包、对应源码、依赖源码及 SHA-256 校验文件附在发布页。

**English:** Calendar creation now follows the conversation's approval setting. Review and save multiple events together, or edit them individually without leaving the chat. Repeated proposals in the same conversation recognize existing events instead of creating duplicates.

## 0.9.2 — 2026-10-04 · Mac 预览版

- 可直接让 AI Bro 删除指定项目。Agent 会查询当前项目，再按照会话权限提交删除计划；默认需要在审批卡确认。
- 项目与所属内容移入可恢复回收站，其他项目的成果、共享原件、本机目录和真实日程保留。发起操作的对话继续可用，结果可直接打开回收站查看。

**English:** Ask AI Bro to delete a project. It checks the live project directory and follows the conversation's approval setting. Projects and their owned contents go to recoverable trash; shared originals, other projects, local folders and calendar events are retained.

## 0.9.1 — 2026-10-04 · Mac 预览版

- 修复首次启动没有灵动岛的问题：未设置过入口时默认显示顶部灵动岛，已手动关闭的偏好仍会保留。
- 在「设置 → 界面偏好」加入「灵动岛与快捷入口」，可直接开关、选择位置及进入详细设置；重新启用会恢复上次的位置。

随 AI Bro 启动与登录 Mac 时启动分别设置。此次不改变登录项、麦克风、摄像头、剪贴板或外部通知权限。

Apple Silicon · macOS 14 及以上。开发预览，使用 ad-hoc 签名，尚未 Apple 公证。完整 VoiceOver、多显示器、不同音频设备及超大资料库仍需更多覆盖。

本版包含 [0.9.0 的全部改进](https://github.com/zihenghe04/AIBro/releases/tag/v0.9.0)。安装与校验见 [安装说明](https://github.com/zihenghe04/AIBro/blob/v0.9.1/docs/DISTRIBUTION.md)。官网与宣传片保持已有设计。

**English:** Dynamic Island now appears on first launch unless you previously turned it off. A new Appearance settings section exposes the on/off control, entry location and detailed preferences. Enabling it restores the last location without changing login or privacy permissions.
