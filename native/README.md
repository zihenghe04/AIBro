# AI Bro native interface

## Local production installation

The user-approved native interface now has a standalone application bundle builder, `scripts/build-native-app.sh`. It bundles web/native resources and Python, uses the existing production data directory, and starts one owned backend. `AIBroProduction` in Info.plist selects production behavior; QA always uses a new temporary directory. A file lock rejects concurrent native writers. Quit an old Electron instance before installing/running the native app.

Native desktop IPC now provides Keychain-backed API and embedding credentials, separately scoped, with main-frame and exact-origin validation. Status is metadata-only. Explicit connection requests can read the previous macOS Electron v10 ciphertext after normal Keychain authorization; old records are never rewritten. Fresh saves go to the native Keychain service, and clearing native credentials disables legacy fallback without deleting the rollback copy. Address checks prevent a key from being returned to another origin. The compatibility cipher and origin validation are tested with synthetic data; actual saved-key access can still require user approval in the system Keychain prompt.

A copied legacy browser profile supplies an allowlisted set of non-secret preferences through `scripts/migrate-native-preferences.cjs`; it loads a local empty page with network interception, never the application workspace. API keys and workspace contents are excluded. Native preferences then persist across backend port changes. OpenAI account state remains in the existing backend auth directory. The host also handles download destinations and JavaScript confirmation/input dialogs.

The local installation preserves original project, note, task, import and conversation records, verified by equality before/after, and checks original attachment bytes. The prior app ZIP, workspace snapshot and Electron profile live only in the private `.aibro-baselines.noindex` backup. No GitHub release or upload is performed. This remains a hybrid native/web application; full native English labels, real model/attachment acceptance and final App Store compatibility are not implied by installing it locally.

The following sections describe earlier preview checkpoints and their validation boundaries.

This is an executable first stage, not a replacement release. SwiftUI owns the window, navigation sidebar, toolbar, overview and appearance settings. WKWebView temporarily hosts the existing conversation, project/document tools and model configuration. Existing JavaScript remains the sole workspace writer; the same Python backend persists its state.

## Run from source

From the repository root:

```sh
./scripts/run-native-preview.sh
```

Requires macOS, a Swift toolchain with the macOS 26 SDK, and the current local app's bundled Python runtime (or a compatible system Python with the Python requirements installed). The CLI build targets macOS 14; new system appearance is supplied on supported macOS versions. `native/Package.swift` also exposes the executable to SwiftPM/Xcode. Set `AIBRO_SOURCE_ROOT` to the repository root when launching outside the script.

Builds and preview data are kept in `.aibro-native-preview.noindex` beside the checkout. No published release, version tag, production application, Electron profile or production knowledge base is replaced. Native preview credentials are not copied from Electron.

## Boundaries

- Navigation commands are allowlisted and JSON-encoded. Workspace snapshots are accepted only from the owned loopback origin's main frame. External links open in the system browser only after a user link activation.
- The host starts its own backend on an OS-assigned port and terminates it when the application quits. Preview state is persisted in a separate directory; web cache is nonpersistent.
- Native `NSOpenPanel` handles web file selection. Full attachment/model end-to-end acceptance is still pending.
- Current native labels are Chinese; completing native English localization is part of the migration, not yet complete.
- Model settings, credential migration, downloads/auth popups, rich editor, full keyboard/accessibility acceptance and native conversation controls remain migration work. These remain acceptance boundaries; the local installation is explicitly user-authorized and retains the prior app for rollback.

## Acceptance

Set `AIBRO_NATIVE_QA=/tmp/aibro-native-report.txt` when launching the built executable. QA always creates a new isolated synthetic workspace. It exercises project synchronization/routing, new conversation, course routing, rejection of unknown commands and persistence across web reload; termination cleans up the owned backend. It optionally captures only this process's main window. This does not validate real model calls or real user data migration.

## Native visual pass

The overview now uses neutral warm-white / charcoal content surfaces, a compact project list, a separated space navigator, and shared typography/spacing. Custom action surfaces use SwiftUI `glassEffect(.regular.interactive())` on macOS 26; the standard toolbar/sidebar retain system materials. Reading surfaces remain opaque for contrast. Reduce Transparency and older systems use a material fallback. Light, dark, and 950-point window screenshots are generated by QA using synthetic project names only.

Pre-native rollback snapshots are stored outside this repository in the private `.aibro-baselines.noindex` directory. They must never be included in source control or release assets. A snapshot contains the original app, exact working source plus Git bundle, workspace and Electron profile, hashes and restore notes. Encrypted credentials still depend on the existing login Keychain. Workspace restore is tested in isolation, not by replacing production data.

