'use strict';
// 语义色与字体令牌：定义在 tokens.css 的 body 上，跟随各主题的 --red/--orange/--green/--muted；
// 一方样式表不再用 var(--danger,#xxxxxx) 这类各自不同的兜底值。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const dir = path.join(__dirname, '..', 'app');
const tokens = fs.readFileSync(path.join(dir, 'tokens.css'), 'utf8');
const sheets = [...fs.readdirSync(dir).filter(f => f.endsWith('.css')).map(f => path.join(dir, f)), ...fs.readdirSync(path.join(dir, 'ui')).filter(f => f.endsWith('.css')).map(f => path.join(dir, 'ui', f))]
  .filter(file => !/document-(editors|markdown)\.css$/.test(file));

test('semantic tokens are defined once, on body, from the theme roles', () => {
  const body = tokens.slice(tokens.indexOf('\nbody {'), tokens.indexOf('}', tokens.indexOf('\nbody {')));
  for (const [name, value] of [['--danger', 'var(--red)'], ['--warning', 'var(--orange)'], ['--success', 'var(--green)'], ['--text-muted', 'var(--muted)']]) assert.ok(body.includes(`${name}:${value}`), name);
  assert.match(body, /--font-sans:-apple-system,/); assert.match(body, /--font-mono:ui-monospace,/);
});

test('first-party stylesheets use the tokens without per-site fallbacks', () => {
  const offenders = [];
  for (const file of sheets) {
    const css = fs.readFileSync(file, 'utf8');
    for (const match of css.matchAll(/var\(\s*--(danger|warning|success|text-muted|font-sans|font-mono)\s*,[^;}]*/g)) offenders.push(`${path.relative(dir, file)}: ${match[0].slice(0, 60)}`);
    for (const match of css.matchAll(/font-family:\s*Geist,[^;}]*/g)) offenders.push(`${path.relative(dir, file)}: ${match[0]}`);
  }
  assert.deepEqual(offenders, []);
});
