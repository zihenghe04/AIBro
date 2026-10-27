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
  check: 'M3.5 8.5l3 3 6-7', x: 'M4 4l8 8M12 4l-8 8', play: 'M5 3.5v9l7.5-4.5z', clock: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 5v3.2l2 1.3',
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
// Stream text with inline citation chips. parts: strings, '\n' for a new paragraph, and {cite, go}.
async function stream(box, parts, step, onCite) {
  let p = document.createElement('p'); p.className = 'caret'; box.append(p);
  try {
    for (const part of parts) {
      if (part === '\n') { p.classList.remove('caret'); p = document.createElement('p'); p.className = 'caret'; box.append(p); await step(80); continue; }
      if (typeof part === 'string') {
        const t = document.createTextNode(''); p.append(t);
        const chars = [...part];
        for (let i = 0; i < chars.length; i += 2) { t.data += chars.slice(i, i + 2).join(''); await step(24); }
      } else {
        const c = h(`<span class="cite" role="button" tabindex="0">${ic('doc')}${esc(part.cite)}</span>`);
        if (onCite) { c.addEventListener('click', () => onCite(part.go)); c.addEventListener('keydown', e => { if (e.key === 'Enter') onCite(part.go); }); }
        p.append(c); await step(120);
      }
    }
  } finally { p.classList.remove('caret'); }
}
async function progress(box, steps, step, doneText) {
  const el = h(`<div class="prog"><div class="prog-h"><span class="spin"></span><span class="t">${T('正在运行', 'Running')}</span><span class="el">0.0s</span></div><ol></ol></div>`);
  box.append(el);
  const t0 = performance.now(), elT = $('.el', el);
  const tick = setInterval(() => { elT.textContent = ((performance.now() - t0) / 1000).toFixed(1) + 's'; }, 100);
  try {
    for (const [b, d, ms] of steps) {
      $('ol', el).append(h(`<li><span class="mk"><i></i></span><span><b>${esc(b)}</b> · ${esc(d)}</span></li>`));
      await step(ms);
    }
  } finally { clearInterval(tick); }
  $('.spin', el).outerHTML = `<span class="ok">${ic('check')}</span>`;
  $('.t', el).textContent = doneText || T(`已完成 · ${steps.length} 步`, `Done · ${steps.length} steps`);
  return el;
}

