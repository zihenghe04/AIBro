const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawnSync } = require('node:child_process');
test('T07 production deadline scheduler, durable dedupe, privacy invalidation and native settings compile', { skip: process.platform !== 'darwin', timeout: 120000 }, () => {
  const root = path.resolve(__dirname, '..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-task-reminder-'));
  try {
    // Compile the exact production projection definitions. The remaining
    // Workbench includes independent bridge/editing modules owned by other tests.
    const workbench = fs.readFileSync(path.join(root, 'native/Sources/AIBro/NativeQuickWorkbench.swift'), 'utf8');
    const marker = '\n/// Published rows are projections, never a second task database.';
    assert.equal(workbench.split(marker).length, 2);
    const models = path.join(temp, 'Projection.swift');
    fs.writeFileSync(models, workbench.split(marker)[0]);
    const names = ['NativeQuickTaskDeadline', 'NativeQuickNotificationQueue', 'NativeQuickNotificationSources',
      'NativeQuickTaskReminderArchive', 'NativeQuickTaskReminder', 'NativeQuickTaskReminderSettingsView'];
    const sources = names.map(n => path.join(root, 'native/Sources/AIBro', n + '.swift'));
    const binary = path.join(temp, 'checks');
    const build = spawnSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', models, ...sources,
      path.join(__dirname, 'native-quick-task-reminder.swift'), '-o', binary], { encoding: 'utf8', timeout: 90000 });
    assert.equal(build.status, 0, build.stdout + build.stderr);
    const run = spawnSync(binary, [temp], { encoding: 'utf8', timeout: 25000 });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /PASS: \d+ task reminder checks/); console.log(run.stdout.trim());
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
