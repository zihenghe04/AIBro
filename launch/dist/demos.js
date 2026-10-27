(() => {
'use strict';
// Scripted, clickable rebuilds of AI Bro screens. Nothing here makes a network request.
// Each chapter is a small controller: render() builds its DOM, user events drive it, auto() plays it once
// with a fake cursor when nobody has touched it. Desktop mounts every chapter into one sticky window;
// narrow screens give each chapter its own window.
const Site = window.Site;
const L = () => Site.lang;
const T = (zh, en) => (L() === 'en' ? en : zh);
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const reduced = () => Site.reduced.matches;
const LOGO = 'assets/v095/mark-128.png';
// Window-level listeners are tied to the current build so a rebuild (language, breakpoint) drops the old ones.
let ac = new AbortController();
const on = (t, type, fn, o) => t.addEventListener(type, fn, Object.assign({ signal: ac.signal }, o));

// ---- icons (line icons sized like the app's 16px set) ----
const P = {
  new: 'M8.5 2.5h-4A1.5 1.5 0 0 0 3 4v8a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 12V8M11.5 2l2.5 2.5-5 5H6.5V7z',
  grid: 'M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z',
  chats: 'M2 3.5h8a1 1 0 0 1 1 1V9a1 1 0 0 1-1 1H6l-2.5 2v-2H2a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1zM12.5 6H14a1 1 0 0 1 1 1v4.5a1 1 0 0 1-1 1h-1v1.8L10.8 12.5H8',
  cal: 'M2.5 3.5h11v10h-11zM2.5 6.5h11M5.5 2v3M10.5 2v3M10 11.5l1.3 1 2-2.5',
  note: 'M3 2.5h10v11H3zM5.5 6h5M5.5 8.5h5M5.5 11h3',
  day: 'M2.5 3.5h11v10h-11zM2.5 6.5h11M5 9h1M7.5 9h1M10 9h1M5 11.3h1M7.5 11.3h1',
  books: 'M2.5 3h2.5v10H2.5zM5 3h3v10H5zM8.5 4.2l2.6-.7 2.4 9-2.6.7z',
  flask: 'M6 2h4M6.5 2v4.5L3 12.5A1 1 0 0 0 3.9 14h8.2a1 1 0 0 0 .9-1.5L9.5 6.5V2',
  folder: 'M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.4 1.5h4.8A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z',
  hist: 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.5H5M8 5.2V8l2 1.3',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9M6.8 7v4.5M9.2 7v4.5',
  gear: 'M8 5.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4zM8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1',
  island: 'M2 4.5h12v8H2zM5.5 4.5h5v2h-5z',
  side: 'M2.5 3h11v10h-11zM6 3v10',
  search: 'M7 2.8a4.2 4.2 0 1 0 0 8.4 4.2 4.2 0 0 0 0-8.4zM10.2 10.2 13.5 13.5',
  bell: 'M4 11V7.2a4 4 0 0 1 8 0V11l1 1.2H3zM6.8 13.6a1.4 1.4 0 0 0 2.4 0',
  compose: 'M8.5 2.5h-4A1.5 1.5 0 0 0 3 4v8a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 12V8M11.5 2l2.5 2.5-5 5H6.5V7z',
  contrast: 'M8 2.2a5.8 5.8 0 1 0 0 11.6zM8 2.2a5.8 5.8 0 0 1 0 11.6',
  plus: 'M8 3v10M3 8h10', at: 'M10.5 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM10.5 8v1a1.8 1.8 0 0 0 3.5 0V8a6 6 0 1 0-2.4 4.8',
  spark: 'M8 2.5l1.3 3.2 3.2 1.3-3.2 1.3L8 11.5 6.7 8.3 3.5 7l3.2-1.3z', shield: 'M8 2 13 4v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4zM5.8 8l1.6 1.6L10.5 6.5',
  dots: 'M4 8h.01M8 8h.01M12 8h.01', mic: 'M6 2.5h4v6.5H6zM3.5 8a4.5 4.5 0 0 0 9 0M8 12.5V14', send: 'M8 13V3.5M4 7l4-4 4 4',
  chev: 'M4 6l4 4 4-4', doc: 'M4 2h5l3 3v9H4zM9 2v3h3', link: 'M6.5 9.5l3-3M7 4.8l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.2l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1',
  check: 'M3.5 8.5l3 3 6-7', copy: 'M5.5 5.5h7v8h-7zM3.5 10.5v-8h7', quote: 'M3.5 10V8a3 3 0 0 1 3-3M9.5 10V8a3 3 0 0 1 3-3M3.5 8.5h3V11h-3zM9.5 8.5h3V11h-3z', up: 'M5 7.5 7.5 2.5c1 0 1.5.7 1.5 1.5V6.5h3.2a1 1 0 0 1 1 1.2l-.9 4.6a1 1 0 0 1-1 .7H5zM2.5 7.5H5v5.5H2.5z', down: 'M11 8.5 8.5 13.5c-1 0-1.5-.7-1.5-1.5V9.5H3.8a1 1 0 0 1-1-1.2l.9-4.6a1 1 0 0 1 1-.7H11zM13.5 8.5H11V3h2.5z', stop: 'M5 5h6v6H5z', x: 'M4 4l8 8M12 4l-8 8', play: 'M5 3.5v9l7.5-4.5z', clock: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 5v3.2l2 1.3',
  cmd: 'M5.5 4a1.5 1.5 0 1 0 0 3H7V5.5A1.5 1.5 0 0 0 5.5 4zM10.5 4A1.5 1.5 0 0 0 9 5.5V7h1.5a1.5 1.5 0 1 0 0-3zM5.5 12a1.5 1.5 0 1 1 0-3H7v1.5A1.5 1.5 0 0 1 5.5 12zM10.5 12A1.5 1.5 0 0 1 9 10.5V9h1.5a1.5 1.5 0 1 1 0 3zM7 7h2v2H7z'
};
const ic = (n, c = 'i') => `<svg class="${c}" viewBox="0 0 16 16" aria-hidden="true"><path d="${P[n]}"/></svg>`;
const CURSOR = '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M2 1.5v13.2l3.6-3.4 2.3 5.2 2.4-1-2.3-5.1h5z" fill="#111" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg>';

// ---- window shell ----
const NAV = [
  ['overview', 'grid', '总览', 'Overview'], ['chats', 'chats', '全部对话', 'All chats'], ['agenda', 'cal', '日程', 'Agenda'], ['captures', 'note', '随记', 'Quick notes'],
  ['g', '空间', 'Spaces'], ['daily', 'day', '日常', 'Daily'], ['courses', 'books', '课程', 'Courses'], ['research', 'flask', '科研', 'Research'],
  ['g', '项目', 'Projects'], ['p-ml', 'folder', '机器学习', 'Machine Learning'], ['p-thesis', 'folder', '毕业论文', 'Thesis'],
  ['hr'], ['history', 'hist', '执行历史', 'Run history'], ['trash', 'trash', '回收站', 'Trash']
];
function shell(compact) {
  const nav = NAV.map(n => n[0] === 'g' ? `<div class="grp">${T(n[1], n[2])}</div>` : n[0] === 'hr' ? '<hr>' :
    `<div class="it" data-nav="${n[0]}">${ic(n[1])}<span>${T(n[2], n[3])}</span></div>`).join('');
  return h(`<div class="win${compact ? ' compact' : ''}" aria-hidden="false">
    <aside class="w-side" aria-hidden="true">
      <div class="w-lights"><i></i><i></i><i></i></div><span class="w-tog">${ic('side')}</span>
      <div class="w-brand"><img src="${LOGO}" alt=""><div><b>AI Bro</b><small>${T('知识与行动，在一起', 'Knowledge and action, together')}</small></div></div>
      <div class="w-new">${ic('new')}<span>${T('新对话', 'New chat')}</span><kbd>⌘ N</kbd></div>
      <nav class="w-nav"><span class="w-sel"></span>${nav}</nav>
      <div class="w-foot"><span data-nav="settings">${ic('gear')}${T('设置', 'Settings')}</span><span>${ic('island')}${T('灵动岛', 'Island')}</span></div>
    </aside>
    <div class="w-main">
      <div class="w-top"><div class="w-title"><span></span></div><div class="w-tools" aria-hidden="true"><i>${ic('search')}</i><i>${ic('bell')}</i><i>${ic('compose')}</i><i>${ic('contrast')}</i><i>${ic('gear')}</i></div></div>
      <div class="w-body"></div>
    </div>
    <div class="cur">${CURSOR}</div>
  </div>`);
}
const DESIGN = { full: [1200, 750], compact: [760, 640] };
function fit(fitEl, win, compact) {
  const [W, H] = compact ? DESIGN.compact : DESIGN.full;
  fitEl.style.aspectRatio = W + '/' + H;
  const set = () => win.style.setProperty('--s', (fitEl.clientWidth / W).toFixed(4));
  set();
  if ('ResizeObserver' in window) new ResizeObserver(set).observe(fitEl); else addEventListener('resize', set);
}
function setNav(win, key) {
  const side = $('.w-side', win), sel = $('.w-sel', win);
  $$('.on[data-nav]', side).forEach(e => e.classList.remove('on'));
  const it = key && $(`.it[data-nav="${key}"]`, side);
  if (it) { it.classList.add('on'); sel.style.setProperty('--y', it.offsetTop + 'px'); sel.style.setProperty('--o', 1); }
  else sel.style.setProperty('--o', 0);
}
function setTitle(win, text) {
  const box = $('.w-title', win), old = box.lastElementChild;
  if (old && old.textContent === text) return;
  if (!old || !old.textContent || reduced()) { box.innerHTML = `<span>${esc(text)}</span>`; return; }
  const n = document.createElement('span'); n.textContent = text; n.className = 'in0';
  box.append(n); old.classList.add('out');
  requestAnimationFrame(() => requestAnimationFrame(() => n.classList.remove('in0')));
  setTimeout(() => old.remove(), 500);
}

// ---- fake cursor + cancellable scripts ----
class Cancelled extends Error {}
function runner(win) {
  let token = 0;
  const cur = $('.cur', win);
  const scale = () => parseFloat(getComputedStyle(win).getPropertyValue('--s')) || 1;
  const api = {
    get busy() { return api._busy; }, _busy: false,
    cancel() { token++; api._busy = false; cur.classList.remove('on'); },
    async play(fn) {
      const mine = ++token; api._busy = true;
      const step = async ms => { await sleep(ms); if (mine !== token) throw new Cancelled(); };
      const to = async (el, dx = 0.5, dy = 0.5) => {
        if (mine !== token) throw new Cancelled();
        const w = win.getBoundingClientRect(), r = el.getBoundingClientRect(), s = scale();
        cur.classList.add('on');
        cur.style.transform = `translate(${((r.left - w.left + r.width * dx) / s).toFixed(1)}px,${((r.top - w.top + r.height * dy) / s).toFixed(1)}px)`;
        await step(950);
      };
      const click = async (el, fnc) => { await to(el); cur.classList.remove('click'); void cur.offsetWidth; cur.classList.add('click'); await step(160); (fnc || (() => el.click()))(); await step(300); };
      try { await fn({ step, to, click }); }
      catch (e) { if (!(e instanceof Cancelled)) throw e; return; }
      if (mine === token) { api._busy = false; await sleep(900); if (mine === token) cur.classList.remove('on'); }
    }
  };
  return api;
}
async function typeInto(el, text, step, speed = 45) {
  el.textContent = '';
  for (const ch of text) { el.textContent += ch; await step(speed); }
}
// Stream text. parts: strings, '\n' for a new paragraph, {cite, go} for a source. Sources get a small number
// in the text and a row in the source list under the answer (styled like the app's .source-link).
// Keep the newest output in view, like the app's chat does while streaming.
const follow = el => { const log = el.closest('.chat-log'); if (log) log.scrollTop = log.scrollHeight; };
async function stream(box, parts, step, onCite) {
  let p = document.createElement('p'); p.className = 'caret'; box.append(p);
  const cites = [];
  try {
    for (const part of parts) {
      if (part === '\n') { p.classList.remove('caret'); p = document.createElement('p'); p.className = 'caret'; box.append(p); await step(80); continue; }
      if (typeof part === 'string') {
        const t = document.createTextNode(''); p.append(t);
        const chars = [...part];
        for (let i = 0; i < chars.length; i += 2) { t.data += chars.slice(i, i + 2).join(''); if (i % 16 === 0) follow(box); await step(24); }
      } else {
        cites.push(part);
        p.append(h(`<sup class="cn">${cites.length}</sup>`)); await step(80);
      }
    }
  } finally { p.classList.remove('caret'); }
  if (!cites.length) return;
  const list = h(`<div class="srcs"><div class="sh">${T('来源', 'Sources')}</div></div>`);
  cites.forEach((c, i) => {
    const [name, where] = c.cite.split(' · ');
    const row = h(`<button type="button" class="source-link"><span class="n">${i + 1}</span>${ic('doc')}<span class="nm">${esc(name)}</span><small>${esc(where || '')}</small></button>`);
    if (onCite) row.addEventListener('click', () => onCite(c.go)); else row.addEventListener('click', () => row.classList.toggle('peek'));
    list.append(row);
  });
  box.append(list); follow(box);
}
const WHO = live => `<div class="who"><i class="wd${live ? ' live' : ''}"></i>AI${live ? T(' · 生成中', ' · generating') : ''}<span>Project Assistant · ${T('中', 'Med')}</span></div>`;
const MACTS = (thumbs) => `<div class="macts">${ic('copy')}${ic('quote')}${ic('dots')}${thumbs ? `<span class="sp"></span>${ic('up')}${ic('down')}` : ''}</div>`;
const MODEL = () => `<span class="model">${ic('spark')}Project Assistant <small>${T('中', 'Med')}</small>${ic('chev')}</span>`;
// Kernel run block in the style of 0.9.10: "正在回答 3 秒 · <step>", hollow markers while running, then "已完成 8 秒 · 3 项过程".
async function progress(msg, steps, step, comp, records) {
  const el = h(`<div class="prog run"><div class="prog-h"><span class="dots3"><i></i><i></i><i></i></span><b class="t">${T('正在回答', 'Answering')}</b><span class="el">0 ${T('秒', 's')}</span><span class="cu"></span>${ic('chev', 'i chev')}</div><ol></ol><div class="slog">› ${T('阶段记录', 'Stage log')}</div><span class="b ghost stop">${T('停止', 'Stop')}</span></div>`);
  msg.append(el);
  const who = $('.who', msg); if (who) who.outerHTML = WHO(true);
  let cstat = null;
  if (comp) {
    comp.classList.add('running');
    cstat = h(`<div class="cstat"><i></i><span>${T('生成结构化规划', 'Planning')}</span><small>0 ${T('秒', 's')}</small><span class="b ghost">${T('停止', 'Stop')}</span></div>`);
    comp.prepend(cstat);
  }
  const t0 = performance.now(), secs = () => Math.max(1, Math.round((performance.now() - t0) / 1000));
  const tick = setInterval(() => { const s = secs() + ' ' + T('秒', 's'); $('.el', el).textContent = s; if (cstat) $('small', cstat).textContent = s; }, 250);
  try {
    for (const [b, dsc, ms] of steps) {
      $$('li', el).forEach(li => li.classList.add('done'));
      const text = dsc ? `${b} · ${dsc}` : b;
      $('ol', el).append(h(`<li><span class="mk"></span><span>${esc(text)}</span></li>`));
      $('.cu', el).textContent = '· ' + text;
      follow(el);
      await step(ms);
    }
  } finally {
    clearInterval(tick);
    if (comp) { comp.classList.remove('running'); cstat && cstat.remove(); }
  }
  const total = Math.max(secs(), steps.length * 2 + 2);
  el.classList.remove('run'); el.classList.add('done');
  $$('li', el).forEach(li => li.classList.add('done'));
  $('.prog-h', el).innerHTML = `<span class="okc">${ic('check')}</span><b class="t">${T('已完成', 'Done')}</b><span class="el">${total} ${T('秒', 's')} · ${T(`${steps.length} 项过程`, `${steps.length} steps`)}</span><span class="cu"></span>${ic('chev', 'i chev')}`;
  $('.stop', el).remove();
  const w = $('.who', msg); if (w) w.outerHTML = WHO(false);
  if (records) el.append(h(`<div class="recs"><div class="rh">${T('项目记录', 'Project records')}</div>${records.map(r => `<span>${esc(r)}</span>`).join('')}</div>`));
  follow(el);
  el.append(h(`<div class="pdone"><span class="pill mute"><i class="wd"></i>${T('已完成', 'Done')}</span><span class="sp"></span><span class="lnk">${T('查看执行记录', 'View run record')}</span></div>`));
  return el;
}

// ---- hero: chat with scripted answers ----
const QA = () => [
  { q: T('第 3 讲的梯度下降，学习率太大为什么会发散？', 'In lecture 3, why does gradient descent diverge when the learning rate is too big?'),
    steps: [[T('正在读取已保存的课件原文', 'Reading the saved lecture slides'), '', 900], [T('定位第 12–13 页相关段落', 'Locating the passage on pp. 12–13'), '', 1000], [T('组织回答并标注来源', 'Writing the answer with sources'), '', 800]], rec: [T('机器学习 · 进展日记 10-27', 'Machine Learning · log 10-27')],
    a: [T('课件用一个二次函数来解释：每一步沿负梯度走 η 倍的梯度。η 超过 2/L（L 是曲率的上界）时，每一步都会越过谷底，而且越过得越来越多，损失就一路往上走。', 'The slides use a quadratic: each step moves η times the gradient downhill. Once η is larger than 2/L, where L bounds the curvature, every step overshoots the bottom by more than the last, so the loss keeps climbing.'), { cite: T('第3讲 · 第 12 页', 'Lecture 3 · p.12') }, '\n',
      T('你 10 月 14 日的课堂笔记记了老师的做法：先从 0.1 试，损失开始震荡就每次除以 3。', 'Your class notes from Oct 14 record the rule of thumb: start at 0.1 and divide by 3 whenever the loss starts to oscillate.'), { cite: T('课堂笔记 · 10月14日', 'Class notes · Oct 14') }] },
  { q: T('把这周组会要讲的三件事列出来', 'List three things to bring to this week’s group meeting'),
    steps: [[T('检索本周随记和日程', 'Searching this week’s notes and agenda'), '', 900], [T('读取组会纪要-10月20日.md', 'Reading Meeting-notes-Oct20.md'), '', 900], [T('组织回答并标注来源', 'Writing the answer with sources'), '', 700]],
    a: [T('按你这周的随记和上次组会纪要，周五可以讲这三件：', 'From this week’s quick notes and the last meeting’s minutes, bring these on Friday:'), '\n',
      T('1. 两组消融实验补完了，结果在表 2。', '1. Two more ablation runs are done; results are in Table 2.'), { cite: T('随记 · 10月23日', 'Note · Oct 23') }, '\n',
      T('2. 数据集第二版的清洗规则改了，需要大家确认。', '2. The cleaning rules for dataset v2 changed and need sign-off.'), { cite: T('组会纪要 · 10月20日', 'Minutes · Oct 20') }, '\n',
      T('3. 下周想借两张卡跑长训练。', '3. You want to borrow two GPUs next week for a long run.'), { cite: T('随记 · 10月25日', 'Note · Oct 25') }] },
  { q: T('这两篇论文的方法差在哪？', 'How do the methods in these two papers differ?'),
    steps: [[T('检索科研知识库里的论文笔记', 'Searching paper notes in Research'), '', 900], [T('读取论文 A 第 3 节、论文 B 第 4 节', 'Reading Paper A §3 and Paper B §4'), '', 1000], [T('组织回答并标注来源', 'Writing the answer with sources'), '', 700]],
    a: [T('两篇都做检索增强，差别在什么时候检索。A 在生成之前检索一次，把结果拼进输入。', 'Both add retrieval to generation; they differ in when they retrieve. Paper A retrieves once before generating and puts the passages into the prompt.'), { cite: T('论文 A · 第 3 节', 'Paper A · §3') }, '\n',
      T('B 在生成过程中碰到没把握的词才去检索，长回答里的引用更准，代价是更慢。', 'Paper B retrieves mid-generation whenever it is unsure of the next words. Citations in long answers are more accurate, at the cost of speed.'), { cite: T('论文 B · 第 4 节', 'Paper B · §4') }] }
];
function heroChapter(win) {
  const body = $('.w-body', win);
  const run = runner(win);
  let busy = false, touched = false;
  const scr = h('<section class="scr on" data-s="hero"></section>');
  body.append(scr);
  function render() {
    run.cancel(); busy = false;
    const qa = QA();
    scr.innerHTML = `<div class="w-wash"></div><div class="chat">
      <div class="crumb">${T('工作区', 'Workspace')} / ${T('课程', 'Courses')} / ${T('机器学习', 'Machine Learning')} / <b>${T('新对话', 'New chat')}</b></div>
      <div class="ptabs">${[T('对话', 'Chats'), T('资料', 'Sources'), T('成果', 'Outputs'), T('任务', 'Tasks'), T('日程', 'Schedule'), T('概览', 'Overview')].map((x, i) => `<span${i ? '' : ' class="on"'}>${x}</span>`).join('')}</div>
      <div class="chat-log"><div class="empty"><img src="${LOGO}" alt=""><small>AI Bro · ${T('你的知识伙伴', 'your knowledge partner')}</small><strong class="h4">${T('从一个想法开始。', 'Start from an idea.')}</strong><p>${T('把文件、网页或想法交给 AI，整理成有迹可循的下一步。', 'Hand AI a file, a page or a thought and get a next step you can trace.')}</p>
        <div class="sugs">${qa.map((x, i) => `<button class="sug" type="button" data-q="${i}">${esc(x.q)}</button>`).join('')}</div></div>
        <div class="chat-col"></div></div>
      <div class="composer"><div class="in" data-ph="${T('发消息，或添加文件与网页…', 'Message, or add files and pages…')}"></div>
        <div class="bar">${ic('plus')}${ic('at')}<span style="display:flex;gap:5px;align-items:center">${ic('folder')}${T('机器学习', 'Machine Learning')}${ic('chev')}</span><span class="sp"></span>
        ${MODEL()}${ic('shield')}${ic('dots')}${ic('mic')}
        <button class="send" type="button" aria-label="${T('发送', 'Send')}">${ic('send')}</button></div></div></div>`;
    $$('.sug', scr).forEach(b => b.addEventListener('click', () => { touched = true; ask(+b.dataset.q, true); }));
    $('.send', scr).addEventListener('click', () => { touched = true; ask(0, true); });
  }
  let asked = 0;
  async function ask(i, user) {
    if (busy && user) { run.cancel(); }
    if (user && run.busy) run.cancel();
    busy = true; asked = i;
    const qa = QA()[i];
    const log = $('.chat-col', scr), empty = $('.empty', scr), inp = $('.composer .in', scr), comp = $('.composer', scr);
    await run.play(async ({ step }) => {
      comp.classList.add('focus');
      await typeInto(inp, qa.q, step, reduced() ? 0 : 28);
      await step(250);
      inp.textContent = ''; comp.classList.remove('focus');
      empty.classList.add('gone');
      log.innerHTML = '';
      log.append(h(`<div class="msg-u">${esc(qa.q)}</div>`), h(MACTS(false)));
      await step(400);
      const a = h(`<div class="msg-a">${WHO(false)}</div>`);
      log.append(a);
      await progress(a, qa.steps, step, comp, qa.rec);
      const ans = h('<div></div>'); a.append(ans);
      await stream(ans, qa.a, step);
      a.append(h(MACTS(true)));
      const more = h(`<div class="sugs" style="justify-content:flex-start;margin-top:4px">${QA().map((x, j) => j === i ? '' : `<button class="sug" type="button" data-q="${j}">${esc(x.q)}</button>`).join('')}</div>`);
      a.append(more);
      $$('.sug', more).forEach(b => b.addEventListener('click', () => { touched = true; ask(+b.dataset.q, true); }));
    });
    busy = false;
  }
  render();
  return {
    key: 'hero', nav: null, title: () => T('对话', 'Chat'), scr,
    enter() {}, leave() {},
    auto(force) { if ((!touched || force) && !busy) { touched = false; ask(0, false); } },
    reset: render,
    get touched() { return touched; }
  };
}

// ---- agenda: one sentence in chat → proposal → Agenda center ----
function agendaChapter(win) {
  // Real flow in 0.9.10: say it in chat → an agenda proposal card → review → saved → open it in the Agenda center.
  const run = runner(win);
  const scr = h('<section class="scr" data-s="agenda"></section>');
  $('.w-body', win).append(scr);
  let touched = false, phase = 'chat', ctrl;
  const SENT = () => T('周五下午三点组会，提前半小时提醒我', 'Group meeting Friday 3pm, remind me 30 minutes before');
  const WEEK = () => [
    [T('周一', 'Mon'), 26, [T('提交观察记录', 'Hand in field notes')]],
    [T('周二', 'Tue'), 27, [T('读《检索增强》并写摘要', 'Read the RAG paper, write a summary'), T('课程小组讨论', 'Course study group')]],
    [T('周三', 'Wed'), 28, [T('整理本周文献', 'Sort this week’s papers'), T('机器学习 第5讲', 'ML lecture 5')]],
    [T('周四', 'Thu'), 29, []],
    [T('周五', 'Fri'), 30, [T('交作业 3', 'Homework 3 due')]],
    [T('周六', 'Sat'), 31, []],
    [T('周日', 'Sun'), 1, [T('组会前复查实验', 'Recheck runs before meeting')]]
  ];
  function calHTML() {
    return `<div class="page cal">
      <div class="ph"><strong class="h4">${T('日程', 'Agenda')}<small>${T('日程已与本机工作区对齐', 'In sync with this Mac’s workspace')}</small></strong><span class="b ghost">${ic('bell')}${T('提醒', 'Reminders')}</span><span class="b ghost">${T('导入', 'Import')}</span><span class="b">${ic('plus')}${T('新建日程', 'New event')}</span></div>
      <div class="cal-bar"><span class="seg"><span>${T('今日', 'Today')}</span><span class="on">${T('周', 'Week')}</span><span>${T('月', 'Month')}</span></span><span class="sp"></span><b>‹ ${T('2026年10月27日', 'Oct 27, 2026')} ›</b><span>${T('今天', 'Today')}</span></div>
      <div class="cal-bar"><span class="fld" style="font-family:inherit;width:150px">${T('全部安排', 'All items')}</span><span class="fld" style="font-family:inherit;flex:1;color:var(--muted)">${T('搜索日程', 'Search agenda')}</span></div>
      <div class="wk7">${WEEK().map(([d, n, items], i) => `<div class="dcol"><span class="dn">${d}</span><div class="dcard${i === 1 ? ' pick' : ''}" data-i="${i}"><div class="dh"><b>${n}${T('日', '')}</b><small>${items.length || ''}</small></div>${items.map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div></div>`).join('')}</div>
      <div class="dlist"><div class="dlh"><b>${T('10月27日 周二', 'Tue, Oct 27')}</b><small>${T('2 项安排', '2 items')}</small></div>
        <div class="drow"><b>16:00<small>${T('任务', 'Task')}</small></b><span>${T('读《检索增强》并写摘要', 'Read the RAG paper, write a summary')}<small>${T('科研', 'Research')}</small></span>${ic('chev')}</div>
        <div class="now"><span>17:49</span><i></i></div></div></div>`;
  }
  function render() {
    run.cancel(); phase = 'chat';
    scr.innerHTML = `<div class="pane on" data-sub="chat"><div class="w-wash"></div><div class="chat">
        <div class="crumb">${T('工作区', 'Workspace')} / ${T('日常', 'Daily')} / <b>${T('新对话', 'New chat')}</b></div>
        <div class="chat-log"><div class="chat-col"></div></div>
        <div class="composer"><div class="in" data-ph="${T('发消息，或添加文件与网页…', 'Message, or add files and pages…')}"></div>
          <div class="bar">${ic('plus')}${ic('at')}<span style="display:flex;gap:5px;align-items:center">${ic('folder')}${T('日常', 'Daily')}${ic('chev')}</span><span class="sp"></span>${MODEL()}${ic('mic')}<button class="send" type="button" aria-label="${T('发送', 'Send')}">${ic('send')}</button></div></div></div></div>
      <div class="pane" data-sub="cal">${calHTML()}</div>`;
    $('.send', scr).addEventListener('click', () => { touched = true; send(); });
    $('.composer .in', scr).addEventListener('click', () => { touched = true; fill(); });
    if (ctrl && ctrl.active) { setNav(win, 'chats'); setTitle(win, T('对话', 'Chat')); }
  }
  let filling = false, sent = false;
  async function fill() {
    const inp = $('.composer .in', scr); if (filling || inp.textContent) return;
    filling = true; $('.composer', scr).classList.add('focus');
    for (const ch of SENT()) { inp.textContent += ch; await sleep(reduced() ? 0 : 40); }
    filling = false;
  }
  async function send() {
    if (sent) return; sent = true;
    const inp = $('.composer .in', scr);
    if (!inp.textContent) await fill();
    await sleep(200);
    inp.textContent = ''; $('.composer', scr).classList.remove('focus');
    const log = $('.chat-col', scr);
    log.append(h(`<div class="msg-u">${esc(SENT())}</div>`));
    await sleep(500);
    const a = h(`<div class="msg-a">${WHO(false)}<p>${T('我按你的原话生成了一条日程提案，保存前请审阅。', 'I drafted an agenda proposal from your words. Review it before saving.')}</p></div>`);
    log.append(a);
    await sleep(500);
    const card = h(`<div class="acard"><div class="ah">${ic('cal')}<b>${T('组会', 'Group meeting')}</b><span class="pill mute">${T('日程提案', 'Proposal')}</span></div>
      <dl><dt>${T('时间', 'When')}</dt><dd>${T('10月30日 周五 15:00–16:00', 'Fri Oct 30, 15:00–16:00')}</dd><dt>${T('提醒', 'Remind')}</dt><dd>${T('提前 30 分钟', '30 minutes before')}</dd><dt>${T('归属', 'Project')}</dt><dd>${T('日常', 'Daily')}</dd></dl>
      <p class="pnote">${T('结束时间未指定，默认时长1小时，请在保存前确认。', 'No end time given; it defaults to one hour. Confirm before saving.')}</p>
      <div class="acts"><button class="b" type="button" data-a="regen">${T('重新生成', 'Regenerate')}</button><button class="b pri" type="button" data-a="save">${T('审阅日程', 'Review')}</button></div></div>`);
    a.append(card);
    $('[data-a=save]', card).addEventListener('click', () => { touched = true; save(card); });
  }
  let saved = false;
  async function save(card) {
    if (saved) return; saved = true;
    const btn = $('[data-a=save]', card);
    btn.textContent = T('保存', 'Save');
    await sleep(reduced() ? 0 : 500);
    $('.ah .pill', card).className = 'pill'; $('.ah .pill', card).textContent = T('已保存', 'Saved');
    $('.acts', card).innerHTML = `<button class="b pri" type="button" data-a="open">${ic('cal')}${T('打开已保存日程', 'Open saved event')}</button>`;
    $('[data-a=open]', card).addEventListener('click', () => { touched = true; openCal(); });
  }
  function openCal() {
    if (phase === 'cal') return; phase = 'cal';
    setNav(win, 'agenda'); setTitle(win, T('日程中心', 'Agenda'));
    $('.pane[data-sub=chat]', scr).classList.remove('on');
    const cal = $('.pane[data-sub=cal]', scr); cal.classList.add('on');
    const fri = $('.dcard[data-i="4"]', cal);
    setTimeout(() => {
      $$('.dcard', cal).forEach(d => d.classList.remove('pick')); fri.classList.add('pick');
      fri.append(h(`<span class="chip new">${T('组会', 'Group meeting')}</span>`)); $('.dh small', fri).textContent = '2';
      $('.dlist', cal).innerHTML = `<div class="dlh"><b>${T('10月30日 周五', 'Fri, Oct 30')}</b><small>${T('2 项安排', '2 items')}</small></div>
        <div class="drow"><b>10:00<small>${T('任务', 'Task')}</small></b><span>${T('交作业 3', 'Homework 3 due')}<small>${T('机器学习', 'Machine Learning')}</small></span>${ic('chev')}</div>
        <div class="drow new"><b>15:00<small>${T('会议', 'Meeting')}</small></b><span>${T('组会', 'Group meeting')}<small>${T('日常 · 14:30 提醒', 'Daily · reminder 14:30')}</small></span>${ic('chev')}</div>`;
    }, reduced() ? 0 : 450);
  }
  render();
  ctrl = {
    key: 'agenda', get nav() { return phase === 'cal' ? 'agenda' : 'chats'; }, title: () => phase === 'cal' ? T('日程中心', 'Agenda') : T('对话', 'Chat'), scr, active: false,
    enter() { ctrl.active = true; },
    leave() { ctrl.active = false; run.cancel(); },
    auto(force) {
      if (touched && !force) return; touched = false;
      sent = false; saved = false; render();
      run.play(async ({ step, click }) => {
        await click($('.composer .in', scr), () => fill()); await step(SENT().length * 40 + 300);
        await click($('.composer .send', scr), () => send()); await step(1700);
        await click($('.acard [data-a=save]', scr)); await step(900);
        await click($('.acard [data-a=open]', scr));
      });
    },
    reset() { sent = false; saved = false; render(); }, get touched() { return touched; }
  };
  return ctrl;
}

// ---- reader: select a passage, explain, jump back from the citation ----
function readChapter(win) {
  // Laid out after the 0.9.10 shots: chat on the left, reader on the right; selecting text pops 解释 / 翻译 / 批注 / 问 AI.
  const run = runner(win);
  const scr = h('<section class="scr" data-s="read"></section>');
  $('.w-body', win).append(scr);
  let touched = false, asked = false;
  const FILE = () => T('第3讲-优化.pdf', 'Lecture3-Optimization.pdf');
  const SENT = () => T('当学习率 η 大于 2/L 时，迭代在谷底两侧来回跳动，且振幅逐步增大，算法发散。', 'When the learning rate η exceeds 2/L, the iterates bounce across the valley with growing amplitude and the method diverges.');
  const ASK = () => T('这句和下一页的图是什么关系？', 'How does this relate to the figure on the next page?');
  const TABS = () => [T('对话', 'Chats'), T('资料', 'Sources'), T('成果', 'Outputs'), T('任务', 'Tasks'), T('排期', 'Schedule'), T('总览', 'Overview')].map((x, i) => `<span${i ? '' : ' class="on"'}>${x}</span>`).join('');
  function render() {
    run.cancel(); asked = false;
    scr.innerHTML = `<div class="split"><div class="chat">
        <div class="crumb">${T('工作区', 'Workspace')} / ${T('课程', 'Courses')} / ${T('机器学习', 'Machine Learning')} / <b>${T('第 3 讲复习', 'Lecture 3 review')}</b></div>
        <div class="ptabs">${TABS()}</div>
        <div class="chat-log"><div class="chat-col" style="padding:0 16px"></div></div>
        <div class="composer" style="width:calc(100% - 28px)"><div class="att"></div><div class="in" data-ph="${T('发消息，或添加文件与网页…', 'Message, or add files and pages…')}"></div><div class="bar">${ic('plus')}${ic('at')}${ic('folder')}<span class="sp"></span>${MODEL()}${ic('mic')}<button class="send" type="button" aria-label="${T('发送', 'Send')}">${ic('send')}</button></div></div>
      </div>
      <div class="reader">
        <div class="r-head"><span class="bk">← ${T('返回资料', 'Back to sources')}</span><span class="r-tab on">${esc(FILE())}<i>×</i></span><span class="sp"></span><span>${T('问 AI', 'Ask AI')}</span><span>${T('引用到对话', 'Quote in chat')}</span><span class="b ghost">${ic('folder')}${T('文件', 'File')}</span></div>
        <div class="r-info">› ${T('文档信息与来源', 'Document info and source')}</div>
        <div class="r-bar"><span>‹</span><span class="fld" style="width:34px;height:24px;justify-content:center;font-family:inherit">12</span><span>/ 28 ›</span><span class="seg"><span class="on">${T('宽度', 'Width')}</span><span>${T('整页', 'Page')}</span></span><span>− 100% +</span>${ic('search')}<span>${T('框选', 'Box')}</span><span>${T('问这一页', 'Ask this page')}</span></div>
        <div class="r-doc"><div class="r-pages">
          <div class="r-page" data-p="12"><div class="kick">AI BRO / COURSE NOTES</div><div class="h6">3.2 ${T('步长与收敛', 'Step size and convergence')}</div>
            <p>${T('梯度下降每一步沿负梯度方向更新参数：', 'Each step of gradient descent moves the parameters against the gradient:')}</p>
            <p class="eq">θ<sub>t+1</sub> = θ<sub>t</sub> − η ∇f(θ<sub>t</sub>)</p>
            <p>${T('设 f 的梯度是 L-Lipschitz 的，即曲率不超过 L。', 'Assume the gradient of f is L-Lipschitz, so curvature is at most L. ')}<span class="sel hint" tabindex="0" role="button">${esc(SENT())}</span>${T('当 η 不超过 1/L 时，每一步都能保证损失下降。', ' When η is at most 1/L, every step is guaranteed to lower the loss.')}</p>
            <p>${T('实践中常从较大的 η 开始，观察损失曲线，出现震荡后逐步减小。', 'In practice one starts with a large η, watches the loss and shrinks η once it oscillates.')}</p><span class="pn">12</span></div>
          <div class="r-page" data-p="13"><div class="h6 cap">${T('图 3.2 两种步长的轨迹', 'Figure 3.2 Trajectories for two step sizes')}</div>
            <svg class="fig" viewBox="0 0 340 120" style="width:100%;height:auto"><path d="M10 110 Q170 -60 330 110" fill="none" stroke="#9aa59f" stroke-width="1.2"/><path d="M40 70 L290 64 L70 46 L250 40 L110 30 L190 28" fill="none" stroke="#087f70" stroke-width="1.6"/><path d="M60 52 L280 68 L30 92 L320 100" fill="none" stroke="#c25766" stroke-width="1.6" stroke-dasharray="4 3"/><text x="200" y="24" font-size="10" fill="#087f70">η = 0.9/L</text><text x="230" y="116" font-size="10" fill="#c25766">η = 2.2/L</text></svg>
            <p>${T('实线收敛，虚线发散。两者只差在步长。', 'Solid converges, dashed diverges. Only the step size differs.')}</p><span class="pn">13</span></div>
        </div>
        <div class="selbar" role="toolbar" aria-label="${T('选中内容的操作', 'Selection actions')}"><button type="button" data-m="explain">${T('解释', 'Explain')}</button><button type="button" data-m="translate">${T('翻译', 'Translate')}</button><button type="button" data-m="annotate">${T('批注', 'Annotate')}</button><button type="button" data-m="ask">${T('问 AI', 'Ask AI')}</button></div>
        </div>
        <div class="r-foot"><span class="b ghost" style="color:var(--red)">${T('移入回收站', 'Move to Trash')}</span><span class="sp"></span><span class="b ghost">${T('移动 / 归属', 'Move')}</span><span class="b ghost">${T('下载原文件', 'Download original')}</span></div>
      </div></div>
      <div class="toast">${ic('check')}<span></span></div>`;
    const sel = $('.sel', scr);
    // Dragging anywhere across the page counts as selecting the outlined sentence.
    let down = null;
    $('.r-pages', scr).addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; touched = true; run.cancel(); e.preventDefault(); });
    scr.addEventListener('pointerup', e => { if (down && (Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 12 || e.target.closest('.sel'))) select(); down = null; });
    sel.addEventListener('click', () => { touched = true; select(); });
    sel.addEventListener('keydown', e => { if (e.key === 'Enter') { touched = true; select(); } });
    $$('.selbar button', scr).forEach(b => b.addEventListener('click', () => { touched = true; act(b.dataset.m); }));
    $('.send', scr).addEventListener('click', () => { touched = true; sendAsk(); });
  }
  function select() {
    const sel = $('.sel', scr), bar = $('.selbar', scr), doc = $('.r-doc', scr);
    sel.classList.remove('hint'); sel.classList.add('on');
    const d = doc.getBoundingClientRect(), r = sel.getBoundingClientRect(), s = parseFloat(getComputedStyle(win).getPropertyValue('--s')) || 1;
    bar.style.left = Math.max(8, (r.left - d.left) / s + 10) + 'px';
    bar.style.top = Math.max(6, (r.top - d.top) / s - 42) + 'px';
    bar.classList.add('on');
  }
  function jump(p) {
    const pages = $('.r-pages', scr), target = p === 13 ? $('.r-page[data-p="13"] .cap', scr) : $('.sel', scr);
    $('.selbar', scr).classList.remove('on');
    $$('.hit', scr).forEach(x => x.classList.remove('hit'));
    pages.style.transform = p === 13 ? 'translateY(-330px)' : 'translateY(-20px)';
    target.classList.remove('sel-on'); target.classList.add('hit');
    if (p === 12) $('.sel', scr).classList.remove('on');
  }
  function toast(t) { const el = $('.toast', scr); $('span', el).textContent = t; el.classList.add('on'); setTimeout(() => el.classList.remove('on'), 2200); }
  function quoteHTML() { return `<div class="quote">${T(`关于《${FILE()}》第 12 页：`, `On “${FILE()}”, p.12:`)}<br>${esc(SENT())}</div>`; }
  async function act(m) {
    const bar = $('.selbar', scr);
    $$('button', bar).forEach(b => b.classList.toggle('hot', b.dataset.m === m));
    await sleep(200); bar.classList.remove('on');
    if (m === 'annotate') { toast(T('已添加批注 · 第 12 页', 'Annotation added · p.12')); return; }
    if (m === 'ask') {
      // 问 AI: the passage goes into the composer as an attachment plus quoted lines, like the real app.
      $('.att', scr).innerHTML = `<span class="achip">${ic('doc')}${esc(FILE())}<i>×</i></span><span class="amode">PDF <b>${T('发送原件', 'Send original')}</b> ⌄</span>`;
      const inp = $('.composer .in', scr);
      inp.innerHTML = `<span class="q">&gt; ${T(`关于《${FILE()}》第 12 页：`, `On “${FILE()}”, p.12:`)}</span><span class="q">&gt; ${esc(SENT().slice(0, 26))}…</span>`;
      $('.composer', scr).classList.add('focus');
      return;
    }
    ask(m === 'explain' ? T('解释这段', 'Explain this') : T('翻译这段', 'Translate this'), m);
  }
  async function sendAsk() {
    const inp = $('.composer .in', scr);
    if (!$('.att', scr).innerHTML) { select(); await sleep(400); await act('ask'); await sleep(300); }
    const tail = document.createElement('div'); inp.append(tail);
    for (const ch of ASK()) { tail.textContent += ch; await sleep(reduced() ? 0 : 35); }
    await sleep(250);
    ask(ASK(), 'ask');
  }
  async function ask(text, m) {
    if (asked) return; asked = true;
    $('.att', scr).innerHTML = ''; $('.composer .in', scr).innerHTML = ''; $('.composer', scr).classList.remove('focus');
    const log = $('.chat-col', scr);
    log.innerHTML = '';
    log.append(h(`<div class="msg-u" style="max-width:94%">${quoteHTML()}${esc(text)}</div>`));
    const a = h(`<div class="msg-a" style="font-size:12.5px">${WHO(false)}</div>`); log.append(a);
    const own = runner(win);
    await own.play(async ({ step }) => {
      await step(300);
      await progress(a, [[T('正在读取已保存的课件原文', 'Reading the saved slides'), '', 800], [T('定位第 12–13 页相关段落', 'Locating pp. 12–13'), '', 800]], step, $('.composer', scr));
      const ans = h('<div></div>'); a.append(ans);
      const parts = m === 'translate'
        ? [T('When the learning rate η exceeds 2/L, the iterates bounce back and forth across the valley with growing amplitude, and the algorithm diverges.', '当学习率 η 大于 2/L 时，迭代在谷底两侧来回跳动，且振幅逐步增大，算法发散。'), { cite: FILE() + ' · ' + T('第 12 页', 'p.12'), go: 12 }]
        : [T('这句说的是步长的上限。步长超过 2/L，每一步都会跨过最低点、落到更高的地方，所以越走越远。', 'It sets an upper bound on the step. Above 2/L every update jumps past the minimum and lands higher, so you drift further away.'), { cite: FILE() + ' · ' + T('第 12 页', 'p.12'), go: 12 }, '\n',
           T('下一页的图 3.2 把 η = 0.9/L 和 η = 2.2/L 两条轨迹画在一起：实线收敛，虚线就是这句话说的发散。', 'Figure 3.2 on the next page draws η = 0.9/L and η = 2.2/L together: the solid line converges, the dashed one is the divergence this sentence describes.'), { cite: FILE() + ' · ' + T('第 13 页 · 图 3.2', 'p.13 · Fig. 3.2'), go: 13 }];
      await stream(ans, parts, step, go => { touched = true; jump(go); });
    });
  }
  render();
  return {
    key: 'read', nav: 'p-ml', title: () => T('课程 · 机器学习', 'Courses · Machine Learning'), scr,
    enter() {}, leave() { run.cancel(); },
    auto(force) {
      if (touched && !force) return; touched = false;
      render();
      run.play(async ({ step, to, click }) => {
        const sel = $('.sel', scr);
        await to(sel, 0.02, 0.3); await step(200);
        await to(sel, 0.98, 0.7); select(); await step(700);
        await click($('.selbar [data-m=ask]', scr), () => act('ask')); await step(600);
        await click($('.composer .send', scr), () => { sendAsk(); }); await step(ASK().length * 35 + 4600);
        const c = $$('.scr[data-s=read] .source-link', win)[1]; if (c) await click(c, () => jump(13));
      });
    },
    reset: render, get touched() { return touched; }
  };
}

// ---- wiki: linked notes ----
function wikiChapter(win) {
  // Laid out after the 0.9.10 project Sources page with the reading pane on the right (project-sources / wiki-note-reader shots).
  const run = runner(win);
  const scr = h('<section class="scr" data-s="wiki"></section>');
  $('.w-body', win).append(scr);
  let touched = false, cur = 'rag', tabs = ['rag'];
  const L2 = (k, t) => `<span class="wl" role="link" tabindex="0" data-go="${k}">${t}</span>`;
  const NOTES = () => ({
    rag: { t: T('检索增强生成（RAG）', 'Retrieval-augmented generation'), meta: T('更新于 10月26日 · 3 篇笔记链接到这里', 'Updated Oct 26 · 3 notes link here'),
      b: `<p>${T('先检索，再生成。检索器从资料里取回最相关的几段，生成模型基于这些片段回答，并标出处。', 'Retrieve first, then generate. A retriever pulls the most relevant passages and the model answers from them, citing where each came from.')}</p>
        <ul><li>${T('检索器：常用 ', 'Retriever: usually ')}${L2('dense', T('稠密检索', 'dense retrieval'))}${T('，也可以和关键词检索混合。', ', sometimes mixed with keyword search.')}</li>
        <li>${T('什么时候检索：', 'When to retrieve: ')}${L2('paperb', T('论文 B', 'Paper B'))}${T(' 在生成过程中按需检索。', ' retrieves on demand while generating.')}</li></ul>
        <blockquote>${T('组会上老师问：检索错了怎么办？见 ', 'Question from the meeting: what if retrieval is wrong? See ')}${L2('meet', T('组会纪要 10月20日', 'minutes of Oct 20'))}</blockquote>`,
      bl: [T('论文笔记 · A', 'Paper notes · A'), T('论文笔记 · B', 'Paper notes · B'), T('组会纪要 10月20日', 'Minutes Oct 20')] },
    dense: { t: T('稠密检索', 'Dense retrieval'), meta: T('更新于 10月22日', 'Updated Oct 22'),
      b: `<p>${T('把问题和文档都编码成向量，按向量相似度取回。和关键词检索比，它能找到换了说法的段落。', 'Encode the question and the documents as vectors and fetch by similarity. Unlike keyword search it finds passages that say the same thing in other words.')}</p>
        <ul><li>${T('常见结构：双塔编码器，问题和文档各一个。', 'Common setup: a two-tower encoder, one for queries and one for documents.')}</li><li>${T('用在哪：', 'Used in: ')}${L2('rag', T('检索增强生成', 'retrieval-augmented generation'))}</li></ul>`,
      bl: [T('检索增强生成（RAG）', 'Retrieval-augmented generation')] },
    paperb: { t: T('论文笔记 · B', 'Paper notes · B'), meta: T('更新于 10月25日 · 来自 论文B.pdf', 'Updated Oct 25 · from PaperB.pdf'),
      b: `<p>${T('生成过程中遇到没把握的词才触发检索，再接着写。', 'Retrieval is triggered mid-generation when the model is unsure of the next words, then writing continues.')}</p><ul><li>${T('优点：长回答里引用更准。', 'Pro: more accurate citations in long answers.')}</li><li>${T('缺点：慢，检索次数不好控制。', 'Con: slower, and the number of retrievals is hard to bound.')}</li><li>${T('对照 ', 'Compare with ')}${L2('rag', T('检索增强生成', 'retrieval-augmented generation'))}</li></ul>`,
      bl: [T('检索增强生成（RAG）', 'Retrieval-augmented generation')] },
    meet: { t: T('组会纪要 · 10月20日', 'Group meeting · Oct 20'), meta: T('随记整理 · 10月20日', 'From a quick note · Oct 20'),
      b: `<ul><li>${T('检索错了怎么办：先看引用对不对，再看检索器召回。', 'If retrieval is wrong: check the citation first, then the retriever’s recall.')}</li><li>${T('数据集第二版的清洗规则下周定。', 'Cleaning rules for dataset v2 to be settled next week.')}</li><li>${T('相关：', 'Related: ')}${L2('rag', T('检索增强生成', 'retrieval-augmented generation'))}</li></ul>`,
      bl: [T('检索增强生成（RAG）', 'Retrieval-augmented generation')] }
  });
  // list rows: [key or null, title, sub, status]
  const ROWS = () => [
    ['rag', NOTES().rag.t, T('文献/主题笔记', 'Literature/topic notes'), T('主题笔记', 'Topic note')],
    ['paperb', NOTES().paperb.t, T('文献/论文笔记', 'Literature/paper notes'), T('论文主笔记', 'Paper note')],
    ['dense', NOTES().dense.t, T('概念', 'Concepts'), T('笔记', 'Note')],
    ['meet', NOTES().meet.t, T('研究日志', 'Research log'), T('笔记', 'Note')],
    [null, T('论文B.pdf', 'PaperB.pdf'), T('文献/来源', 'Literature/sources'), T('待 AI 分析', 'Awaiting AI'), 'warn'],
    [null, T('研究日志 · 第11天', 'Research log · day 11'), T('研究日志', 'Research log'), T('笔记', 'Note')]
  ];
  function noteHTML(k, cls) {
    const n = NOTES()[k];
    return `<article class="wnote ${cls || ''}" data-k="${k}"><div class="h4">${esc(n.t)}</div><div class="meta">${esc(n.meta)}</div>${n.b}<div class="bl">${T('链接到这里', 'Linked from')}<br>${n.bl.map(x => `<span>${esc(x)}</span>`).join('')}</div><div class="mdhint">${T('Markdown 笔记 · 修改后按 ⌘S 保存', 'Markdown note · ⌘S to save changes')}</div></article>`;
  }
  const tabsHTML = () => tabs.map(k => `<span class="r-tab${k === cur ? ' on' : ''}" data-k="${k}"><small>${T('笔记', 'Note')}</small>${esc(NOTES()[k].t)}<i>×</i></span>`).join('');
  function render() {
    run.cancel(); cur = 'rag'; tabs = ['rag'];
    scr.innerHTML = `<div class="split src"><div class="srcs-pane">
        <div class="crumb">${T('工作区', 'Workspace')} / ${T('科研', 'Research')} / ${T('毕业论文', 'Thesis')} / <b>${T('资料', 'Sources')}</b></div>
        <div class="ptabs">${[T('对话', 'Chats'), T('资料', 'Sources'), T('成果', 'Outputs'), T('任务', 'Tasks'), T('排期', 'Schedule'), T('总览', 'Overview')].map((x, i) => `<span${i === 1 ? ' class="on"' : ''}>${x}</span>`).join('')}</div>
        <div class="sp-head"><div><div class="h4">${T('资料', 'Sources')}</div><small>${T('5 篇笔记 · 2 份原始资料 · 2 篇论文', '5 notes · 2 originals · 2 papers')}</small></div><span class="b pri dark">${T('添加资料', 'Add')}</span><span class="b ghost">${T('连接本机目录', 'Link a folder')}</span></div>
        <div class="seg wide"><span class="on">${T('资料', 'Sources')} 9</span><span>${T('记录', 'Records')} 0</span><span>${T('全部', 'All')} 9</span></div>
        <div class="dirs"><div class="on">${ic('doc')}${T('全部资料', 'All sources')}<small>9</small></div><div>${ic('folder')}${T('未分类', 'Unsorted')}<small>1</small></div><div>${ic('folder')}${T('文献', 'Literature')}<small>5</small></div><div>${ic('folder')}${T('研究日志', 'Research log')}<small>3</small></div></div>
        <div class="fld" style="font-family:inherit;color:var(--muted);margin-top:10px;margin-bottom:6px">${ic('search')}&nbsp;${T('搜索名称、标签和状态', 'Search names, tags and status')}</div>
        <div class="rows">${ROWS().map(([k, t, sub, st, w]) => `<div class="row${k === cur ? ' on' : ''}"${k ? ` data-k="${k}" role="button" tabindex="0"` : ''}><i class="cb"></i>${ic('note')}<span class="nm">${esc(t)}<small>${esc(sub)}</small></span><span class="st${w ? ' warn' : ''}">${esc(st)}</span></div>`).join('')}</div>
      </div>
      <div class="reader nr">
        <div class="r-head"><span class="bk">← ${T('返回资料', 'Back to sources')}</span><small class="pth">${T('科研空间 / 毕业论文', 'Research / Thesis')}</small><span class="sp"></span><span>${T('问 AI', 'Ask AI')}</span><span>${T('引用到对话', 'Quote in chat')}</span><span class="b ghost">${ic('folder')}${T('文件', 'File')}</span></div>
        <div class="ntabs">${tabsHTML()}</div>
        <div class="r-info">› ${T('文档信息与来源', 'Document info and source')}</div>
        <div class="modes"><span class="seg"><span class="on">${T('阅读', 'Read')}</span><span>${T('编辑', 'Edit')}</span><span>${T('源码', 'Source')}</span></span><span>${T('大纲', 'Outline')}</span><span class="sp"></span><small>${T('已保存', 'Saved')}</small><span>${T('AI 改写', 'AI rewrite')}</span></div>
        <div class="note-v">${noteHTML('rag')}</div>
        <div class="r-foot"><span class="b ghost" style="color:var(--red)">${T('移入回收站', 'Move to Trash')}</span><span class="sp"></span><span class="b ghost">${T('编辑 Markdown', 'Edit Markdown')}</span><span class="b ghost">${T('导出 Markdown', 'Export Markdown')}</span></div>
      </div></div>`;
    $$('.rows .row[data-k]', scr).forEach(r => {
      r.addEventListener('click', () => { touched = true; go(r.dataset.k); });
      r.addEventListener('keydown', e => { if (e.key === 'Enter') { touched = true; go(r.dataset.k); } });
    });
    bind();
  }
  function bind() {
    $$('.wnote:not(.left):not(.right) .wl', scr).forEach(a => {
      a.onclick = () => { touched = true; go(a.dataset.go); };
      a.onkeydown = e => { if (e.key === 'Enter') { touched = true; go(a.dataset.go); } };
    });
    $$('.ntabs .r-tab', scr).forEach(t => { t.onclick = e => { touched = true; if (e.target.tagName === 'I' && tabs.length > 1) { close(t.dataset.k); return; } go(t.dataset.k, true); }; });
  }
  function close(k) {
    tabs = tabs.filter(x => x !== k);
    if (k === cur) go(tabs[tabs.length - 1], true); else { $('.ntabs', scr).innerHTML = tabsHTML(); bind(); }
  }
  // A link opens the note in a new reading tab; picking an earlier tab slides back.
  function go(k, back) {
    if (k === cur) return;
    if (!tabs.includes(k)) tabs.push(k);
    const idxOld = tabs.indexOf(cur), idxNew = tabs.indexOf(k);
    back = back && idxNew < idxOld;
    const v = $('.note-v', scr), old = $('.wnote', v);
    cur = k;
    const n = h(noteHTML(k, back ? 'left' : 'right')); v.append(n);
    old.classList.add(back ? 'right' : 'left');
    requestAnimationFrame(() => requestAnimationFrame(() => n.classList.remove('left', 'right')));
    setTimeout(() => old.remove(), 650);
    $$('.rows .row', scr).forEach(x => x.classList.toggle('on', x.dataset.k === k));
    $('.ntabs', scr).innerHTML = tabsHTML();
    bind();
  }
  render();
  return {
    key: 'wiki', nav: 'p-thesis', title: () => T('科研 · 毕业论文', 'Research · Thesis'), scr,
    enter() {}, leave() { run.cancel(); },
    auto(force) {
      if (touched && !force) return; touched = false;
      render();
      run.play(async ({ step, click }) => {
        await step(300);
        await click($('.wnote .wl[data-go=dense]', scr), () => go('dense')); await step(1800);
        await click($('.ntabs .r-tab[data-k=rag]', scr), () => go('rag', true)); await step(1400);
        await click($('.wnote:not(.left):not(.right) .wl[data-go=paperb]', scr), () => go('paperb')); await step(1600);
        await click($('.rows .row[data-k=meet]', scr), () => go('meet'));
      });
    },
    reset: render, get touched() { return touched; }
  };
}

// ---- island: hold to talk ----
function islandChapter(win, base) {
  const run = runner(win);
  const layer = h('<div class="scr ov" data-s="island" style="pointer-events:none"></div>');
  const dim = h('<div class="dim"></div>');
  const isl = h('<div class="island" role="button" tabindex="0"></div>');
  win.append(dim, isl);
  let touched = false, state = 'idle', words = [], timer = 0, waveT = 0, holdT = 0;
  const RAW = () => L() === 'en'
    ? ['um', 'move', 'tomorrow', 'morning’s', 'group', 'meeting', 'to', '3pm', 'and', 'uh', 'remind', 'me', 'to', 'bring', 'the', 'printed', 'results']
    : ['嗯', '帮我把', '明天上午的', '组会', '改到', '下午三点', '然后', '那个', '提醒我', '带上', '实验结果的', '打印稿'];
  const FILL = () => L() === 'en' ? ['um', 'uh'] : ['嗯', '那个', '然后'];
  const TIDY = () => T('把明天上午的组会改到下午三点，并提醒我带上实验结果的打印稿。', 'Move tomorrow morning’s group meeting to 3pm and remind me to bring the printed results.');
  function idle() {
    state = 'idle'; clearInterval(timer); clearInterval(waveT); isl.classList.remove('big');
    isl.innerHTML = `<div class="row"><span class="dot"></span>${T('按住说话', 'Hold to talk')}<span class="r">${T('空格', 'Space')}</span></div>`;
  }
  function wave() {
    clearInterval(waveT);
    waveT = setInterval(() => $$('.wave i', isl).forEach(i => { i.style.height = (20 + Math.random() * 80) + '%'; }), 120);
  }
  function startHold() {
    if (state === 'listen') return;
    touched = true; run.cancel(); state = 'listen'; words = [];
    isl.classList.add('big');
    isl.innerHTML = `<div class="row"><span class="dot" style="background:#ff7a6e;box-shadow:0 0 8px #ff7a6e"></span>${T('正在听你说', 'Listening')}<span class="wave">${'<i></i>'.repeat(9)}</span></div><div class="tx"></div><div class="ft"><span>${T('松开结束 · Esc 取消', 'Release to finish · Esc cancels')}</span></div>`;
    wave();
    const raw = RAW(), fill = FILL(); let i = 0;
    const tx = $('.tx', isl);
    clearInterval(timer);
    timer = setInterval(() => {
      if (i >= raw.length) { clearInterval(timer); return; }
      const w = raw[i++]; const s = document.createElement('span');
      s.textContent = (L() === 'en' && i > 1 ? ' ' : '') + w; if (fill.includes(w)) s.className = 'dim2';
      tx.append(s);
    }, reduced() ? 0 : 230);
  }
  async function endHold() {
    if (state !== 'listen') return;
    state = 'tidy'; clearInterval(timer); clearInterval(waveT);
    const tx = $('.tx', isl);
    isl.querySelector('.row').innerHTML = `<span class="spin" style="color:#a8d9b8"></span>${T('整理中…', 'Tidying…')}`;
    await sleep(700);
    if (state !== 'tidy') return;
    state = 'confirm';
    isl.querySelector('.row').innerHTML = `<span class="dot"></span>${T('识别的指令', 'Recognized instruction')}`;
    tx.innerHTML = esc(TIDY());
    $('.ft', isl).innerHTML = `<span>${T('确认后才发送 · Esc 取消', 'Send when ready · Esc to cancel')}</span><span class="sp"></span><button type="button" data-a="note">${T('记成随记', 'Save as note')}</button><button type="button" class="go" data-a="send">${T('交给 AI Bro', 'Send to AI Bro')}</button>`;
    $('[data-a=note]', isl).addEventListener('click', e => { e.stopPropagation(); finish('note'); });
    $('[data-a=send]', isl).addEventListener('click', e => { e.stopPropagation(); finish('send'); });
  }
  async function finish(kind) {
    state = 'done';
    isl.classList.remove('big');
    if (kind === 'note') {
      isl.innerHTML = `<div class="row"><span style="color:#a8d9b8">${ic('check')}</span>${T('随记已保存，再记一条', 'Note saved. New note')}</div>`;
    } else {
      isl.innerHTML = `<div class="row"><span class="spin" style="color:#a8d9b8"></span>${T('交给 AI Bro…', 'Sending to AI Bro…')}</div>`;
      await sleep(1300);
      isl.innerHTML = `<div class="row"><span style="color:#a8d9b8">${ic('check')}</span>${T('已完成', 'Done')}<span class="r">${T('组会 → 15:00', 'Meeting → 3pm')}</span></div>`;
    }
    await sleep(2600); if (state === 'done') idle();
  }
  isl.addEventListener('pointerdown', e => { if (e.target.closest('button')) return; e.preventDefault(); holdT = performance.now(); if (state === 'idle' || state === 'done') startHold(); });
  on(window, 'pointerup', () => { if (state === 'listen') endHold(); });
  isl.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat && state !== 'listen') { e.preventDefault(); startHold(); } });
  isl.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') endHold(); });
  let active = false;
  on(window, 'keydown', e => {
    if (!active || e.code !== 'Space' || e.repeat || e.target.closest('input,textarea,[contenteditable],button,a,summary,.island')) return;
    e.preventDefault(); if (state !== 'listen') startHold();
  });
  on(window, 'keyup', e => { if (active && e.code === 'Space') endHold(); });
  on(window, 'keydown', e => { if (active && e.key === 'Escape' && state !== 'idle') idle(); });
  idle();
  return {
    key: 'island', nav: base.nav, title: base.title, scr: base.scr, layer,
    enter() { active = true; isl.classList.add('on'); dim.classList.add('on'); },
    leave() { active = false; run.cancel(); isl.classList.remove('on'); dim.classList.remove('on'); if (state === 'listen') { clearInterval(timer); } idle(); },
    auto(force) {
      if (touched && !force) return; touched = false;
      run.play(async ({ step, to }) => {
        await to(isl);
        startHold(); touched = false; await step(RAW().length * 230 + 500);
        await endHold(); touched = false; await step(1400);
        const b = $('[data-a=send]', isl); if (b) { await to(b); finish('send'); }
      });
    },
    reset: idle, get touched() { return touched; }
  };
}

