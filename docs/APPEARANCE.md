# 外观与可访问性 / Appearance and accessibility

AI Bro 提供浅色银白与深色石墨两套外观。材质主要用于导航与控件，笔记、PDF 和聊天正文保持稳定的阅读对比度。

AI Bro uses a light silver and dark graphite appearance. Materials belong mainly to navigation and controls; notes, PDFs, and chat text retain a stable reading surface.

## 使用方式 / Using the interface

- 侧栏、对话顶栏与阅读区提供主题切换入口，外观选择保存在当前设备。Theme controls are available in the sidebar, conversation header, and reader, with a device-local preference.
- 拖动分隔条调整侧栏、对话列表和阅读区宽度；分隔条也支持方向键、Home/End 和双击复位。Resize panes with their separators, use arrow keys or Home/End, or double-click to reset.
- 多个阅读标签保留原件与笔记上下文；窄屏时可收起阅读区，返回对话继续输入。Reading tabs retain document context; on narrow screens, collapse the reader to return to the conversation.
- 系统的减少动态效果、减少透明度与强制颜色设置会启用对应的简化处理。Reduced motion, reduced transparency, and forced colors use the appropriate simplified presentation.

## macOS 系统玻璃 / Native macOS glass

在 macOS 26 及以上，且原生组件可用时，AI Bro 使用 Apple 公开的 [NSGlassEffectView](https://developer.apple.com/documentation/appkit/nsglasseffectview)。系统材质覆盖侧栏、对话列表、顶栏、输入框及阅读区工具栏。网页菜单与弹窗仍使用 CSS 材质，不被标称为原生控件。

On macOS 26+, when the native component is available, the public `NSGlassEffectView` supplies material for the sidebar, conversation navigator, top bar, composer, and reader controls. Web menus and dialogs retain CSS materials; they are not presented as native controls.

原生视图位于 WebContents 后方，不能折射同一 WebContents 中的文字。应用在非材质区域保留不透明底板，在材质内加入中性的文字承载层；输入框下方的聊天内容会渐隐，避免背景与输入文字重叠。系统明暗外观跟随应用设置，玻璃不依赖私有 AppKit 样式。

Native views sit behind the WebContents and cannot refract text drawn by that same WebContents. Opaque backing covers non-material regions, neutral content layers support text contrast, and messages fade below the composer to prevent text overlap. System appearance follows the app setting without private AppKit styles.

## Web 与较早系统 / Web and earlier systems

浏览器、较早 macOS、缺少原生组件或关闭透明效果时，会使用相应回退。支持的 Chromium 环境可在有限表面上采用 SVG 边缘折射与磨砂中心；不支持时保留普通的背景、边界和阴影，不影响点击与阅读。

Browsers, earlier macOS versions, missing native components, or reduced-transparency settings use a fallback. Supported Chromium environments apply SVG edge refraction and a frosted center to a limited set of surfaces. Other environments keep conventional surfaces, borders, and shadows without changing interaction.

指针高光只作用于有限控件；它不移动布局、不处理用户图片，也不用于暗示模型进度。数据图表仍根据真实工作区内容绘制，空数据不会被装饰性样本替换。

Pointer highlights are limited to controls. They do not move the layout, process user images, or imply model activity. Charts still use actual workspace records, including empty states.

## 开发与构建 / Development and builds

原生组件编译需要包含 macOS 26 SDK 的 Xcode / Command Line Tools，以及 Node-API 头文件。启动与构建命令会尝试编译；可选组件失败时，开发环境回退到 Web 材质。

Native compilation needs Xcode / Command Line Tools with the macOS 26 SDK and Node-API headers. Start and build commands attempt compilation; development builds fall back to web materials when the optional component is unavailable.

```sh
npm run native:build
```

可通过 `NODE_INCLUDE_DIR` 指定包含 `node_api.h` 的目录。不要把生成的 `.node` 文件提交到仓库；发行构建按目标架构重新构建。运行预编译的发行 App 不需要这些开发工具。

Use `NODE_INCLUDE_DIR` to point to the directory containing `node_api.h`. Generated `.node` files are not committed; distribution builds target the release architecture. Users of a prebuilt app do not need this toolchain.

| 文件 / File | 职责 / Responsibility |
| --- | --- |
| `native-glass-ui.js/css` | 跟踪实际区域、确认原生结果后启用透明层、维护不透明底板与文字对比 / Region tracking, acknowledged activation, backing, contrast |
| `native-liquid-glass.js`, `native-glass.mm` | AppKit 视图与窗口生命周期 / AppKit views and window lifecycle |
| `liquid-glass.js/css` | Web 材质、有限折射与减少透明度回退 / Web materials and fallbacks |
| `workspace-layout.js/css` | 分区宽度、分隔条与响应式约束 / Widths, separators, responsive constraints |
| `reading-pane.js/css` | 阅读标签、收起/放大与异步生命周期 / Reading tabs and lifecycle |

检查材质改动时，除代码测试外，还应验证深浅色、明暗窗后背景、窄屏、打开的阅读区、弹窗及长对话。截图不能只证明 CSS 已挂载；需要确认文字清晰、非材质区域不漏出桌面、控件保持可交互。

Material changes should be checked in both themes, over bright and dark backdrops, with narrow windows, an open reader, dialogs, and a long conversation. Verify legibility, opaque coverage outside material regions, and usable controls—not merely that a filter is attached.