// ---- hero: chat with scripted answers ----
const QA = () => [
  { q: T('第 3 讲的梯度下降，学习率太大为什么会发散？', 'In lecture 3, why does gradient descent diverge when the learning rate is too big?'),
    steps: [[T('检索项目资料', 'Searched the project'), T('机器学习 · 找到 3 处', 'Machine Learning · 3 matches'), 900], [T('读取原件', 'Read the original'), T('第3讲-优化.pdf 第 12–13 页', 'Lecture3-Optimization.pdf pp. 12–13'), 1000], [T('整理回答', 'Writing'), T('对照课件和课堂笔记', 'slides against class notes'), 700]],
    a: [T('课件用一个二次函数来解释：每一步沿负梯度走 η 倍的梯度。η 超过 2/L（L 是曲率的上界）时，每一步都会越过谷底，而且越过得越来越多，损失就一路往上走。', 'The slides use a quadratic: each step moves η times the gradient downhill. Once η is larger than 2/L, where L bounds the curvature, every step overshoots the bottom by more than the last, so the loss keeps climbing.'), { cite: T('第3讲 · 第 12 页', 'Lecture 3 · p.12') }, '\n',
      T('你 10 月 14 日的课堂笔记记了老师的做法：先从 0.1 试，损失开始震荡就每次除以 3。', 'Your class notes from Oct 14 record the rule of thumb: start at 0.1 and divide by 3 whenever the loss starts to oscillate.'), { cite: T('课堂笔记 · 10月14日', 'Class notes · Oct 14') }] },
  { q: T('把这周组会要讲的三件事列出来', 'List three things to bring to this week’s group meeting'),
    steps: [[T('检索随记和日程', 'Searched notes and agenda'), T('本周 · 找到 5 条', 'this week · 5 items'), 900], [T('读取原件', 'Read the original'), T('组会纪要-10月20日.md', 'Meeting-notes-Oct20.md'), 900], [T('整理回答', 'Writing'), T('按优先级排', 'ordered by priority'), 600]],
    a: [T('按你这周的随记和上次组会纪要，周五可以讲这三件：', 'From this week’s quick notes and the last meeting’s minutes, bring these on Friday:'), '\n',
      T('1. 两组消融实验补完了，结果在表 2。', '1. Two more ablation runs are done; results are in Table 2.'), { cite: T('随记 · 10月23日', 'Note · Oct 23') }, '\n',
      T('2. 数据集第二版的清洗规则改了，需要大家确认。', '2. The cleaning rules for dataset v2 changed and need sign-off.'), { cite: T('组会纪要 · 10月20日', 'Minutes · Oct 20') }, '\n',
      T('3. 下周想借两张卡跑长训练。', '3. You want to borrow two GPUs next week for a long run.'), { cite: T('随记 · 10月25日', 'Note · Oct 25') }] },
  { q: T('这两篇论文的方法差在哪？', 'How do the methods in these two papers differ?'),
    steps: [[T('检索知识库', 'Searched the knowledge base'), T('科研 · 2 篇论文笔记', 'Research · 2 paper notes'), 900], [T('读取原件', 'Read the original'), T('论文 A 第 3 节、论文 B 第 4 节', 'Paper A §3, Paper B §4'), 1000], [T('整理回答', 'Writing'), T('逐项对照', 'side by side'), 600]],
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
      <div class="chat-log"><div class="empty"><img src="${LOGO}" alt=""><small>AI Bro · ${T('你的知识伙伴', 'your knowledge partner')}</small><h4>${T('从一个想法开始。', 'Start from an idea.')}</h4><p>${T('把文件、网页或想法交给 AI，整理成有迹可循的下一步。', 'Hand AI a file, a page or a thought and get a next step you can trace.')}</p>
        <div class="sugs">${qa.map((x, i) => `<button class="sug" type="button" data-q="${i}">${esc(x.q)}</button>`).join('')}</div></div>
        <div class="chat-col"></div></div>
      <div class="composer"><div class="in" data-ph="${T('发消息，或添加文件与网页…', 'Message, or add files and pages…')}"></div>
        <div class="bar">${ic('plus')}${ic('at')}<span style="display:flex;gap:5px;align-items:center">${ic('folder')}${T('机器学习', 'Machine Learning')}${ic('chev')}</span><span class="sp"></span>
        <span class="model">${ic('spark')}gpt-5.6-luna <small>${T('默认推理', 'default effort')}</small>${ic('chev')}</span>${ic('shield')}${ic('dots')}${ic('mic')}
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
      log.append(h(`<div class="msg-u">${esc(qa.q)}</div>`));
      await step(400);
      const a = h(`<div class="msg-a"><div class="who"><img src="${LOGO}" alt="">AI Bro · gpt-5.6-luna</div></div>`);
      log.append(a);
      await progress(a, qa.steps, step);
      const ans = h('<div></div>'); a.append(ans);
      await stream(ans, qa.a, step);
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

// ---- agenda: one sentence to a draft, then the calendar ----
function agendaChapter(win) {
  const run = runner(win);
  const scr = h('<section class="scr" data-s="agenda"></section>');
  $('.w-body', win).append(scr);
  let touched = false;
  const days = () => L() === 'en' ? ['Mon 26', 'Tue 27', 'Wed 28', 'Thu 29', 'Fri 30'] : ['周一 26', '周二 27', '周三 28', '周四 29', '周五 30'];
  const ev = (d, start, end, cls, t, s) => ({ d, start, end, cls, t, s });
  const EVENTS = () => [
    ev(0, 10, 11.67, 'b2', T('机器学习 第5讲', 'ML lecture 5'), T('10:00 · 教学楼 204', '10:00 · Room 204')),
    ev(1, 14, 15, '', T('导师 1 对 1', '1:1 with advisor'), '14:00'),
    ev(2, 9, 10, '', T('读论文小组', 'Paper reading group'), '09:00'),
    ev(3, 13.5, 15.5, 'b3', T('实验课', 'Lab session'), T('13:30 · 实验楼', '13:30 · Lab')),
    ev(4, 10, 11, 'b2', T('交作业 3', 'Homework 3 due'), '10:00')
  ];
  const top = hr => ((hr - 9) * 52 + 1) + 'px', ht = (a, b) => ((b - a) * 52 - 3) + 'px';
  const SENT = () => T('周五下午三点组会，提前半小时提醒我', 'Group meeting Friday 3pm, remind me 30 minutes before');
  function render() {
    run.cancel();
    const cols = days().map((d, i) => `<div class="col" data-d="${i}"><div class="hd${i === 1 ? ' today' : ''}">${d}</div>${EVENTS().filter(e => e.d === i).map(e => `<div class="ev ${e.cls}" style="top:${parseFloat(top(e.start)) + 34}px;height:${ht(e.start, e.end)}">${esc(e.t)}<small>${esc(e.s)}</small></div>`).join('')}</div>`).join('');
    const hrs = [9, 10, 11, 12, 13, 14, 15, 16].map(x => `<div>${x}:00</div>`).join('');
    scr.innerHTML = `<div class="page">
      <div class="ph"><h4>${T('日程', 'Agenda')}<small>${T('日程已与本机工作区对齐', 'In sync with this Mac’s workspace')}</small></h4><span class="b ghost">${ic('bell')}${T('提醒', 'Reminders')}</span><span class="b ghost">${T('导入', 'Import')}</span><span class="b">${ic('plus')}${T('新建日程', 'New event')}</span></div>
      <div style="display:flex;align-items:center;gap:10px"><span class="seg"><span>${T('今日', 'Today')}</span><span class="on">${T('周', 'Week')}</span><span>${T('月', 'Month')}</span></span><span style="margin-left:auto;font-size:12px;font-weight:600">${T('2026 年 10 月 26 日 – 30 日', 'Oct 26 – 30, 2026')}</span></div>
      <div class="nl" role="button" tabindex="0" aria-label="${T('一句话新建日程', 'New event from one sentence')}">${ic('spark')}<span class="in" data-ph="${T('一句话新建，例如：周五下午三点组会，提前半小时提醒我', 'One sentence, e.g. Group meeting Friday 3pm, remind me 30 min before')}"></span><button class="send" type="button" aria-label="${T('生成草稿', 'Draft it')}">${ic('send')}</button></div>
      <div class="wk"><div class="hrs"><div class="hd"></div>${hrs}</div>${cols}<div class="grid"></div></div>
      <div class="prop" role="dialog" aria-label="${T('日程草稿', 'Event draft')}"><h5>${T('日程草稿', 'Event draft')}</h5><p class="pnote">${T('请确认日期、时间和提醒；保存前不会安排通知。', 'Check the date, time and reminder. Notifications are scheduled only after saving.')}</p>
        <dl><dt>${T('标题', 'Title')}</dt><dd>${T('组会', 'Group meeting')}</dd><dt>${T('时间', 'When')}</dt><dd>${T('10月30日 周五 15:00–16:00', 'Fri Oct 30, 15:00–16:00')}</dd><dt>${T('提醒', 'Remind')}</dt><dd>${T('提前 30 分钟', '30 minutes before')}</dd><dt>${T('类型', 'Type')}</dt><dd><span class="pill">${T('会议', 'Meeting')}</span></dd></dl>
        <div class="acts"><button class="b" type="button" data-act="cancel">${T('取消', 'Cancel')}</button><button class="b pri" type="button" data-act="save">${T('保存', 'Save')}</button></div></div>
      <div class="toast">${ic('check')}<span></span></div></div>`;
    const nl = $('.nl', scr), inp = $('.in', nl);
    nl.addEventListener('click', e => { if (e.target.closest('.send')) return; touched = true; fill(); });
    $('.send', nl).addEventListener('click', e => { e.stopPropagation(); touched = true; submit(); });
    $('[data-act=save]', scr).addEventListener('click', () => { touched = true; save(); });
    $('[data-act=cancel]', scr).addEventListener('click', () => { touched = true; $('.prop', scr).classList.remove('on'); inp.textContent = ''; });
  }
  let filling = false;
  async function fill() {
    const inp = $('.nl .in', scr); if (filling || inp.textContent) return;
    filling = true; $('.nl', scr).classList.add('focus');
    for (const ch of SENT()) { inp.textContent += ch; await sleep(reduced() ? 0 : 40); }
    filling = false;
  }
  async function submit() {
    const inp = $('.nl .in', scr);
    if (!inp.textContent) { await fill(); await sleep(250); }
    $('.nl', scr).classList.remove('focus');
    $('.prop', scr).classList.add('on');
  }
  function save() {
    $('.prop', scr).classList.remove('on');
    $('.nl .in', scr).textContent = '';
    if (!$('.ev.new', scr)) $('.col[data-d="4"]', scr).append(h(`<div class="ev new" style="top:${parseFloat(top(15)) + 34}px;height:${ht(15, 16)}">${T('组会', 'Group meeting')}<small>15:00 · ${T('提前 30 分钟提醒', 'reminder 30 min before')}</small></div>`));
    const t = $('.toast', scr); $('span', t).textContent = T('已保存 · 周五 14:30 提醒你', 'Saved · reminder Fri 14:30'); t.classList.add('on');
    setTimeout(() => t.classList.remove('on'), 2600);
  }
  render();
  return {
    key: 'agenda', nav: 'agenda', title: () => T('日程中心', 'Agenda'), scr,
    enter() {}, leave() { run.cancel(); },
    auto(force) {
      if (touched && !force) return; touched = false;
      render();
      run.play(async ({ step, to, click }) => {
        await click($('.nl', scr), () => fill()); await step(SENT().length * 40 + 300);
        await click($('.nl .send', scr), () => submit()); await step(900);
        await click($('[data-act=save]', scr), () => save());
      });
    },
    reset: render, get touched() { return touched; }
  };
}

// ---- reader: select a passage, explain, jump back from the citation ----
function readChapter(win) {
  const run = runner(win);
  const scr = h('<section class="scr" data-s="read"></section>');
  $('.w-body', win).append(scr);
  let touched = false, asked = false;
  function render() {
    run.cancel(); asked = false;
    scr.innerHTML = `<div class="split"><div class="chat">
        <div class="crumb">${T('课程', 'Courses')} / ${T('机器学习', 'Machine Learning')} / <b>${T('第 3 讲复习', 'Lecture 3 review')}</b></div>
        <div class="chat-log"><div class="chat-col" style="padding:0 18px"><div class="msg-a" style="color:var(--muted);font-size:12.5px"><div class="who"><img src="${LOGO}" alt="">AI Bro</div>${T('第3讲-优化.pdf 已在右边打开。选中一段文字，用工具条提问。', 'Lecture3-Optimization.pdf is open on the right. Select a passage and use the toolbar.')}</div></div></div>
        <div class="composer" style="width:calc(100% - 28px)"><div class="in" data-ph="${T('就这份资料提问…', 'Ask about this file…')}"></div><div class="bar">${ic('plus')}${ic('at')}<span class="sp"></span>${ic('mic')}<button class="send" type="button" disabled aria-label="${T('发送', 'Send')}">${ic('send')}</button></div></div>
      </div>
      <div class="reader"><div class="r-tabs"><span class="r-tab on">${ic('doc')}${T('第3讲-优化.pdf', 'Lecture3-Optimization.pdf')}</span><span class="r-tab">${ic('note')}${T('课堂笔记.md', 'class-notes.md')}</span></div>
        <div class="r-bar"><span>${T('第 12 / 28 页', 'Page 12 / 28')}</span><span class="sp"></span><span>100%</span><span class="b ghost" style="height:24px">${T('问 AI', 'Ask AI')}</span></div>
        <div class="r-doc"><div class="r-pages">
          <div class="r-page" data-p="12"><h6>3.2 ${T('步长与收敛', 'Step size and convergence')}</h6>
            <p>${T('梯度下降每一步沿负梯度方向更新参数：', 'Each step of gradient descent moves the parameters against the gradient:')}</p>
            <p class="eq">θ<sub>t+1</sub> = θ<sub>t</sub> − η ∇f(θ<sub>t</sub>)</p>
            <p>${T('设 f 的梯度是 L-Lipschitz 的，即曲率不超过 L。', 'Assume the gradient of f is L-Lipschitz, so curvature is at most L.')}<span class="sel hint" tabindex="0" role="button" aria-label="${T('可选中的句子', 'Selectable sentence')}">${T('当学习率 η 大于 2/L 时，迭代在谷底两侧来回跳动，且振幅逐步增大，算法发散。', 'When the learning rate η exceeds 2/L, the iterates bounce across the valley with growing amplitude and the method diverges.')}</span>${T('当 η 不超过 1/L 时，每一步都能保证损失下降。', ' When η is at most 1/L, every step is guaranteed to lower the loss.')}</p>
            <p>${T('实践中常用的做法是从较大的 η 开始，观察损失曲线，出现震荡后逐步减小。', 'In practice one starts with a large η, watches the loss curve and shrinks η once it oscillates.')}</p><span class="pn">12</span></div>
          <div class="r-page" data-p="13"><h6>${T('图 3.2', 'Figure 3.2')}</h6>
            <svg class="fig" viewBox="0 0 340 120" style="width:100%;height:auto;border-radius:4px"><path d="M10 110 Q170 -60 330 110" fill="none" stroke="#9aa59f" stroke-width="1.2"/><path d="M40 70 L290 64 L70 46 L250 40 L110 30 L190 28" fill="none" stroke="#087f70" stroke-width="1.6"/><path d="M60 52 L280 68 L30 92 L320 100" fill="none" stroke="#c25766" stroke-width="1.6" stroke-dasharray="4 3"/><text x="200" y="24" font-size="10" fill="#087f70">η = 0.9/L</text><text x="230" y="116" font-size="10" fill="#c25766">η = 2.2/L</text></svg>
            <p>${T('实线收敛，虚线发散。两者只差在步长。', 'Solid converges, dashed diverges. Only the step size differs.')}</p><span class="pn">13</span></div>
        </div>
        <div class="selbar" role="toolbar" aria-label="${T('选中内容的操作', 'Selection actions')}"><button type="button" data-m="explain">${T('解释', 'Explain')}</button><button type="button" data-m="annotate">${T('批注', 'Annotate')}</button><button type="button" data-m="translate">${T('翻译', 'Translate')}</button><span class="sep"></span><button type="button" data-m="quote">${T('引用到对话', 'Quote in chat')}</button></div>
        </div></div></div>
      <div class="toast">${ic('check')}<span></span></div>`;
    const sel = $('.sel', scr);
    // Dragging anywhere across the page counts as selecting the outlined sentence.
    let down = null;
    $('.r-pages', scr).addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; touched = true; run.cancel(); e.preventDefault(); });
    scr.addEventListener('pointerup', e => { if (down && (Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 12 || e.target.closest('.sel'))) select(); down = null; });
    sel.addEventListener('click', () => { touched = true; select(); });
    sel.addEventListener('keydown', e => { if (e.key === 'Enter') { touched = true; select(); } });
    $$('.selbar button', scr).forEach(b => b.addEventListener('click', () => { touched = true; act(b.dataset.m); }));
  }
  function select() {
    const sel = $('.sel', scr), bar = $('.selbar', scr), doc = $('.r-doc', scr);
    sel.classList.remove('hint'); sel.classList.add('on');
    const d = doc.getBoundingClientRect(), r = sel.getBoundingClientRect(), s = parseFloat(getComputedStyle(win).getPropertyValue('--s')) || 1;
    bar.style.left = Math.max(8, (r.left - d.left) / s + 10) + 'px';
    bar.style.top = Math.max(6, (r.top - d.top) / s - 44) + 'px';
    bar.classList.add('on');
  }
  function jump(p) {
    const pages = $('.r-pages', scr), target = p === 13 ? $('.r-page[data-p="13"] .fig', scr) : $('.sel', scr);
    $('.selbar', scr).classList.remove('on');
    pages.style.transform = p === 13 ? 'translateY(-380px)' : 'translateY(-40px)';
    target.classList.remove('flash'); void target.offsetWidth; target.classList.add('flash');
    setTimeout(() => { pages.style.transform = ''; }, p === 13 ? 2600 : 2000);
  }
  async function act(m) {
    const bar = $('.selbar', scr);
    if (m === 'annotate' || m === 'quote') {
      bar.classList.remove('on');
      const t = $('.toast', scr); $('span', t).textContent = m === 'annotate' ? T('已添加批注 · 第 12 页', 'Annotation added · p.12') : T('已引用到对话', 'Quoted in the chat');
      t.classList.add('on'); setTimeout(() => t.classList.remove('on'), 2200);
      if (m === 'quote') { const inp = $('.composer .in', scr); inp.textContent = T('> 摘自 第3讲-优化.pdf 第 12 页', '> From Lecture3-Optimization.pdf p.12'); }
      return;
    }
    if (asked) return; asked = true;
    $$('button', bar).forEach(b => b.classList.toggle('hot', b.dataset.m === m));
    await sleep(250); bar.classList.remove('on');
    const log = $('.chat-col', scr);
    log.innerHTML = '';
    const quote = T('当学习率 η 大于 2/L 时，迭代在谷底两侧来回跳动…', 'When the learning rate η exceeds 2/L, the iterates bounce…');
    log.append(h(`<div class="msg-u" style="max-width:92%"><div class="quote">${T('摘自 第3讲-优化.pdf 第 12 页', 'From Lecture3-Optimization.pdf p.12')}<br>${esc(quote)}</div>${m === 'explain' ? T('解释这段', 'Explain this') : T('翻译这段', 'Translate this')}</div>`));
    const a = h(`<div class="msg-a" style="font-size:12.5px"><div class="who"><img src="${LOGO}" alt="">AI Bro</div></div>`); log.append(a);
    const own = runner(win);
    await own.play(async ({ step }) => {
      await step(300);
      await progress(a, [[T('读取原件', 'Read the original'), T('第 12–13 页', 'pp. 12–13'), 800]], step, T('已完成 · 1 步', 'Done · 1 step'));
      const ans = h('<div></div>'); a.append(ans);
      const parts = m === 'explain'
        ? [T('这句说的是步长的上限。L 衡量损失曲面最弯的地方有多弯；步长超过 2/L，每一步都会跨过最低点、落到更高的地方，所以离最优点越来越远。', 'It sets an upper bound on the step. L measures how sharply the loss curves at its steepest; with a step above 2/L each update jumps past the minimum and lands higher, so you move further away every time.'), { cite: T('第 12 页', 'p.12'), go: 12 }, '\n',
           T('下一页的图把 η = 0.9/L 和 η = 2.2/L 两条轨迹画在一起，可以对照看。', 'The figure on the next page draws η = 0.9/L and η = 2.2/L side by side.'), { cite: T('第 13 页 · 图 3.2', 'p.13 · Fig. 3.2'), go: 13 }]
        : [T('When the learning rate η exceeds 2/L, the iterates bounce back and forth across the valley with growing amplitude, and the algorithm diverges.', '当学习率 η 大于 2/L 时，迭代在谷底两侧来回跳动，且振幅逐步增大，算法发散。'), { cite: T('第 12 页', 'p.12'), go: 12 }];
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
        await click($('.selbar [data-m=explain]', scr), () => act('explain'));
        await step(4800);
        const c = $$('.chat-col .cite', scr)[1]; if (c) await click(c, () => jump(13));
      });
    },
    reset: render, get touched() { return touched; }
  };
}

