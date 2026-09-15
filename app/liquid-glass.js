/* Backdrop-only refraction and bounded pointer lighting. The displacement
   image is a rounded-rectangle lens, not a screenshot of application content. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LiquidGlass = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const SURFACES = '#sidebar, #conversationNavigator, .topbar, #composer, .reading-toolbar';
  const QUERY = {
    motion: '(prefers-reduced-motion: reduce)',
    transparency: '(prefers-reduced-transparency: reduce)',
    contrast: '(forced-colors: active)',
    pointer: '(hover: hover) and (pointer: fine)'
  };
  function coordinates(rect, point) {
    if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0 || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return null;
    const clamp = value => Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
    return { x: clamp((point.x - rect.left) * 100 / rect.width), y: clamp((point.y - rect.top) * 100 / rect.height) };
  }
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const REFRACTION_QUERY = '#composer'; // One bounded filter; never on a document.
  let filterSequence = 0;
  function roundedDistance(x, y, width, height, radius) {
    const sx = x < width / 2 ? -1 : 1, sy = y < height / 2 ? -1 : 1;
    const qx = Math.abs(x - width / 2) - (width / 2 - radius), qy = Math.abs(y - height / 2) - (height / 2 - radius);
    const ax = Math.max(qx, 0), ay = Math.max(qy, 0), length = Math.hypot(ax, ay);
    const normal = length ? { x: sx * ax / length, y: sy * ay / length } : qx > qy ? { x: sx, y: 0 } : { x: 0, y: sy };
    return { distance: length + Math.min(Math.max(qx, qy), 0) - radius, ...normal };
  }
  function lensOffset(depth, rim) {
    if (depth < 0 || depth >= rim) return 0;
    // A circular bevel profile and Snell's law (air -> glass, n=1.45).
    // The flat center has zero slope and therefore zero displacement.
    const u = depth / rim, height = Math.sqrt(1 - (1 - u) ** 2);
    const incident = Math.atan((1 - u) / Math.max(.025, height));
    const refracted = Math.asin(Math.sin(incident) / 1.45);
    return (rim * .95 * height + rim * .28) * Math.tan(incident - refracted);
  }
  function rimClarity(depth, rim) {
    if (!Number.isFinite(depth) || !Number.isFinite(rim) || depth < 0 || rim <= 0) return 0;
    const start = Math.min(4, rim * .2), end = Math.min(20, rim);
    const t = Math.max(0, Math.min(1, (depth - start) / (end - start)));
    return 1 - t * t * (3 - 2 * t);
  }
  function makeDisplacementMap(width, height, radius = 25, maxDimension = 512) {
    if (![width, height, radius, maxDimension].every(Number.isFinite) || width <= 0 || height <= 0) return null;
    radius = Math.max(1, Math.min(radius, width / 2, height / 2));
    const rim = Math.min(24, radius, height / 3), scale = rim * 2;
    const resolution = Math.min(1, Math.max(64, Math.min(512, maxDimension)) / Math.max(width, height));
    const mapWidth = Math.max(1, Math.ceil(width * resolution)), mapHeight = Math.max(1, Math.ceil(height * resolution));
    const pixels = new Uint8ClampedArray(mapWidth * mapHeight * 4);
    for (let y = 0; y < mapHeight; y++) for (let x = 0; x < mapWidth; x++) {
      const normal = roundedDistance((x + .5) * width / mapWidth, (y + .5) * height / mapHeight, width, height, radius);
      const displacement = lensOffset(-normal.distance, rim), index = (y * mapWidth + x) * 4;
      pixels[index] = Math.round(128 + normal.x * displacement / scale * 254);
      pixels[index + 1] = Math.round(128 + normal.y * displacement / scale * 254);
      // B is a separate clarity mask, not another displacement channel:
      // a clear refracting rim fades into fully frosted reading-safe glass.
      pixels[index + 2] = Math.round(255 * rimClarity(-normal.distance, rim)); pixels[index + 3] = 255;
    }
    return { width: mapWidth, height: mapHeight, pixels, scale, rim, radius };
  }
  function supportsRefraction(env) {
    const chromium = /(?:Chrome|Chromium|Edg)\//.test(env.navigator?.userAgent || '') || env.navigator?.userAgentData?.brands?.some(item => /Chromium|Google Chrome|Microsoft Edge/.test(item.brand));
    // CSS.supports alone also returns true in engines which parse url() but
    // do not render SVG backdrop reference filters. Keep those on the fallback.
    return !!(chromium && env.CSS?.supports?.('backdrop-filter', 'url("#aw-glass-probe")') && env.document?.createElementNS && env.ResizeObserver);
  }
  function createRefraction(env, media) {
    const document = env.document, body = document.body;
    if (!supportsRefraction(env)) return { refresh() {}, setNativeActive() {}, destroy() {} };
    const element = document.querySelector(REFRACTION_QUERY);
    if (!element) return { refresh() {}, setNativeActive() {}, destroy() {} };
    const pane = element.closest?.('.conversation-pane'), list = pane?.querySelector?.('#messageList');
    let layoutHeight = 0;
    function syncLayout() {
      if (!pane || !list || !element.isConnected) return;
      const height = Math.round(element.getBoundingClientRect().height);
      if (!height || height === layoutHeight) return;
      const follow = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      layoutHeight = height; pane.style.setProperty('--lg-composer-height', height + 'px'); pane.setAttribute('data-glass-chat', 'true');
      if (follow) list.scrollTop = list.scrollHeight;
    }
    const id = `aw-glass-lens-${++filterSequence}`, create = name => document.createElementNS(SVG_NS, name);
    const svg = create('svg'), defs = create('defs'), filter = create('filter'), mapImage = create('feImage'), calibration = create('feComponentTransfer'), displacement = create('feDisplacementMap'), softness = create('feGaussianBlur');
    const frost = create('feGaussianBlur'), rimMask = create('feColorMatrix'), rimLayer = create('feComposite'), centerLayer = create('feComposite'), composite = create('feComposite');
    svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
    filter.setAttribute('id', id); filter.setAttribute('color-interpolation-filters', 'sRGB');
    filter.setAttribute('filterUnits', 'userSpaceOnUse'); filter.setAttribute('primitiveUnits', 'userSpaceOnUse');
    filter.setAttribute('x', '0'); filter.setAttribute('y', '0');
    mapImage.setAttribute('x', '0'); mapImage.setAttribute('y', '0'); mapImage.setAttribute('preserveAspectRatio', 'none'); mapImage.setAttribute('result', 'lens-map-raw');
    calibration.setAttribute('in', 'lens-map-raw'); calibration.setAttribute('result', 'lens-map');
    // 8-bit 128 must mean exactly .5, otherwise the supposedly stable center
    // acquires a small global translation. SVG defaults to linearRGB; use sRGB.
    for (const channel of ['R', 'G']) { const fn = create(`feFunc${channel}`); fn.setAttribute('type', 'linear'); fn.setAttribute('slope', String(255 / 254)); fn.setAttribute('intercept', String(-1 / 254)); calibration.append(fn); }
    displacement.setAttribute('in', 'SourceGraphic'); displacement.setAttribute('in2', 'lens-map'); displacement.setAttribute('xChannelSelector', 'R'); displacement.setAttribute('yChannelSelector', 'G'); displacement.setAttribute('result', 'refracted');
    softness.setAttribute('in', 'refracted'); softness.setAttribute('stdDeviation', '.35'); softness.setAttribute('result', 'clear-glass');
    frost.setAttribute('in', 'refracted'); frost.setAttribute('stdDeviation', '14'); frost.setAttribute('edgeMode', 'duplicate'); frost.setAttribute('result', 'frosted-glass');
    rimMask.setAttribute('in', 'lens-map-raw'); rimMask.setAttribute('type', 'matrix'); rimMask.setAttribute('values', '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 1 0 0'); rimMask.setAttribute('result', 'rim-mask');
    rimLayer.setAttribute('in', 'clear-glass'); rimLayer.setAttribute('in2', 'rim-mask'); rimLayer.setAttribute('operator', 'in'); rimLayer.setAttribute('result', 'clear-rim');
    centerLayer.setAttribute('in', 'frosted-glass'); centerLayer.setAttribute('in2', 'rim-mask'); centerLayer.setAttribute('operator', 'out'); centerLayer.setAttribute('result', 'frosted-center');
    // Add complementary premultiplied layers rather than alpha-over blending.
    // The latter would leave a partly transparent seam leaking sharp text.
    composite.setAttribute('in', 'clear-rim'); composite.setAttribute('in2', 'frosted-center'); composite.setAttribute('operator', 'arithmetic');
    composite.setAttribute('k1', '0'); composite.setAttribute('k2', '1'); composite.setAttribute('k3', '1'); composite.setAttribute('k4', '0');
    filter.append(mapImage, calibration, displacement, softness, frost, rimMask, rimLayer, centerLayer, composite); defs.append(filter); svg.append(defs); body.append(svg);
    let timer = null, destroyed = false, cached = '', running = false, nativeActive = false;
    const enabled = () => !destroyed && !media.transparency.matches && !media.contrast.matches && !document.hidden;
    function deactivate() { element.removeAttribute('data-glass-refracting'); element.style.removeProperty('--lg-refraction-filter'); }
    function update() {
      timer = null;
      if (!enabled() || !element.isConnected) { deactivate(); return; }
      const bounds = element.getBoundingClientRect();
      if (!bounds.width || !bounds.height) { deactivate(); return; }
      if (body.classList.contains('workspace-resizing')) { deactivate(); return; }
      const width = Math.round(bounds.width), height = Math.round(bounds.height), radius = parseFloat(env.getComputedStyle(element).borderTopLeftRadius) || 25;
      const key = `${width}:${height}:${radius}`;
      try {
        if (key !== cached) {
          running = true;
          const map = makeDisplacementMap(width, height, radius), canvas = document.createElement('canvas'); canvas.width = map.width; canvas.height = map.height;
          const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas unavailable');
          const image = context.createImageData(map.width, map.height); image.data.set(map.pixels); context.putImageData(image, 0, 0);
          const url = canvas.toDataURL('image/png');
          filter.setAttribute('width', String(width)); filter.setAttribute('height', String(height));
          mapImage.setAttribute('width', String(width)); mapImage.setAttribute('height', String(height)); mapImage.setAttribute('href', url);
          displacement.setAttribute('scale', String(map.scale)); cached = key;
        }
        element.style.setProperty('--lg-refraction-filter', `url("#${id}")`); element.setAttribute('data-glass-refracting', 'true');
      } catch (_error) { deactivate(); }
      finally { running = false; }
    }
    function schedule() { if (destroyed || running || timer !== null) return; timer = env.setTimeout(update, 100); }
    function refresh() { if (timer !== null) { env.clearTimeout(timer); timer = null; } if (!enabled()) deactivate(); else schedule(); }
    const observer = new env.ResizeObserver(() => { syncLayout(); schedule(); }); observer.observe(element);
    // Radius may change at a breakpoint without the composer dimensions changing.
    env.addEventListener?.('resize', schedule);
    document.addEventListener('pointerup', schedule, { passive: true }); document.addEventListener('pointercancel', schedule, { passive: true });
    syncLayout(); schedule();
    return { refresh, setNativeActive(value) { nativeActive = value === true; syncLayout(); refresh(); }, destroy() { destroyed = true; if (timer !== null) env.clearTimeout(timer); timer = null; observer.disconnect(); env.removeEventListener?.('resize', schedule); document.removeEventListener('pointerup', schedule); document.removeEventListener('pointercancel', schedule); deactivate(); pane?.removeAttribute('data-glass-chat'); pane?.style.removeProperty('--lg-composer-height'); svg.remove(); } };
  }
  function createController(env = root) {
    const document = env.document;
    if (!document?.body) return null;
    const body = document.body;
    const hadClass = body.classList.contains('liquid-glass'); body.classList.add('liquid-glass');
    let active = null, pending = null, frame = null, destroyed = false, nativeActive = false;
    const media = Object.fromEntries(Object.entries(QUERY).map(([name, query]) => [name, env.matchMedia?.(query) || { matches: name === 'pointer' }]));
    const refraction = createRefraction(env, media);
    const enabled = () => !destroyed && !nativeActive && !document.hidden && !body.classList.contains('liquid-glass-unfocused') && !media.motion.matches && !media.transparency.matches && !media.contrast.matches && media.pointer.matches;
    const raf = fn => env.requestAnimationFrame ? env.requestAnimationFrame(fn) : env.setTimeout(fn, 16);
    const caf = id => env.cancelAnimationFrame ? env.cancelAnimationFrame(id) : env.clearTimeout(id);
    function clearSurface(surface) {
      if (!surface) return;
      surface.removeAttribute('data-glass-lit'); surface.style.removeProperty('--lg-pointer-x'); surface.style.removeProperty('--lg-pointer-y');
    }
    function reset() { if (frame !== null) caf(frame); frame = null; pending = null; clearSurface(active); active = null; }
    function paint() {
      frame = null;
      if (!enabled() || !pending || pending.surface.isConnected === false || pending.surface.hidden || body.classList.contains('workspace-resizing')) { reset(); return; }
      const next = pending; pending = null;
      const rect = next.surface.getBoundingClientRect(); const light = coordinates(rect, next);
      if (!light) { reset(); return; }
      if (active !== next.surface) { clearSurface(active); active = next.surface; }
      active.style.setProperty('--lg-pointer-x', light.x + '%'); active.style.setProperty('--lg-pointer-y', light.y + '%'); active.setAttribute('data-glass-lit', 'true');
    }
    function move(event) {
      if (!enabled() || (event.pointerType && !['mouse', 'pen'].includes(event.pointerType)) || event.buttons || body.classList.contains('workspace-resizing')) { reset(); return; }
      const surface = event.target?.closest?.(SURFACES);
      if (!surface || !body.contains(surface)) { reset(); return; }
      pending = { surface, x: event.clientX, y: event.clientY };
      if (frame === null) frame = raf(paint);
    }
    function out(event) {
      const destination = event.relatedTarget?.closest?.(SURFACES);
      if (!destination || destination !== (pending?.surface || active)) reset();
    }
    function preference() {
      body.classList.toggle('liquid-glass-static', !enabled()); reset(); refraction.refresh();
    }
    function blur() { body.classList.add('liquid-glass-unfocused'); reset(); }
    function focus() { body.classList.remove('liquid-glass-unfocused'); preference(); }
    document.addEventListener('pointermove', move, { passive: true }); document.addEventListener('pointerout', out, { passive: true });
    document.addEventListener('pointercancel', reset, { passive: true }); document.addEventListener('visibilitychange', preference);
    env.addEventListener?.('blur', blur); env.addEventListener?.('focus', focus); env.addEventListener?.('resize', reset);
    for (const query of Object.values(media)) { if (query.addEventListener) query.addEventListener('change', preference); else query.addListener?.(preference); }
    preference();
    return { refresh: preference, setNativeActive(value) { nativeActive = value === true; refraction.setNativeActive(nativeActive); preference(); }, destroy() {
      if (destroyed) return; destroyed = true; reset(); refraction.destroy();
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerout', out); document.removeEventListener('pointercancel', reset); document.removeEventListener('visibilitychange', preference);
      env.removeEventListener?.('blur', blur); env.removeEventListener?.('focus', focus); env.removeEventListener?.('resize', reset);
      for (const query of Object.values(media)) { if (query.removeEventListener) query.removeEventListener('change', preference); else query.removeListener?.(preference); }
      body.classList.remove('liquid-glass-static', 'liquid-glass-unfocused'); if (!hadClass) body.classList.remove('liquid-glass');
    } };
  }
  let instance = null;
  return { SURFACES, QUERY, REFRACTION_QUERY, coordinates, roundedDistance, lensOffset, rimClarity, makeDisplacementMap, supportsRefraction, createRefraction, createController, init() { if (!instance) instance = createController(); return instance; }, setNativeActive(value) { instance?.setNativeActive(value); }, destroy() { instance?.destroy(); instance = null; } };
});
