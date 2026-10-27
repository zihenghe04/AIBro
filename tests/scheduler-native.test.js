const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('scheduler reminders are handed to the system ahead of time and survive quitting', () => {
  const host = read('native/Sources/AIBro/NativeKernelHost.swift');
  assert.match(host, /if let reminders = pending\["reminders"\] as\? \[\[String: Any\]\] \{ await planReminders\(reminders\) \}/);
  assert.match(host, /static let reminderPrefix = "scheduler-reminder-"/);
  // Future reminders: a calendar trigger the system keeps after the app quits.
  assert.match(host, /UNCalendarNotificationTrigger\(dateMatching: parts, repeats: false\)/);
  // Only our own prefix is withdrawn; agenda notifications are untouched.
  assert.match(host, /filter \{ \$0\.hasPrefix\(Self\.reminderPrefix\) \}/);
  assert.match(host, /guard notificationsEnabled else \{ return \}/);
  const kernel = read('app/server.py');
  assert.match(kernel, /KERNEL_RUNS\.extra_pending = lambda: \{'reminders': SCHEDULER\.notifications\(\)\}/);
});

test('start in background at login: hidden only when opened as a login item with the option on', () => {
  const login = read('native/Sources/AIBro/NativeQuickLoginItem.swift'), app = read('native/Sources/AIBro/AIBro.swift'), view = read('native/Sources/AIBro/NativeQuickLoginItemView.swift');
  assert.match(login, /launchedAsLoginItem && defaults\.bool\(forKey: backgroundKey\)/);
  assert.match(login, /keyAELaunchedAsLogInItem/);
  assert.match(app, /NativeLoginLaunch\.startHidden\(launchedAsLoginItem:NativeLoginLaunch\.launchedAsLoginItem\(NSAppleEventManager\.shared\(\)\.currentAppleEvent\)\)/);
  assert.match(view, /@AppStorage\(NativeLoginLaunch\.backgroundKey\)/);
  assert.match(view, /\.disabled\(!store\.status\.isRegistered\)/);
});