## Material and motion pass

Reference research (implementation remains original and no library was installed):
- https://github.com/SohrabZ/swiftui-macos-app — native clear glass above a legible, varied backdrop.
- https://github.com/GetStream/awesome-liquid-glass — interaction and morphing examples.
- https://developer.apple.com/documentation/SwiftUI/Applying-Liquid-Glass-to-custom-views — GlassEffectContainer and glass identity.

The overview has an original interactive three-space composition. Research uses jade, courses amber, daily coral. Small optical glass navigation cards sit over animated contours; content remains on stable surfaces. Custom action morphs use GlassEffectContainer and glassEffectID. Project hover lift, press springs and first-appearance motion honor Reduce Motion; Reduce Transparency gives optical cards an opaque fallback. Ambient animation caps at 20 fps and pauses when the view is absent or the scene is inactive. The controls navigate existing real space views, and project counts come from the live snapshot, not mock display totals.

Validated with synthetic data: compile; light/dark/narrow screenshots; existing routing/save-reload QA; native accessibility click expands the shortcut (collapsed to expanded), reveals the dashboard button, and glass Research card navigates to the Research workspace. This pass covers the native overview and navigation controls; the embedded conversation/document UI still needs native migration and matching visual treatment. No production app or public release updated.

## Workspace visual pass (local checkpoint)

The approved overview baseline is local commit `0fa5a1b`; the pre-native Electron backup remains outside source control. No release or production bundle is changed by this pass.

Daily, course and research spaces now share a native Swift Charts dashboard: status donut with task filtering, 14-day completion bars with date selection, a scrollable task timeline, project progress, editable task links, and a project ownership map. Charts use saved task dates and completion timestamps. The map shows explicit ownership, not inferred semantic edges. Opening or creating a task uses the existing editor and returns to the native dashboard after closing it. Content editing remains in WKWebView.

Native-only CSS extends warm neutral surfaces, jade/amber/coral accents, subtle edge lighting, focus rings, press feedback and dialog/reader entry transitions to embedded content. Text-heavy surfaces are opaque. Reduce Motion disables transitions. The native toolbar owns appearance. Native split layout excludes the hidden HTML sidebar and switches to full-width reading only below 661 points; saved widths survive collapse/reopen.

