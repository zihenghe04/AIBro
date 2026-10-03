// Each caller owns its compiled fixture and generated wire payload. There is
// no checked-in acceptance record or cross-test producer/consumer ordering.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
function nativeAgendaFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-agenda-agent-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const binary = path.join(directory, 'checks'), payload = path.join(directory, 'native-roundtrip.json');
  const names = ['AgendaCore', 'AgendaSync', 'AgendaEditing', 'AgendaStore', 'AgendaAgentAccess', 'AgendaAgentReview'];
  const build = spawnSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5',
    ...names.map(name => path.join(ROOT, 'native/Sources/AIBro', name + '.swift')),
    path.join(ROOT, 'tests/agenda-agent-native.swift'), '-o', binary], { encoding: 'utf8', timeout: 100000 });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const result = spawnSync(binary, [payload], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /agenda agent checks passed/);
  return { directory, wire: JSON.parse(fs.readFileSync(payload, 'utf8')), stdout: result.stdout };
}
module.exports = { nativeAgendaFixture };