// ---- ⌘K palette over a finished chat ----
function cmdkChapter(win) {
  const run = runner(win);
  const scr = h('<section class="scr" data-s="chatdone"></section>');
  $('.w-body', win).append(scr);
  const pal = h('<div class="pal" role="dialog"></div>');
  $('.w-main', win).append(pal);
  let touched = false, sel = 0, rows = [], active = false;
  // [group, icon, [[title, subtitle, shortcut]], isCommand]
  const DATA = () => [
    [T('对话', 'Chats'), 'chats', [[T('梯度下降的学习率怎么选', 'Choosing a learning rate'), T('机器学习 · 今天', 'Machine Learning · today')], [T('组会要讲的三件事', 'Three things for group meeting'), T('日常 · 昨天', 'Daily · yesterday')]]],
    [T('笔记', 'Notes'), 'note', [[T('检索增强生成（RAG）', 'Retrieval-augmented generation'), T('科研 · 知识库', 'Research · knowledge base')], [T('组会纪要 · 10月20日', 'Group meeting · Oct 20'), T('随记整理', 'From a quick note')], [T('稠密检索', 'Dense retrieval'), T('科研 · 知识库', 'Research · knowledge base')]]],
    [T('日程', 'Agenda'), 'cal', [[T('组会 · 周五 15:00', 'Group meeting · Fri 15:00'), T('提前 30 分钟提醒', 'reminder 30 min before')], [T('机器学习 第5讲', 'ML lecture 5'), T('周三 10:00', 'Wed 10:00')]]],
    [T('资料', 'Files'), 'doc', [[T('第3讲-优化.pdf', 'Lecture3-Optimization.pdf'), T('机器学习 · 28 页', 'Machine Learning · 28 pages')], [T('论文B.pdf', 'PaperB.pdf'), T('科研', 'Research')]]],
    [T('命令', 'Commands'), 'cmd', [[T('新建对话', 'New chat'), T('开始一个新目标', 'Start a new goal'), '⌘N'], [T('新建项目', 'New project'), T('集中管理相关对话、资料和任务', 'Keep related chats, files and tasks together')], [T('新建任务', 'New task'), T('添加一项待办及截止日期', 'Add a to-do with a due date')], [T('打开当前项目', 'Open current project'), T('机器学习', 'Machine Learning')], [T('打开总览', 'Open overview'), ''], [T('打开日常空间', 'Open Daily space'), ''], [T('打开课程空间', 'Open Courses space'), ''], [T('打开科研空间', 'Open Research space'), '']], true]
  ];
  function renderChat() {
    scr.innerHTML = `<div class="w-wash"></div><div class="chat"><div class="crumb">${T('全部对话', 'All chats')} / <b>${T('梯度下降的学习率怎么选', 'Choosing a learning rate')}</b></div><div class="chat-log"><div class="chat-col">
      <div class="msg-u">${T('第 3 讲的梯度下降，学习率太大为什么会发散？', 'In lecture 3, why does gradient descent diverge when the learning rate is too big?')}</div>
      <div class="msg-a">${WHO(false)}<div class="prog done"><div class="prog-h"><span class="okc">${ic('check')}</span><b class="t">${T('已完成', 'Done')}</b><span class="el">8 ${T('秒', 's')} · ${T('3 项过程', '3 steps')}</span><span class="cu"></span>${ic('chev', 'i chev')}</div></div>
      <p>${T('课件用一个二次函数来解释：η 超过 2/L 时，每一步都会越过谷底，而且越过得越来越多。', 'The slides use a quadratic: once η is larger than 2/L, every step overshoots the bottom by more than the last.')}<sup class="cn">1</sup></p></div></div></div>
      <div class="composer"><div class="in" data-ph="${T('发消息，或添加文件与网页…', 'Message, or add files and pages…')}"></div><div class="bar">${ic('plus')}${ic('at')}<span class="sp"></span>${MODEL()}${ic('mic')}<button class="send" type="button" disabled aria-label="${T('发送', 'Send')}">${ic('send')}</button></div></div></div>
      <div class="toast">${ic('check')}<span></span></div>`;
  }
  function render() {
    run.cancel(); renderChat(); sel = 0;
    pal.setAttribute('aria-label', T('搜索', 'Search'));
    pal.innerHTML = `<div class="q">${ic('search')}<input type="text" aria-label="${T('搜索内容或命令', 'Search content or commands')}" placeholder="${T('搜索内容或命令，输入 > 只看命令…', 'Search content or commands; type > for commands…')}" autocomplete="off" spellcheck="false"><kbd>esc</kbd></div><div class="res"></div>`;
    const input = $('input', pal);
    input.addEventListener('input', () => { touched = true; run.cancel(); sel = 0; list(); });
    input.addEventListener('keydown', e => {
      touched = true; run.cancel();
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(rows.length - 1, sel + 1); mark(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); mark(); }
      else if (e.key === 'Enter') { e.preventDefault(); open(); }
      else if (e.key === 'Escape') { input.value = ''; list(); }
    });
    list();
  }
  function list() {
    const q = $('input', pal).value.trim(), cmd = q.startsWith('>'), qq = (cmd ? q.slice(1) : q).trim().toLowerCase();
    const res = $('.res', pal); rows = [];
    let html = q ? '' : `<div class="hint">${T('选择常用命令，或输入关键词查找工作区内容；> 只搜索命令', 'Pick a command, or type to search the workspace; > searches commands only')}</div>`;
    for (const [g, icon, items, isCmd] of DATA()) {
      if (cmd && !isCmd) continue;
      if (!q && !isCmd) continue;
      const hits = items.filter(([t, sub]) => !qq || (t + ' ' + sub).toLowerCase().includes(qq)).slice(0, q ? 4 : 8);
      if (!hits.length) continue;
      html += `<div class="g">${esc(g)}<span>${hits.length}</span></div>`;
      for (const [t, sub, key] of hits) {
        const i = t.toLowerCase().indexOf(qq);
        const label = qq && i >= 0 ? esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + qq.length)) + '</mark>' + esc(t.slice(i + qq.length)) : esc(t);
        html += `<div class="r" data-i="${rows.length}"><span class="ptile">${isCmd ? '›' : ic(icon)}</span><span class="tt">${label}${sub ? `<small>${esc(sub)}</small>` : ''}</span>${key ? `<kbd>${key}</kbd>` : ''}</div>`;
        rows.push(t);
      }
    }
    res.innerHTML = rows.length ? html : `<div class="none">${T('没有找到。试试“组会”或“>”', 'Nothing found. Try “meeting” or “>”')}</div>`;
    $$('.r', res).forEach(r => { r.addEventListener('mouseenter', () => { sel = +r.dataset.i; mark(); }); r.addEventListener('click', () => { touched = true; sel = +r.dataset.i; open(); }); });
    mark();
  }
  function mark() { $$('.r', pal).forEach(r => r.classList.toggle('on', +r.dataset.i === sel)); }
  function open() {
    const t = rows[sel]; if (!t) return;
    pal.classList.remove('on');
    const toast = $('.toast', scr); $('span', toast).textContent = T('已打开：', 'Opened: ') + t; toast.classList.add('on');
    setTimeout(() => { toast.classList.remove('on'); if (active) { $('input', pal).value = ''; list(); pal.classList.add('on'); } }, 1800);
  }
  on(window, 'keydown', e => {
    if (active && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); pal.classList.add('on'); $('input', pal).focus({ preventScroll: true }); }
  });
  render();
  return {
    key: 'cmdk', nav: 'chats', title: () => T('全部对话', 'All chats'), scr, layer: pal,
    enter() { active = true; pal.classList.add('on'); },
    leave() { active = false; run.cancel(); pal.classList.remove('on'); },
    auto(force) {
      if (touched && !force) return; touched = false;
      render(); pal.classList.add('on');
      const input = $('input', pal);
      run.play(async ({ step, to }) => {
        await to(input, 0.2);
        for (const ch of T('组会', 'meeting')) { input.value += ch; list(); await step(260); }
        await step(500); sel = 1; mark(); await step(700); sel = 2; mark(); await step(700);
        await to($('.r.on', pal)); open();
      });
    },
    reset: render, get touched() { return touched; }
  };
}

