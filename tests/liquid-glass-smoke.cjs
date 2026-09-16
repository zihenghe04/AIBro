const { app, BrowserWindow, nativeTheme } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-glass-qa-'));
app.setPath('userData', profile); app.disableHardwareAcceleration();
let window;
const run = script => window.webContents.executeJavaScript(script, true);
app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 1440, height: 1000, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  await window.loadFile(path.join(directory, 'index.html'));
  await run(`window.WorkstationOnboarding?.close(); document.querySelector('#onboardingLayer')?.remove(); window.LiquidGlass?.init(); window.showView('agent','持续对话');`);
  const report = [];
  for (const width of [1440, 650]) {
    window.setSize(width, 1000);
    for (const theme of ['light', 'dark']) {
      await run(`document.body.classList.toggle('light-mode',${theme === 'light'});`);
      await new Promise(resolve => setTimeout(resolve, 120));
      const result = await run(`(() => {
        const body=document.body, composer=document.querySelector('#composer'), sidebar=document.querySelector('#sidebar');
        const size=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
        body.classList.remove('liquid-glass'); const before={sidebar:size(sidebar),composer:size(composer),main:size(document.querySelector('.main'))};body.classList.add('liquid-glass'); const after={sidebar:size(sidebar),composer:size(composer),main:size(document.querySelector('.main'))};
        const css=getComputedStyle(composer), lens=getComputedStyle(sidebar,'::before');return {before,after,width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,blur:css.backdropFilter,composerRadius:css.borderRadius,lens:lens.backgroundImage,rim:getComputedStyle(composer,'::after').pointerEvents,paper:getComputedStyle(document.querySelector('.main')).backgroundColor};
      })()`);
      assert.deepEqual(result.before, result.after, `material must not change layout ${width}/${theme}`); assert.equal(result.overflow, false); assert.match(result.blur, /url\(.*aw-glass-lens-/); assert.match(result.lens, /radial-gradient/); assert.equal(result.rim, 'none');
      // Geometry toggling above restarts inherited button color transitions.
      // Inspect the resting material rather than a partly transitioned frame.
      await new Promise(resolve => setTimeout(resolve, 300));
      const file = path.join(directory, 'design', `qa-liquid-glass-${theme}-${width}.png`); fs.writeFileSync(file, (await window.webContents.capturePage()).toPNG());
      report.push({ width, theme, blur: result.blur, paper: result.paper, geometry: 'unchanged', screenshot: path.basename(file) });
    }
  }
  await window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
  const reduced = await run(`({blur:getComputedStyle(document.querySelector('#composer')).backdropFilter,rim:getComputedStyle(document.querySelector('#composer'),'::after').display})`);
  assert.equal(reduced.blur, 'none'); assert.equal(reduced.rim, 'none');
  process.stdout.write(JSON.stringify({ passed: 5, report, reduced }) + '\n');
}).catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; }).finally(() => { window?.destroy(); app.quit(); });
app.on('quit', () => { fs.rmSync(profile, { recursive: true, force: true }); });
