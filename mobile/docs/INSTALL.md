# AI Bro iOS 0.1.2

这个目录的 IPA 已完成 iPhoneOS ARM64 Release 构建，但没有 Apple 开发者证书签名，不能直接点击安装。

优先安装方式：在 Xcode 打开 mobile/ios/App/App.xcodeproj，选择 App scheme，在 App、ShareExtension、TodayWidget 配置自己的 Team 和 Bundle ID，以及三者共用的 App Group，连接 iPhone 后 Run。注册自己可用的 App Group 后，需要将源码和 entitlements 中的 group.app.aibro.mobile 一并替换。保持三者一致。

如果使用外部重新签名工具，需保留两个扩展并将 Signing/ 中的 App Group 权限映射到自己的有效 App Group；仅给主二进制签名无法保证分享与小组件可用。开发者账号、个人 Team 和外部工具支持范围不同，需要在目标 iPhone 上验收。

验证记录见 verification.json，校验和见 SHA256SUMS.txt。源码、第三方归属与构建脚本位于 mobile/。
