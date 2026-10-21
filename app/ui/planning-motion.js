// Layout motion for planning lists without React hooks: the island
// components are also called as plain functions by the Node tests.
// A callback ref owns one observer per root. Items are tracked by a stable
// data attribute, so a card that React remounts in another column still
// glides from its previous position (FLIP). Motion is visual only; no state.
const EASE = 'cubic-bezier(.22,1,.36,1)';
const roots = new WeakMap();
const reduced = () => document.body?.classList.contains('reduce-motion') || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function snapshot(record) {
  const base = record.root.getBoundingClientRect(), rects = new Map();
  for (const item of record.root.querySelectorAll(`[${record.attribute}]`)) {
    const key = item.getAttribute(record.attribute), rect = item.getBoundingClientRect();
    rects.set(key, { item, x: rect.left - base.left, y: rect.top - base.top, done: item.getAttribute('data-motion-done') === 'true' });
  }
  return rects;
}
function settle(record) {
  for (const item of record.root.querySelectorAll(`[${record.attribute}]`)) item.__planningMotion?.cancel();
}
function play(record) {
  const mode = record.root.getAttribute('data-motion-mode') || '';
  settle(record);
  const next = snapshot(record), previous = record.rects;
  record.rects = next;
  // A list/board switch changes every geometry; a cross-fade is enough.
  if (!previous || mode !== record.mode || reduced()) { record.mode = mode; return; }
  for (const [key, now] of next) {
    const before = previous.get(key);
    if (!before) {
      now.item.__planningMotion = now.item.animate([{ opacity: 0, transform: 'translateY(6px) scale(.985)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: EASE });
      continue;
    }
    const dx = before.x - now.x, dy = before.y - now.y;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      now.item.__planningMotion = now.item.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 380, easing: EASE });
    }
    if (now.done && !before.done) {
      now.item.setAttribute('data-motion-checked', '');
      clearTimeout(now.item.__planningChecked);
      now.item.__planningChecked = setTimeout(() => now.item.removeAttribute('data-motion-checked'), 700);
    }
  }
}

export function layoutMotion(attribute) {
  return root => {
    if (!root) return;
    if (roots.has(root)) return;
    if (typeof MutationObserver !== 'function' || typeof root.animate !== 'function') return;
    const record = { root, attribute, rects: null, mode: root.getAttribute('data-motion-mode') || '' };
    const observer = new MutationObserver(() => { if (!root.isConnected) { observer.disconnect(); resize?.disconnect(); roots.delete(root); return; } play(record); });
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-motion-done', 'data-motion-mode'] });
    // Window and scroll changes refresh positions without animating them.
    const refresh = () => { if (root.isConnected) record.rects = snapshot(record); };
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(refresh) : null;
    resize?.observe(root); root.addEventListener('scroll', refresh, { capture: true, passive: true });
    roots.set(root, record);
    requestAnimationFrame(refresh);
  };
}
