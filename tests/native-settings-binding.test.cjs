const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'native/Sources/AIBro', f), 'utf8');
const voice = src('NativeSettingsVoiceBinding.swift');
const quick = src('NativeSettingsQuickBinding.swift');
const trigger = src('NativeDictateTrigger.swift');

test('dictation trigger change goes through setKind, not a bare preference write', () => {
  const m = voice.match(/case \("dictate\.trigger"[\s\S]*?setKind\(kind\)/);
  assert.ok(m, 'dictate.trigger must call dictate.setKind');
  assert.doesNotMatch(m[0], /UserDefaults|\.set\(/);
  const fn = trigger.match(/func setKind\([\s\S]*?\n    \}/);
  assert.ok(fn && /refresh\(force: true\)/.test(fn[0]), 'setKind must re-register immediately via refresh(force: true)');
});

test('dictation enable, combo and speech writes use the stores entry points', () => {
  for (const call of ['dictate.setEnabled(on)', 'dictate.apply(', 'speech.apply(', 'speech.setMode(mode)', 'speech.setAutoSubmit(on)'])
    assert.ok(voice.includes(call), call);
});

test('silence is clamped to 0...10 with default 1.5 and the existing key', () => {
  assert.match(voice, /"aibro\.dictation\.silenceSeconds"/);
  assert.match(voice, /defaultSilence = 1\.5/);
  assert.match(voice, /min\(max\(seconds, 0\), 10\)/);
});

test('permission status is read-only and never requests access', () => {
  assert.doesNotMatch(voice, /case \("dictate\.access"/);
  assert.doesNotMatch(voice, /requestAccess|AXIsProcessTrustedWithOptions|CGRequestListenEventAccess/);
});

test('quick binding: one preferences key split per id, stamp verified before apply', () => {
  assert.match(quick, /quickPanel\.section\./);
  assert.match(quick, /quickPanel\.home\./);
  assert.match(quick, /quickPanel\.size\./);
  assert.match(quick, /quickPanel\.move\./);
  assert.match(quick, /guard clipboard\.retentionPreview != nil/);
  assert.match(quick, /applyRetention\(\)/);
  assert.doesNotMatch(quick, /clipboard\.(delete|purge|clear)/i);
});

test('login background is stored under the existing key and login uses the store', () => {
  assert.match(quick, /NativeLoginLaunch\.backgroundKey/);
  assert.match(quick, /login\.setEnabled\(on\)/);
});

test('no credential words in either binding', () => {
  for (const s of [voice, quick]) assert.doesNotMatch(s, /apiKey|token|password|secret/i);
});
