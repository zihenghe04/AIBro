'use strict';
// 配色主题：三套（蓝灰 / 液态玻璃 / 青绿）各有浅色和深色，与外观设置分开；未选择时保持平台自带配色。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const app = read('app/app.js'), themes = read('app/themes.css');

function declarations(css, selector) {
  const start = css.indexOf(selector + ' {'); assert.ok(start >= 0, `missing ${selector}`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)].map(([, name, value]) => [name, value.trim().replace(/\s+/g, ' ')]));
}
const theme = (name, mode) => declarations(themes, `html[data-palette="${name}"]:root body[data-view]${mode === 'light' ? '.light-mode' : ':not(.light-mode)'}`);

test('every theme defines the same colour roles in light and dark', () => {
  const roles = ['--bg', '--panel', '--panel-raised', '--panel-hover', '--canvas', '--glass', '--line', '--line-strong', '--rim', '--text', '--muted', '--faint', '--accent', '--accent-soft', '--accent-solid', '--green', '--orange', '--red', '--surface-wash'];
  for (const name of ['blue', 'glass', 'teal']) for (const mode of ['light', 'dark']) {
    const values = theme(name, mode);
    for (const role of roles) assert.ok(values[role], `${name} ${mode} defines ${role}`);
  }
  assert.notEqual(theme('blue', 'light')['--accent'], theme('blue', 'dark')['--accent']);
});

test('theme values are the shipped palettes, copied without change', () => {
  const tokens = read('app/tokens.css'), glass = read('app/liquid-glass.css'), native = read('native/Resources/workspace.css');
  const same = (themeValues, source, label) => { for (const [name, value] of Object.entries(themeValues)) if (source[name] !== undefined) assert.equal(value, source[name].replace(/\s+/g, ' '), `${label} ${name}`); };
  same(theme('blue', 'dark'), declarations(tokens, ':root'), 'blue dark');
  same(theme('blue', 'light'), declarations(tokens, 'body.light-mode'), 'blue light');
  same(theme('glass', 'dark'), declarations(glass, 'body.liquid-glass[data-view]'), 'glass dark');
  same(theme('glass', 'light'), declarations(glass, 'body.liquid-glass[data-view].light-mode'), 'glass light');
  const rule = selector => { const row = native.split('\n').find(text => text.startsWith(selector) && /^\s?\{/.test(text.slice(selector.length))); assert.ok(row, selector); return Object.fromEntries([...row.slice(row.indexOf('{') + 1).matchAll(/(--[\w-]+):([^;}]+)/g)].map(([, n, v]) => [n, v.trim()])); };
  const nativeLight = rule('html body.aibro-native[data-view],html body.aibro-native[data-view].light-mode'), nativeDark = { ...nativeLight, ...rule('html body.aibro-native[data-view]:not(.light-mode)') };
  same(theme('teal', 'light'), nativeLight, 'teal light'); same(theme('teal', 'dark'), nativeDark, 'teal dark');
});

