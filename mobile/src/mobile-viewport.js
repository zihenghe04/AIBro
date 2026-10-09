// Native keyboard resize changes the WKWebView itself. keyboardHeight is a
// visibility signal, never a second amount to subtract from that resized view.
export function viewportState({ layoutHeight, visualHeight = layoutHeight, offsetTop = 0,
  scale = 1, baselineHeight = layoutHeight, focused = false, native = false, nativeKeyboardOpen = false }) {
  const layout = Math.max(0, Number(layoutHeight) || 0);
  const zoomed = Math.abs((Number(scale) || 1) - 1) > 0.05;
  const visual = zoomed ? layout : Math.min(layout, Math.max(0, Number(visualHeight) || layout));
  const top = zoomed ? 0 : Math.max(0, Number(offsetTop) || 0);
  const bottomInset = Math.max(0, layout - visual - top);
  const browserKeyboard = !native && focused && !zoomed && Math.max(baselineHeight - visual, bottomInset) > 120;
  return { visibleHeight: visual, offsetTop: top, bottomInset, keyboardOpen: native ? nativeKeyboardOpen : browserKeyboard };
}

// A native keyboard can resize the WebView after its initial focus scroll.
// Reveal only the currently focused task/calendar field inside its own sheet;
// never scroll the conversation or keep snapping back while the user reads.
export function revealFocusedSheetInput(doc, viewport) {
  const input = doc.activeElement, form = input?.closest?.('#task-form,#event-form'), sheet = form?.closest('#sheet');
  if (!sheet?.open || !input.matches('input:not([type=checkbox]),textarea,select')) return false;
  let moved = false;
  for (let pass = 0; pass < 2; pass++) {
    const bounds = sheet.getBoundingClientRect(), header = sheet.querySelector('.sheet-head')?.getBoundingClientRect();
    const top = Math.max(viewport.offsetTop, bounds.top, header?.bottom || bounds.top) + 10;
    const bottom = Math.min(viewport.offsetTop + viewport.visibleHeight, bounds.bottom) - 12;
    const rect = input.getBoundingClientRect();
    if (bottom <= top) break;
    const delta = rect.height <= bottom - top && rect.bottom > bottom ? rect.bottom - bottom
      : rect.top < top || rect.top >= bottom ? rect.top - top : 0;
    if (Math.abs(delta) < 1) break;
    const previous = sheet.scrollTop; sheet.scrollTop += delta;
    if (sheet.scrollTop === previous) break;
    moved = true;
  }
  return moved;
}

export function mountMobileViewport({ window: win = globalThis.window, document: doc = win.document,
  native = false, onChange = () => {} } = {}) {
  let disposed = false, frame, revealFrame, focusedSheetInput, current, baselineHeight = win.innerHeight, baselineWidth = win.innerWidth;
  let nativeKeyboardOpen = false;
  const editable = () => !!doc.activeElement?.matches('textarea,input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]),[contenteditable=true]');
  function refresh() {
    if (disposed) return current;
    const focused = editable(), viewport = win.visualViewport;
    if (win.innerWidth !== baselineWidth) {
      baselineWidth = win.innerWidth; baselineHeight = win.innerHeight;
    } else if (!focused && !nativeKeyboardOpen) baselineHeight = win.innerHeight;
    const next = viewportState({ layoutHeight: win.innerHeight, visualHeight: viewport?.height,
      offsetTop: viewport?.offsetTop, scale: viewport?.scale, baselineHeight, focused, native, nativeKeyboardOpen });
    // Keep baseline from before a native resize. It is not used to set the height.
    if (!next.keyboardOpen) baselineHeight = Math.max(baselineHeight, win.innerHeight);
    const signature = JSON.stringify(next), resized = current?.visibleHeight !== next.visibleHeight || current?.keyboardOpen !== next.keyboardOpen;
    if (signature !== JSON.stringify(current)) {
      current = next;
      doc.body.classList.toggle('keyboard-open', next.keyboardOpen);
      doc.documentElement.style.setProperty('--app-viewport-height', next.visibleHeight + 'px');
      doc.documentElement.style.setProperty('--app-viewport-offset', next.offsetTop + 'px');
      doc.documentElement.style.setProperty('--keyboard-inset', next.keyboardOpen ? next.bottomInset + 'px' : '0px');
      onChange(next);
    }
    const field = doc.activeElement?.closest?.('#task-form,#event-form') ? doc.activeElement : null;
    if (field && (next.keyboardOpen || next.visibleHeight < 500) && (resized || field !== focusedSheetInput)) {
      if (revealFrame) win.cancelAnimationFrame(revealFrame);
      revealFrame = win.requestAnimationFrame(() => {
        revealFrame = null;
        if (!disposed && doc.activeElement === field) revealFocusedSheetInput(doc, current);
      });
    }
    focusedSheetInput = field;
    return current;
  }
  const schedule = () => { if (!disposed && !frame) frame = win.requestAnimationFrame(() => { frame = null; refresh(); }); };
  for (const event of ['resize', 'orientationchange']) win.addEventListener(event, schedule);
  for (const event of ['resize', 'scroll']) win.visualViewport?.addEventListener(event, schedule);
  for (const event of ['focusin', 'focusout']) doc.addEventListener(event, schedule);
  refresh();
  return {
    get state() { return current; }, refresh,
    keyboardWillShow(info = {}) { nativeKeyboardOpen = Number(info.keyboardHeight) > 0; refresh(); },
    keyboardWillHide() { nativeKeyboardOpen = false; refresh(); },
    dispose() {
      disposed = true; if (frame) win.cancelAnimationFrame(frame); if (revealFrame) win.cancelAnimationFrame(revealFrame);
      for (const event of ['resize', 'orientationchange']) win.removeEventListener(event, schedule);
      for (const event of ['resize', 'scroll']) win.visualViewport?.removeEventListener(event, schedule);
      for (const event of ['focusin', 'focusout']) doc.removeEventListener(event, schedule);
    },
  };
}
