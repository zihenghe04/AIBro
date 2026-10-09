const sized = new WeakMap();
let observedForm = null, formObserver = null;
function measureForm(form) {
  const measured = Math.ceil(form.getBoundingClientRect().height);
  if (measured) form.ownerDocument.documentElement.style.setProperty('--chat-composer-height', measured + 'px');
}
function observeForm(form) {
  if (form !== observedForm) {
    formObserver?.disconnect(); formObserver = null; observedForm = form;
    const Observer = form?.ownerDocument.defaultView.ResizeObserver;
    if (form && Observer) {
      formObserver = new Observer(() => { if (observedForm === form && form.isConnected) measureForm(form); });
      formObserver.observe(form);
    }
  }
  if (form) measureForm(form);
}
export function composerHeight({ scrollHeight, minimum = 64, visibleHeight = 720, border = 0 }) {
  const limit = Math.max(minimum, Math.min(180, Math.floor(Math.max(0, visibleHeight) * 0.3)));
  return Math.max(minimum, Math.min(limit, Math.ceil(scrollHeight + border)));
}

// Only these two composers are owned here, not note/capture/editor textareas.
// Changing height never changes the value, selection, focus, or composing range.
export function sizeComposer(textarea, { visibleHeight } = {}) {
  if (!textarea?.matches?.('#home-chat-text,#chat-text')) return null;
  const doc = textarea.ownerDocument, win = doc.defaultView;
  const style = win.getComputedStyle(textarea);
  const height = visibleHeight || win.visualViewport?.height || win.innerHeight;
  const minimum = parseFloat(style.minHeight) || 64;
  const border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
  const signature = [textarea.value, textarea.clientWidth, height, minimum, border, style.fontSize, style.lineHeight, style.paddingTop, style.paddingBottom].join('|');
  let result = sized.get(textarea);
  if (result?.signature !== signature) {
    const scroll = textarea.scrollTop;
    textarea.style.height = '0px';
    const desired = composerHeight({ scrollHeight: textarea.scrollHeight, minimum, visibleHeight: height, border });
    textarea.style.height = desired + 'px';
    textarea.style.overflowY = textarea.scrollHeight > textarea.clientHeight ? 'auto' : 'hidden';
    textarea.scrollTop = scroll;
    result = { signature, height: desired }; sized.set(textarea, result);
  }
  if (textarea.id === 'chat-text' && textarea.form) observeForm(textarea.form);
  return result.height;
}

export function sizeComposers(root = document, options = {}) {
  const inputs = [...root.querySelectorAll('#home-chat-text,#chat-text')];
  if (!inputs.some(input => input.id === 'chat-text')) observeForm(null);
  return inputs.map(textarea => sizeComposer(textarea, options));
}