test('theme selectors outrank the liquid-glass and native palettes', () => {
  // (0,4,2) > liquid glass (0,3,1) and native workspace.css (0,3,2), which the Swift shell injects last.
  assert.match(themes, /html\[data-palette="teal"\]:root body\[data-view\]\.light-mode \{/);
  assert.match(read('app/index.html'), /href="macos-chrome.css"\/>\n<link rel="stylesheet" href="themes.css"\/>/);
  assert.ok(JSON.parse(read('app/asset-manifest.json')).files?.includes?.('themes.css') ?? read('app/asset-manifest.json').includes('"themes.css"'));
});

function harness(native) {
  const start = app.indexOf('const THEME_PALETTES'), end = app.indexOf('function applyUiPreferences', start);
  const root = { dataset: {} }, select = { value: '' };
  const context = { state: { ui: {} }, document: { documentElement: root, body: { classList: { contains: name => native && name === 'aibro-native' } } }, $: selector => selector === '#paletteSelect' ? select : null };
  vm.createContext(context); vm.runInContext(app.slice(start, end), context);
  return { context, root, select };
}

test('no choice keeps the platform palette with no override; a different choice sets data-palette', () => {
  const web = harness(false); web.context.applyPalette({});
  assert.equal(web.root.dataset.palette, undefined); assert.equal(web.select.value, 'glass');
  web.context.applyPalette({ palette: 'teal' }); assert.equal(web.root.dataset.palette, 'teal'); assert.equal(web.select.value, 'teal');
  web.context.applyPalette({ palette: 'glass' }); assert.equal(web.root.dataset.palette, undefined, 'choosing the built-in palette removes the override');
  const native = harness(true); native.context.applyPalette({});
  assert.equal(native.root.dataset.palette, undefined); assert.equal(native.select.value, 'teal');
  native.context.applyPalette({ palette: 'blue' }); assert.equal(native.root.dataset.palette, 'blue');
  native.context.applyPalette({ palette: 'nonsense' }); assert.equal(native.root.dataset.palette, undefined);
});

test('the choice is stored in the workspace, validated on load, and offered in Settings', () => {
  assert.match(app, /if \(!\['blue', 'glass', 'teal'\]\.includes\(state\.ui\.palette\)\) delete state\.ui\.palette;/);
  assert.match(app, /\$\('#paletteSelect'\)\?\.addEventListener\('change', event => \{ if \(!THEME_PALETTES\.includes\(event\.target\.value\)\) return; state\.ui\.palette = event\.target\.value; applyUiPreferences\(\); save\(\); \}\);/);
  const html = read('app/index.html');
  for (const option of ['value="blue" data-i18n>蓝灰', 'value="glass" data-i18n>中性灰', 'value="teal" data-i18n>青绿']) assert.ok(html.includes(option));
  const native = read('native/Resources/bridge.js'), swift = read('native/Sources/AIBro/AIBro.swift');
  assert.match(native, /const data=\{palette:typeof effectivePalette==='function'\?effectivePalette\(\):'teal',/);
  assert.match(swift, /let palette:String\? \}/); assert.match(swift, /StudioPalette\.theme=palette/);
});

test('native shell remembers the confirmed theme per data directory and applies it at launch', () => {
  const swift = read('native/Sources/AIBro/AIBro.swift');
  const init = swift.slice(swift.indexOf('override init()'), swift.indexOf('agendaAgent.configure('));
  assert.match(init, /super\.init\(\)\s*\n\s*if let saved=UserDefaults\.standard\.string\(forKey:"AIBro\.theme\."\+dataDirectory\.standardizedFileURL\.path\),StudioPalette\.themes\.contains\(saved\) \{StudioPalette\.theme=saved\}/);
  assert.match(swift, /UserDefaults\.standard\.set\(palette,forKey:themeDefaultsKey\)/);
  assert.match(swift, /private var themeDefaultsKey:String \{"AIBro\.theme\."\+dataDirectory\.standardizedFileURL\.path\}/);
  assert.match(swift, /static var theme="teal"/, 'with nothing saved the shell stays teal exactly as before');
});

test('native shell applies the saved appearance per data directory before the first snapshot', () => {
  const swift = read('native/Sources/AIBro/AIBro.swift');
  const init = swift.slice(swift.indexOf('override init()'), swift.indexOf('web.navigationDelegate = self'));
  assert.match(init, /appearance=NativeAppearancePolicy\.resolved\(perDirectory:UserDefaults\.standard\.string\(forKey:appearanceDefaultsKey\),global:UserDefaults\.standard\.string\(forKey:"NativePreviewAppearance"\)\)/, 'per-directory choice first, the global preference stays the fallback');
  assert.match(init, /if appearance != "system" \{NSApplication\.shared\.appearance=NSAppearance\(named:appearance == "light" \? \.aqua:\.darkAqua\)\}/);
  assert.match(swift, /UserDefaults\.standard\.set\(value,forKey:appearanceDefaultsKey\)\n\s*if NativeAppearancePolicy\.writesGlobal\(dataPath:dataDirectory\.standardizedFileURL\.path,defaultPath:defaultDataDirectory\.standardizedFileURL\.path\) \{UserDefaults\.standard\.set\(value,forKey:"NativePreviewAppearance"\)\}/, 'only the default data directory writes the shared key');
  assert.equal((swift.match(/forKey:"NativePreviewAppearance"\)\}/g) || []).length, 1, 'no other unconditional global write');
  assert.match(init, /\} else \{dataDirectory=defaultDataDirectory\}/, 'without an override the default directory is the data directory');
  assert.match(swift, /private var appearanceDefaultsKey:String \{"AIBro\.appearance\."\+dataDirectory\.standardizedFileURL\.path\}/);
});
