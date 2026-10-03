(function (root) {
  'use strict';
  const doc = root.document;
  if (!doc || root.ActivityMotion) return;
  const clockSelector = '[data-progress-start],[data-reception-clock]';
  const motionSelector = '[data-halaska-orb],.aicss-thinking-label[data-aicss-thinking-state="running"],.progress-activity,.progress-spinner,.progress-active-mark,.activity-pulse,.progress-phase-label,.progress-signal,.live-message .message-identity';
  const selector = `${clockSelector},${motionSelector}`;
  const records = new Map(), clocks = new Set(), transitions = new Map(), clockSubscriptions = new Map();
  const reduced = root.matchMedia?.('(prefers-reduced-motion: reduce)');
  let timer = null, frame = null, started = false, stopped = false, ticks = 0, writes = 0;
  const hostVisible = () => !doc.hidden && root.__aibroPresentationVisible !== false && root.__aibroSurfaceVisible !== false;
  const reduceMotion = () => reduced?.matches || doc.body?.classList.contains('reduce-motion');

  // Geometry alone is insufficient for closed <details>: WebKit can retain
  // layout boxes for its unpainted descendants. The summary remains visible.
  function painted(node, ignoreOwnOpacity = false) {
    if (!node.isConnected || !hostVisible()) return false;
    for (let parent = node; parent; parent = parent.parentElement) {
      if (parent.hidden) return false;
      if (parent.tagName === 'DETAILS' && !parent.open) {
        const summary = [...parent.children].find(child => child.tagName === 'SUMMARY');
        if (!summary?.contains(node)) return false;
      }
    }
    if (node.checkVisibility && !node.checkVisibility({ checkVisibilityCSS: true })) return false;
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
    let right = Math.min(root.innerWidth, rect.right), bottom = Math.min(root.innerHeight, rect.bottom);
    for (let parent = node; parent; parent = parent.parentElement) {
      const style = root.getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || (Number(style.opacity) === 0 && !(ignoreOwnOpacity && parent === node) && ![...transitions.values()].includes(parent))) return false;
      if (parent !== node && /(auto|scroll|hidden|clip)/.test(style.overflowX + style.overflowY)) {
        const box = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
      }
      if (right <= left || bottom <= top) return false;
    }
    return right > left && bottom > top;
  }
  const canAnimate = node => !!node && !reduceMotion() && painted(node);
  function updateClock(node) {
    if (node.hasAttribute('data-reception-clock')) {
      clockSubscriptions.get(node)?.(Date.now());
      return;
    }
    const start = Number(node.getAttribute('data-progress-start'));
    if (!Number.isFinite(start) || start <= 0) return;
    const text = root.AgentProgress?.duration(start);
    if (typeof text === 'string' && node.textContent !== text) { node.textContent = text; writes++; }
  }
  function scheduleClock() {
    if (!clocks.size || !hostVisible()) {
      if (timer !== null) root.clearTimeout(timer);
      timer = null; return;
    }
    if (timer !== null) return;
    timer = root.setTimeout(() => {
      timer = null; ticks++;
      // Reconcile once per visible second, never replay missed background ticks.
      refresh();
    }, 1000);
  }
  function refresh() {
    if (stopped) return;
    clocks.clear();
    for (const [node, record] of records) {
      if (!node.isConnected || !node.matches(selector)) {
        observer?.unobserve(node); records.delete(node); clockSubscriptions.delete(node); node.removeAttribute('data-activity-paused'); continue;
      }
      const visible = record.intersecting !== false && painted(node);
      if (node.matches(motionSelector)) {
        if (!visible || reduceMotion()) {
          if (!node.hasAttribute('data-activity-paused')) node.setAttribute('data-activity-paused', '');
        } else if (node.hasAttribute('data-activity-paused')) node.removeAttribute('data-activity-paused');
      } else if (node.hasAttribute('data-activity-paused')) node.removeAttribute('data-activity-paused');
      const start = Number(node.getAttribute('data-progress-start'));
      if (visible && (node.hasAttribute('data-reception-clock') ? clockSubscriptions.has(node) : Number.isFinite(start) && start > 0)) { clocks.add(node); updateClock(node); }
    }
    // An owned entrance may itself begin at opacity zero; that is not a hidden
    // surface. Ancestor visibility, clipping and reduced motion still apply.
    for (const [animation, node] of transitions) if (reduceMotion() || !painted(node, true)) animation.cancel();
    scheduleClock();
  }
  const observer = root.IntersectionObserver ? new root.IntersectionObserver(entries => {
    for (const entry of entries) {
      const record = records.get(entry.target);
      if (record) record.intersecting = entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0;
    }
    refresh();
  }, { threshold: [0, 0.000001] }) : null;
  function collect(node) {
    if (node.nodeType !== 1) return false;
    let changed = false;
    const add = candidate => {
      if (!candidate.isConnected || records.has(candidate)) return;
      records.set(candidate, { intersecting: null }); observer?.observe(candidate); changed = true;
    };
    if (node.matches(selector)) add(node);
    for (const candidate of node.querySelectorAll(selector)) add(candidate);
    return changed;
  }
  const mutations = new root.MutationObserver(changes => {
    let dirty = false;
    for (const change of changes) {
      if (change.type === 'childList') {
        for (const node of change.addedNodes) dirty = collect(node) || dirty;
        // Text deltas and our own clock writes do not rescan the document.
        if ([...change.removedNodes].some(node => node.nodeType === 1)) dirty = true;
      } else {
        const node = change.target;
        // This one continuous selector depends on a retained wrapper class.
        if (change.attributeName === 'class' && node.matches('.live-message')) dirty = collect(node) || dirty;
        if (node.matches(selector) && !records.has(node)) { records.set(node, { intersecting: null }); observer?.observe(node); }
        if (records.has(node) || [...records.keys()].some(candidate => node.contains(candidate)) || transitions.size) dirty = true;
      }
    }
    if (dirty) refresh();
  });
  function viewportChanged() {
    // IntersectionObserver handles normal scroll visibility without a scroll
    // loop. Finite transitions and browsers without IO need one bounded frame.
    if ((!transitions.size && observer) || frame !== null || !hostVisible()) return;
    frame = root.requestAnimationFrame(() => { frame = null; refresh(); });
  }
  function animate(node, keyframes, options) {
    if (!canAnimate(node) || !node.animate) return null;
    const animation = node.animate(keyframes, options);
    transitions.set(animation, node);
    const release = () => { transitions.delete(animation); refresh(); };
    animation.addEventListener('finish', release, { once: true });
    animation.addEventListener('cancel', release, { once: true });
    return animation;
  }
  // Owned React status headings share the elapsed-time clock. The callback
  // updates that heading only; this module never writes its text or body DOM.
  function subscribeClock(node, callback) {
    if (stopped || !node || typeof callback !== 'function') return () => {};
    clockSubscriptions.set(node, callback); collect(node); refresh();
    return () => {
      if (clockSubscriptions.get(node) !== callback) return;
      clockSubscriptions.delete(node); refresh();
    };
  }
  function visibilityChanged() {
    if (!hostVisible() && frame !== null) { root.cancelAnimationFrame(frame); frame = null; }
    refresh();
  }
  function init() {
    if (started || stopped || !doc.body) return;
    started = true; collect(doc.body);
    mutations.observe(doc.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'open', 'data-progress-start', 'data-reception-clock', 'data-aicss-thinking-state', 'data-activity-paused'] });
    doc.addEventListener('visibilitychange', visibilityChanged);
    root.addEventListener('aibro:presentation-visibility', visibilityChanged);
    root.addEventListener('aibro:surface-visibility', visibilityChanged);
    reduced?.addEventListener('change', refresh);
    doc.addEventListener('scroll', viewportChanged, { capture: true, passive: true });
    root.addEventListener('resize', viewportChanged);
    refresh();
  }
  function destroy() {
    stopped = true;
    if (timer !== null) root.clearTimeout(timer);
    if (frame !== null) root.cancelAnimationFrame(frame);
    timer = frame = null; observer?.disconnect(); mutations.disconnect();
    doc.removeEventListener('DOMContentLoaded', init);
    doc.removeEventListener('visibilitychange', visibilityChanged);
    root.removeEventListener('aibro:presentation-visibility', visibilityChanged);
    root.removeEventListener('aibro:surface-visibility', visibilityChanged);
    reduced?.removeEventListener('change', refresh);
    doc.removeEventListener('scroll', viewportChanged, true); root.removeEventListener('resize', viewportChanged);
    for (const node of records.keys()) node.removeAttribute('data-activity-paused');
    for (const animation of transitions.keys()) animation.cancel();
    records.clear(); clocks.clear(); transitions.clear(); clockSubscriptions.clear();
  }
  root.ActivityMotion = { canAnimate, animate, subscribeClock, destroy, inspect: () => ({
    tracked: records.size, visibleClocks: clocks.size, timerActive: timer !== null,
    transitions: transitions.size, hostVisible: hostVisible(), ticks, writes
  }) };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})(typeof globalThis !== 'undefined' ? globalThis : this);