// ---- wiki: linked notes ----
function wikiChapter(win) {
  const run = runner(win);
  const scr = h('<section class="scr" data-s="wiki"></section>');
  $('.w-body', win).append(scr);
  let touched = false, cur = 'rag', trail = ['rag'];
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
  const TREE = [['rag'], ['dense'], ['paperb'], ['meet']];
  function noteHTML(k, cls) {
    const n = NOTES()[k], names = NOTES();
    const crumbs = trail.map((x, i) => i < trail.length - 1 ? `<b data-back="${i}">${esc(names[x].t)}</b> ›` : esc(names[x].t)).join(' ');
    return `<article class="wnote ${cls || ''}" data-k="${k}"><div class="back">${T('科研 · 知识库', 'Research · Knowledge base')} › ${crumbs}</div><h4>${esc(n.t)}</h4><div class="meta">${esc(n.meta)}</div>${n.b}<div class="bl">${T('链接到这里', 'Linked from')}<br>${n.bl.map(x => `<span>${esc(x)}</span>`).join('')}</div></article>`;
  }
  function render() {
    run.cancel(); cur = 'rag'; trail = ['rag'];
    const names = NOTES();
    scr.innerHTML = `<div class="wiki"><div class="w-tree"><div class="h">${T('知识库', 'KNOWLEDGE BASE')}</div>${TREE.map(([k]) => `<div class="n${k === cur ? ' on' : ''}" data-k="${k}">${ic('note')}${esc(names[k].t)}</div>`).join('')}<div class="n">${ic('folder')}${T('实验记录', 'Lab log')}</div><div class="n">${ic('folder')}${T('论文PDF', 'Paper PDFs')}</div></div><div class="note-v">${noteHTML('rag')}</div></div>`;
    bind();
  }
  function bind() {
    $$('.wnote:not(.left) .wl', scr).forEach(a => {
      a.onclick = () => { touched = true; go(a.dataset.go); };
      a.onkeydown = e => { if (e.key === 'Enter') { touched = true; go(a.dataset.go); } };
    });
    $$('.wnote:not(.left) [data-back]', scr).forEach(b => { b.onclick = () => { touched = true; const i = +b.dataset.back; const k = trail[i]; trail = trail.slice(0, i); go(k, true); }; });
  }
  function go(k, back) {
    if (k === cur) return;
    const v = $('.note-v', scr), old = $('.wnote', v);
    trail.push(k);
    cur = k;
    const n = h(noteHTML(k, back ? 'left' : 'right')); v.append(n);
    old.classList.add(back ? 'right' : 'left');
    requestAnimationFrame(() => requestAnimationFrame(() => n.classList.remove('left', 'right')));
    setTimeout(() => old.remove(), 650);
    $$('.w-tree .n', scr).forEach(x => x.classList.toggle('on', x.dataset.k === k));
    bind();
  }
  render();
  return {
    key: 'wiki', nav: 'research', title: () => T('科研 · 知识库', 'Research · Knowledge base'), scr,
    enter() {}, leave() { run.cancel(); },
    auto(force) {
      if (touched && !force) return; touched = false;
      render();
      run.play(async ({ step, click }) => {
        await step(300);
        await click($('.wnote .wl[data-go=dense]', scr), () => go('dense')); await step(1800);
        await click($('.wnote:not(.left):not(.right) [data-back="0"]', scr) || $('.wnote .wl', scr), () => { const k = trail[0]; trail = []; go(k, true); });
        await step(1200);
        await click($('.wnote:not(.left):not(.right) .wl[data-go=paperb]', scr), () => go('paperb'));
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
    isl.setAttribute('aria-label', T('灵动岛：按住说话', 'Island: hold to talk'));
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
  const DATA = () => [
    [T('对话', 'Chats'), 'chats', [T('梯度下降的学习率怎么选', 'Choosing a learning rate'), T('组会要讲的三件事', 'Three things for group meeting')]],
    [T('笔记', 'Notes'), 'note', [T('检索增强生成（RAG）', 'Retrieval-augmented generation'), T('组会纪要 · 10月20日', 'Group meeting · Oct 20'), T('稠密检索', 'Dense retrieval')]],
    [T('日程', 'Agenda'), 'cal', [T('组会 · 周五 15:00', 'Group meeting · Fri 15:00'), T('机器学习 第5讲 · 周一 10:00', 'ML lecture 5 · Mon 10:00')]],
    [T('资料', 'Files'), 'doc', [T('第3讲-优化.pdf', 'Lecture3-Optimization.pdf'), T('论文B.pdf', 'PaperB.pdf')]],
    [T('命令', 'Commands'), 'cmd', [T('新建对话', 'New chat'), T('新建日程', 'New event'), T('打开设置', 'Open settings'), T('切换深色', 'Toggle dark mode'), T('打开灵动岛', 'Open the island')], true]
  ];
  function renderChat() {
    scr.innerHTML = `<div class="w-wash"></div><div class="chat"><div class="crumb">${T('全部对话', 'All chats')} / <b>${T('梯度下降的学习率怎么选', 'Choosing a learning rate')}</b></div><div class="chat-log"><div class="chat-col">
      <div class="msg-u">${T('第 3 讲的梯度下降，学习率太大为什么会发散？', 'In lecture 3, why does gradient descent diverge when the learning rate is too big?')}</div>
      <div class="msg-a"><div class="who"><img src="${LOGO}" alt="">AI Bro · gpt-5.6-luna</div><div class="prog"><div class="prog-h"><span class="ok">${ic('check')}</span>${T('已完成 · 3 步', 'Done · 3 steps')}<span class="el">4.1s</span></div></div>
      <p>${T('课件用一个二次函数来解释：η 超过 2/L 时，每一步都会越过谷底，而且越过得越来越多。', 'The slides use a quadratic: once η is larger than 2/L, every step overshoots the bottom by more than the last.')}<span class="cite">${ic('doc')}${T('第3讲 · 第 12 页', 'Lecture 3 · p.12')}</span></p></div></div></div>
      <div class="composer"><div class="in" data-ph="${T('发消息，或添加文件与网页…', 'Message, or add files and pages…')}"></div><div class="bar">${ic('plus')}${ic('at')}<span class="sp"></span><span class="model">${ic('spark')}gpt-5.6-luna</span>${ic('mic')}<button class="send" type="button" disabled aria-label="${T('发送', 'Send')}">${ic('send')}</button></div></div></div>
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
    let html = '';
    for (const [g, icon, items, isCmd] of DATA()) {
      if (cmd && !isCmd) continue;
      if (!q && isCmd) continue;
      const hits = items.filter(t => !qq || t.toLowerCase().includes(qq)).slice(0, q ? 4 : 1);
      if (!hits.length) continue;
      html += `<div class="g">${esc(q ? g : T('最近', 'Recent') + ' · ' + g)}</div>`;
      for (const t of hits) {
        const i = t.toLowerCase().indexOf(qq);
        const label = qq && i >= 0 ? esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + qq.length)) + '</mark>' + esc(t.slice(i + qq.length)) : esc(t);
        html += `<div class="r" data-i="${rows.length}">${ic(icon)}<span>${label}</span><small>${esc(g)}</small></div>`;
        rows.push(t);
      }
    }
    res.innerHTML = html || `<div class="none">${T('没有找到。试试“组会”或“>”', 'Nothing found. Try “meeting” or “>”')}</div>`;
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
    layer.innerHTML = `<div class="dlg" role="dialog" aria-label="${T('计划任务', 'Scheduled tasks')}"><div class="dh"><h5>${T('计划任务', 'Scheduled tasks')}</h5><span class="b">${T('关闭', 'Close')}</span></div>
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
      <div class="acts"><button class="b pri" type="button" data-a="test">${T('测试可用性', 'Test')}</button><span class="b">${T('重新检测', 'Re-check')}</span><span style="flex:1"></span><span class="b ghost" style="color:var(--red)">${T('从列表移除', 'Remove')}</span></div>
      <div class="res" role="status"></div></div>`;
  }
  function render() {
    run.cancel(); cur = 0; testing = false;
    const ps = PROV();
    scr.innerHTML = `<div class="set"><div class="ph"><h4>${T('设置', 'Settings')}<small>${T('模型、同步、检索与界面偏好，各自清楚管理。', 'Models, sync, retrieval and interface, each in its place.')}</small></h4><span class="b ghost">${T('新手引导', 'Getting started')}</span></div>
      <div class="set-nav"><span class="on">${T('模型与权限', 'Models & permissions')}</span><span>${T('服务器同步', 'Server sync')}</span><span>${T('知识库检索', 'Knowledge retrieval')}</span><span>${T('插件', 'Plugins')}</span><span>${T('界面偏好', 'Interface')}</span></div>
      <div class="card"><h5>${T('模型', 'Models')}</h5><p class="d">${T('选一个默认模型就能用；其余用途需要时再单独指定。密钥只保存在系统钥匙串里。', 'Pick one default model and you are set; assign others per purpose when needed. Keys live only in the system Keychain.')}</p>
        <div style="display:flex;gap:8px;margin-bottom:12px"><span class="seg"><span class="on">${T('供应商', 'Providers')}</span><span>${T('嵌入', 'Embedding')}</span><span>${T('语音识别', 'Speech')}</span><span>${T('使用统计', 'Usage')}</span></span><span style="flex:1"></span><span class="b ghost">${T('从 CC Switch 导入', 'Import from CC Switch')}</span></div>
        <div class="mrow"><div class="plist"><div class="h">${T('已启用 · 拖拽排序，首位为默认', 'Enabled · drag to reorder, first is default')}</div>
          ${ps.map((p, i) => `<button class="prov${i === 0 ? ' on' : ''}" type="button" data-i="${i}"><span class="av">${p.id}</span><span><b>${esc(p.n)}${p.tag[0] ? `<span class="pill ${p.tag[1]}">${esc(p.tag[0])}</span>` : ''}</b><small>${esc(p.sub)}</small></span></button>`).join('')}
          <div style="font-size:12px;color:var(--accent);padding:8px">＋ ${T('添加供应商', 'Add provider')}</div></div>
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
    let current = null, t = 0;
    const activate = key => {
      const c = ctrls[key]; if (!c || c === current) return;
      clearTimeout(t);
      show(sw, ctrls, c, current); current = c;
      $$('.ch').forEach(a => a.classList.toggle('on', a.dataset.ch === key));
      $$('i', rail).forEach((i, n) => i.classList.toggle('on', CHAPTERS[n] === key));
      t = autoplay(c, 1400);
    };
    activate('agenda');
    const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) activate(e.target.dataset.ch); }), { rootMargin: '-48% 0px -48% 0px' });
    $$('.ch').forEach(a => io.observe(a));
    // stop autoplay once the stage leaves the screen
    const vis = new IntersectionObserver(([e]) => { if (!e.isIntersecting && current) { clearTimeout(t); } }, { threshold: 0 });
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
