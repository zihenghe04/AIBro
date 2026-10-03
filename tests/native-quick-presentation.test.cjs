const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

test('native island latest intent, reduced motion and physical display geometry', { skip: process.platform !== 'darwin', timeout: 90000 }, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-island-presentation-'));
  try {
    const source = fs.readFileSync(path.join(root, 'native/Sources/AIBro/NativeQuickPresentation.swift'), 'utf8');
    const program = path.join(temporary, 'main.swift'), binary = path.join(temporary, 'checks');
    fs.writeFileSync(program, source + `
func check(_ value: @autoclosure () -> Bool, _ message: String) {
    precondition(value(), message)
}
var motion = NativeQuickPresentation()
let opening = motion.request(expanded: true, reducedMotion: false)!
check(motion.phase == .opening && !motion.contentVisible, "Opening must not expose content before reveal")
check(!motion.shellExpanded, "Opening intent waits for the committed canvas before changing the shape")
check(motion.animateShell(opening) && motion.shellExpanded, "Committed opening can start its shell animation")
check(motion.request(expanded: true, reducedMotion: false) == nil, "Duplicate open must not replace its transition")
let closing = motion.request(expanded: false, reducedMotion: false)!
check(motion.shellExpanded && !motion.contentVisible, "Closing revokes interaction while retaining the full canvas for body exit")
check(!motion.revealContent(opening), "Stale opening cannot reveal content during close")
check(!motion.settle(opening), "Stale opening cannot undo close")
let reopened = motion.request(expanded: true, reducedMotion: false)!
check(!motion.settle(closing), "Old closing completion cannot collapse a reopened panel")
check(motion.revealContent(reopened), "Current opening reveals content")
check(motion.settle(reopened) && motion.phase == .expanded, "Latest intent settles expanded")
let fadingClose = motion.request(expanded: false, reducedMotion: false)!
check(!motion.contentVisible && !motion.visualContentVisible && motion.shellExpanded, "Content exits before the shell begins shrinking")
let fadingReopen = motion.request(expanded: true, reducedMotion: false)!
check(motion.contentVisible && motion.visualContentVisible, "Reversing visible close restores body without another black 110ms gap")
check(!motion.animateShell(fadingClose), "Old fade receipt cannot shrink the newly reopened shell")
check(motion.animateShell(fadingReopen) && motion.settle(fadingReopen), "New opening owns completion")
let shrinkingClose = motion.request(expanded: false, reducedMotion: false)!
check(motion.animateShell(shrinkingClose) && !motion.shellExpanded, "A content exit receipt starts collapse")
let shrinkingReopen = motion.request(expanded: true, reducedMotion: false)!
check(motion.contentVisible && !motion.shellExpanded, "An in-flight shrinking body resumes immediately while shape awaits its reversal")
check(!motion.settle(shrinkingClose) && !motion.animateShell(shrinkingClose), "Neither stale shell nor fade completion owns a later opening")
check(motion.animateShell(shrinkingReopen) && motion.settle(shrinkingReopen), "Reverse shrinking shell returns expanded")
check(!motion.settle(shrinkingReopen), "A late completion after watchdog cannot replay focus or resize in the same generation")
let cancelled = motion.request(expanded: false, reducedMotion: false)!
motion.reset()
check(!motion.settle(cancelled) && motion.phase == .collapsed, "Stop or mode reset invalidates outstanding callbacks")
let disabledDuringOpening = motion.request(expanded: true, reducedMotion: false)!
motion.reset()
check(!motion.wantsExpanded && !motion.contentVisible && !motion.settle(disabledDuringOpening), "Disabling an opening entry cancels its pending reveal and finish")
let reenabled = motion.request(expanded: true, reducedMotion: false)!
check(motion.revealContent(reenabled) && motion.settle(reenabled), "The entry can open normally after being enabled again")
_ = motion.request(expanded: false, reducedMotion: true)
_ = motion.request(expanded: true, reducedMotion: true)
check(motion.phase == .expanded && motion.contentVisible, "Reduced motion opens without a timer")
_ = motion.request(expanded: false, reducedMotion: true)
check(motion.phase == .collapsed && !motion.contentVisible, "Reduced motion closes without a timer")
check(!motion.shellExpanded && !motion.visualContentVisible, "Reduced motion settles both visual surfaces together")
let freshOpen = motion.request(expanded: true, reducedMotion: false)!
check(!motion.contentVisible && !motion.shellExpanded, "After a complete close the next opening retains its initial reveal delay")
_ = motion.settle(freshOpen)
_ = motion.request(expanded: false, reducedMotion: true)
let interrupted = motion.request(expanded: true, reducedMotion: false)!
motion.settleImmediately()
check(motion.phase == .expanded && !motion.settle(interrupted), "Enabling reduced motion invalidates the old timer")
for index in 0..<1000 {
    let target = index % 3 != 0
    if let token = motion.request(expanded: target, reducedMotion: false) { _ = motion.settle(token) }
    check(motion.wantsExpanded == target, "Repeated toggles follow the last intent")
}

let screen = CGRect(x: 0, y: 0, width: 1512, height: 982)
let visible = CGRect(x: 0, y: 64, width: 1512, height: 881)
let notch = NativeQuickGeometry.resolve(screen: screen, visible: visible, safeTop: 37,
    leftArea: CGRect(x: 0, y: 945, width: 664, height: 37),
    rightArea: CGRect(x: 848, y: 945, width: 664, height: 37), placement: .island)
check(notch.hardwareWidth == 184, "Use the actual gap between safe menu areas")
check(notch.collapsed.maxY == screen.maxY && notch.expanded.maxY == screen.maxY, "Both states touch the physical top edge")
check(notch.collapsed.midX == notch.expanded.midX, "Opening preserves the island anchor")
check(notch.safeTop >= 37, "All expanded controls remain below the camera obstruction")
check(notch.expanded.minY >= screen.minY, "Expanded panel fits the screen")
check(notch.expanded.width == 760 && notch.expanded.height == 520, "Quick entry has a compact stable canvas instead of the full upstream dashboard")
let narrowScreen = CGRect(x: 0, y: 0, width: 800, height: 600)
let narrow = NativeQuickGeometry.resolve(screen: narrowScreen, visible: narrowScreen, safeTop: 0, placement: .island)
check(narrow.expanded.width == 640 && narrow.expanded.height == 450, "Small displays retain surrounding context instead of almost filling the screen")
for size in [CGSize(width: 1280, height: 800), CGSize(width: 3440, height: 1440), CGSize(width: 600, height: 400)] {
    let bounds = CGRect(origin: .zero, size: size)
    let fitted = NativeQuickGeometry.resolve(screen: bounds, visible: bounds, safeTop: 0, placement: .island)
    check(fitted.expanded.width <= size.width * 0.8 && fitted.expanded.height <= size.height * 0.75, "Quick entry preserves screen context at laptop, ultrawide and small display sizes")
    check(bounds.contains(fitted.expanded), "The compact canvas never leaves the display")
}
let external = CGRect(x: -1920, y: 500, width: 1920, height: 1080)
let externalVisible = CGRect(x: -1920, y: 500, width: 1920, height: 1056)
let plain = NativeQuickGeometry.resolve(screen: external, visible: externalVisible, safeTop: 0, placement: .island)
check(plain.hardwareWidth == 0 && plain.collapsed.width == 176, "Unnotched display uses compact fallback")
check(plain.expanded.maxY == 1580 && plain.expanded.midX == -960, "Screen above/left of primary keeps physical coordinates")
let edge = NativeQuickGeometry.resolve(screen: external, visible: externalVisible, safeTop: 0, placement: .edge)
check(edge.expanded.maxX == edge.collapsed.maxX && edge.expanded.midY == edge.collapsed.midY, "Edge mode retains right-center anchor")
check(externalVisible.contains(edge.expanded), "Edge expansion fits usable area")
let menu = NativeQuickGeometry.resolve(screen: external, visible: externalVisible, safeTop: 0, placement: .menu,
    menuAnchor: CGRect(x: -30, y: 1556, width: 24, height: 24))
check(externalVisible.contains(menu.expanded), "Menu panel clamps at right edge")
let fullScreen = NativeQuickGeometry.resolve(screen: screen, visible: screen, safeTop: 37,
    leftArea: CGRect(x: 0, y: 945, width: 664, height: 37), rightArea: CGRect(x: 848, y: 945, width: 664, height: 37), placement: .island)
check(fullScreen.safeTop == 37, "Auto-hidden menu bar never removes hardware clearance")
print("PASS: transition ownership, reduced motion and five display placements")
`);
    const compiled = spawnSync('xcrun', ['swiftc', '-swift-version', '5', program, '-o', binary], { encoding: 'utf8', timeout: 60000 });
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /PASS: transition ownership/);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('entry has one window and keeps task and capture writes in production stores', () => {
  const source = fs.readFileSync(path.join(root, 'native/Sources/AIBro/NativeQuickEntry.swift'), 'utf8');
  assert.doesNotMatch(source, /NativeQuickEntryPillPanel|\.animator\(\)|setFrame\([^\n]+animate:/);
  assert.match(source, /auxiliaryTopLeftArea/);
  assert.match(source, /screen: screen\.frame/);
  assert.match(source, /capture\.flushDraft\(\)/);
  assert.match(source, /await workbench\.createTask\(title: submitted, fields: submittedFields\)/);
  assert.match(source, /if saved && coordinator\.taskDraft\.trimmingCharacters/);
  assert.match(source, /workbench\.pendingTaskTitle \?\? coordinator\.taskDraft/);
  assert.match(source, /if workbench\.preservePendingTaskAndStartNew\(\)/);
  const taskList = fs.readFileSync(path.join(root, 'native/Sources/AIBro/NativeQuickTaskListView.swift'), 'utf8');
  assert.match(taskList, /await workbench\.setTaskCompleted/);
  assert.match(source, /await workbench\.cancelRun/);
  assert.doesNotMatch(source, /workbench\.tasks\.(?:append|remove)|item\.isCompleted\s*=/);
  const disabledEntry = source.slice(source.indexOf('if mode == .off {'), source.indexOf('if statusItem == nil {'));
  assert.match(disabledEntry, /motionTask\?\.cancel\(\)[\s\S]*presentation\.reset\(\)/);
  assert.match(disabledEntry, /panel\?\.allowsKey = false/);
  assert.match(disabledEntry, /panel\?\.ignoresMouseEvents = false[\s\S]*panel\?\.orderOut\(nil\)/);
});
