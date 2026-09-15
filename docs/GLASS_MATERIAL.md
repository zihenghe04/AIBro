# Local material refinement

This is a local design iteration, not a published release or an exact reproduction of Apple's system rendering.

## Material ownership

- Native `NSGlassEffectView` owns the sidebar and conversation navigator on supported Macs. Their DOM labels use an inset readability veil. The old combined 97–98% opaque overlay is replaced by roughly 72–73% central coverage and a much thinner edge, so the native material remains visible. Stronger secondary-label colors compensate for DOM labels lacking AppKit vibrancy.
- The composer uses an SVG **backdrop** displacement filter inside Chromium. Native navigation no longer disables this separate lens. An opaque content canvas prevents unrelated desktop windows from appearing through the composer.
- The lens bends only background pixels at the rounded rim. A 14px frosted center and scroll-edge fade protect text and controls; foreground text is never filtered or duplicated.
- Menus and reading controls retain bounded CSS backdrop materials. Notes, documents and tables remain stable content planes.
- Reduced transparency / increased contrast remove the material; reduced motion suppresses moving highlights. Resizing defers native geometry changes until acknowledged, with an opaque fallback.

## Reference decisions

- [macOS App Skills](https://github.com/fayazara/macos-app-skills/tree/main/settings-ui): native navigation/content separation and scroll-edge treatment. Its SwiftUI code is not a direct replacement for Electron markup.
- [super-browser-window-kit](https://www.npmjs.com/package/super-browser-window-kit): confirms the native `NSGlassEffectView` approach. The package README specifies proprietary licensing; no dependency or code from it was installed.
- [Kube's CSS/SVG study](https://kube.io/blog/liquid-glass-css-svg/): refractive rim, flat center, matching filter dimensions, directional highlights, and the cost of regenerating maps. Existing original optics implementation is retained.
- [Outpace's glass study](https://glass.outpacestudios.com/): lens continuity and separation of background from controls. Its duplicated-backdrop method is useful for cross-browser scenes but not adopted for long interactive conversations/PDFs; Electron can filter the live backdrop directly.
- [Apple: Adopting Liquid Glass](https://developer.apple.com/documentation/TechnologyOverviews/adopting-liquid-glass): rebuilding native standard controls with the new SDK differs from migrating HTML controls to SwiftUI/AppKit.

## Validation

`tests/glass-material-smoke.cjs` starts a separate profile and synthetic workspace, exercises the real installed native addon together with the DOM lens, and captures both WebContents and native window output. It checks light/dark themes, scoped native regions, unfiltered foreground text, resize and reduced-transparency behavior, with external requests blocked. Native captures require macOS capture permission; screenshots contain synthetic content only.

No application versions, release tags, remote branches or public repositories are changed by this design iteration.
