const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');
const pkg = JSON.parse(source('package.json'));
const builder = source('build-electron-app.sh');

test('AI Bro display/package names retain the existing application bundle identity', () => {
  assert.equal(pkg.name, 'ai-bro');
  assert.equal(pkg.productName, 'AI Bro');
  assert.equal(pkg.build.productName, 'AI Bro');
  assert.equal(pkg.build.appId, 'app.ai-workstation.studio');
  assert.equal(pkg.private, true);
  assert.equal(pkg.main, 'electron-main.js');
  assert.equal(pkg.build.mac.icon, 'ai-bro-icon.icns');
});

test('both builders select the AI Bro icon and preserve one default output and runtime executable', () => {
  assert.match(builder, /OUT_APP="\$\{AI_WORKSTATION_OUT_APP:-\$ROOT_DIR\/AI Bro\.app\}"/);
  assert.match(builder, /^APP_ID="app\.ai-workstation\.studio"$/m);
  assert.doesNotMatch(builder, /AI_WORKSTATION_APP_ID/);
  assert.match(builder, /Set :CFBundleName AI Bro/);
  assert.match(builder, /Set :CFBundleDisplayName AI Bro/);
  assert.match(builder, /Set :CFBundleExecutable Electron/);
  assert.match(builder, /Set :CFBundleIconFile ai-bro-icon\.icns/);
  assert.match(builder, /cp "\$ROOT_DIR\/ai-bro-icon\.icns" "\$OUT_APP\/Contents\/Resources\/ai-bro-icon\.icns"/);
  assert.doesNotMatch(builder, /(?:rm|mv|cp|ditto).*AI Workstation\.app/);
  assert.doesNotMatch(builder, /(?:rm|mv|cp|ditto).*ai-workstation-studio/);
  const module = { exports: {} }, files = ['index.html', 'ai-bro-icon.png', 'package.json'];
  vm.runInNewContext(source('electron-builder.config.cjs'), {
    module, __dirname: root,
    require: name => name === './app-assets' ? { validateAssets: () => ({ files }) } : pkg
  });
  assert.equal(module.exports.appId, 'app.ai-workstation.studio');
  assert.equal(module.exports.productName, 'AI Bro');
  assert.equal(module.exports.mac.icon, 'ai-bro-icon.icns');
  assert.equal(module.exports.asar, false);
  assert.equal(module.exports.files, files);
});

function iconPreflight(icons) {
  const marker = 'node - "$ROOT_DIR" <<\'NODE\'\n';
  const start = builder.indexOf(marker) + marker.length;
  assert.ok(start >= marker.length);
  const end = builder.indexOf('\nNODE', start);
  assert.ok(end < builder.indexOf('rm -rf "$OUT_APP"'));
  const errors = [];
  const context = {
    require: name => name === 'path' ? path : { readFileSync: filename => {
      const bytes = icons[path.basename(filename)];
      if (!bytes) throw new Error('synthetic missing icon');
      return bytes;
    } },
    Buffer, process: { argv: ['node', '-', '/synthetic'], exit: code => { throw Object.assign(new Error('exit'), { exitCode: code }); } },
    console: { error: message => errors.push(message) }
  };
  try { vm.runInNewContext(builder.slice(start, end), context); return { errors, exitCode: 0 }; }
  catch (error) { if (error.exitCode) return { errors, exitCode: error.exitCode }; throw error; }
}

test('icon preflight fails before bundle replacement when PNG or ICNS inputs are absent or malformed', () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const icns = Buffer.alloc(8); icns.write('icns'); icns.writeUInt32BE(8, 4);
  const valid = { 'ai-bro-icon.png': png, 'ai-bro-icon.icns': icns };
  assert.equal(iconPreflight(valid).exitCode, 0);
  for (const icons of [{}, { 'ai-bro-icon.png': png }, { ...valid, 'ai-bro-icon.png': Buffer.from('not png!') }, { ...valid, 'ai-bro-icon.icns': Buffer.from('not icns') }, { ...valid, 'ai-bro-icon.icns': Buffer.concat([icns, Buffer.from('length mismatch')]) }]) {
    const result = iconPreflight(icons);
    assert.equal(result.exitCode, 1);
    assert.match(result.errors.join(''), /现有 App 未被改动/);
  }
});

test('launch messages use AI Bro while existing runtime selection and shell syntax remain valid', () => {
  const launcher = source('run-electron.sh');
  assert.match(launcher, /AI Bro could not find an Electron executable/);
  assert.match(launcher, /AI Bro: using Electron runtime/);
  assert.match(launcher, /ELECTRON_BIN/);
  for (const filename of ['run-electron.sh', 'build-electron-app.sh']) {
    const result = spawnSync('/bin/sh', ['-n', path.join(root, filename)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});