// ---- scheduled tasks: run, pause at the boundary, approve ----
function tasksChapter(win, base) {
  const run = runner(win);
  const layer = h('<div class="ovl"></div>');
  const dim = h('<div class="dim"></div>');
  win.append(dim); $('.w-main', win).append(layer);
  let touched = false, state = 'idle';
  function render() {
    run.cancel(); state = 'idle';
    layer.innerHTML = `<div class="dlg" role="dialog" aria-label="${T('计划任务', 'Scheduled tasks')}"><div class="dh"><strong class="h5">${T('计划任务', 'Scheduled tasks')}</strong><span class="b">${T('关闭', 'Close')}</span></div>
      <p class="lead">${T('人工提醒到点由系统通知（App 关闭也会送达），2 小时未处理标为过期。自动任务到点由 AI 在后台无人值守执行，只做声明范围内的事；App 关闭期间错过的，下次打开只补最近一次。', 'Manual reminders arrive as system notifications, even with the app closed, and expire after 2 hours. Automatic tasks run unattended in the background and only do what they declared. If the app was closed, only the latest missed run is made up.')}</p>
      <div class="task"><b>${T('每周组会摘要', 'Weekly meeting digest')}</b><div class="m">${T('自动任务 · 等待到点 · 下次 11月2日 周一 08:00', 'Automatic · waiting · next Mon Nov 2, 08:00')}<br>${T('范围：只读（默认）· 外部工具 0 · 电脑操作关', 'Scope: read-only (default) · external tools 0 · computer use off')}<br>▸ ${T('执行历史 · 6', 'Run history · 6')}</div><div class="acts"><span class="b">${T('编辑', 'Edit')}</span><span class="b">${T('暂停', 'Pause')}</span><span class="b">${T('立即运行', 'Run now')}</span><span class="b">${T('归档', 'Archive')}</span></div></div>
      <div class="task" data-t="dl"><b>${T('整理下载文件夹', 'Tidy the downloads folder')}</b><div class="m"><span class="st">${T('自动任务 · 等待到点 · 每天 21:00', 'Automatic · waiting · daily 21:00')}</span><br>${T('范围：可写，每次写入先问我 · 外部工具 0 · 电脑操作关', 'Scope: may write, ask before each write · external tools 0 · computer use off')}</div>
        <div class="tl" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
        <div class="acts"><span class="b">${T('编辑', 'Edit')}</span><span class="b">${T('暂停', 'Pause')}</span><button class="b pri" type="button" data-a="run">${ic('play')}${T('立即运行', 'Run now')}</button><span class="b">${T('归档', 'Archive')}</span></div></div>
      <div class="task"><b>${T('交作业提醒', 'Homework reminder')}</b><div class="m">${T('人工提醒 · 每周四 20:00', 'Manual reminder · Thursdays 20:00')}</div></div></div>
      <div class="appr" role="dialog" aria-label="${T('等待审批', 'Needs review')}"><b>${T('整理下载文件夹', 'Tidy the downloads folder')}</b><div style="color:var(--muted);font-size:11px">${T('来源：scheduler · 要写入文件', 'Source: scheduler · wants to write files')}</div>
        <pre>{"move": 18, "to": "~/Downloads/${T('归档', 'Archive')}/2026-10"}</pre>
        <div class="acts"><button class="b pri" type="button" data-a="ok">${T('批准', 'Approve')}</button><button class="b" type="button" data-a="no">${T('拒绝', 'Reject')}</button><span style="flex:1"></span><button class="b ghost" type="button" data-a="stop">${T('停止', 'Stop')}</button></div></div>
      <div class="bgpill"><span></span></div>`;
    $('[data-a=run]', layer).addEventListener('click', () => { touched = true; start(); });
    $('[data-a=ok]', layer).addEventListener('click', () => { touched = true; decide(true); });
    $('[data-a=no]', layer).addEventListener('click', () => { touched = true; decide(false); });
    $('[data-a=stop]', layer).addEventListener('click', () => { touched = true; decide(false, true); });
  }
  const seg = i => $$('.task[data-t=dl] .tl i', layer)[i];
  const status = t => { $('.task[data-t=dl] .st', layer).textContent = t; };
  async function start() {
    if (state !== 'idle' && state !== 'done') return;
    if (state === 'done') { render(); }
    state = 'run';
    const task = $('.task[data-t=dl]', layer); task.classList.add('run');
    const pill = $('.bgpill', layer);
    $('span', pill).textContent = T('后台运行 · 1', 'Background · 1'); pill.classList.add('on');
    status(T('运行中 · 读取 ~/Downloads', 'Running · reading ~/Downloads')); seg(0).classList.add('done'); await sleep(900);
    status(T('运行中 · 归类 18 个文件', 'Running · sorting 18 files')); seg(1).classList.add('done'); await sleep(1000);
    if (state !== 'run') return;
    state = 'wait';
    status(T('等待审批 · 要移动 18 个文件', 'Needs review · wants to move 18 files')); seg(2).classList.add('wait');
    pill.classList.add('warn'); $('span', pill).textContent = T('后台运行 · 待审批 1', 'Background · needs review 1');
    $('.appr', layer).classList.add('on');
  }
  async function decide(ok, stop) {
    if (state !== 'wait') return;
    state = 'done';
    $('.appr', layer).classList.remove('on');
    const pill = $('.bgpill', layer); pill.classList.remove('warn');
    if (ok) {
      seg(2).classList.remove('wait'); seg(2).classList.add('done'); status(T('运行中 · 移动文件', 'Running · moving files')); await sleep(800);
      seg(3).classList.add('done'); status(T('已完成 · 移动了 18 个文件', 'Done · moved 18 files'));
    } else {
      seg(2).classList.remove('wait'); status(stop ? T('已停止 · 没有改动任何文件', 'Stopped · nothing was changed') : T('已拒绝 · 没有改动任何文件', 'Rejected · nothing was changed'));
    }
    $('span', pill).textContent = ok ? T('后台运行 · 已完成', 'Background · done') : T('后台运行 · 已结束', 'Background · ended');
    setTimeout(() => pill.classList.remove('on'), 2400);
  }
  render();
  return {
    key: 'tasks', nav: 'history', title: () => T('执行历史', 'Run history'), scr: base.scr, layer,
    enter() { layer.style.display = ''; dim.classList.add('on'); },
    leave() { run.cancel(); layer.style.display = 'none'; dim.classList.remove('on'); },
    auto(force) {
      if (touched && !force) return; touched = false;
      render();
      run.play(async ({ step, click }) => {
        await step(300);
        await click($('[data-a=run]', layer), () => start()); await step(2400);
        await click($('[data-a=ok]', layer), () => decide(true));
      });
    },
    reset: render, get touched() { return touched; }
  };
}

