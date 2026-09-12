/* Public macOS material regions sit behind WebContents. No DOM snapshots,
   content sampling, native hit targets, or per-token IPC are involved. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NativeGlassUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const SELECTORS = '#sidebar, #conversationNavigator, .topbar, #composer, .reading-toolbar, .reading-tabs';
  const HOSTS = SELECTORS + ', .main, .reading-pane';
  const QUERIES = ['(prefers-reduced-transparency: reduce)', '(forced-colors: active)', '(prefers-contrast: more)'];
  const LAYOUT_CLASSES = ['sidebar-collapsed', 'reading-open', 'reading-expanded', 'inspector-open', 'workspace-resizing', 'light-mode'];
  function clippedRect(rect, viewport, inset = {}) {
    if (!rect || ![rect.left, rect.top, rect.width, rect.height, viewport.width, viewport.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null;
    const x = Math.max(0, rect.left + (inset.left || 0)), y = Math.max(0, rect.top + (inset.top || 0));
    const right = Math.min(viewport.width, rect.left + rect.width - (inset.right || 0)), bottom = Math.min(viewport.height, rect.top + rect.height - (inset.bottom || 0));
    const round = n => Math.round(n * 2) / 2;
    if (right - x < 2 || bottom - y < 2) return null;
    return { x: round(x), y: round(y), width: round(right - x), height: round(bottom - y) };
  }
  function collectRegions(document, env = root) {
    const viewport = { width: env.innerWidth || document.documentElement.clientWidth, height: env.innerHeight || document.documentElement.clientHeight };
    const regions = [], elements = [];
    function visible(element) {
      if (!element || element.hidden || element.isConnected === false || element.closest?.('[hidden]')) return false;
      const style = env.getComputedStyle?.(element);
      return style?.display !== 'none' && style?.visibility !== 'hidden';
    }
    function add(id, selectors, fallbackRadius, inset) {
      const nodes = selectors.map(selector => document.querySelector(selector)).filter(visible);
      const boxes = nodes.map(element => ({ element, box: clippedRect(element.getBoundingClientRect(), viewport, inset) })).filter(item => item.box);
      if (!boxes.length) return;
      const x = Math.min(...boxes.map(item => item.box.x)), y = Math.min(...boxes.map(item => item.box.y));
      const width = Math.max(...boxes.map(item => item.box.x + item.box.width)) - x, height = Math.max(...boxes.map(item => item.box.y + item.box.height)) - y;
      const radius = Math.min(fallbackRadius, width / 2, height / 2);
      regions.push({ id, x, y, width, height, radius, style: 'regular' });
      boxes.forEach(item => elements.push({ element: item.element, id }));
    }
    const compact = viewport.width <= 760;
    add('sidebar', ['#sidebar'], compact ? 18 : 23, compact ? { left: 5, right: 3, top: 6, bottom: 6 } : { left: 8, right: 5, top: 8, bottom: 8 });
    add('navigator', ['#conversationNavigator'], 20);
    add('topbar', ['.topbar'], 16);
    if (document.body.dataset.view === 'agent') add('composer', ['#composer'], compact ? 20 : 25);
    add('reader-header', ['.reading-toolbar', '.reading-tabs'], 16);
    return { regions, elements };
  }
  function shellPath(regions, width, height) {
    // An opaque viewport with precise rounded holes. Even the gaps between
    // panes must not expose an unfiltered application behind this window.
    let path = `M0 0H${width}V${height}H0Z`;
    for (const region of regions) {
      const { x, y, width: w, height: h } = region, r = Math.min(region.radius, w / 2, h / 2);
      path += `M${x+r} ${y}H${x+w-r}Q${x+w} ${y} ${x+w} ${y+r}V${y+h-r}Q${x+w} ${y+h} ${x+w-r} ${y+h}H${x+r}Q${x} ${y+h} ${x} ${y+h-r}V${y+r}Q${x} ${y} ${x+r} ${y}Z`;
    }
    return path;
  }
  function createController(hooks = {}, env = root) {
    const document = env.document, bridge = hooks.bridge || env.workstationDesktop?.nativeGlass, glass = hooks.glass || env.LiquidGlass;
    if (!document?.body || !bridge?.status || !bridge?.setRegions) return { ready: Promise.resolve({ supported: false, active: false, regions: 0 }), refresh() {}, destroy() {}, status: () => ({ supported: false, active: false, regions: 0 }) };
    let destroyed = false, supported = false, active = false, timer = null, dirty = false, inflight = null, generation = 0, accepted = null;
    let status = { supported: false, active: false, regions: 0 }, marked = [], observersStarted = false, shell = null, shellShape = null;
    const removers = [], queries = QUERIES.map(query => env.matchMedia?.(query) || { matches: false });
    const observed = new Set();
    const resizeObserver = env.ResizeObserver ? new env.ResizeObserver(() => refresh()) : null;
    const blocked = () => destroyed || document.hidden || queries.some(query => query.matches) || document.body.classList.contains('workspace-resizing');
    const layoutKey = () => [document.body.dataset.view, ...LAYOUT_CLASSES.map(name => document.body.classList.contains(name))].join(':');
    let previousLayout = layoutKey();
    function createShell() {
      shell = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      shell.id = 'nativeGlassShell'; shell.setAttribute('aria-hidden', 'true'); shell.setAttribute('focusable', 'false');
      shellShape = document.createElementNS('http://www.w3.org/2000/svg', 'path'); shellShape.setAttribute('fill-rule', 'evenodd');
      shell.append(shellShape); shell.style.display = 'none'; document.body.append(shell);
    }
    function publish(value, snapshot) {
      marked.forEach(element => element.removeAttribute('data-native-glass-region')); marked = [];
      const next = value === true && !!shell && !blocked();
      if (shell) {
        if (next) {
          const width = env.innerWidth || document.documentElement.clientWidth, height = env.innerHeight || document.documentElement.clientHeight;
          shell.setAttribute('viewBox', `0 0 ${width} ${height}`); shellShape.setAttribute('d', shellPath(snapshot.regions, width, height));
        }
        shell.style.display = next ? 'block' : 'none';
      }
      if (next) for (const item of snapshot.elements) { if (item.element.isConnected !== false) { item.element.setAttribute('data-native-glass-region', item.id); marked.push(item.element); } }
      document.documentElement.classList.toggle('native-liquid-glass', next);
      if (active !== next) glass?.setNativeActive?.(next);
      active = next;
    }
    function report(next) { status = { ...next, active }; hooks.onStatus?.({ ...status }); }
    function desired() { return blocked() ? { regions: [], elements: [] } : collectRegions(document, env); }
    function observeElements() {
      if (!resizeObserver) return;
      const next = new Set(document.querySelectorAll(HOSTS));
      for (const element of observed) if (!next.has(element)) { resizeObserver.unobserve?.(element); observed.delete(element); }
      for (const element of next) if (!observed.has(element)) { observed.add(element); resizeObserver.observe(element); }
    }
    async function clear() { try { await bridge.setRegions([]); } catch (_) { /* Fallback stays opaque even if cleanup IPC is unavailable. */ } }
    async function send() {
      timer = null;
      if (!supported || destroyed || inflight || !dirty) return;
      dirty = false;
      const snapshot = desired(), key = JSON.stringify(snapshot.regions), version = generation;
      if (key === accepted) { publish(snapshot.regions.length > 0, snapshot); return; }
      publish(false);
      const request = Promise.resolve().then(() => bridge.setRegions(snapshot.regions)); inflight = request;
      try {
        const result = await request;
        if (destroyed) return;
        if (result?.supported === true && result.active === (snapshot.regions.length > 0) && result.regions === snapshot.regions.length) {
          accepted = key;
          if (version === generation) publish(result.active, snapshot);
          report({ supported: true, active, regions: result.regions });
        } else {
          accepted = null; publish(false); report({ supported: result?.supported === true, active: false, regions: 0, reason: result?.reason || 'inactive' });
          await clear();
        }
      } catch (_) {
        if (!destroyed) { accepted = null; publish(false); report({ supported, active: false, regions: 0, reason: 'bridge-failure' }); await clear(); }
      } finally {
        inflight = null;
        if (destroyed) await clear();
        else if (dirty && timer === null) timer = env.setTimeout(send, 80);
      }
    }
    function refresh() {
      if (destroyed || !supported) return;
      generation++; dirty = true;
      // Stale native rectangles are never revealed while resize/navigation settles.
      if (active && (blocked() || JSON.stringify(desired().regions) !== accepted)) publish(false);
      if (timer !== null) env.clearTimeout(timer);
      timer = env.setTimeout(send, 80);
    }
    function listen(target, name, fn, options) { target?.addEventListener?.(name, fn, options); removers.push(() => target?.removeEventListener?.(name, fn, options)); }
    const mutationObserver = env.MutationObserver ? new env.MutationObserver(records => {
      let relevant = false;
      for (const record of records) {
        if (record.type === 'attributes' && record.target === document.body) { const key = layoutKey(); if (key !== previousLayout) { previousLayout = key; relevant = true; } }
        else if (record.type === 'attributes' && record.target?.matches?.(HOSTS)) relevant = true;
        else if (record.type === 'childList') {
          const nodes = [...(record.addedNodes || []), ...(record.removedNodes || [])];
          if (nodes.some(node => node.nodeType === 1 && (node.matches?.(HOSTS) || node.querySelector?.(HOSTS)))) relevant = true;
        }
      }
      if (relevant) { observeElements(); refresh(); }
    }) : null;
    function startObservers() {
      if (observersStarted || destroyed) return; observersStarted = true;
      observeElements();
      mutationObserver?.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden', 'data-view'] });
      listen(env, 'resize', refresh); listen(env.visualViewport, 'resize', refresh);
      listen(document, 'visibilitychange', refresh); listen(document, 'workstation-language-change', refresh);
      listen(document, 'pointerup', refresh, { passive: true }); listen(document, 'pointercancel', refresh, { passive: true });
      for (const query of queries) if (query.addEventListener) listen(query, 'change', refresh); else { query.addListener?.(refresh); removers.push(() => query.removeListener?.(refresh)); }
    }
    const ready = Promise.resolve().then(() => bridge.status()).then(result => {
      if (destroyed) return status;
      supported = result?.supported === true;
      report({ supported, active: false, regions: 0, ...(result?.reason ? { reason: result.reason } : {}) });
      if (supported) { createShell(); startObservers(); dirty = true; return send().then(() => ({ ...status })); }
      publish(false); return { ...status };
    }).catch(() => { publish(false); report({ supported: false, active: false, regions: 0, reason: 'bridge-failure' }); return { ...status }; });
    return { ready, refresh, status: () => ({ ...status, active }), destroy() {
      if (destroyed) return; destroyed = true; generation++; dirty = false;
      if (timer !== null) env.clearTimeout(timer); timer = null;
      publish(false); removers.forEach(remove => remove()); resizeObserver?.disconnect(); mutationObserver?.disconnect(); observed.clear();
      shell?.remove(); shell = null; shellShape = null;
      // If a region update is in flight, its finally clears after it settles.
      if (!inflight) void clear();
    } };
  }
  let instance;
  return { SELECTORS, QUERIES, clippedRect, collectRegions, shellPath, createController, init(hooks) { if (!instance) instance = createController(hooks); return instance; }, refresh() { instance?.refresh(); }, destroy() { instance?.destroy(); instance = null; } };
});
