(() => {
'use strict';
// Page shell: language, header, reveal-on-scroll, hero tilt, film. The app-window demos live in demos.js.
// Chinese is the source text in index.html. English lives next to it in data-en / data-en-aria.
const root = document.documentElement;
root.classList.add('js');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const params = new URLSearchParams(location.search);
let lang = params.get('lang') === 'en' ? 'en' : 'zh';

const zhHTML = new Map(), zhAria = new Map();
document.querySelectorAll('[data-en]').forEach(el => zhHTML.set(el, el.innerHTML));
document.querySelectorAll('[data-en-aria]').forEach(el => zhAria.set(el, el.getAttribute('aria-label')));
const zhAlt = new Map();
document.querySelectorAll('[data-en-alt]').forEach(el => zhAlt.set(el, el.alt));
const zhTitle = document.title, zhDesc = document.querySelector('meta[name=description]').content;
const enTitle = 'AI Bro | A Mac assistant that has read your files';
const enDesc = 'A Mac app for students and researchers. It reads your lectures, papers and notes and names the file and page in every answer. One-line agenda entries, hold-to-talk island, scheduled tasks. Files stay on your Mac and you pick the model.';

const listeners = [];
window.Site = { get lang() { return lang; }, reduced, onLang: fn => listeners.push(fn) };

function localize() {
  root.lang = lang === 'en' ? 'en' : 'zh-CN';
  zhHTML.forEach((zh, el) => { el.innerHTML = lang === 'en' ? el.dataset.en : zh; });
  zhAria.forEach((zh, el) => el.setAttribute('aria-label', lang === 'en' ? el.dataset.enAria : zh));
  zhAlt.forEach((zh, el) => { el.alt = lang === 'en' ? el.dataset.enAlt : zh; });
  document.title = lang === 'en' ? enTitle : zhTitle;
  document.querySelector('meta[name=description]').content = lang === 'en' ? enDesc : zhDesc;
  const btn = document.getElementById('lang');
  btn.textContent = lang === 'en' ? '中文' : 'EN';
  btn.setAttribute('aria-label', lang === 'en' ? '中文，切换到中文' : 'EN，Switch to English');
  const u = new URL(location.href);
  if (lang === 'en') u.searchParams.set('lang', 'en'); else u.searchParams.delete('lang');
  history.replaceState(null, '', u);
  listeners.forEach(fn => fn(lang));
}
document.getElementById('lang').addEventListener('click', () => { lang = lang === 'en' ? 'zh' : 'en'; localize(); });
localize();

// Header turns into a floating capsule once the page moves.
const hdr = document.getElementById('hdr');
let stuck = null;
const onHeader = () => { const s = scrollY > 24; if (s !== stuck) { stuck = s; hdr.classList.toggle('stuck', s); } };

// Reveal once, staggered within the same parent.
if (!reduced.matches && 'IntersectionObserver' in window) {
  const io = new IntersectionObserver(entries => {
    entries.filter(e => e.isIntersecting).forEach((e, i) => {
      e.target.style.setProperty('--d', (i * 0.08).toFixed(2) + 's');
      e.target.classList.add('in'); io.unobserve(e.target);
    });
  }, { rootMargin: '0px 0px -8% 0px' });
  document.querySelectorAll('.rv,.tile').forEach(el => io.observe(el));
} else document.querySelectorAll('.rv,.tile').forEach(el => el.classList.add('in'));

// Hero window settles from a slight tilt to flat over the first ~40% of a screen of scrolling.
const tilt = document.getElementById('heroTilt');
const onTilt = () => {
  if (reduced.matches) return;
  const p = Math.min(1, Math.max(0, scrollY / (innerHeight * 0.4)));
  const e = 1 - Math.pow(1 - p, 3);
  tilt.style.setProperty('--rx', (14 * (1 - e)).toFixed(2) + 'deg');
  tilt.style.setProperty('--sc', (0.92 + 0.08 * e).toFixed(4));
  tilt.style.setProperty('--ty', (24 * (1 - e)).toFixed(1) + 'px');
};
let ticking = false;
addEventListener('scroll', () => {
  if (ticking) return; ticking = true;
  requestAnimationFrame(() => { ticking = false; onHeader(); onTilt(); });
}, { passive: true });
onHeader(); onTilt();

// Film: load the file only when asked.
const film = document.getElementById('film-video'), filmPlay = document.getElementById('film-play');
filmPlay.addEventListener('click', () => {
  if (!film.src) film.src = film.dataset.src;
  film.controls = true; filmPlay.hidden = true;
  const p = film.play(); if (p) p.catch(() => { filmPlay.hidden = false; });
});
film.addEventListener('ended', () => { filmPlay.hidden = false; });
})();
