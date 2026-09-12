# AI Bro product films / 产品演示短片

The Chinese and English films are recorded from the real application with **isolated fictional workspaces and scripted model responses**. Each language has a 61-second launch cut and a 120-second walkthrough. Files, notes, task changes, retrieval, and charts run through the app; the response text is prewritten for a repeatable demonstration. Waiting is edited. This is not a model benchmark or a claim of real-time model performance.

## Story

1. A course handout becomes a source-linked note and a useful task.
2. Read the original beside a note, edit and save your own reflection.
3. Start another conversation using the knowledge already in the project.
4. Organize fictional research through a file tree and a paper relationship view.
5. Refine an existing daily task and check its list.
6. Inspect progress and activity across the workspace.
7. Choose a model and reasoning effort; switch appearance.

中文和英文各录制一套界面、问句、课件和笔记，再各自制作字幕与影片。演示不包含真实个人资料、私有课程、账号、服务器地址或 API Key。画面只捕获独立 App 的 WebContents，不录制桌面、通知、其他窗口或麦克风。原生玻璃在录制环境中使用不透明底层的网页回退，避免桌面内容透入；短片不用于证明原生玻璃效果。

## Reproduce

Requires the app development dependencies, Python with PyMuPDF and Pillow, and ffmpeg. Fonts default to macOS PingFang; use `--font` for another CJK-capable font. The fonts are rendered locally, not redistributed.

```sh
npm ci
python3 -m pip install -r requirements.txt Pillow==11.3.0
npm run demo:record -- --lang zh-CN --output /tmp/ai-bro-record-zh
npm run demo:record -- --lang en --output /tmp/ai-bro-record-en
npm run demo:render -- /tmp/ai-bro-record-zh --output /tmp/ai-bro-films/AI-Bro-Launch-zh-CN.mp4 --teaser
npm run demo:render -- /tmp/ai-bro-record-en --output /tmp/ai-bro-films/AI-Bro-Launch-en.mp4 --teaser
npm run demo:render -- /tmp/ai-bro-record-zh --output /tmp/ai-bro-films/AI-Bro-Tour-zh-CN.mp4
npm run demo:render -- /tmp/ai-bro-record-en --output /tmp/ai-bro-films/AI-Bro-Tour-en.mp4
```

The recorder outputs timestamped image frames, a seven-chapter manifest and `verification.json`. `--quick` is a selector/flow rehearsal, not the published take. The renderer adds typography, restrained camera push-ins, dissolves, chapter progress, subtitles and an original synthesized sound bed. `--preview` renders review stills without producing the movie. No marketing screen replaces a real app interaction.

## Creative references

The primary reference for task-led pacing is the [ChatGPT agent launch film](https://openai.com/zh-Hans-CN/index/introducing-chatgpt-agent/). The scenario-based progression and close-ups are also informed by the official [OpenAI Canvas launch](https://openai.com/index/introducing-canvas/) and [Anthropic Claude 3.5 Sonnet demonstrations](https://www.anthropic.com/news/claude-3-5-sonnet). Their footage, music, logos and copy are not included. AI Bro uses its own product screens, branding and bilingual narrative.

## Privacy review before release

Review `verification.json`, all chapter stills and a contact sheet spanning the entire movie. The allowed inputs are the checked-in synthetic fixture and generated PDF. Keep raw captures and rendered assets outside the source tree. Publish only the reviewed films, captions and poster; never upload an application profile or workspace snapshot. The GitHub repository and releases remain private until the owner chooses otherwise.
