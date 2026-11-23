// Emits harness steps for a theme x width x language matrix. Every step first forces the requested state and then
// throws if the DOM does not show it, so a screenshot named "dark" can never be a light render.
// usage: node tests/harness/gen-shots.cjs <prefix> <cat,cat,...> [themes] [widths] [langs] > steps.json
const [prefix, cats, themes = 'light,dark', widths = 'wide,narrow', langs = 'zh,en'] = process.argv.slice(2);
const SIZE = { wide: [1200, 800], narrow: [480, 800], w1280: [1280, 800], w1440: [1440, 900], w1728: [1728, 1117], w2560: [2560, 1440] };
const steps = [];
const setup = (theme, lang) => `
  const s0=document.createElement('style');s0.textContent='*{animation:none!important;transition:none!important}';document.head.appendChild(s0);
  document.getElementById('onboardingLayer')?.remove();
  window.WorkstationI18n.setLanguage('zh-CN'); SettingsShell.show('general'); /* build the shell in zh first so a later language switch is exercised */
  window.WorkstationI18n.setLanguage(${JSON.stringify(lang === 'en' ? 'en' : 'zh-CN')});
  const wantLight=${theme === 'light'};
  if(document.body.classList.contains('light-mode')!==wantLight) document.getElementById('themeBtn').click();
  await new Promise(r=>setTimeout(r,300));
  if(document.body.classList.contains('light-mode')!==wantLight) throw new Error('theme not applied: want ${theme}');
  if(document.documentElement.lang!==${JSON.stringify(lang === 'en' ? 'en' : 'zh-CN')}) throw new Error('language not applied: want ${lang}');`;
for (const theme of themes.split(',')) for (const width of widths.split(',')) for (const lang of langs.split(',')) {
  let first = true;
  for (const cat of cats.split(',')) {
    const [w, h] = SIZE[width];
    const check = `
  await new Promise(r=>setTimeout(r,500));
  const shell=document.getElementById('settingsShell'); if(!shell||shell.hidden) throw new Error('shell not visible');
  const cjk=/[\\u3400-\\u9fff]/;
  const wantEn=${lang === 'en'};
  const nav=[...shell.querySelectorAll('.st-nav-item')].map(b=>b.textContent.trim());
  if(wantEn&&nav.some(x=>cjk.test(x))) throw new Error('untranslated nav: '+nav.filter(x=>cjk.test(x)).join('|'));
  if(!wantEn&&nav.some(x=>/^[A-Za-z]/.test(x))) throw new Error('nav not Chinese: '+nav.join('|'));
  ${width === 'narrow' ? `const stacked=[...shell.querySelectorAll('.st-row')].filter(r=>!r.closest('[hidden]')&&r.offsetParent&&r.querySelector(':scope > .st-row-control > .st-switch')&&[...r.querySelector(':scope > .st-row-control').children].every(c=>c.classList.contains('st-switch')||c.classList.contains('st-saved'))).filter(r=>{const t=r.querySelector('.st-row-text').getBoundingClientRect(),w=r.querySelector('.st-switch').getBoundingClientRect();return w.top>=t.bottom-1&&w.top+w.height/2>t.bottom;}).map(r=>r.querySelector('.st-row-title').textContent);
  if(stacked.length) throw new Error('toggle stacked under its text in narrow layout: '+stacked.join('|'));` : ''}
  const light=document.body.classList.contains('light-mode'); if(light!==${theme === 'light'}) throw new Error('theme drifted');
  const stray=wantEn?[...shell.querySelectorAll('*')].filter(n=>!n.closest('[hidden]')).flatMap(n=>[...n.childNodes].filter(c=>c.nodeType===3&&cjk.test(c.textContent)).map(c=>c.textContent.trim())).concat([...shell.querySelectorAll('[aria-label],[title],[placeholder]')].flatMap(n=>['aria-label','title','placeholder'].map(a=>n.getAttribute(a)||'').filter(v=>cjk.test(v)))):[];
  return JSON.stringify({errs:window.__errs,stray});`;
    steps.push({ name: `${cat}-${theme}-${width}-${lang}`, w, h,
      js: `{${setup(theme, lang)}}\n${first ? '' : ''}showView('settings');SettingsShell.show(${JSON.stringify(cat)});${check}`,
      shot: `${cat}-${theme}-${width}-${lang}` });
    first = false;
  }
}
process.stdout.write(JSON.stringify(steps));