// ---- settings → models ----
function modelsChapter(win) {
  const run = runner(win);
  const scr = h('<section class="scr" data-s="models"></section>');
  $('.w-body', win).append(scr);
  let touched = false, cur = 0, testing = false;
  const PROV = () => [
    { id: 'C', n: 'ChatGPT', tag: [T('默认', 'Default'), ''], sub: T('已登录 · 复用现有账号', 'Signed in · existing account'), kind: 'acct', models: ['gpt-5.6-luna', 'gpt-5.6-luna-mini', 'gpt-5.5'], ms: 188 },
    { id: 'D', n: 'DeepSeek', tag: [T('未验证', 'Unverified'), 'warn'], sub: 'deepseek-v4.1', kind: 'api', url: 'https://api.deepseek.com/v1', models: ['deepseek-v4.1', 'deepseek-v4.1-flash', 'deepseek-reasoner'], ms: 214 },
    { id: 'Q', n: T('通义千问', 'Qwen'), tag: [T('未验证', 'Unverified'), 'warn'], sub: 'qwen3.5-plus', kind: 'api', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen3.5-max', 'qwen3.5-plus', 'qwen3.5-flash', 'qwen3.5-vl'], ms: 263 },
    { id: 'O', n: 'Ollama', tag: [T('本机', 'Local'), 'mute'], sub: 'llama4:8b', kind: 'api', url: 'http://127.0.0.1:11434/v1', fail: true }
  ];
  function detail(p) {
    const fields = p.kind === 'acct'
      ? `<label>${T('账号', 'Account')}</label><div class="fld" style="font-family:inherit">${T('已登录 · 复用现有账号', 'Signed in · existing account')}</div><p style="font-size:11px;color:var(--muted);margin-top:6px">${T('经官方登录；AI Bro 不读取也不保存令牌。', 'Signed in officially; AI Bro neither reads nor stores the token.')}</p>`
      : `<label>${T('API 地址', 'API address')}</label><div class="fld">${esc(p.url)}</div><label>${T('密钥', 'Key')}</label><div class="fld">${p.fail ? T('（本机服务不需要）', '(not needed for a local service)') : '••••••••••••••••'}</div>`;
    return `<div class="pd-body"><div class="t"><span class="av">${p.id}</span><b>${esc(p.n)}</b><span class="pill ${p.tag[1]}">${esc(p.tag[0])}</span></div>${fields}
      <label>${T('默认模型', 'Default model')}</label><div class="fld">${esc(p.sub.includes('·') ? (p.models || [''])[0] : p.sub)}</div>
      <div class="acts"><button class="b pri" type="button" data-a="test">${T('测试可用性', 'Test')}</button><span class="b">${T('重新检测', 'Re-check')}</span>${p.kind === 'acct' ? `<span class="b">${T('登录', 'Sign in')}</span>` : ''}<span style="flex:1"></span><span class="b ghost" style="color:var(--red)">${T('从列表移除', 'Remove')}</span></div>
      <div class="res" role="status"></div></div>`;
  }
  function render() {
    run.cancel(); cur = 0; testing = false;
    const ps = PROV();
    scr.innerHTML = `<div class="set"><div class="ph"><strong class="h4">${T('设置', 'Settings')}<small>${T('模型、同步、检索与界面偏好，各自清楚管理。', 'Models, sync, retrieval and interface, each in its place.')}</small></strong><span class="b ghost">${T('新手引导', 'Getting started')}</span></div>
      <div class="set-nav"><span class="on">${T('模型', 'Models')}</span><span>${T('服务器同步', 'Server sync')}</span><span>${T('知识库检索', 'Knowledge retrieval')}</span><span>${T('插件', 'Plugins')}</span><span>${T('界面偏好', 'Interface')}</span></div>
      <div class="card"><strong class="h5">${T('模型', 'Models')}</strong><p class="d">${T('选一个默认模型就能用；其余用途需要时再单独指定。密钥只保存在系统钥匙串里。', 'Pick one default model and you are set; assign others per purpose when needed. Keys live only in the system Keychain.')}</p>
        <div style="display:flex;gap:8px;margin-bottom:12px"><span class="seg"><span class="on">${T('文本生成', 'Text')}</span><span>${T('嵌入', 'Embedding')}</span><span>${T('语音识别', 'Speech')}</span><span>${T('使用统计', 'Usage')}</span></span><span style="flex:1"></span><span class="b ghost">${T('从 CC Switch 导入', 'Import from CC Switch')}</span></div>
        <div class="mrow"><div class="plist"><div class="h">${T('已启用 · 拖拽排序，首位为默认', 'Enabled · drag to reorder, first is default')}</div>
          ${ps.map((p, i) => `<button class="prov${i === 0 ? ' on' : ''}" type="button" data-i="${i}"><span class="av">${p.id}</span><span><b>${esc(p.n)}${p.tag[0] ? `<span class="pill ${p.tag[1]}">${esc(p.tag[0])}</span>` : ''}</b><small>${esc(p.sub)}</small></span></button>`).join('')}
          <div style="font-size:12px;color:var(--accent);padding:8px">＋ ${T('添加供应商', 'Add provider')}</div>
          <div class="uses"><div class="h">${T('用途', 'Purposes')}</div>${[[T('默认模型（问答）', 'Default (chat)'), 'gpt-5.6-luna'], [T('翻译', 'Translation'), T('跟随默认', 'Same as default')], [T('视觉', 'Vision'), T('跟随默认', 'Same as default')], [T('内核', 'Kernel'), T('跟随默认', 'Same as default')]].map(([a, b]) => `<div><b>${a}</b><small>${b}</small></div>`).join('')}</div></div>
          <div class="pd">${detail(ps[0])}</div></div></div></div>`;
    $$('.prov[data-i]', scr).forEach(b => b.addEventListener('click', () => { touched = true; pick(+b.dataset.i); }));
    bindTest();
  }
  function bindTest() { $('[data-a=test]', scr).addEventListener('click', () => { touched = true; test(); }); }
  function pick(i) {
    if (i === cur) return; cur = i; testing = false;
    $$('.prov[data-i]', scr).forEach(b => b.classList.toggle('on', +b.dataset.i === i));
    const pd = $('.pd', scr), body = $('.pd-body', pd);
    body.classList.add('swap');
    setTimeout(() => { pd.innerHTML = detail(PROV()[i]); const nb = $('.pd-body', pd); nb.classList.add('swap'); requestAnimationFrame(() => requestAnimationFrame(() => nb.classList.remove('swap'))); bindTest(); }, reduced() ? 0 : 200);
  }
  async function test() {
    if (testing) return; testing = true;
    const p = PROV()[cur], btn = $('[data-a=test]', scr), res = $('.res', scr), my = cur;
    btn.innerHTML = `<span class="spin"></span>${T('测试中…', 'Testing…')}`;
    res.classList.remove('on');
    await sleep(reduced() ? 100 : 1100);
    if (my !== cur) return;
    btn.innerHTML = T('测试可用性', 'Test');
    if (p.fail) {
      res.style.background = '#c98a1a1a';
      res.innerHTML = `<span style="color:var(--orange);font-weight:600">${T('连不上', 'Unreachable')}</span>${T('127.0.0.1:11434 没有响应，确认 Ollama 已启动。', '127.0.0.1:11434 did not answer. Is Ollama running?')}`;
    } else {
      res.innerHTML = `<div><span class="ok">${ic('check')} ${T('可用', 'Available')}</span> · ${T(`读取到 ${p.models.length} 个模型`, `${p.models.length} models listed`)} · ${p.ms} ms<div class="models">${p.models.map((m, k) => `<span style="animation-delay:${k * 60}ms">${m}</span>`).join('')}</div></div>`;
      const pill = $('.pd .pill', scr); if (pill && p.tag[1] === 'warn') { pill.className = 'pill'; pill.textContent = T('已验证', 'Verified'); const lp = $(`.prov[data-i="${cur}"] .pill`, scr); if (lp) { lp.className = 'pill'; lp.textContent = T('已验证', 'Verified'); } }
    }
    res.classList.add('on'); testing = false;
  }
  render();
  return {
    key: 'models', nav: 'settings', title: () => T('模型与知识库设置', 'Models & knowledge settings'), scr,
    enter() {}, leave() { run.cancel(); },
    auto(force) {
      if (touched && !force) return; touched = false;
      render();
      run.play(async ({ step, click }) => {
        await step(300);
        await click($('.prov[data-i="1"]', scr), () => pick(1)); await step(500);
        await click($('[data-a=test]', scr), () => test()); await step(2200);
        await click($('.prov[data-i="3"]', scr), () => pick(3)); await step(500);
        await click($('[data-a=test]', scr), () => test());
      });
    },
    reset: render, get touched() { return touched; }
  };
}

// ---- mounting ----
const CHAPTERS = ['agenda', 'read', 'wiki', 'island', 'cmdk', 'tasks', 'models'];
function mountChapter(key, win, ctrls = {}) {
  switch (key) {
    case 'agenda': return agendaChapter(win);
    case 'read': return readChapter(win);
    case 'wiki': return wikiChapter(win);
    case 'cmdk': return cmdkChapter(win);
    case 'models': return modelsChapter(win);
    case 'island': return islandChapter(win, ctrls.wiki || wikiChapter(win));
    case 'tasks': return tasksChapter(win, ctrls.cmdk || cmdkChapter(win));
  }
}
function show(win, ctrls, c, prev) {
  if (prev && prev !== c) prev.leave();
  setNav(win, c.nav); setTitle(win, c.title());
  $$('.w-body > .scr', win).forEach(s => s.classList.toggle('on', s === c.scr));
  c.enter();
}
// Each window gets an "untouched → play once" timer when it becomes visible or its chapter becomes active.
function autoplay(ctrl, delay = 1200) {
  if (reduced() || !ctrl || ctrl.touched) return 0;
  return setTimeout(() => ctrl.auto(), delay);
}

let built = [];
function teardown() { ac.abort(); ac = new AbortController(); built.forEach(b => b.dispose && b.dispose()); built = []; $$('[data-win], .m-win').forEach(el => { el.innerHTML = ''; }); }
const wide = matchMedia('(min-width: 1024px)');
function build() {
  teardown();
  // hero
  const hf = $('[data-win=hero]');
  const hw = shell(innerWidth < 700); hf.append(hw); fit(hf, hw, innerWidth < 700);
  hw.classList.add('solo');
  const hero = heroChapter(hw); setTitle(hw, hero.title()); setNav(hw, 'p-ml');
  let ht = 0;
  const hio = new IntersectionObserver(([e]) => { clearTimeout(ht); if (e.isIntersecting) ht = autoplay(hero, 1600); }, { threshold: 0.45 });
  hio.observe(hf);
  built.push({ dispose: () => hio.disconnect() });

  if (wide.matches) {
    const sf = $('[data-win=stage]');
    const sw = shell(false); sf.append(sw); fit(sf, sw, false);
    const ctrls = {};
    CHAPTERS.forEach(k => { ctrls[k] = mountChapter(k, sw, ctrls); });
    // overlays belonging to other chapters stay hidden until their chapter is active
    ctrls.tasks.layer.style.display = 'none';
    const rail = $('.stage-rail'); rail.innerHTML = CHAPTERS.map(() => '<i></i>').join('');
    let current = null, t = 0, seen = false;
    const activate = key => {
      const c = ctrls[key]; if (!c || c === current) return;
      clearTimeout(t);
      show(sw, ctrls, c, current); current = c;
      $$('.ch').forEach(a => a.classList.toggle('on', a.dataset.ch === key));
      $$('i', rail).forEach((i, n) => i.classList.toggle('on', CHAPTERS[n] === key));
      if (seen) t = autoplay(c, 1400);
    };
    activate('agenda');
    const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) activate(e.target.dataset.ch); }), { rootMargin: '-48% 0px -48% 0px' });
    $$('.ch').forEach(a => io.observe(a));
    // stop autoplay once the stage leaves the screen
    // Autoplay only while the stage is on screen; the first time it shows up, play the current chapter.
    const vis = new IntersectionObserver(([e]) => {
      seen = e.isIntersecting; clearTimeout(t);
      if (seen && current) t = autoplay(current, 1400);
    }, { threshold: 0.5 });
    vis.observe(sf);
    built.push({ dispose: () => { io.disconnect(); vis.disconnect(); clearTimeout(t); } });
  } else {
    $$('.ch').forEach(a => {
      const key = a.dataset.ch, box = $('.m-win', a);
      const f = h('<div class="win-fit"></div>'); box.append(f);
      const w = shell(true); f.append(w); fit(f, w, true);
      const c = mountChapter(key, w);
      if (c.layer && key === 'tasks') c.layer.style.display = '';
      show(w, {}, c, null);
      const btn = h(`<button class="replay" type="button">${ic('play')}<span>${T('播放一遍', 'Play it')}</span></button>`);
      btn.addEventListener('click', () => { c.enter(); c.auto(true); });
      box.append(btn);
      let tm = 0;
      const io = new IntersectionObserver(([e]) => { clearTimeout(tm); if (e.isIntersecting) tm = autoplay(c, 900); }, { threshold: 0.6 });
      io.observe(f);
      built.push({ dispose: () => io.disconnect() });
    });
  }
  undoArt(); themeArt();
}

