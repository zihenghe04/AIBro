/* Message chrome adapts the existing delegated actions; it never forks, saves,
 * sends, or changes the conversation itself. Only settled messages opt in. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MessageActions = api;
})(globalThis, root => {
  'use strict';
  const actionKeys = ['copyMessage', 'saveNote', 'retryRun', 'branchMessage', 'forkMessage', 'editMessage'];
  const records = new WeakMap();
  const quoteSelections = new WeakMap();
  const nearbyQuotes = new WeakMap();
  const renderedBodies = new WeakMap();
  const t = (zh, en) => root.WorkstationI18n?.getLanguage?.() === 'en' ? en : zh;

  // A mouse click can collapse the native selection before the delegated click
  // reaches the host. Preserve only the actual selected body at activation,
  // never a previous hover/selection or text from an adjacent message.
  function selectedQuote(button, selection = root.getSelection?.()) {
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const text = String(selection.toString());
    if (!text.trim()) return null;
    const wrapper = button?.closest?.('.message-wrap'), body = wrapper?.querySelector(':scope > .message-body');
    const rendered = body && renderedBodies.get(body);
    if (selection.rangeCount !== 1 || !body || !rendered || body.hidden || wrapper.classList.contains('live-message') ||
        !body.contains(selection.anchorNode) || !body.contains(selection.focusNode)) return { invalid: true };
    return { messageId: wrapper.dataset.messageId, text, body, bodyText: body.textContent, messageText: rendered.messageText };
  }
  function takeQuoteSelection(button) {
    // Nearby actions are selection-only. A stale/collapsed selection must never
    // silently turn this small action into a quote of the complete response.
    if (nearbyQuotes.has(button)) return nearbyQuotes.get(button)();
    const saved = quoteSelections.get(button); quoteSelections.delete(button);
    // Consume only the activation immediately preceding this click. If that
    // activation had an invalid selection, reject rather than quoting all.
    return saved ? Date.now() - saved.at < 2000 ? saved.selection : { invalid: true } : selectedQuote(button);
  }
  function bindQuoteSelection(button) {
    const capture = event => {
      if (event.type === 'pointerdown' && event.button !== 0) return;
      if (event.type === 'keydown' && (event.isComposing || !['Enter', ' '].includes(event.key))) return;
      quoteSelections.set(button, { selection: selectedQuote(button), at: Date.now() });
    };
    button.addEventListener('pointerdown', capture);
    button.addEventListener('keydown', capture);
  }

  // One transient, independently owned Kit root. It delegates to the existing
  // quote path; no second composer writer, portal or saved selection history.
  function createSelectionAction({ canonical, document: doc = root.document } = {}) {
    if (!doc?.addEventListener || !doc.createElement || !canonical) return { destroy() {} };
    let active = null, frame = null, validationFrame = null, dragging = false, suppressed = null, destroyed = false;
    const listeners = [];
    const on = (target, type, fn, options) => {
      target?.addEventListener?.(type, fn, options);
      listeners.push(() => target?.removeEventListener?.(type, fn, options));
    };
    const forbidden = 'button,summary,input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="button"],.safe-preview-toolbar,.code-block-toolbar';
    const element = node => node?.nodeType === 1 ? node : node?.parentElement;
    const same = (a, b) => !!a && !!b && a.body === b.body && a.text === b.text &&
      a.anchorNode === b.anchorNode && a.anchorOffset === b.anchorOffset && a.focusNode === b.focusNode && a.focusOffset === b.focusOffset;
    const visible = body => body?.isConnected && !doc.hidden && !body.closest('[hidden],[inert],[aria-hidden="true"]') &&
      body.getClientRects().length && root.getComputedStyle?.(body)?.visibility !== 'hidden';
    const current = snapshot => {
      const value = canonical(snapshot.messageId);
      return !!value && value.conversation.id === snapshot.conversationId && value.message.role === 'agent' &&
        value.message.text === snapshot.messageText && snapshot.body.textContent === snapshot.bodyText &&
        !snapshot.body.closest('.live-message') && visible(snapshot.body);
    };
    const read = () => {
      const selection = root.getSelection?.();
      if (!selection || selection.isCollapsed || selection.rangeCount !== 1 || !String(selection).trim()) return null;
      const body = element(selection.anchorNode)?.closest('.message-body');
      if (!body || !body.contains(selection.focusNode) || !visible(body)) return null;
      const wrapper = body.closest('.message-wrap.agent-message'), rendered = renderedBodies.get(body);
      if (!wrapper || !rendered || wrapper.classList.contains('live-message')) return null;
      const range = selection.getRangeAt(0);
      // Endpoints alone miss controls in the middle of a multi-paragraph range.
      if (element(selection.anchorNode)?.closest(forbidden) || element(selection.focusNode)?.closest(forbidden) ||
          [...body.querySelectorAll(forbidden)].some(node => range.intersectsNode(node))) return null;
      const value = canonical(wrapper.dataset.messageId), scroller = body.closest('.message-list');
      if (!value || value.message.role !== 'agent' || value.message.text !== rendered.messageText || !scroller) return null;
      const box = scroller.getBoundingClientRect(), bounds = { left: Math.max(8, box.left + 8), top: Math.max(8, box.top + 8),
        right: Math.min(root.innerWidth - 8, box.right - 8), bottom: Math.min(root.innerHeight - 8, box.bottom - 8) };
      if (body.getBoundingClientRect().height <= box.height || bounds.right - bounds.left < 150 || bounds.bottom - bounds.top < 52) return null;
      const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0 && rect.bottom > bounds.top &&
        rect.top < bounds.bottom && rect.right > bounds.left && rect.left < bounds.right);
      if (!rects.length) return null;
      const backwards = selection.focusNode === range.startContainer && selection.focusOffset === range.startOffset;
      const rect = backwards ? rects[0] : rects[rects.length - 1];
      // If the actual selection endpoint is offscreen, do not offer an action
      // against an unrelated visible slice after dragging beyond the viewport.
      const all = [...range.getClientRects()], endpoint = backwards ? all[0] : all[all.length - 1];
      if (!endpoint || endpoint.top < bounds.top || endpoint.bottom > bounds.bottom) return null;
      return { messageId: wrapper.dataset.messageId, conversationId: value.conversation.id,
        messageText: rendered.messageText, bodyText: body.textContent, text: String(selection), body, wrapper,
        anchorNode: selection.anchorNode, anchorOffset: selection.anchorOffset, focusNode: selection.focusNode,
        focusOffset: selection.focusOffset, range: range.cloneRange(), rect, bounds };
    };
    const returnToBody = snapshot => {
      if (!current(snapshot)) return;
      const old = snapshot.body.getAttribute('tabindex'); snapshot.body.setAttribute('tabindex', '-1');
      snapshot.body.focus({ preventScroll: true });
      if (old === null) snapshot.body.removeAttribute('tabindex'); else snapshot.body.setAttribute('tabindex', old);
      const selection = root.getSelection?.();
      try {
        if (selection?.setBaseAndExtent) selection.setBaseAndExtent(snapshot.anchorNode, snapshot.anchorOffset, snapshot.focusNode, snapshot.focusOffset);
        else { selection?.removeAllRanges(); selection?.addRange(snapshot.range); }
        // addRange fallback normalizes a backwards range. Suppress that same
        // restored selection too, rather than immediately reopening on Escape.
        suppressed = read() || snapshot;
      } catch (_) { /* A later render owns this range. */ }
    };
    const hide = ({ restoreFocus = false, suppress = true } = {}) => {
      if (frame !== null) { root.cancelAnimationFrame(frame); frame = null; }
      if (validationFrame !== null) { root.cancelAnimationFrame(validationFrame); validationFrame = null; }
      if (!active) return;
      const old = active; active = null; old.observer?.disconnect();
      if (suppress) suppressed = old.snapshot;
      const focused = old.surface.contains(doc.activeElement);
      nearbyQuotes.set(old.button, () => ({ invalid: true }));
      root.SelectionExplain?.releaseToolbar(old.owner);
      root.HalaskaUI?.unmount(old.host); old.host.remove();
      if (restoreFocus && focused) returnToBody(old.snapshot);
    };
    const refresh = () => {
      frame = null; if (destroyed || dragging) return;
      // Tab can collapse a native selection. Its snapshot remains valid only
      // while this owned button has focus and the canonical body is unchanged.
      if (active?.surface.contains(doc.activeElement) && current(active.snapshot)) return;
      const snapshot = read();
      if (!snapshot || same(snapshot, suppressed)) { hide(); return; }
      if (active && same(snapshot, active.snapshot) && current(active.snapshot)) return;
      hide({ suppress: false });
      if (!root.HalaskaUI?.mount || !root.SelectionExplain?.claimToolbar) return;
      const host = doc.createElement('span'); host.className = 'message-selection-action';
      const owner = { element: host, snapshot, pick: () => current(snapshot) ? snapshot : null, close: () => hide() };
      const surface = root.SelectionExplain.claimToolbar(owner);
      if (!surface) return;
      try { root.HalaskaUI.mount(host, 'Button', { children: t('引用提问', 'Ask about selection'), variant: 'secondary', size: 'sm',
        title: t('把选中文字引用到输入框，接着提问', 'Quote the selected text in the composer'),
        style: { margin: 0, height: 34, minHeight: 34, whiteSpace: 'nowrap', padding: '6px 12px', fontSize: 12 } }); }
      catch (_) { root.SelectionExplain.releaseToolbar(owner); root.HalaskaUI?.unmount(host); host.remove(); return; }
      const button = host.querySelector('button');
      if (!button) { root.SelectionExplain.releaseToolbar(owner); root.HalaskaUI.unmount(host); host.remove(); return; }
      button.dataset.quoteMessage = snapshot.messageId;
      const width = surface.getBoundingClientRect().width, height = surface.getBoundingClientRect().height;
      if (width > snapshot.bounds.right - snapshot.bounds.left || height > snapshot.bounds.bottom - snapshot.bounds.top) {
        root.SelectionExplain.releaseToolbar(owner); root.HalaskaUI.unmount(host); host.remove(); return;
      }
      surface.style.left = `${Math.max(snapshot.bounds.left, Math.min(snapshot.rect.left, snapshot.bounds.right - width))}px`;
      const above = snapshot.rect.top - height - 8;
      surface.style.top = `${Math.max(snapshot.bounds.top, Math.min(above >= snapshot.bounds.top ? above : snapshot.rect.bottom + 8, snapshot.bounds.bottom - height))}px`;
      active = { host, button, snapshot, surface, owner };
      nearbyQuotes.set(button, () => {
        const valid = active?.button === button && current(snapshot);
        hide(); return valid ? snapshot : { invalid: true };
      });
      button.addEventListener('pointerdown', event => { if (event.button === 0) event.preventDefault(); });
      if (root.MutationObserver) {
        const observer = new root.MutationObserver(changes => {
          if (active?.button !== button) return;
          // Detachment/navigation and ancestor visibility changes retire the
          // action immediately. Sibling streams/animation never rescan this
          // response; changes inside its body coalesce into one frame check.
          if (!snapshot.body.isConnected || changes.some(change => change.type === 'attributes' &&
              !snapshot.body.contains(change.target) && change.target.contains(snapshot.body))) { hide(); return; }
          if (!changes.some(change => snapshot.body.contains(change.target))) return;
          if (validationFrame === null) validationFrame = root.requestAnimationFrame(() => {
            validationFrame = null;
            if (active?.button === button && !current(snapshot)) hide();
          });
        });
        active.observer = observer;
        observer.observe(doc.body, { subtree: true, childList: true, characterData: true, attributes: true,
          attributeFilter: ['hidden', 'class', 'style', 'aria-hidden', 'inert'] });
      }
    };
    const schedule = () => { if (!destroyed && frame === null) frame = root.requestAnimationFrame(refresh); };
    on(doc, 'selectionchange', schedule);
    on(doc, 'pointerdown', event => {
      if (active?.surface.contains(event.target)) return;
      dragging = event.button === 0; hide(); suppressed = null;
    }, true);
    on(doc, 'pointerup', event => {
      if (!dragging) return; dragging = false;
      const snapshot = read();
      if (snapshot?.body.contains(event.target)) schedule(); else { suppressed = snapshot; hide(); }
    }, true);
    on(doc, 'pointercancel', () => { dragging = false; hide(); });
    on(doc, 'keydown', event => {
      if (!active || event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); hide({ restoreFocus: true }); return; }
      if (event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey &&
          !active.surface.contains(doc.activeElement) && !element(doc.activeElement)?.closest('input,textarea,[contenteditable="true"]')) {
        if (!current(active.snapshot)) { hide(); return; }
        event.preventDefault(); active.button.focus({ preventScroll: true });
      }
    }, true);
    on(doc, 'focusin', event => { if (active && !active.surface.contains(event.target) && event.target !== active.snapshot.body) hide(); });
    for (const type of ['scroll', 'wheel', 'contextmenu']) on(doc, type, () => hide(), { capture: true, passive: true });
    on(doc, 'visibilitychange', () => hide());
    on(doc, 'workstation-language-change', () => hide());
    for (const type of ['resize', 'blur', 'pagehide']) on(root, type, () => hide());
    return { destroy() { destroyed = true; hide(); listeners.forEach(remove => remove()); } };
  }
  function createCopyController({ writeText = text => root.navigator?.clipboard?.writeText?.(text), getContext = () => null,
    onSuccess = () => {}, onError = () => {}, clearFeedback = () => {}, feedbackMs = 1600 } = {}) {
    const entries = new Map(); let destroyed = false;
    const restore = (target, entry) => {
      if (entries.get(target) !== entry) return;
      for (const [name, value] of entry.attributes) {
        if (target.getAttribute(name) !== 'true') continue;
        if (value === null) target.removeAttribute(name); else target.setAttribute(name, value);
      }
    };
    const release = (target, entry) => {
      if (entries.get(target) !== entry) return;
      restore(target, entry); root.clearTimeout(entry.timer); entries.delete(target);
    };
    return {
      async request(target) {
        if (destroyed) return { ok: false, reason: 'destroyed' };
        if (!target?.isConnected || target.disabled || target.dataset?.copyMessage === undefined) return { ok: false, reason: 'unavailable' };
        if (entries.has(target)) return { ok: false, reason: 'pending' };
        const text = String(target.dataset.copyMessage), context = getContext();
        const entry = { attributes: ['aria-busy', 'aria-disabled'].map(name => [name, target.getAttribute(name)]), timer: null };
        entries.set(target, entry);
        target.setAttribute('aria-busy', 'true'); target.setAttribute('aria-disabled', 'true');
        const current = () => !destroyed && entries.get(target) === entry && target.isConnected && getContext() === context && target.dataset.copyMessage === text;
        try {
          const write = writeText(text);
          // A missing clipboard API must not be reported as a successful copy.
          if (!write || typeof write.then !== 'function') throw Error('Clipboard is unavailable');
          const result = await write;
          if (result === false) throw Error('Clipboard write was not acknowledged');
          if (!current()) { release(target, entry); return { ok: false, reason: 'stale' }; }
          restore(target, entry);
          entry.timer = root.setTimeout(() => release(target, entry), Math.max(0, feedbackMs));
          // Clipboard acknowledgement is authoritative even if optional visual
          // feedback is unavailable; never label a successful write as failed.
          try { onSuccess(target); } catch (_) { /* The copy itself succeeded. */ }
          return { ok: true };
        } catch (error) {
          const present = current(); release(target, entry);
          if (present) onError(error, target);
          return { ok: false, reason: present ? 'failed' : 'stale' };
        }
      },
      destroy() {
        destroyed = true;
        for (const [target, entry] of entries) { release(target, entry); clearFeedback(target); }
      }
    };
  }

  function quoteText(text) {
    const value = String(text ?? '').replace(/\r\n?/g, '\n');
    return value.trim() ? value.split('\n').map(line => `> ${line}`).join('\n') : '';
  }
  function appendQuote(draft, text) {
    const before = String(draft ?? ''), quote = quoteText(text);
    if (!quote) return before;
    return `${before}${before && !before.endsWith('\n\n') ? before.endsWith('\n') ? '\n' : '\n\n' : ''}${quote}\n\n`;
  }
  function createQuoteController({ getConversation, getInput, exportText = message => message.text, onChange = () => {} }) {
    let input = null, composing = false, pending = [], timer = null, destroyed = false;
    const canonical = id => {
      const conversation = getConversation?.();
      const message = conversation?.messages?.find(item => item?.id === id && !item.deletedAt && !item.live && ['agent', 'user'].includes(item.role));
      return conversation?.id && !conversation.deletedAt && message ? { conversation, message } : null;
    };
    const append = (id, conversationId, target, selection, originalText) => {
      const current = canonical(id);
      if (destroyed || !current || current.conversation.id !== conversationId || getInput?.() !== target || target.isConnected === false) return { ok: false, reason: 'stale' };
      let value;
      if (selection && (selection.invalid || selection.messageId !== id || selection.body?.isConnected !== true ||
          selection.body.textContent !== selection.bodyText || current.message.text !== originalText ||
          current.message.text !== selection.messageText)) return { ok: false, reason: 'stale' };
      try { value = selection ? selection.text : String(exportText(current.message, current.conversation) ?? ''); }
      catch { return { ok: false, reason: 'unavailable' }; }
      if (!value.trim()) return { ok: false, reason: 'empty' };
      target.value = appendQuote(target.value, value);
      target.focus?.(); target.setSelectionRange?.(target.value.length, target.value.length);
      onChange({ ...current, input: target });
      return { ok: true, queued: false };
    };
    const start = () => { composing = true; };
    const end = () => {
      composing = false;
      if (timer !== null) root.clearTimeout(timer);
      // Native IME can deliver its final input after compositionend. Consume
      // the current textarea only after that event sequence has settled.
      timer = root.setTimeout(() => {
        timer = null;
        if (destroyed || composing) return;
        const queue = pending; pending = [];
        queue.forEach(item => append(item.id, item.conversationId, item.target, item.selection, item.originalText));
      }, 0);
    };
    const bind = () => {
      const next = getInput?.();
      if (next === input) return next;
      input?.removeEventListener('compositionstart', start); input?.removeEventListener('compositionend', end);
      composing = false; pending = []; input = next;
      input?.addEventListener('compositionstart', start); input?.addEventListener('compositionend', end);
      return input;
    };
    bind();
    const selectionAction = createSelectionAction({ canonical });
    return {
      request(id, { selection = null } = {}) {
        if (destroyed) return { ok: false, reason: 'destroyed' };
        const target = bind(), current = canonical(id);
        if (!target || !current) return { ok: false, reason: 'unavailable' };
        const originalText = current.message.text;
        if (selection && (selection.invalid || selection.messageId !== id || typeof selection.text !== 'string' || !selection.text.trim())) return { ok: false, reason: 'selection' };
        if (composing || timer !== null) {
          pending.push({ id, conversationId: current.conversation.id, target, selection, originalText });
          return { ok: true, queued: true };
        }
        return append(id, current.conversation.id, target, selection, originalText);
      },
      destroy() {
        destroyed = true; pending = [];
        selectionAction.destroy();
        if (timer !== null) root.clearTimeout(timer);
        input?.removeEventListener('compositionstart', start); input?.removeEventListener('compositionend', end);
      }
    };
  }
  function plan(message, buttons = [], exportedText) {
    if (!message?.id || message.live || message.deletedAt || !['agent', 'user'].includes(message.role)) return [];
    const values = [];
    for (const button of buttons) {
      const kind = actionKeys.find(key => Object.prototype.hasOwnProperty.call(button.dataset || {}, key));
      if (!kind || values.some(item => item.key === kind)) continue;
      values.push({ key: kind, label: button.textContent.trim(), title: button.title || '', disabled: !!button.disabled,
        dataset: { [kind]: button.dataset[kind] } });
    }
    const text = String(exportedText ?? message.text ?? '');
    if (message.role === 'user' && text.trim() && !values.some(item => item.key === 'copyMessage')) {
      values.unshift({ key: 'copyMessage', label: t('复制', 'Copy'), title: t('复制这条消息', 'Copy this message'), dataset: { copyMessage: text } });
    }
    if (text.trim()) values.push({ key: 'quoteMessage', label: t('引用回复', 'Quote reply'),
      title: t('引用选中的正文；未选择时引用整条消息', 'Quote selected text, or the whole message when nothing is selected'), dataset: { quoteMessage: message.id } });
    return values;
  }
  function bind(host, actions) {
    for (const action of actions) {
      const slot = [...host.querySelectorAll('[data-message-action-key]')].find(node => node.dataset.messageActionKey === action.key);
      const button = slot?.querySelector('button');
      if (!button) continue;
      // Halaska Button owns presentation, the application owns exactly one
      // delegated business callback. Do not add an onClick that repeats it.
      for (const [key, value] of Object.entries(action.dataset)) button.dataset[key] = value;
      if (action.key === 'quoteMessage') bindQuoteSelection(button);
    }
  }
  function enhance(wrapper, message, options = {}) {
    if (!wrapper || !root.HalaskaUI || message?.live || message?.deletedAt) return false;
    const bar = wrapper.querySelector(':scope > .message-meta > .meta-actions');
    if (!bar || records.get(bar)?.host?.parentElement === bar) return false;
    const actions = plan(message, [...bar.querySelectorAll('button')], options.exportedText);
    if (!actions.length) return false;
    const host = (wrapper.ownerDocument || root.document).createElement('span');
    host.className = 'message-action-bar-host';
    const props = { actions, label: t('消息操作', 'Message actions'), moreLabel: t('更多消息操作', 'More message actions') };
    // Mount next to existing controls; if the Kit is unavailable the original
    // controls remain intact. Transfer ownership only after successful mount.
    bar.append(host);
    try { root.HalaskaUI.mount(host, 'MessageActionBar', props); bind(host, actions); }
    catch (error) { root.HalaskaUI.unmount?.(host); host.remove(); return false; }
    [...bar.childNodes].filter(node => node !== host).forEach(node => node.remove());
    records.set(bar, { host, actions });
    const body = wrapper.querySelector(':scope > .message-body');
    if (body) renderedBodies.set(body, { messageText: options.sourceText ?? message.text });
    return true;
  }
  return { enhance, plan, quoteText, appendQuote, selectedQuote, takeQuoteSelection, createQuoteController, createCopyController };
});
