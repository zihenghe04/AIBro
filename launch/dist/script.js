(() => {
'use strict';
// Chinese is the source text in index.html. English lives next to it in data-en / data-en-aria / data-words-en.
const root = document.documentElement;
root.classList.add('js');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const params = new URLSearchParams(location.search);
let lang = params.get('lang') === 'en' ? 'en' : 'zh';

// Capture the Chinese originals once so switching back restores them exactly.
const zhHTML = new Map(), zhAria = new Map();
document.querySelectorAll('[data-en]').forEach(el => zhHTML.set(el, el.innerHTML));
document.querySelectorAll('[data-en-aria]').forEach(el => zhAria.set(el, el.getAttribute('aria-label')));
const zhTitle = document.title, zhDesc = document.querySelector('meta[name=description]').content;
const enTitle = 'AI Bro | A learning and research assistant for Mac';
const enDesc = 'A Mac app for students and researchers. Reads your PDFs and notes, cites the file and page, keeps your agenda and runs scheduled tasks. Files stay on your Mac and you pick the model.';

// Island transcript: split into words that fade in one after another.
function buildWords() {
  document.querySelectorAll('[data-words]').forEach(el => {
    const text = lang === 'en' ? el.dataset.wordsEn : el.dataset.words;
    const parts = lang === 'en' ? text.split(/(\s+)/) : [...text];
    el.textContent = '';
    let n = 0;
    parts.forEach(p => {
      const s = document.createElement('span');
      s.className = 'w';
      s.textContent = p;
      if (p.trim()) { s.style.setProperty('--d', (1 + n * (lang === 'en' ? .32 : .17)).toFixed(2) + 's'); n++; }
      el.append(s);
    });
  });
}

function localize() {
  root.lang = lang === 'en' ? 'en' : 'zh-CN';
  zhHTML.forEach((zh, el) => { el.innerHTML = lang === 'en' ? el.dataset.en : zh; });
  zhAria.forEach((zh, el) => el.setAttribute('aria-label', lang === 'en' ? el.dataset.enAria : zh));
  document.title = lang === 'en' ? enTitle : zhTitle;
  document.querySelector('meta[name=description]').content = lang === 'en' ? enDesc : zhDesc;
  const btn = document.getElementById('lang');
  btn.textContent = lang === 'en' ? '中文' : 'EN';
  btn.setAttribute('aria-label', lang === 'en' ? '中文，切换到中文' : 'EN，Switch to English');
  buildWords();
  const u = new URL(location.href);
  if (lang === 'en') u.searchParams.set('lang', 'en'); else u.searchParams.delete('lang');
  history.replaceState(null, '', u);
}
document.getElementById('lang').addEventListener('click', () => { lang = lang === 'en' ? 'zh' : 'en'; localize(); });
localize();

// Header border once the page scrolls.
const hdr = document.getElementById('hdr');
const onScroll = () => hdr.classList.toggle('stuck', scrollY > 8);
addEventListener('scroll', onScroll, { passive: true }); onScroll();

// Scenes play when they scroll into view and replay every data-loop ms while visible. Reduced motion shows the end state.
const scenes = new Map();
function play(el) {
  el.classList.remove('play'); void el.offsetWidth; el.classList.add('play');
}
if (!reduced.matches) {
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      const s = scenes.get(e.target) || {};
      if (e.isIntersecting && !s.timer) {
        play(e.target);
        s.timer = setInterval(() => !document.hidden && play(e.target), +e.target.dataset.loop || 12000);
      } else if (!e.isIntersecting && s.timer) { clearInterval(s.timer); s.timer = 0; }
      scenes.set(e.target, s);
    }
  }, { threshold: .35 });
  document.querySelectorAll('.scene').forEach(el => io.observe(el));
} else {
  document.querySelectorAll('.scene').forEach(el => el.classList.add('play'));
}

// Film: load the file only when asked.
const film = document.getElementById('film-video'), filmPlay = document.getElementById('film-play');
filmPlay.addEventListener('click', () => {
  if (!film.src) film.src = film.dataset.src;
  film.controls = true; filmPlay.hidden = true;
  const p = film.play(); if (p) p.catch(() => { filmPlay.hidden = false; });
});
film.addEventListener('ended', () => { filmPlay.hidden = false; });
})();
