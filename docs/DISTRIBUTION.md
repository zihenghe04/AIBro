# 安装与构建 / Install and build

AI Bro 提供两条路径，使用同一份版本代码和资源清单。

> 首个公开二进制 Release 尚未发布；目前请使用下方源码方式。以下下载步骤在 Release 开放后适用。 / The first public binary is not published yet; use the source-build path below.

## 1. 下载 App / Download the app

从 [GitHub Releases](https://github.com/zihenghe04/AIBro/releases) 下载当前版本的 `AI-Bro-<version>-macos-arm64-preview.zip`。公开仓库中的 Release 与源码均可直接访问。

1. 下载 ZIP 与 `SHA256SUMS.txt`。在下载目录运行 `shasum -a 256 -c SHA256SUMS.txt --ignore-missing`，核对已下载文件。
2. 解压，将 `AI Bro.app` 移到“应用程序”，正常退出旧版本后替换。应用升级保留已有工作区。
3. 在设置中连接兼容 API。OpenAI 账号连接另外需要本机安装官方 Codex CLI；本版本不内置 Codex CLI。

当前发行包支持 **Apple Silicon（M 系列）Mac、macOS 12+**；原生 Liquid Glass 需要 macOS 26。Intel、Windows、Linux 发行包暂未提供。发行包内置 Python 与 PDF 运行时，不必先安装 Node.js、Python 或 Homebrew。

预览包使用 ad-hoc 签名，**尚未获得 Apple Developer ID 签名与公证**。下载后可能被 Gatekeeper 拦截；确认下载来源和校验值后，按 macOS“系统设置 → 隐私与安全性”显示的提示允许本次打开。不要关闭系统整体安全保护。公开商用分发前仍需完成正式签名、公证和依赖许可审核。

Download the Apple Silicon ZIP from the public [Releases page](https://github.com/zihenghe04/AIBro/releases). Extract it and move `AI Bro.app` to Applications after quitting the older copy. Python and PDF dependencies are included. Node.js and Homebrew are not required to run the release app. A compatible API connection is configured in Settings; account sign-in additionally requires an installed official Codex CLI. The preview is ad-hoc signed, not notarized, and may require an explicit per-app approval in macOS Privacy & Security. Native glass requires macOS 26; other supported versions use the web material.

## 2. 从源代码构建 / Build from source

需要 macOS、Node.js 24（发行构建推荐）、Python 3.10+。原生玻璃编译另外需要 macOS 26 SDK 和 Node-API 头文件；缺少时，开发构建使用 CSS 材质。

```sh
git clone https://github.com/zihenghe04/AIBro.git
cd AIBro
npm ci
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
AI_WORKSTATION_PYTHON="$PWD/.venv/bin/python" npm start
```

构建本地开发 App（仍依赖你配置的 Python）：

```sh
npm run app
```

构建含独立 Python 的 Apple Silicon 发行包：

```sh
npm run release:mac -- --output "$PWD/release/preview"
```

输出目录必须不存在，防止覆盖已有产物。脚本不替换正在运行的 App。下载运行时的 URL、版本与 SHA-256 固定在 `scripts/release-runtime-lock.json`；第三方许可证与依赖信息随包保留。第一次构建需要联网，后续可通过 `--cache <目录>` 复用校验通过的下载。

Use the commands above to build from source. `npm run app` creates a developer bundle; `npm run release:mac` creates the portable arm64 distribution. The release builder rejects an existing output directory and verifies all locked runtime downloads.

## 持续发布 / Release automation

`.github/workflows/release.yml` 在 `macos-26` 的 arm64 runner 上安装锁定依赖、执行测试、编译原生组件，再构建 App、完整源码包和 SHA-256 清单。推送与 `package.json` 一致的 `v<version>` 标签会创建预发布版本；手动运行只生成 Actions 构建产物。

```sh
# 先修改版本、完成检查并提交代码，再发布标签。
git tag vX.Y.Z
git push origin vX.Y.Z
```

不会更改仓库可见性，不含自动更新。演示视频由独立录制流程产生，人工检查后作为同版本 Release 附件上传。发布者应核对源码包与打包 manifest 指向同一提交。

The workflow creates a prerelease on a version tag, or downloadable CI artifacts on a manual run. It never changes repository visibility. Demo films are separate, privacy-reviewed release assets. The application does not yet auto-update.

## 依赖与源码 / Dependencies and source

发行包保留 Electron、CPython、PyMuPDF/MuPDF、certifi 等依赖的许可证；`THIRD-PARTY-NOTICES.txt` 与运行时 manifest 记录对应版本和来源。PyMuPDF/MuPDF 使用 AGPL／商业双许可，私有仓库不意味着免除许可义务。接收者应同时取得对应版本源代码与依赖来源信息；进一步转发、公开或商业分发前需确认适用的许可证或商业授权。