Research: [Apple Swift Charts session](https://developer.apple.com/videos/play/wwdc2023/10037/) informed native sector marks and chart selections. No third-party chart code or dependency was installed.

QA fixtures are entirely synthetic (`Resources/qa-workspace.js`): three daily projects, 16 tasks and two Markdown notes, plus course/research navigation projects. The fixture is loaded only with `AIBRO_NATIVE_QA`, which uses a fresh isolated data directory. It is never injected into production.

Validation: Swift build; 22 layout tests; 3 bridge tests; 47 reading-pane/planning/note-editor tests. Native UI acceptance covered task creation and dashboard count refresh, status filtering, note-node navigation, reading-width keyboard adjustment (332 to 348), collapse/reopen with width and tab preserved, note title save with synchronized tab/title and version history. Real AI processing, native English localization and full editor migration remain separate acceptance work.

## Coordinated controls and project dashboards (local preview)

Projects now use the same native charts as spaces, scoped to the selected project's saved records. `文件与内容` opens the existing project workspace; creating a task from a project binds that project. Native sidebar selection uses a short matched-geometry transition, controls have hover/press feedback, and appearance uses visual SwiftUI glass choices. Reduced Motion removes positional animation. A pending-navigation guard prevents stale web snapshots from redirecting a newly selected destination.

The embedded selection adapter covers all single-value HTML selects, including dynamically created task status/priority, project assignment, task moves, model/reasoning choices, archive destinations and collection filters. Language, connection type and permission choices use visible segments/cards; other lists use a compact top-layer popover with selection marks, semantic status dots, group headings, and search above six options. Original select values and input/change handlers remain the persistence boundary. Disabled risk-protection controls remain disabled. Multiple-select/listbox controls and date/time pickers retain their existing behavior.

The adapter supports arrows, Home/End, Escape, Tab, focus restoration, external value updates, dynamic disabled/hidden states and stale-list dismissal. Lists are removed when their parent dialog closes or navigation removes their trigger. Content stays opaque for readability; these WKWebView controls are styled HTML, not a claim of native SwiftUI optical glass. Native project-map selection also uses a searchable SwiftUI popover instead of a menu picker.

Validation: Swift compilation and 73 bridge/layout/reading/planning/note tests passed. Native isolated QA additionally executes `Resources/qa-choices.js` (language/permission coverage, disabled protection, dynamic insertion, search, optgroups, dialog top layer, single change event, Escape/focus, external updates, stale options, hidden/disabled synchronization, parent cleanup), plus routing and save/reload checks. Manual native-window acceptance changed a fixture task from completed to in-progress with arrow keys, saved it and verified project completion changed from 2/5 to 1/5. Settings and task-popup visuals were inspected in the running preview. No real credentials, production records, public commit or release were changed.

## Fresh palette and independent motion

This local iteration uses a clear white/mint foundation with sky and lilac category accents. Warm-gray, bronze and dusty-purple surfaces are replaced. Light/dark semantic tokens are shared conceptually between SwiftUI and the embedded stylesheet; destructive/blocked states keep a separate rose-red. Charts no longer have colored card outlines or strongly fading fills. The hero backdrop also uses mint/sky/lilac rather than mixing amber and red behind glass.

References informed role separation rather than copied component code: [Radix palette composition](https://www.radix-ui.com/colors/docs/palette-composition/composing-a-palette), [Adobe Spectrum color system](https://spectrum.adobe.com/page/color-system/), and [Apple custom Liquid Glass](https://developer.apple.com/documentation/SwiftUI/Applying-Liquid-Glass-to-custom-views).

Sidebar navigation now consists of accessible buttons and one continuously positioned selection surface. Per-row frame preferences place that surface within the scroll content; a 0.32-second spring moves it. The former system List selection and competing per-row highlights are removed. On macOS 26 the selection surface uses the native glassEffect API, with reduced-transparency and older-system fallbacks.

Space/project content uses independent opacity/7-point translation entrances: heading lines first, then chart rows with 45 ms stagger steps (capped at five). A canceled view task does not start its entrance. Saved-data refreshes keep view identity and do not restart the entrance. Whole-detail fading and whole-dashboard movement are removed. Geometry chooses only one chart layout instead of measuring two ViewThatFits alternatives; LazyVStack defers lower sections. Embedded pages no longer stack page and nested heading animations on top of their navigation entrance.

Validation: successful Swift build, 73 regression tests, native isolated routing/save-reload and choice-system QA; native window inspection of daily/course/project routing, a single selected sidebar destination and fresh palette. Computed text/action contrast on the specified opaque surfaces: light 12.60 / 5.03 / 4.74 and dark 13.03 / 7.72 / 8.77 (primary / secondary / action). This is not a full contrast audit of every glass backdrop or a measured frame-time benchmark. No production app or public release changed.

## AppKit material beneath embedded controls

On macOS 26, `WebGlassHost` adds actual `NSGlassEffectView` surfaces underneath the composer, the reader toolbar/tab strip, and the active modal. A geometry-only bridge sends at most three allowlisted rectangles; it never includes message text, files or credentials. Main-frame/origin validation remains in the host. Frames are clamped to the viewport, duplicate/invalid geometry is rejected, and native surfaces cannot intercept input. Resize and scroll updates are coalesced; transform entrances are followed only for a bounded transition window.

The host draws an opaque application-owned backdrop, so transparent web regions cannot reveal another desktop window. Modal content is isolated from the underlying web text while open, and a native backdrop dim replaces the old HTML blur/dim layer. Closing the modal restores the composer/reader material. Reduce Transparency, unsupported systems or unavailable transparency support retain the opaque CSS fallback. Dark surfaces now use neutral graphite, with mint confined to accents and a subdued ambient wash; the former deep-green chat rectangle is removed.

**Migration compatibility boundary:** macOS WKWebView still lacks a public `drawsBackground` counterpart. `underPageBackgroundColor` alone did not expose the native material in the tested runtime. This local preview therefore confines a guarded `drawsBackground` KVC compatibility shim to `WebGlassHost`; see [WebKit's API issue](https://bugs.webkit.org/show_bug.cgi?id=221663) and [upstream macOS implementation](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/mac/WKWebViewMac.mm). An unavailable selector disables the native web material rather than cutting holes in an opaque web view. This is not ready for App Store submission: replace the shim with public support or finish native foreground migration before that distribution path. No public release is made here.

The material is native AppKit; foreground conversation/editor/select controls remain HTML. Charts and reading bodies deliberately use stable content surfaces. This does not claim every component has been ported to SwiftUI, or that a static screenshot proves animation frame rate.

Validation: Swift build and 77 bridge/layout/editor/material-geometry tests passed. The isolated native QA verifies composer, reader and modal material counts/acknowledgements, restoration after modal close, and existing save/reload/choice controls. QA screenshots use only synthetic fixtures; real model calls and production knowledge-base data are not part of this visual pass.

## Reader layout and separator repair

The native reader separator now occupies the eight-point gutter instead of overlapping the document. A short centered grip handles hover, drag and keyboard focus; the generic full-height focus outline is excluded. Reader entrance uses opacity without translation, and pane animation completion recalibrates separator geometry. Drag bounds, keyboard adjustment and persisted widths remain unchanged.

Reader spacing is compacted and its Markdown toolbar participates in normal document scrolling. When a note's first Markdown heading exactly matches its preview title, the redundant outer heading is hidden in read mode only; note content, heading anchors and exports are untouched. Closing execution history restores the prior native navigation selection, preventing a history title above an unrelated workspace.

Validation: Swift build and 79 bridge/material/layout/reader/planning/editor tests passed. Isolated native QA checks separator alignment and focus styling, duplicate-heading presentation, and history close restoration. Manual window acceptance dragged the reader from 320 to 487 points and independently scrolled to the note's final section and footer actions. Changes are local preview only; production records and release artifacts are unchanged.

Reader chrome follow-up: the docked AppKit material now has square edges matching the pane, rather than a rounded card behind two square HTML outlines. Toolbar and tabs share an uninterrupted surface with one content divider; only the selected tab keeps a small radius. The 79 regression checks and isolated native QA passed, and the running window was visually inspected.

## Native agenda (local preview)

The sidebar's **日程** opens a native today/week/month calendar. Events, weekly courses and meetings can link to existing projects and notes; task deadlines appear automatically without creating duplicate tasks. Users can create/edit a series, move or skip a single occurrence, mark an occurrence complete, and cancel/restore a series. Calendar items keep stable IDs, time zones, recurrence rules and excluded dates in an atomically written `agenda.json` alongside this preview's data. This is an independent local store; it is not yet cloud-synchronized or exposed as an Agent tool. Existing knowledge-base mutations remain in the web bridge.

The importer previews and selects entries before saving. It supports a documented subset of ICS (daily/weekly/monthly, interval, weekly BYDAY, COUNT/UNTIL and EXDATE), recognizes WakeUp-exported ICS as courses, and deduplicates UIDs unless update is explicitly selected. Unsupported recurrence is reported rather than silently imported as a one-time event. Embedded ICS alarms are not automatically enabled. CSV accepts explicit clock times, semester first Monday, week ranges and odd/even weeks. Images/PDFs use local text extraction/OCR; an explicit AI action sends the editable extracted text to the currently configured conversation model to propose CSV. The proposal executes no workspace actions and must be reviewed before import. Native English localization and broader ICS recurrence remain future work.

Reminders use UserNotifications after user opt-in. Titles are hidden by default. Date-only task deadlines use 09:00 local time for reminders without changing the source deadline. Upcoming concrete reminders are reconciled after edits and every five minutes while running, for the nearest 60 triggers within 30 days; later entries are displayed as awaiting replenishment. Scheduled triggers can deliver with the app closed, but a prolonged absence does not replenish the concrete queue. Daily briefing uses a repeating OS trigger. Notification actions support opening the date and snoozing ten minutes. Delivery remains subject to OS permission and Focus settings.

Apple's [Liquid Glass design session](https://developer.apple.com/videos/play/wwdc2025/219/) informed functional glass controls above legible calendar content. Header actions share a 44-point height and centered icon/text geometry; they reflow below the heading in narrow layouts. Date cells keep compact entries rather than allowing color markers to stretch their height.

Validation: 16 recurrence/import checks, 20 persistence/reminder-planning checks and 83 bridge/layout/editor/AI transport regression checks. Manual native-window validation saved an event, imported a synthetic recurring course, skipped only its first occurrence, verified later weeks remained, and checked the persisted file. A user-supplied WakeUp ICS was parsed locally with no warnings; its contents and screenshots are not committed. Manual notification testing reached the macOS permission prompt; the current automation tool cannot operate that protected window, so actual delivery remains unverified until the user allows notifications and runs the test. Real model import requests are not part of the automated checks. No production Electron data, GitHub push or release changed.

Run `scripts/test-native-agenda.sh` for deterministic local checks. `AIBRO_NATIVE_QA` normally suppresses system notification authorization. An additional explicit `AIBRO_NATIVE_QA_NOTIFICATIONS=1` allows manual system-delivery testing in the otherwise isolated synthetic workspace; no permission is requested automatically.