// ---- bento: undo and themes ----
function undoArt() {
  const box = $('#undoArt'); if (!box) return;
  const rows = [[T('第 5 讲复习提纲', 'Lecture 5 review sheet'), T('对话', 'Chat')], [T('周四下午两点 302', 'Thu 2pm, room 302'), T('随记', 'Note')], [T('实验记录 10/24', 'Lab log 10/24'), T('笔记', 'Note')]];
  box.innerHTML = `<div class="u-list">${rows.map((r, i) => `<div class="u-row" data-i="${i}"><span>${esc(r[0])}</span><small style="color:var(--mut);font-size:11px">${esc(r[1])}</small><button type="button" aria-label="${T('删除', 'Delete')} ${esc(r[0])}">${ic('trash', '')}</button></div>`).join('')}</div><div class="u-toast" role="status"><span></span><button type="button">${T('撤销', 'Undo')}</button></div>`;
  let last = null, tm = 0;
  const toast = $('.u-toast', box);
  $$('.u-row button', box).forEach(b => b.addEventListener('click', () => {
    const row = b.closest('.u-row'); row.classList.add('gone'); last = row;
    $('span', toast).textContent = T('已移到回收站', 'Moved to Trash'); toast.classList.add('on');
    clearTimeout(tm); tm = setTimeout(() => toast.classList.remove('on'), 4000);
  }));
  $('button', toast).addEventListener('click', () => { if (last) last.classList.remove('gone'); last = null; toast.classList.remove('on'); });
}
function themeArt() {
  const box = $('#themeArt'); if (!box) return;
  const dark = matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light';
  const TH = {
    blue: { n: T('蓝灰', 'Blue-grey'), l: ['#476f93', '#e9ecef', '#fcfdfe', '#f3f5f7'], d: ['#9ab9d2', '#141618', '#202326', '#1e2226'] },
    glass: { n: T('中性灰', 'Neutral'), l: ['#3d3d40', '#f7f7f5', '#ffffff', '#f4f4f4'], d: ['#d0d0d2', '#171719', '#202022', '#252525'] },
    teal: { n: T('青绿', 'Teal'), l: ['#087f70', '#f5faf8', '#ffffff', '#eceeed'], d: ['#65d7bb', '#1b1e20', '#25292b', '#222527'] }
  };
  box.innerHTML = `<div class="th"><div class="th-sw" role="group" aria-label="${T('主题', 'Theme')}">${Object.entries(TH).map(([k, v]) => `<button type="button" data-k="${k}" aria-pressed="${k === 'teal'}"><i style="background:${dark ? v.d[0] : v.l[0]}"></i>${v.n}</button>`).join('')}</div><div class="th-prev"><div class="s"><i class="on"></i><i></i><i></i><i></i></div><div class="m"><i style="width:60%"></i><i></i><i style="width:80%"></i><b></b></div></div></div>`;
  const prev = $('.th-prev', box);
  const apply = k => {
    const v = TH[k][dark ? 'd' : 'l'];
    prev.style.setProperty('--ta', v[0]); prev.style.setProperty('--tc', v[2]); prev.style.setProperty('--ts', v[3]); prev.style.setProperty('--tl', dark ? '#ffffff1f' : '#0000001a');
    $$('button', box).forEach(b => b.setAttribute('aria-pressed', b.dataset.k === k));
  };
  $$('button', box).forEach(b => b.addEventListener('click', () => apply(b.dataset.k)));
  apply('teal');
}

build();
Site.onLang(() => build());
wide.addEventListener('change', build);
})();
