/* Presentation-only pacing for a streamed answer. Network deltas arrive in
 * bursts (a stall, then 150+ characters at once); the pacer reveals the text
 * that has already arrived over the next few frames instead of in one jump.
 * It never holds data back from anything but the screen: callers keep the raw
 * output themselves, and flush() shows everything synchronously when the
 * request settles, so the end of a stream is never delayed.
 */
(function (root, factory) {
  const api = factory(root);
  root.StreamPacer = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, root => {
  'use strict';
  // The backlog decays with this time constant: a burst is shown within about
  // three of them, so the reveal never trails the network by much.
  const CATCH_UP_MS = 220;
  const reducedMotion = () => {
    const doc = root.document;
    if (doc?.body?.classList?.contains('reduce-motion')) return true;
    try { return !!root.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
  };
  const highSurrogate = code => code >= 0xd800 && code <= 0xdbff;

  function create(present, options = {}) {
    const frame = options.frame || (callback => root.requestAnimationFrame(callback));
    const cancelFrame = options.cancelFrame || (id => root.cancelAnimationFrame(id));
    const immediate = options.immediate || (() => reducedMotion() || !!root.document?.hidden || typeof root.requestAnimationFrame !== 'function');
    let shown = '', target = '', meta = null, pending = 0, last = 0;
    const stop = () => { if (pending) cancelFrame(pending); pending = 0; last = 0; };
    const show = text => { shown = text; present(text, meta); };
    const tick = time => {
      pending = 0;
      const dt = last ? Math.min(64, Math.max(0, time - last)) : 16;
      last = time;
      const backlog = target.length - shown.length;
      if (backlog <= 0) { last = 0; return; }
      let end = shown.length + Math.max(1, Math.ceil(backlog * Math.min(1, dt / CATCH_UP_MS)));
      if (end < target.length && highSurrogate(target.charCodeAt(end - 1))) end += 1;
      show(target.slice(0, end));
      if (shown.length < target.length) pending = frame(tick);
      else last = 0;
    };
    return {
      push(text, nextMeta) {
        const value = typeof text === 'string' ? text : String(text ?? '');
        const sameAttempt = !meta || meta?.attemptId === nextMeta?.attemptId;
        meta = nextMeta;
        target = value;
        // A new attempt, a rewrite or a shrink is not a continuation: show it as is.
        if (!sameAttempt || value.length <= shown.length || !value.startsWith(shown) || immediate()) { stop(); show(value); return; }
        if (!pending) pending = frame(tick);
      },
      flush() { stop(); if (shown !== target) show(target); },
      cancel() { stop(); },
      get pending() { return target.length - shown.length; }
    };
  }

  return { create, CATCH_UP_MS };
});
