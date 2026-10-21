# AI Bro 0.9.7 开发预览版

从 [本版 Release](https://github.com/zihenghe04/AIBro/releases/tag/v0.9.7) 下载 Mac Apple Silicon 安装包。需要 macOS 14+，采用未公证的 ad-hoc 签名。

本版重点是稳定性、内存和数据安全：关闭窗口后再次打开不再空白；向量索引按需读取，检索时内存峰值大幅降低，旧索引自动迁移并保留可回退的备份；流式回答的写盘次数大幅减少，发送消息后更跟手；新增自动备份（近 7 天每日加 4 周每周）和启动时数据库自检，损坏时可从备份恢复。

本版不包含新的移动端安装包，Android 0.4.9 APK 仍在 [v0.9.4 Release](https://github.com/zihenghe04/AIBro/releases/tag/v0.9.4) 提供。详见 [更新日志](../CHANGELOG.md) 和 [安装说明](DISTRIBUTION.md)。
