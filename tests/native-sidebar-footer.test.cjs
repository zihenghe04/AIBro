const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const swift = fs.readFileSync(path.join(__dirname, '../native/Sources/AIBro/AIBro.swift'), 'utf8');
const footer = swift.slice(swift.indexOf('// Footer buttons fill their row'), swift.indexOf('.navigationSplitViewColumnWidth(min:220'));

test('native sidebar settings button fills its row with a 32 pt hit height', () => {
  assert.ok(footer.length > 0 && footer.length < 2000, 'footer block found');
  assert.match(footer, /openWorkspaceSettings\(\) \} label: \{ SidebarFooterLabel\(title:nativeUI\("设置", "Settings"\),symbol:"gearshape"\)\.frame\(maxWidth:\.infinity,alignment:\.leading\) \}/);
  assert.match(swift, /struct SidebarFooterLabel: View \{[^]*?\.frame\(minHeight:32\)/);
  // LiftStyle's content shape covers the whole label frame, so the padded frame is the hit area.
  assert.match(swift, /content\.contentShape\(RoundedRectangle\(cornerRadius:10\)\)/);
});

test('island entry is labelled text plus a top-of-screen symbol, not the split-view glyph', () => {
  assert.doesNotMatch(footer, /rectangle\.trailinghalf\.inset\.filled/);
  assert.match(footer, /SidebarFooterLabel\(title:nativeUI\("灵动岛", "Island"\),symbol:"rectangle\.topthird\.inset\.filled"\)/);
  assert.match(footer, /\.help\(nativeUI\("打开灵动岛与快捷入口/);
  assert.match(footer, /\.accessibilityLabel\(nativeUI\("灵动岛与快捷入口", "Island & quick entry"\)\)/);
});

test('web sidebar settings entry stays a full-width nav item', () => {
  const html = fs.readFileSync(path.join(__dirname, '../app/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../app/styles.css'), 'utf8');
  assert.match(html, /<div class="sidebar-bottom"><button class="nav-item" data-view="settings">/);
  assert.match(css, /\.tool-link,\.nav-item\{padding:var\(--space-9\) var\(--space-11\);width:100%/);
});
