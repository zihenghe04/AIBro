# AI Bro for iOS · 0.1.2

把科研、课程和生活带在身边。手机用来随手记录、查看安排、阅读知识和继续讨论；电脑继续承担长任务与复杂文件工作。

## 已加入本轮实现

- **今天**：日期切换、任务截止时间、日程详情、课表 ICS 导入、提醒开关。支持重复课表、排除日期和导入预览。新增 Mac 原生日程双向适配，保留重复规则、取消/恢复和并发冲突。
- **随记**：文字、链接、文件、拍照入口；草稿离线保留；选中随记交给 AI 整理。系统分享扩展接收 Safari、照片、文件中的资料。
- **知识与项目**：科研 Wiki 按目录展开与搜索，Markdown 预览/源码编辑，项目任务和项目对话。
- **带资料的对话**：引用笔记、附件文字与项目记忆；模型连接独立配置；回答可保存为笔记。
- **修改审阅**：AI 先生成草稿，逐行 diff 与排版预览，用户采纳后才替换正文；保留旧版本，原文变化时阻止覆盖。
- **本机文件能力**：Quick Look 原件预览、文件分享导出、PDF 文本提取、图片文字识别（Vision）。Office 原件交给系统预览。
- **国科大课程助手**：SEP 邮箱 / 轻新课堂学号登录、今日课程与当前/下一节判断、手动到课签到、校时动态二维码、今日前台自动签到（默认关闭）、课前提醒、课程加入日程。学校会话与模型凭据隔离；可选择在本机钥匙串记住密码，在明确失效时恢复连接。
- **桌面小组件**：iOS 小、中、大三种尺寸，显示课程和日程，点击回到 App；使用 App Group 分享最近一次刷新的快照，不共享学校会话。
- **完整备份**：ZIP 同时打包记录与附件原件，恢复前验证全部文件哈希；仍可导入旧版 JSON 记录备份。
- **跨设备协议**：复用桌面端 protocol v1 的笔记、随记、项目、任务、对话、文件同步；离线队列、原件哈希校验、断线幂等重试和显式冲突处理。

## 技术结构

`src/` 是独立的移动业务核心和页面，Vite 构建后随应用打包，Capacitor 8 提供 iOS 容器。手机不运行桌面 Python 服务。

`ios/App/App/WorkspaceDatabase.swift` 用 SQLite 原子保存内容、游标和未确认操作；`MobileBridge.swift` 提供 Keychain、URLSession、Quick Look、PDFKit、Vision；`ios/App/ShareExtension/` 是独立系统分享扩展，通过 App Group 收件箱交付资料。分享清单在附件完成后才落盘，主 App 持久化导入后才确认清理。

密码与 token 不进入工作区备份/同步记录，原生桥接日志已关闭。模型只收到显式引用的资料及当前项目记忆；学校会话不进入模型上下文。浏览器预览只在内存保存临时凭据。

## 开发运行

需要 Node 22+、完整 Xcode 和已安装的 iOS Simulator runtime。最低部署目标 iOS 16。

```sh
cd mobile
npm ci
npm run dev
# http://127.0.0.1:8899
```

`?demo=1` 使用独立浏览器数据库和虚构演示数据，禁止连接真实同步账号。普通预览不自动装入样例。

```sh
npm run ios:sync
npm run ios:open
```

在 Xcode 中选择 App scheme 和 iPhone simulator。真机运行需要在 **App、ShareExtension、TodayWidget 三个 target** 选择自己的签名 Team，配置可用 Bundle ID，并为三者启用相同 App Group。源码目前使用 `group.app.aibro.mobile`，更改标识时需要同步修改所有使用该标识的 Swift 文件与 entitlements。不要把个人签名凭据提交到 Git。

```sh
npm test                       # 业务、真实隔离云服务、桌面存储往返
npx playwright test            # 手机视口与操作流程，需要本机 Chrome
xcrun swiftc ios/App/App/WorkspaceDatabase.swift tests/native-storage.swift -o /tmp/aibro-storage-test
/tmp/aibro-storage-test         # 实际 SQLite 重启与持久化
./scripts/check-native.sh      # 完整 iOS simulator 构建
```

云协议集成测试使用临时目录及随机 loopback 端口，自动寻找支持 `hashlib.scrypt` 的 Python 3.11+，不会使用真实账号或已有工作区。

完整逐项核对见 [交付验收表](docs/ACCEPTANCE.md)。

## 当前验收状态（2026-09-16）

- iOS 0.1.2：31 项业务与协议测试通过；完整 iPhoneOS ARM64 Release 构建通过，包含分享扩展和小组件。
- 网络修复已通过 6 项原生 XCTest，包含 Tailscale 私有 HTTPS 连通性验证。0.1.2 在此基础上区分云同步密码错误与登录会话失效。
- 学校账号登录与签到已经用户实际验证；模拟器中的登录、课程与同步设置可操作。
- 官网图片来自独立 iOS Simulator，只使用虚构的任务、课程项目和随记，无真实账号或资料。
- 编译、协议测试和模拟器验收不代表全部真机能力已验收；相机、通知送达、分享扩展、后台恢复及真实双端全量同步继续按 [验收表](docs/ACCEPTANCE.md) 核对。

## 后续收尾

1. 完成原生界面交互验收，再做 iPhone 签名安装；模拟器启动与原生桥接基础已通过。
2. 验收相机、照片、系统分享、文件预览、OCR、通知权限/送达及 Keychain 重启保留。
3. 学校登录和手动签到已验证；继续核对课程提醒及会话恢复。无需把学校密码交给开发者。
4. 验收手机与配套 Mac 构建的真实双端日程操作。双向适配、持久化基线与冲突选择已实现；27 项测试中包含与 Swift 原生引擎的时间结果对照，尚未把这些测试当作真实双端界面验收。详见 [日程衔接](docs/DESKTOP_AGENDA_SYNC.md)。
5. 真机验证后台恢复同步与大资料阅读体验。完整 ZIP 备份现已包含附件原件。

桌面终端、长时间后台 Agent、SQLite 资料查询和音视频解析保留在桌面工作流。iOS 自动签到明确限于用户当天开启后的前台执行，锁屏/后台不承诺准点运行。

开源归属与第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 安装包构建

`./scripts/package-ios.sh unsigned` 构建完整 Release archive，再产生供 AltStore / Sideloadly 等重新签名的 IPA。未签名 IPA 不能直接安装到 iPhone。脚本不会绕过图标、扩展或 Asset Catalog 构建。

开发者签名使用 `./scripts/package-ios.sh signed`，通过 `AIBRO_TEAM_ID` 与 `AIBRO_EXPORT_OPTIONS` 提供已选 Team 和导出配置；Apple ID 登录和证书保留在本机 Xcode / 钥匙串中。

原生测试 scheme 为 `MobileNativeTests`，在已启动的隔离 Simulator 上运行，例如：

```sh
xcodebuild -project ios/App/App.xcodeproj -scheme MobileNativeTests \
  -destination 'platform=iOS Simulator,name=AI Bro iPhone QA' \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- -parallel-testing-enabled NO -jobs 2 test
```

Simulator 构建保留模拟签名权限，避免 App Group 与 Keychain 行为失真。测试使用独立临时文件和临时 Keychain 服务，不读取真实学校会话。
