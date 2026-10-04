<p align="center"><img src="app/ai-bro-icon.png" width="76" height="76" alt="AI Bro" /></p>
<h1 align="center">AI Bro</h1>
<p align="center"><strong>An AI study and research assistant for Mac</strong></p>
<p align="center">Read course materials and papers, edit your notes, and plan tasks and events.</p>
<p align="center"><sub>NATIVE MAC APP · LOCAL FIRST · YOUR MODELS · OPEN SOURCE</sub></p>
<p align="center"><a href="README.md">简体中文</a> · English</p>
<p align="center"><a href="https://github.com/zihenghe04/AIBro/releases/tag/v0.9.1"><strong>Download the Mac preview ↗</strong></a> &nbsp; · &nbsp; <a href="https://zihenghe04.github.io/AIBro/?lang=en">Website and demos</a> &nbsp; · &nbsp; <a href="CHANGELOG.md">Changelog</a></p>

[![AI Bro: read course materials, ask questions, and edit study notes on Mac](launch/dist/assets/demo/hero-workspace.png)](https://zihenghe04.github.io/AIBro/?lang=en)
<p align="center"><sub>Actual AI Bro 0.8.0 App interface, captured from an isolated demo workspace. Projects, documents, and responses are fictional; animations arrange interface steps and do not represent live model speed. <a href="https://zihenghe04.github.io/AIBro/?lang=en#workspace">Explore the workflows ↗</a></sub></p>

Add course materials, papers, and notes to a project, then ask questions about them. AI Bro can help summarize key ideas, draft notes, and break work into tasks. Open the cited source to check an answer, or review and edit an AI draft before saving it. When you need the material for an exam or a report, search your saved documents and notes.

The public download is **0.9.1, a Mac development preview** for Apple Silicon / macOS 14+, not yet Apple-notarized. [Release notes](docs/RELEASE_NOTES.md)

---

## See a complete workflow in 84 seconds

[![AI Bro workflow demo: import course materials, draft notes, review, and schedule, 84 seconds](launch/dist/assets/film/motion-84-poster-en.jpg)](https://zihenghe04.github.io/AIBro/?lang=en#film)

[▶ Watch the 84-second workflow](https://zihenghe04.github.io/AIBro/?lang=en#film) · [Download MP4](https://zihenghe04.github.io/AIBro/assets/film/motion-84-en.mp4)

Watch course materials being imported and processed, then see notes reviewed, events scheduled, and research sources retrieved. The footage uses the actual App with fictional materials, edited across sessions with waits condensed. At recording time, some features, such as the island panel, were still in development; not everything shown was available in the public 0.8.0 download.

## Read course materials and papers with source references

Import a handout or paper and ask a specific question: “What are the key concepts in this chapter?” or “What are the limits of this method?” Check the answer against the original and save useful findings as project notes.

![Actual App interface sequence: a fictional source becomes a cited learning note](launch/dist/assets/demo/source-to-note.gif)

- **Read alongside your sources**: import PDFs, Markdown, and other supported files, reference them in chat, and open the cited material.
- **Inspect the original**: PDF navigation and search, document tabs, fit-to-width or fit-to-page, and an adjustable reading area beside the conversation.
- **Find material again**: search project documents and notes, ask follow-up questions, and open saved notes directly from project outputs.

## Edit your notes and review AI changes

Write in the visual editor or Markdown source mode, with tables, math, code, and images. When AI proposes an addition or rewrite, inspect the differences and choose which changes to keep.

![Actual App interface sequence: review changes to a fictional note and save them](launch/dist/assets/demo/review-to-save.gif)

- **Edit the document directly**: switch between visual and source modes for common Markdown structures.
- **Review individual changes**: inspect file diffs, compare side by side, work through change blocks, and keep editing after accepting a draft.
- **Check save status**: drafts and reading positions are retained, with undo during the current editing session and feedback for save failures or version conflicts.

## Schedule assignments, revision, and meetings

Turn course requirements into tasks with due dates, or say “Schedule a lab meeting every Thursday at 2:30 pm.” AI proposes an event for you to check and save, including its time and repeat rule.

![Actual App interface sequence: tasks and calendar entries for a fictional project](launch/dist/assets/demo/plan-to-agenda.gif)

- **Manage tasks**: checklists, boards, due dates, and project schedules, alongside the relevant material.
- **Plan events**: one-off or recurring events, reminders, and ICS import.
- **Check previous work**: move between a project's conversations, sources, outputs, tasks, scheduling, and overview. Consult execution records and version history, or restore supported content from Trash.

<p align="center"><a href="https://zihenghe04.github.io/AIBro/?lang=en#workspace"><strong>Explore the interactive demos ↗</strong></a></p>

## A few ways to use it

| When | Ask AI Bro to help with | Use the result later |
| --- | --- | --- |
| Taking a course | Organize concepts, examples, and assignment requirements into study notes and revision tasks. | Review the notes in your course project, check the original, and add explanations where needed. |
| Reading papers or preparing a report | Analyze methods and limitations, save paper notes, and link questions to sources in Research Wiki. | Retrieve a paper you read earlier and check the source behind a claim in your report. |
| Capturing an idea | Save an idea, link, or plan as a note, checklist, or calendar entry. | Add it to an existing project, then find, edit, or expand it when needed. |

## Models, data, and sync

Connect a compatible API or a locally configured official Codex CLI, and choose a model per conversation. Skills, project plans, and memory help reuse workflows and context. Tool support, attachments, and reasoning options depend on the provider. AI Bro does not include a model subscription or API credits.

Your workspace is stored on your Mac by default. Reading, editing, organizing material, and managing tasks do not require a sync server. Requests to remote models or online tools send the necessary content to the service you select.

For multiple devices, connect your own sync service over HTTPS or an SSH tunnel to push and pull supported workspace content. SSH provides the connection; the sync account establishes content ownership. Model credentials and local-folder permissions are not included in workspace sync. [Models and local data](docs/DESKTOP_APP.md) · [Self-hosted sync](docs/CLOUD_SYNC.md)

## Get started

1. Download the DMG and checksums from [v0.9.1 Releases](https://github.com/zihenghe04/AIBro/releases/tag/v0.9.1), following the [installation guide](docs/DISTRIBUTION.md). Python and PDF support are bundled.
2. Connect your model service in Settings and select a model.
3. Create a project, add a document, and start a conversation.

> Summarize the core ideas in this handout, include source page references, save a learning note, and suggest three revision tasks.

<p align="center"><a href="https://github.com/zihenghe04/AIBro/releases/tag/v0.9.1"><strong>Download AI Bro for Mac ↗</strong></a> &nbsp; · &nbsp; <a href="https://zihenghe04.github.io/AIBro/?lang=en">See the demos</a></p>

<details>
<summary><strong>Preview boundaries and data handling</strong></summary>

The current focus is the Mac App. Full VoiceOver paths, input-method composition, very long documents, and large libraries remain areas of active work. Visual editing supports common Markdown structures; source mode preserves access to extensions. Restoring a document and its draft does not preserve the entire undo history across restarts. Whether an AI task produces a file depends on its actual execution result.

The default workspace directory is `~/Library/Application Support/ai-workstation`. Native credentials use a separate locally encrypted file. Its key and ciphertext are stored under the same user account, so this does not protect against processes that can read that directory. Sync propagates changes and deletions and is not a backup. The sync server can read synchronized content; end-to-end encryption is not currently provided. See [credential storage](docs/DESKTOP_APP.md) and [sync, conflicts, and backups](docs/CLOUD_SYNC.md).

Remote agents, remote file management, and real-time multiplayer collaboration are outside the current scope. Older platform builds are listed in [release history](https://github.com/zihenghe04/AIBro/releases). Promotional demos use original fictional content, with no personal documents, credentials, or service addresses.

</details>

<details>
<summary><strong>Build from source and contribute</strong></summary>

A SwiftUI / AppKit native shell, a WKWebView workspace, and a local Python service. Document editing uses Milkdown and CodeMirror; the product film uses React + Remotion. Development requires an Apple Silicon Mac, Xcode 26, Node.js 24, and Python 3.12.

```sh
git clone https://github.com/zihenghe04/AIBro.git
cd AIBro
npm ci
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
npm run start:native
```

The source preview uses `.aibro-native-preview.noindex/workspace` beside the repository, separately from the installed App. Its launcher does not automatically select an active `.venv`; see the [runtime and build guide](docs/DISTRIBUTION.md). After changing UI or editor sources, run the relevant `npm run build:ui`, `npm run build:editors`, or `npm run build:document-markdown`. Native releases use `npm run release:mac`.

[Install and build](docs/DISTRIBUTION.md) · [Architecture](docs/ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md) · [Third-party sources and licenses](docs/THIRD_PARTY.md)

</details>

---

<p align="center">Try it with a handout or paper and make your first set of notes.</p>
<p align="center"><a href="LICENSE">AGPL-3.0-only</a> · <a href="https://github.com/zihenghe04/AIBro/issues">Feedback</a> · <a href="CHANGELOG.md">Changelog</a></p>
