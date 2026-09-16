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
