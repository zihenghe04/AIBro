/* 对话代码块的「复制代码」按钮。
   按钮只有一个，浮在 body 上、跟随指针或键盘焦点所在的代码块，不插进消息 DOM：
   流式补丁、整条消息复制、页内查找和导出都看不到它，也不会把“复制”二字算进正文。
   只服务已完成的回复；生成中的代码块不提供复制（内容还在变）。 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CodeCopy = api;
})(globalThis, root => {
  'use strict';
  const T = (zh, en) => {
    try { return root.WorkstationI18n?.getLanguage?.() === 'en' ? en : zh; }
    catch (error) { return zh; }
  };
  // 只取 <code> 的纯文本：语言标签与高亮标记都不进剪贴板。
  function codeText(pre) {
    const code = pre?.querySelector?.(':scope > code');
    return code ? code.textContent : '';
  }
  function eligible(pre, host) {
    return !!pre && pre.isConnected && !!host?.contains(pre) && pre.matches?.('pre.message-code')
      && !pre.closest('.live-message') && !!codeText(pre).length;
  }

  let destroy = null;
  function init(hooks = {}) {
    destroy?.();
    const doc = root.document; if (!doc?.body) return null;
    const listeners = [], on = (node, type, fn, options) => { node?.addEventListener(type, fn, options); listeners.push(() => node?.removeEventListener(type, fn, options)); };
    const button = doc.createElement('button');
    button.type = 'button'; button.className = 'code-copy-float'; button.hidden = true;
    const label = () => T('复制代码', 'Copy code');
    const setLabel = text => { button.textContent = text; button.setAttribute('aria-label', text === label() ? label() : `${text} · ${label()}`); };
    setLabel(label());
    doc.body.append(button);
    let target = null, hideTimer = null, resetTimer = null, copying = false;
    const host = () => hooks.getRoot?.() || null;
    function place() {
      if (!target || !eligible(target, host())) return hide(true);
      const rect = target.getBoundingClientRect?.();
      if (!rect || !rect.width) return hide(true);
      // Bottom-right keeps the language label (top-right) readable.
      button.style.top = `${Math.max(4, rect.bottom - 34)}px`;
      button.style.left = `${Math.max(4, rect.right - 8)}px`;
    }
    function show(pre) {
      clearTimeout(hideTimer);
      if (!eligible(pre, host())) return;
      if (target !== pre) { target = pre; clearTimeout(resetTimer); setLabel(label()); }
      button.hidden = false; place();
    }
    function hide(now) {
      clearTimeout(hideTimer);
      const run = () => { if (copying) return; button.hidden = true; target = null; };
      if (now) run(); else hideTimer = setTimeout(run, 220);
    }
    async function copy() {
      if (copying || !target || !eligible(target, host())) return;
      const pre = target, text = codeText(pre);
      copying = true;
      try {
        await root.navigator.clipboard.writeText(text);
        if (target === pre) setLabel(T('已复制', 'Copied'));
        hooks.announce?.(T('代码已复制。', 'Code copied.'));
      } catch (error) {
        if (target === pre) setLabel(T('复制失败', 'Copy failed'));
        hooks.announce?.(T('无法访问剪贴板，请选中代码后复制。', 'Clipboard unavailable; select the code to copy it.'));
      } finally {
        copying = false;
        clearTimeout(resetTimer); resetTimer = setTimeout(() => { if (button.isConnected) setLabel(label()); }, 1600);
      }
    }
    on(button, 'click', event => { event.preventDefault(); event.stopPropagation(); copy(); });
    on(button, 'pointerenter', () => clearTimeout(hideTimer));
    on(button, 'pointerleave', () => hide(false));
    on(button, 'blur', () => hide(false));
    on(doc, 'pointerover', event => {
      const pre = event.target?.closest?.('pre.message-code');
      if (pre) show(pre); else if (target && event.target !== button) hide(false);
    });
    // Keyboard: selecting text inside a code block offers the same button.
    on(doc, 'selectionchange', () => {
      const node = root.getSelection?.()?.anchorNode, element = node?.nodeType === 1 ? node : node?.parentElement;
      const pre = element?.closest?.('pre.message-code');
      if (pre) show(pre);
    });
    on(doc, 'scroll', () => { if (!button.hidden) place(); }, true);
    on(root, 'resize', () => { if (!button.hidden) place(); });
    destroy = () => { clearTimeout(hideTimer); clearTimeout(resetTimer); listeners.forEach(off => off()); button.remove(); destroy = null; };
    return { button, show, hide, copy, destroy: () => destroy?.() };
  }
  return { init, codeText, eligible, destroy: () => destroy?.() };
});
