# 安装与构建 / Install and build

## 下载原生 Mac App

[AI Bro 0.7.0](https://github.com/zihenghe04/AIBro/releases/tag/v0.7.0) · Apple Silicon · macOS 14+。原生 Liquid Glass 需要 macOS 26，较早版本使用兼容材质。

1. 从 Release 下载 DMG 和 `SHA256SUMS.txt`，用 `shasum -a 256 AI-Bro-0.7.0-macos-arm64-preview.dmg` 核对同名校验值。
2. 正常退出旧版，将 DMG 内的 AI Bro 拖到 Applications。已有工作区保留；更新前建议备份。
3. 在设置中配置兼容 API，或连接已安装的官方 Codex CLI 账号。ChatGPT 订阅不等于 API / embedding 额度。

内置 Python、PDF 运行时，无需为运行 App 安装 Node.js、Homebrew 或 Python。当前是 ad-hoc 签名预览包，尚未 Apple 公证；首次打开可能需要在系统“隐私与安全性”中允许该应用。不要关闭系统整体安全保护。

Download the DMG from the public release, verify its SHA-256, quit the old app, and drag AI Bro to Applications. Your workspace is retained. The preview is ad-hoc signed, not Apple-notarized. Intel, Windows and Linux installers are not provided.

## 从源码构建

需要 Apple Silicon Mac、macOS 26 SDK / Xcode 26 Command Line Tools、Node.js 24、Python 3.12。编译目标为 macOS 14。原生导航和控件使用 SwiftUI / AppKit，文件与文档工具使用 WKWebView。

```sh
git clone https://github.com/zihenghe04/AIBro.git
cd AIBro
npm ci
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
npm test
npm run test:native
npm run release:mac -- --output "$PWD/release/native-0.7.0"
```

发行脚本要求已提交且无跟踪文件改动的 Git 工作区，以及不存在的新输出目录。它下载 SHA-256 锁定的独立 Python 与 PDF 依赖，编译原生 App，检查签名、无系统 Python 的启动、PDF 预览和资源隔离，再生成 ZIP / DMG。`--cache <目录>` 可复用校验通过的下载。不会替换正在运行的应用。

`npm run start:native` 用于开发预览；旧 Electron 开发入口暂时保留，但不再是发行包。打包脚本为 `scripts/release-native.js`，锁文件为 `scripts/release-runtime-lock.json`。

## 发布与源码一致性

公开仓库 `zihenghe04/AIBro` 的标签 `v<version>` 必须与两个 package.json 一致。CI 在 macOS 26 上检查测试并生成原生预发布；手动运行只产生构建附件。`release-manifest.json` 记录对应 Git 提交、源文件摘要、App 摘要与运行时信息。源码归档从同一提交生成。

开发仓库的私有历史不应作为发布分支直接推送；在公开仓库独立提交经检查的源码，不包含本机工作区、密钥、个人资料、录制缓存或未跟踪实验文件。

## 依赖与许可

AI Bro 采用 AGPL-3.0-only。发行包保留 CPython、PyMuPDF / MuPDF、certifi 等依赖许可，随版本提供对应依赖源码和 `THIRD-PARTY-NOTICES.txt`。商业使用需继续遵守相应许可。用户的工作区内容不属于应用源码分发范围。

模型服务及可选自托管同步各自需要配置；应用没有后台静默自动更新。演示素材是隔离示例，不打包到用户数据目录。
