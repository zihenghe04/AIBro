#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { command, treeHash } = require('./release-runtime');

// Package an already verified release bundle, never the installed user app.
function buildDmg({ app, output, minimumMacOS = '12' }) {
  if (process.platform !== 'darwin') throw Error('DMG packaging requires macOS.');
  app = path.resolve(app); output = path.resolve(output);
  if (!output.endsWith('.dmg') || fs.existsSync(output)) throw Error('Use a new .dmg output path.');
  if (path.basename(app) !== 'AI Bro.app' || !fs.existsSync(path.join(app, 'Contents/Info.plist'))) throw Error('Expected a release AI Bro.app bundle.');
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const before = treeHash(app);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-dmg-'));
  const contents = path.join(stage, 'contents'), mount = path.join(stage, 'mounted');
  const temporary = path.join(stage, 'AI Bro.dmg');
  let attached = false;
  try {
    fs.mkdirSync(contents); fs.mkdirSync(mount);
    command('/usr/bin/ditto', ['--noqtn', app, path.join(contents, 'AI Bro.app')]);
    fs.symlinkSync('/Applications', path.join(contents, 'Applications'));
    fs.writeFileSync(path.join(contents, 'Install - 安装.txt'), `AI Bro\n\n将 AI Bro.app 拖到 Applications，然后从应用程序打开。\nDrag AI Bro.app to Applications, then open it from Applications.\n\n更新前请退出旧版本。个人工作区会保留。\nQuit the older app before replacing it. Your workspace is retained.\n\nApple Silicon · macOS ${minimumMacOS}+ · Developer preview\n本预览版尚未经 Apple 公证。\nThis preview is not Apple-notarized.\nhttps://github.com/zihenghe04/AIBro\n`);
    command('/usr/bin/hdiutil', ['create', '-volname', 'AI Bro', '-srcfolder', contents, '-format', 'UDZO', '-fs', 'HFS+', temporary]);
    command('/usr/bin/hdiutil', ['verify', temporary]);
    command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, temporary]); attached = true;
    command('/usr/bin/codesign', ['--verify', '--deep', '--strict', path.join(mount, 'AI Bro.app')]);
    if (treeHash(path.join(mount, 'AI Bro.app')) !== before || treeHash(app) !== before) throw Error('DMG application differs from the reviewed bundle.');
    if (fs.readlinkSync(path.join(mount, 'Applications')) !== '/Applications') throw Error('Invalid installation shortcut.');
    command('/usr/bin/hdiutil', ['detach', mount]); attached = false;
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(temporary, output, fs.constants.COPYFILE_EXCL);
    return { output, appTreeSha256: before, verified: true };
  } finally {
    if (attached) command('/usr/bin/hdiutil', ['detach', mount]);
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--app' || args[2] !== '--output') throw Error('Usage: node scripts/release-dmg.js --app RELEASE_APP --output NEW_DMG');
  console.log(JSON.stringify(buildDmg({ app: args[1], output: args[3] }), null, 2));
}
module.exports = { buildDmg };
