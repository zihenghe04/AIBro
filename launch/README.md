# AI Bro product page

A bilingual static website. Chinese is the default; `?lang=en` selects English. The existing dark and soft-green visual direction is retained.

## Preview

Serve `dist/` with an HTTP server. No build step or package installation is required. `features.json` contains the nine workflow descriptions and recording metadata; `script.js` loads it at startup. The page uses no external fonts, analytics or media CDN.

## Real recordings and languages

- Chinese: the user's 128-second ScreenCam export, plus nine independently downloadable GIFs. The original ScreenCam background, cursor and shadows are preserved.
- Feature playback: 30 fps MP4 derivatives of the same nine recording intervals, about 4.7 MB combined. GIF downloads remain available at 1200 px / 15 fps. Video sources are assigned when needed; posters load first.
- Visible clips may play simultaneously. Offscreen clips pause. A discreet page-motion toggle, enlarged playback, hidden-tab pause and reduced-motion preferences are supported. No controls, duration labels or recording-tool badges are overlaid on the clips. The main tour also loops while visible. Containers follow intrinsic video proportions without independent height caps. Small opacity/translation reveals run once as content enters view; no scroll-driven layout or video blur is used.
- English: a separate 41-second recording of the English project/task UI, edited to remove waiting time. The nine feature explanations use clearly labeled English workflow illustrations. Complete English feature recordings are still outstanding; Chinese clips are never substituted.
- Chinese and English hero backgrounds also use language-specific images. Previous montage assets remain on disk for rollback but are not referenced by the current page.

## Evidence and scope

The recordings show example workspaces. Existing example conversations and results are not model-speed or quality benchmarks. Clip captions describe the operations actually visible, rather than implying that unrecorded AI processing or notification delivery occurred.

The full Chinese source is the user-exported `屏幕录制-20260915-162058.mp4`, SHA-256 `5cd0fa2ffec80e91a5854ffa9bd7ebe8bcb9b7a6fb6337e6b23c50f412c8c051`. The original is unchanged. Intervals in source seconds:

| Feature | Start | End |
|---|---:|---:|
| Overview | 0.4 | 7.2 |
| File review | 9.1 | 24.3 |
| Calendar | 25.4 | 31.3 |
| Captures | 39.1 | 55.2 |
| Project charts | 57.5 | 69.8 |
| Project reader | 78.8 | 86.9 |
| Research Wiki | 95.5 | 103.1 |
| History and trash | 104.0 | 112.7 |
| Model settings | 114.1 | 117.7 |

The English footage uses `screen-cam-1789458513.mp4`, concatenating 104–123, 190–205 and 213–220 seconds without changing playback speed.

## Validation and release

2026-09-15: JavaScript syntax, a DOM simulation of concurrent playback/viewport pause/global motion control and unobstructed frames/language isolation/reduced motion/enlarged-view close, local asset existence and section anchors passed. All 11 current MP4s were decoded with FFmpeg. HTTP checks cover pages, scripts, feature data, posters, GIFs and videos. These checks are not browser visual acceptance.

This is a local website update, not a published app release. Download links lead to the latest public GitHub Releases; release-specific availability is governed by the linked release notes. Do not claim an upcoming version is already available. Keep the private development repository and its history separate from the sanitized public release checkout.

## iOS companion (2026-09-16)

`#ios` introduces captures, knowledge, UCAS course tools and self-hosted sync, with an iOS 0.1.2 download and signing guide. `assets/ios/` contains three actual iOS Simulator screenshots at 1206 × 2622. They were captured in a newly created simulator seeded exclusively with fictional data; no existing user workspace or credentials were loaded. The English page provides translated capability descriptions without substituting Chinese screenshots.

### Course assistant showcase

`assets/ios/courses.png` is captured from the same isolated Simulator with fictional courses and teachers. An offline preview opens the unmodified course-assistant layout directly and labels its seeded attendance state as simulated. No school login or attendance request was made. The production app and IPA are unchanged. The Chinese page shows this image at `#ios-courses`; the English page describes the workflow without displaying Chinese UI.
