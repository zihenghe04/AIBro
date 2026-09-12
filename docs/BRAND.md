# AI Bro 品牌与材质

AI Bro 是显示品牌名，代表随时协助学习、科研与日常的知识伙伴。内部 bundle ID、加密凭据名称与数据路径延续旧版，升级不会新建工作区。

## 标识

三枚柔和的种子形围合成一个向内汇聚、向外展开的抽象图形。中间留白表达探索的入口，整体表达知识的收集与生长。没有字母、文字或人物，单色轮廓适合缩小使用；浅色瓷白底座与细玻璃边缘衬托深色符号。

- `ai-bro-icon.png`：带透明外背景的原始 Logo，供 Web、侧栏与桌面使用。
- `ai-bro-icon.icns`：由同一 PNG 等比例缩放封装为 macOS 图标。
- 不使用 Apple 或其他 AI 品牌的标志；尚未进行商标查重。

## 生成记录

使用内置 imagegen 生成模式制作，未使用 API/CLI fallback。最终提示词：

> Use case: logo-brand. Design one finished original app icon for AI Bro, a personal knowledge companion for students and researchers. The logo must be a purely abstract symbol, NOT a letter, monogram, word, robot, face or brain. Concept: a small seed of insight opening into three smoothly folded asymmetric petals; a single bold circular silhouette with three calm flowing negative-space channels leading toward a small triangular central opening. Suggest knowledge gathering and continuous exploration through the geometry alone. It should have the economy, recognizability and monochrome strength of leading AI brand identities while NOT resembling OpenAI's six-part knot, Claude's radial asterisk, Gemini's four-point sparkle, Perplexity's line-grid, or any existing logo. Three broad rounded solid forms only, optically balanced, softly organic but mathematically precise. Main mark in solid deep charcoal, crisp vector-like shape with no 3D lettering or metallic shading on the mark. Center it at 56 percent canvas size on a pale warm porcelain rounded-square app tile with very subtle clear glass rim and fine ambient contact shadow. True transparent outside tile. Premium understated editorial feel, no blue candy look, no glossy blob. Orthographic front view, centered single icon, 1024 square. No text whatsoever, no letter B or A, no typography, no mockup, no watermark, no comparison sheet.

## 材质设计

参考 [Apple 官方 Liquid Glass 展示](https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/) 与 [WWDC25 Meet Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/)。

输入框使用圆角凸透镜边缘的法线位移图，SVG backdrop filter 会偏折真正滚动到背后的聊天内容。镜片中心采用磨砂散射，不位移前景文字。滚动内容靠近输入框时还会逐渐淡化，避免细小字形穿透并干扰控件；聚焦输入时增加中心底色。尺寸变化时缓存更新位移图，无持续画布渲染。边缘镜面高光、透光背景与接触阴影形成厚度，鼠标移动时高光位置随之变化。

macOS 窗口外围另外接入 Electron 的原生 vibrancy，使桌面背景可以透过窗口外层。它与网页内部折射是两个不同的合成层：SVG 不采样操作系统桌面。浏览器则使用网页背景回退。此实现不宣称使用 Apple 原生 Liquid Glass API。

导航和操作控件使用玻璃；正文、长表格和笔记使用稳定底色。支持减少动态效果、减少透明度、高对比与强制颜色设置。真实背景折射以支持 SVG backdrop filter 的 Chromium 为目标，其他引擎回退为透光磨砂。

## 品牌使用 / Brand use

代码许可不授予商标权，也不表示对衍生项目的官方认可。可以如实介绍作品源于 AI Bro；发布修改版时应清楚标明改动与维护者，避免让用户误认为是原项目官方发行。此说明不削减 AGPL 授予的代码使用权。

The code license does not grant trademark rights or imply endorsement. You may accurately identify AI Bro as the source of your work. Clearly identify modified versions and their maintainers to avoid confusion with official releases. This guidance does not limit the code rights granted by the AGPL.
