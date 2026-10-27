# Third-party software

AI Bro includes D3 7.9.0 by Mike Bostock and Observable, Inc. under the ISC license. The browser bundle `d3.min.js` is copied without modification from the official npm `d3@7.9.0` package; see [D3-LICENSE.txt](../app/D3-LICENSE.txt) for the full license.

Electron, electron-builder, and their dependencies retain their upstream licenses, recorded in the [locked npm dependency tree](../package-lock.json). They support legacy development and test tools; the current Mac release uses the native SwiftUI / WKWebView shell. Source development installs PyMuPDF and Pillow through [requirements.txt](../requirements.txt). Portable release bundles include locked CPython, PyMuPDF/MuPDF, certifi and Pillow builds, their license notices, and runtime metadata. The release includes PyMuPDF and MuPDF corresponding source archives. See [release-runtime-lock.json](../scripts/release-runtime-lock.json) for exact versions, URLs and SHA-256 hashes. AI Bro’s original code is distributed under AGPL-3.0-only; this distribution uses the AGPL option for PyMuPDF/MuPDF. Preserve the project LICENSE, upstream notices and corresponding source when redistributing. No commercial license from Artifex is claimed.

The initial Agent workspace redesign referenced [UI by Halaska](https://ui.halaska.com/) while using AI Bro's own DOM components. The subsequent Kit integration vendors the [original MIT source](../app/ui/halaska-kit.jsx) and builds an explicitly selected set of components into `app/halaska-ui.js`. Existing screens have not all migrated. [The build script](../scripts/build-halaska-ui.mjs) applies the host palette, scoped styles, local fonts and explicit adapters; [provenance](../app/ui/halaska-provenance.json) records the pinned source/API and output hashes. Preserve [HALASKA-MIT.txt](licenses/HALASKA-MIT.txt), [REACT-MIT.txt](licenses/REACT-MIT.txt), [REACT-DOM-MIT.txt](licenses/REACT-DOM-MIT.txt), and the local Geist fonts' [SIL OFL notice](licenses/GEIST-OFL.txt). The current bundle also includes adapted public MIT AICSS `ReasoningEffort` and `ThinkingState` components and the Bencho `Create` menu. Unmodified reference files and fixed source hashes are kept under [app/ui/vendor](../app/ui/vendor/); preserve [AICSS-MIT.txt](licenses/AICSS-MIT.txt) and [BENCHO-MIT.txt](licenses/BENCHO-MIT.txt). The AICSS activity label uses real application lifecycle states, with no demonstration completion timers. No paid Pro source is bundled. Animation and icon dependencies retain the additional notices in [docs/licenses](licenses/).

The document editing foundation introduced on 2026-09-30 uses actual Milkdown/Crepe and CodeMirror editing engines. The visual adapter uses `@milkdown/crepe` and `@milkdown/kit` 7.22.2 (MIT), including ProseMirror, Vue, and selected Crepe features. The source adapter uses CodeMirror 6 packages, including `@codemirror/view` 6.43.13, `@codemirror/state` 6.7.6, `@codemirror/commands` 6.11.1, `@codemirror/search` 6.7.2, and `@codemirror/lang-markdown` 6.5.2 (MIT). The current dependency inventory also includes KaTeX 0.18.9 and 0.16.47 (MIT) and DOMPurify 3.4.16, whose declared license expression is `(MPL-2.0 OR Apache-2.0)`; the aggregate must not be described as entirely MIT. Preserve the full generated [DOCUMENT-EDITORS.txt](licenses/DOCUMENT-EDITORS.txt) notices, including copyright statements and the available DOMPurify license texts. The exact packages contributing code and the built asset sizes/SHA-256 hashes are recorded in [app/editor/provenance.json](../app/editor/provenance.json); the lockfile remains the installation record.

[build-document-editors.mjs](../scripts/build-document-editors.mjs) gathers notices from the packages actually contributing to the JavaScript bundle, rejects packages without a verified notice, and embeds the gathered texts in the distributed `document-editors-bundle.js` as well as the notice file above. It builds local editor CSS with inline KaTeX fonts. Both assets are listed in the [shared native asset manifest](../app/asset-manifest.json) and loaded on demand from the application itself; no editor CDN or third-party font service is required. Adaptations live in [app/editor](../app/editor/) and the [pinned local patch](../scripts/lib/document-editor-patches.mjs). Supported editing behavior and current boundaries are described in [the desktop guide](DESKTOP_APP.md#阅读编辑与修改审阅); build steps are in [installation and building](DISTRIBUTION.md).

Typora, ZCode, and OpenCode informed the document workflow research. This editor integration does not incorporate their product source, styles, or assets. Typora is a proprietary product; its public documentation is used only as an interaction reference. Vditor was evaluated but is not included in this editor bundle. Interaction references do not establish dependency inclusion or current feature parity; the source and package inventories above describe the code actually distributed.


The document reader introduced on 2026-09-30 pins unified 11.0.5, remark-parse 11.0.0, remark-gfm 4.0.1, remark-math 6.0.0 and KaTeX 0.18.9. [build-document-markdown.mjs](../scripts/build-document-markdown.mjs) records contributing inputs and 63 package notices in [document-markdown-provenance.json](../app/editor/document-markdown-provenance.json), embeds full notices in `app/document-markdown-bundle.js`, and saves [DOCUMENT-MARKDOWN.txt](licenses/DOCUMENT-MARKDOWN.txt). Preserve all notices when distributing. The reader uses local WOFF2 KaTeX fonts, with no runtime CDN. Package provenance and source availability do not replace native workflow acceptance; see the relevant [Release](https://github.com/zihenghe04/AIBro/releases) for the delivered version and known limitations.

The native top-island workbench introduced on 2026-10-01 adapts window geometry, continuous shell animation, and transition-ownership patterns from [TO-DO Panel](https://github.com/xiaopu-ai/TO-DO-Panel/tree/1deb3cac1e32599f13b1d6b30a7e52af76f67efd), pinned at `1deb3cac1e32599f13b1d6b30a7e52af76f67efd` (MIT; copyright 2026 TO-DO Panel contributors). The adaptation is implemented in SwiftUI/AppKit in `native/Sources/AIBro/NativeQuickEntry.swift` and `NativeQuickPresentation.swift`; it does not bundle the upstream Electron application. Preserve the full [to-do-panel-MIT.txt](licenses/to-do-panel-MIT.txt) notice.

## CC Switch (MIT)

The model price table in [model-prices-data.js](../app/model-prices-data.js) (generated by [gen-model-prices.mjs](../scripts/gen-model-prices.mjs); USD per million tokens, a price seed taken from the same project) and the provider preset table in [provider-presets-data.js](../app/provider-presets-data.js) is generated by [gen-provider-presets.mjs](../scripts/gen-provider-presets.mjs) from the preset tables of [CC Switch](https://github.com/farion1231/cc-switch) (commit e8e1cfbff4f2d93f2d6c4ba4ad10b511e012c733, MIT). Only vendor names, public endpoints, model names and capability metadata are kept; partner flags, promotion text and referral links are dropped. The import of a CC Switch database and the balance adapters port small parts of its logic under the same licence; each ported file keeps this notice in its header.

```
MIT License

Copyright (c) 2025 Jason Young

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

AI Bro's own ChatGPT account sign-in (`app/chatgpt_oauth.py`, `app/chatgpt_bridge.py`) ports the OAuth flow structure (PKCE browser login, device-code login, token refresh, ChatGPT account claims, model and usage endpoints) from [CC Switch](https://github.com/farion1231/cc-switch) (MIT; copyright 2025 Jason Young). It is reimplemented in Python and shares no source files with the upstream Rust application. Preserve the full [CC-SWITCH-MIT.txt](licenses/CC-SWITCH-MIT.txt) notice.
