# AI Bro product page

A bilingual static product website for the Mac App. The design retains the earlier site's immersive dark hero, large product imagery and alternating workflow chapters. A 42-second product film on a warm-white and mint player stage is the first showcase after the hero; actual interface walkthroughs remain available below it. Product images come from the actual **AI Bro 0.8.0 native App**, captured in an isolated workspace containing only fictional materials.

Chinese is the default; `?lang=en` selects English. The canonical site is [zihenghe04.github.io/AIBro](https://zihenghe04.github.io/AIBro/), and download links target [v0.9.0](https://github.com/zihenghe04/AIBro/releases/tag/v0.9.0). Website changes do not rebuild or replace the App.

## Local preview

No dependency installation or build is required:

```sh
python3 -m http.server 8080 --bind 127.0.0.1 --directory launch/dist
```

Open `http://127.0.0.1:8080/` and `http://127.0.0.1:8080/?lang=en`. This serves public marketing assets, not a user workspace. The page has no external font service, analytics script, or media CDN.

| File | Purpose |
| --- | --- |
| `dist/index.html` | Semantic Chinese content, real App screenshots, video controls, FAQ and downloads |
| `dist/style.css` | Typography, dark olive page with a light film stage, alternating media layout, responsive and reduced-motion styles |
| `dist/script.js` | English translations, language history, viewport playback, motion controls and image dialog |
| `dist/assets/mark.png` | Existing App brand mark |
| `dist/assets/demo/native-*.png` | Actual native App screenshots: overview, reader, editor and agenda |
| `dist/assets/demo/hero-workspace.png` | Actual App screenshot used by README |
| `dist/assets/film/promo-{zh,en}.mp4` | 42-second, 1080p React + Remotion product film in Chinese and English |
| `dist/assets/film/poster-{zh,en}.jpg` | Language-matched product film posters |
| `dist/assets/demo/{source-to-note,review-to-save,plan-to-agenda}.{mp4,gif}` | Three workflow sequences, with GIF alternatives for GitHub |

## Interaction and motion

- An immersive hero introduces the product; a separate unshaded, high-resolution image lets visitors inspect the real workspace.
- The main film starts only after a deliberate play or chapter-button action. It has native playback controls, six chapter jumps, a progress indicator and a download link. Switching languages pauses and resets playback, replacing the film, poster and download target together.
- The main film pauses offscreen or when the page is hidden. The three smaller interface walkthroughs preload near the viewport, play when visible, and pause offscreen; they also pause while the main film plays.
- Visitors can pause page motion, play individual chapters, download GIFs, or enlarge screenshots in a keyboard-accessible native dialog. Escape closes the dialog and focus returns to the trigger.
- Reduced-motion preferences disable automatic playback and entrance movement. Content remains readable without JavaScript.
- The English dictionary must cover visible copy and accessible labels. Language changes preserve the URL hash; back/forward navigation restores the selected language.
- Failed media retains access to the real screenshot and reports a readable status instead of leaving an empty frame.

The product film is authored in **React + Remotion** and exported as ordinary MP4 files. Animated typography, layered real App captures, perspective, focal camera movement and scene transitions are part of the rendered film. Warm-white backgrounds and mint accents keep the film bright; the surrounding website retains its existing dark visual identity. The [film source and storyboard](film/README.md) record its two visual references and asset provenance. The landing page remains static, using browser media APIs and CSS for playback and surrounding presentation; it does not ship a Remotion player runtime. The main film is 16:9, while the actual App screenshots and smaller walkthroughs retain the captured window ratio of 128:85.

## Media provenance

All current product screenshots were captured from the native 0.8.0 App on 2026-10-01. The capture App uses the released executable and frontend resources, with a distinct bundle identifier and a separate demo workspace. Public examples include a fictional interaction-design course, an urban-transport research project, and a weekend plan. No production workspace, account, credentials, server addresses, or personal documents are included.

The main film combines **actual App screenshots with React + Remotion motion design**. The smaller workflow videos and GIFs remain screenshot sequences illustrating interface steps. Neither type is a continuous screen recording, live model execution, or model-speed benchmark. The main film has separate Chinese and English typography; both versions use the same actual Chinese App captures. The English film must not be described as an English App interface. The page discloses the fictional data and edited presentation in both languages.

Film chapter starts are 00:00 (idea), 00:05 (workspace), 00:12 (reading), 00:20 (documents), 00:29 (planning), and 00:36 (choice and closing brand sequence). Keep these values in `index.html` and the rendered composition aligned. A new render should be reviewed before replacing either language's public files.

Do not reintroduce generated product mockups, fabricated tool results or unreviewed screenshots. The earlier `assets/recordings/`, `assets/ios/`, and `features.json` remain historical assets and are not referenced by the current landing page. A historical asset is not automatically approved for reuse.

## Publication checklist

Verify Chinese and English at desktop and narrow widths; image enlargement and focus restoration; explicit film playback, each chapter jump and its timing; language changes during playback; pause/replay controls; failed-media recovery; keyboard access; reduced motion; local asset references; image encodings; and privacy of every newly published frame. Check readable type, image aspect ratios and media size as well as JavaScript syntax. Browser acceptance is separate from App acceptance.

The [Pages workflow](../.github/workflows/pages.yml) publishes `launch/dist` on matching `main` changes, only for the public `zihenghe04/AIBro` repository. Publish from the sanitized public checkout, never private development history. Confirm the exact commit's successful Pages deployment and the resulting live page. Keep product claims aligned with the downloadable version; a successful website deployment does not establish App feature correctness.
