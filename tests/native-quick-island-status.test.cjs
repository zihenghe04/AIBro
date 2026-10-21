const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

// Compiles the production status model; only nativeUI is stubbed (English).
test('island status derives one collapsed state by priority with clear-on-read', { skip: process.platform !== 'darwin', timeout: 90000 }, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-island-status-'));
  try {
    const source = fs.readFileSync(path.join(root, 'native/Sources/AIBro/NativeQuickIslandStatus.swift'), 'utf8');
    const program = path.join(temporary, 'main.swift'), binary = path.join(temporary, 'checks');
    fs.writeFileSync(program, source + `
func nativeUI(_ zh: String, _ en: String) -> String { en }
var checks = 0
func check(_ value: @autoclosure () -> Bool, _ message: String) { precondition(value(), message); checks += 1 }
typealias S = NativeQuickIslandStatus
typealias I = NativeQuickIslandInputs
let done = I.Run(id: "a", title: "Summarise inbox", status: "completed", finishedAt: 2000, notificationReady: true)
let failed = I.Run(id: "b", title: "Sync notes", status: "failed", finishedAt: 1500, notificationReady: true)
let running = I.Run(id: "c", title: "Draft weekly report", status: "running")
let approval = I.Run(id: "d", title: "Edit calendar", status: "awaiting-approval")
let reply = I.Run(id: "e", title: "Ask user", status: "awaiting-input")

var input = I()
check(S.derive(input).kind == .idle && S.derive(input).title == "AI Bro", "Empty workspace is idle")
input.ready = false
check(S.derive(input).kind == .preparing, "Unready workspace says it is preparing")
input.ready = true

input.runs = [done, failed, running, approval]
input.voice = .init(title: "Listening", symbol: "waveform", isProcessing: true)
input.recording = .recording(5); input.music = .init(title: "Song"); input.unread = 3
let voice = S.derive(input)
check(voice.kind == .voice && voice.busy && voice.tint == .accent, "Voice outranks every run state")
input.voice = nil
let awaiting = S.derive(input)
check(awaiting.kind == .awaiting && awaiting.tint == .amber && awaiting.runID == "d", "Awaiting approval outranks running and outcomes")
check(awaiting.title == "Needs review" && awaiting.trailing == nil && awaiting.actionWord == "Review" && awaiting.shoulder == nil && awaiting.detail == "Edit calendar", "Awaiting shows the action word")
check(awaiting.attention && !awaiting.busy, "Awaiting needs attention and does not shimmer")
input.runs.append(reply)
let two = S.derive(input)
check(two.trailing == "2" && two.shoulder == "2" && two.detail?.hasSuffix(" +1") == true, "Multiple waiting runs show a count")
input.runs = [reply]
check(S.derive(input).title == "Reply needed" && S.derive(input).symbol == "questionmark.bubble.fill", "Awaiting input asks for a reply")
input.runs = [.init(id: "s", title: "Save", status: "awaiting-save")]
check(S.derive(input).title == "Save needed", "Awaiting save asks for a save")

input.runs = [done, failed, running]
let live = S.derive(input)
check(live.kind == .running && live.busy && live.tint == .accent && live.detail == "Draft weekly…", "Running shows a clipped run title and shimmers")
input.runs = [done, failed]; input.busy = true
check(S.derive(input).kind == .running && S.derive(input).detail == nil, "A busy workspace without a projected run still reads as running")
input.busy = false

let failure = S.derive(input)
check(failure.kind == .failed && failure.tint == .red && failure.runID == "b", "Unseen failure outranks unseen completion")
input.seen.insert(S.outcomeKey(failed))
let completion = S.derive(input)
check(completion.kind == .completed && completion.runID == "a" && completion.trailing == nil && completion.title == "Done", "Reading the failure reveals the unseen completion")
input.seen.insert(S.outcomeKey(done))
check(S.derive(input).kind == .recording, "Read outcomes clear and ambient activity returns")
var retried = done; retried.finishedAt = 9000
input.runs = [retried]
check(S.derive(input).kind == .completed, "A later outcome for the same run alerts again")
input.runs = [.init(id: "x", title: "Stopped", status: "cancelled", finishedAt: 3000, notificationReady: true)]
check(S.derive(input).kind == .recording, "A user stop is not an alert")
input.runs = [.init(id: "y", title: "Unconfirmed", status: "completed", finishedAt: 3000, notificationReady: false)]
check(S.derive(input).kind == .recording, "Unconfirmed completion does not alert")
input.since = 5000
input.runs = [.init(id: "z", title: "Old", status: "failed", finishedAt: 4000, notificationReady: true)]
check(S.derive(input).kind == .recording, "History from before this session is not new")
input.runs = []

let rec = S.derive(input)
check(rec.trailing == "0:05" && rec.shoulder == "0:05" && rec.tint == .red && rec.busy, "Recording shows elapsed time")
input.recording = .paused(3725)
check(S.derive(input).trailing == "1:02:05" && S.derive(input).shoulder == "62:05" && S.derive(input).tint == .amber && !S.derive(input).busy, "Paused recording shows hours and stops pulsing")
input.recording = nil
let song = S.derive(input)
check(song.kind == .music && song.title == "Song", "Music playing outranks unread")
input.music = nil
let unread = S.derive(input)
check(unread.kind == .unread && unread.trailing == "3", "Unread shows a count")
input.unread = 250
check(S.derive(input).trailing == "99+", "Unread count is bounded")

check(S.clipped("line one\\nline two", 40) == "line one line two", "Labels are one line")
check(S.clipped("abcdefghij", 5) == "abcd…", "Long labels clip with an ellipsis")
check(S.clock(.nan) == "0:00" && S.clock(-4) == "0:00", "Invalid elapsed time is safe")

let measure: (String) -> CGFloat = { CGFloat($0.count) * 7 }
check(S.derive(I()).peekWidth(notchGap: 0, base: 176, measure: measure) == 176, "Idle keeps the existing unnotched footprint")
check(S.derive(I()).peekWidth(notchGap: 184, base: 248, measure: measure) == 248, "Idle keeps the existing notched footprint")
check(!live.peeks && live.peekWidth(notchGap: 0, base: 176, measure: measure) == 176, "Running renders inside the base footprint")
check(!rec.peeks && rec.peekWidth(notchGap: 184, base: 248, measure: measure) == 248, "Recording renders inside the base footprint")
let peek = failure.peekWidth(notchGap: 0, base: 176, measure: measure)
check(failure.peeks && peek > 176 && peek <= 176 + 88, "Attention grows modestly above the base")
let notchedPeek = awaiting.peekWidth(notchGap: 184, base: 248, measure: measure)
check(notchedPeek >= 248 && notchedPeek <= 248 + 56, "Notched attention grows modestly and symmetrically")
check(S(kind: .failed, symbol: "x", title: String(repeating: "w", count: 200)).peekWidth(notchGap: 0, base: 176, measure: measure) == 176 + 88, "Very long attention content stays bounded")
check(S(kind: .failed, symbol: "x", title: "").peekWidth(notchGap: 0, base: 400, measure: measure) == 400, "A peek never shrinks below the base")
check(failure.accessibilityValue == "Run failed, Sync notes", "Accessibility value names state and run")
print("PASS \\(checks) island status assertions")
`);
    const compiled = spawnSync('xcrun', ['swiftc', '-swift-version', '5', program, '-o', binary], { encoding: 'utf8', timeout: 60000 });
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /PASS \d+ island status assertions/);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
