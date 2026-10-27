# AI Bro product page

A bilingual static product website for the Mac App, redesigned for **0.9.10**. Instead of screenshots and recordings, the product screens are rebuilt in HTML and CSS from the App's own palette (`native/Resources/workspace.css`, teal, light and dark) and layout, and they can be clicked: a hero chat that streams a scripted answer with run steps and sources, then a "day" section where one sticky App window switches between the agenda proposal flow, PDF selection and Ask AI, the project Sources page with linked Markdown notes, the island, the ⌘K palette, scheduled tasks with an approval, and Settings → Models. Below that are a grid of smaller details, two masked screenshots of the real App, the planned items, the 0.9.5 film, FAQ and a download panel. All demo content is fictional and every answer is scripted; the page makes no network requests besides its own files.

Chinese is the default; `?lang=en` selects English. The canonical site is [zihenghe04.github.io/AIBro](https://zihenghe04.github.io/AIBro/), and download links target [v0.9.10](https://github.com/zihenghe04/AIBro/releases/tag/v0.9.10). Website changes do not rebuild or replace the App.

## Local preview

No dependency installation or build is required:

```sh
python3 -m http.server 8080 --bind 127.0.0.1 --directory launch/dist
```

Open `http://127.0.0.1:8080/` and `http://127.0.0.1:8080/?lang=en`. This serves public marketing assets, not a user workspace. The page has no external font service, analytics script, or media CDN.

| File | Purpose |
| --- | --- |
| `dist/index.html` | Chinese copy with English in `data-en` attributes, empty placeholders for the App windows, film, FAQ and downloads |
| `dist/style.css` | Page typography, header capsule, sticky story layout, bento, responsive and reduced-motion styles |
| `dist/app.css` | The rebuilt App window: native sidebar, chat and run steps, agenda, reader, Sources page, island, palette, settings |
| `dist/demos.js` | Window shell and one scripted controller per demo (render, user events, a one-time autoplay with a fake cursor) |
| `dist/script.js` | Language switch and history, header state, scroll reveal, hero tilt, film loading |
| `dist/assets/real/*.webp` | Two masked 0.9.10 screenshots (light and dark) |
| `dist/assets/film/promo-095-*` | 0.9.5 product film and posters |

## Interaction and motion

- Each demo plays once by itself when it comes into view and stops as soon as the visitor touches it; on phones each chapter has its own window and a "Play it" button.
- Motion uses transform, opacity and filter only. Reduced-motion preferences turn off entrance animation, the hero tilt and autoplay; the demos still respond to clicks.
- Content is readable without JavaScript except the App windows, which are built by `demos.js`.

## Media provenance

The App windows are rebuilt from the 0.9.10 source and checked against screenshots of 0.9.10 taken in an isolated copy with a fictional workspace. The two screenshots on the page are from that session and show only demo data. The film is the 0.9.5 cut. The 0.9.5 captures and recordings under `assets/v095/`, and the older material under `assets/demo/`, `assets/recordings/`, `assets/ios/`, `features.json` and `ios-gallery.js`, are no longer referenced by the page (the brand mark still comes from `assets/v095/`).

## Publication checklist

Verify Chinese and English at desktop and narrow widths; image enlargement and focus restoration; explicit film playback, each chapter jump and its timing; language changes during playback; pause/replay controls; failed-media recovery; keyboard access; reduced motion; local asset references; image encodings; and privacy of every newly published frame. Check readable type, image aspect ratios and media size as well as JavaScript syntax. Browser acceptance is separate from App acceptance.

The [Pages workflow](../.github/workflows/pages.yml) publishes `launch/dist` on matching `main` changes, only for the public `zihenghe04/AIBro` repository. Publish from the sanitized public checkout, never private development history. Confirm the exact commit's successful Pages deployment and the resulting live page. Keep product claims aligned with the downloadable version; a successful website deployment does not establish App feature correctness.
