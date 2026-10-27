/* UIKit: one small set of controls shared by settings, the in-chat model picker and forms.
   Select/Combobox (search, groups, icon, sub-title, check mark, keyboard), Popover, Segmented, Switch,
   Badge, Row (card list row) and the Effort picker. Plain DOM, no framework; styles in ui-kit.css (tokens.css colours).
   enhanceSelect() swaps a native <select> for the Select while the native element stays in the DOM as the
   source of truth (value, change events, option updates), so existing code that reads select.value keeps working. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UIKit = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const doc = () => root.document;
  const english = () => root.WorkstationI18n?.getLanguage?.() === 'en' || /^en(?:-|$)/i.test(root.document?.documentElement?.lang || '');
  const t = (zh, en) => english() ? en : zh;
  let seed = 0;
  const uid = prefix => `${prefix}-${++seed}`;

  function h(tag, props = {}, ...children) {
    const node = doc().createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) if (child != null && child !== false) node.append(child.nodeType ? child : doc().createTextNode(String(child)));
    return node;
  }
  const svg = (path, size = 16, extra = '') => {
    const wrapper = h('span', { class: 'uk-glyph', 'aria-hidden': 'true' });
    wrapper.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ${extra}>${path}</svg>`;
    return wrapper;
  };
  const GLYPHS = {
    chevron: '<path d="m4 6 4 4 4-4"/>',
    check: '<path d="m3.5 8.5 3 3 6-7"/>',
    search: '<circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3 3"/>',
    spark: '<path d="M8 1.8 9.3 6.2 13.7 7.5 9.3 8.8 8 13.2 6.7 8.8 2.3 7.5 6.7 6.2z"/>',
    arrow: '<path d="M4 8h8M8.5 4.5 12 8l-3.5 3.5"/>'
  };
  const glyph = (name, size) => svg(GLYPHS[name] || '', size);

  // ---- icon tile: emoji/text, an element, or a deterministic monogram colour from the name ----
  function hueOf(text) { let value = 7; for (const ch of String(text)) value = (value * 31 + ch.codePointAt(0)) % 360; return value; }
  function iconTile(icon, name, size = 28) {
    const tile = h('span', { class: 'uk-icon', 'aria-hidden': 'true', style: `--uk-icon-size:${size}px` });
    if (icon && icon.nodeType) tile.append(icon);
    else if (icon && typeof icon === 'object' && icon.glyph) { tile.append(glyph(icon.glyph, Math.round(size * .56))); tile.dataset.tone = icon.tone || 'accent'; }
    else if (icon) tile.textContent = String(icon);
    else {
      const label = String(name || '?').trim();
      tile.textContent = (label.match(/[A-Za-z0-9]/)?.[0] || label[0] || '?').toUpperCase();
      tile.dataset.mono = '';
      tile.style.setProperty('--uk-hue', String(hueOf(label)));
    }
    return tile;
  }

  // ---- Popover ----
  const openPopovers = new Set();
  function placeFloating(panel, anchor, { matchWidth = true, align = 'start', gap = 6, minWidth = 0, prefer = 'below' } = {}) {
    const view = { w: root.innerWidth || 1024, h: root.innerHeight || 768 };
    const rect = anchor.getBoundingClientRect?.() || { left: 0, right: 0, top: 0, bottom: 0, width: 0 };
    panel.style.maxHeight = ''; panel.style.minWidth = `${Math.max(minWidth, matchWidth ? Math.round(rect.width) : 0)}px`;
    const own = panel.getBoundingClientRect?.() || { width: 0, height: 0 };
    const width = own.width || minWidth || rect.width, height = own.height || 0;
    const below = view.h - rect.bottom - gap - 10, above = rect.top - gap - 10;
    const up = prefer === 'above' ? (above >= Math.min(height, 260) || above > below) : (below < Math.min(height, 260) && above > below);
    const room = Math.max(160, up ? above : below);
    const limit = Math.min(room, view.h - 20);
    panel.style.maxHeight = `${Math.floor(limit)}px`;
    const used = Math.min(height || limit, limit);
    let left = align === 'end' ? rect.right - width : rect.left;
    left = Math.max(10, Math.min(left, view.w - width - 10));
    const top = up ? Math.max(10, rect.top - gap - used) : Math.min(rect.bottom + gap, view.h - used - 10);
    panel.style.left = `${Math.round(left)}px`; panel.style.top = `${Math.round(top)}px`;
    panel.dataset.placement = up ? 'above' : 'below';
  }
  /* popover({anchor, content, onClose, align, matchWidth, modal-safe}) -> {el, close, reposition, isOpen}
     The panel lives in the anchor's <dialog> (so it stays interactive over a modal) or in <body>, and uses the
     Popover API top layer when the engine has it. Esc and outside press close it; focus returns to the anchor. */
  function popover({ anchor, content, onClose, align = 'start', matchWidth = false, minWidth = 0, className = '', label = '', role = 'dialog', restoreFocus = true, prefer = 'below', closeOnScroll = false } = {}) {
    const host = anchor.closest?.('dialog[open]') || doc().body;
    const panel = h('div', { class: `uk-pop ${className}`.trim(), role, 'aria-label': label || null, tabindex: '-1', 'data-state': 'closed' }, content);
    let open = true, listeners = [];
    const supportsTop = typeof panel.showPopover === 'function';
    if (supportsTop) panel.setAttribute('popover', 'manual');
    host.append(panel);
    if (supportsTop) { try { panel.showPopover(); } catch (_) { /* detached or already open */ } }
    const reposition = () => { if (open) placeFloating(panel, anchor, { matchWidth, align, minWidth, prefer }); };
    reposition();
    root.requestAnimationFrame ? root.requestAnimationFrame(() => { if (open) panel.dataset.state = 'open'; }) : (panel.dataset.state = 'open');
    const on = (target, type, fn, opts) => { if (!target?.addEventListener) return; target.addEventListener(type, fn, opts); listeners.push(() => target.removeEventListener(type, fn, opts)); };
    function close(reason = 'close') {
      if (!open) return; open = false; openPopovers.delete(api);
      listeners.forEach(off => off()); listeners = [];
      panel.dataset.state = 'closed';
      const done = () => { try { if (supportsTop) panel.hidePopover(); } catch (_) { /* already hidden */ } panel.remove(); };
      const animated = root.matchMedia && !root.matchMedia('(prefers-reduced-motion: reduce)').matches && root.requestAnimationFrame;
      animated ? setTimeout(done, 120) : done();
      if (restoreFocus && reason !== 'outside' && anchor.isConnected) anchor.focus?.({ preventScroll: true });
      onClose?.(reason);
    }
    on(doc(), 'pointerdown', event => { if (!panel.contains(event.target) && !anchor.contains(event.target)) close('outside'); }, true);
    on(doc(), 'keydown', event => { if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing) { event.preventDefault(); event.stopPropagation(); close('escape'); } }, true);
    on(root, 'resize', reposition);
    on(doc(), 'scroll', event => { if (panel.contains(event.target)) return; closeOnScroll ? close('scroll') : reposition(); }, true);
    const api = { el: panel, close, reposition, isOpen: () => open };
    openPopovers.add(api);
    return api;
  }

  // ---- Select / Combobox ----
  const norm = option => typeof option === 'string' ? { value: option, label: option } : option;
  const hay = option => `${option.label || ''} ${option.sub || ''} ${option.group || ''} ${(option.keywords || []).join(' ')} ${option.value}`.toLowerCase();

  /* select({options, value, onChange, placeholder, searchable, id, label, disabled, size, align, footer, emptyText, renderValue})
     options: {value, label, sub?, icon?, badge?, group?, disabled?, keywords?}   -> {el, value(), setValue, setOptions, open, close, isOpen, trigger} */
  function select(config = {}) {
    let options = (config.options || []).map(norm), value = config.value == null ? '' : String(config.value), disabled = !!config.disabled, pop = null;
    const listId = uid('uk-list'), triggerId = config.id || uid('uk-select');
    const labelText = h('span', { class: 'uk-select-label' }), subText = h('span', { class: 'uk-select-sub' });
    const trigger = h('button', { type: 'button', class: 'uk-select', id: triggerId, role: 'combobox', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-controls': listId, 'aria-label': config.label || null, 'data-size': config.size || 'md', ...(disabled ? { disabled: true } : {}) },
      h('span', { class: 'uk-select-icon' }), h('span', { class: 'uk-select-text' }, labelText, subText), glyph('chevron', 14));
    const wrap = h('span', { class: `uk-select-wrap ${config.className || ''}`.trim() }, trigger);
    const current = () => options.find(option => option.value === value) || null;
    function paintTrigger() {
      const option = current();
      const iconSlot = trigger.querySelector('.uk-select-icon');
      iconSlot.replaceChildren();
      if (option && (option.icon || config.iconFor)) iconSlot.append(iconTile(option.icon, option.label, 22));
      iconSlot.hidden = !iconSlot.firstChild;
      const text = config.renderValue ? config.renderValue(option) : (option ? option.label : '');
      labelText.textContent = text || config.placeholder || '';
      trigger.dataset.empty = text ? 'false' : 'true';
      subText.textContent = config.showSub && option?.sub ? option.sub : ''; subText.hidden = !subText.textContent;
    }
    paintTrigger();

    function openList() {
      if (disabled || pop?.isOpen()) return;
      const searchable = config.searchable === 'auto' || config.searchable === undefined ? options.length > 8 : !!config.searchable;
      let query = '', active = -1, visible = [];
      const list = h('div', { class: 'uk-list', role: 'listbox', id: listId, tabindex: '-1' });
      const search = searchable ? h('input', { class: 'uk-search', type: 'search', autocomplete: 'off', spellcheck: 'false', placeholder: config.searchPlaceholder || t('搜索', 'Search'), 'aria-label': t('搜索', 'Search'), 'aria-controls': listId }) : null;
      const header = search ? h('div', { class: 'uk-search-row' }, glyph('search', 14), search) : null;
      const body = h('div', { class: 'uk-pop-body' }, header, list, config.footer ? (typeof config.footer === 'function' ? config.footer(() => pop?.close()) : config.footer) : null);
      pop = popover({ anchor: trigger, content: body, matchWidth: true, minWidth: config.minWidth || 220, className: 'uk-select-pop', role: 'presentation', align: config.align || 'start', onClose: () => { trigger.setAttribute('aria-expanded', 'false'); trigger.removeAttribute('aria-activedescendant'); pop = null; } });
      trigger.setAttribute('aria-expanded', 'true');
      const choose = option => { if (option.disabled) return; const changed = option.value !== value; value = option.value; paintTrigger(); pop?.close('choose'); if (changed) config.onChange?.(value, option); };
      function setActive(index, scroll = true) {
        const nodes = [...list.querySelectorAll('[role=option]')];
        nodes.forEach(node => node.classList.remove('is-active'));
        active = nodes.length ? Math.max(0, Math.min(index, nodes.length - 1)) : -1;
        const node = nodes[active];
        if (node) { node.classList.add('is-active'); (search || trigger).setAttribute('aria-activedescendant', node.id); if (scroll) node.scrollIntoView?.({ block: 'nearest' }); }
      }
      function renderList() {
        const needle = query.trim().toLowerCase();
        visible = options.filter(option => !needle || needle.split(/\s+/).every(part => hay(option).includes(part)));
        list.replaceChildren();
        if (!visible.length) { list.append(h('div', { class: 'uk-empty', text: config.emptyText || t('没有匹配项', 'No matches') })); active = -1; return; }
        let group = null;
        visible.forEach((option, index) => {
          if (option.group && option.group !== group) { group = option.group; list.append(h('div', { class: 'uk-group', role: 'presentation', text: group })); }
          if (!option.group) group = null;
          const selected = option.value === value;
          list.append(h('div', { class: `uk-option${selected ? ' is-selected' : ''}${option.disabled ? ' is-disabled' : ''}`, role: 'option', id: `${listId}-${index}`, 'aria-selected': String(selected), ...(option.disabled ? { 'aria-disabled': 'true' } : {}), dataset: { value: option.value },
            onclick: () => choose(option), onpointermove: event => { if (!event.currentTarget.classList.contains('is-active')) setActive(index, false); } },
            (option.icon || config.icons) ? iconTile(option.icon, option.label, 28) : null,
            h('span', { class: 'uk-option-text' }, h('span', { class: 'uk-option-label', text: option.label }), option.sub ? h('span', { class: 'uk-option-sub', text: option.sub }) : null),
            option.badge ? (Array.isArray(option.badge) ? option.badge : [option.badge]).map(badge => badge.nodeType ? badge : UIKit.badge(badge.text || badge, { tone: badge.tone })) : null,
            h('span', { class: 'uk-check' }, selected ? glyph('check', 14) : null)));
        });
        const selectedIndex = visible.findIndex(option => option.value === value);
        setActive(needle ? 0 : Math.max(0, selectedIndex));
        pop?.reposition();
      }
      const onKey = event => {
        if (event.isComposing || event.keyCode === 229) return;
        const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
        if (step) { event.preventDefault(); setActive(active < 0 ? 0 : (active + step + visible.length) % visible.length); }
        else if (event.key === 'Home' && !search) { event.preventDefault(); setActive(0); }
        else if (event.key === 'End' && !search) { event.preventDefault(); setActive(visible.length - 1); }
        else if (event.key === 'Enter') { event.preventDefault(); if (visible[active]) choose(visible[active]); }
        else if (event.key === 'Tab') pop?.close('tab');
      };
      trigger.addEventListener('keydown', onKey); pop.el.addEventListener('keydown', onKey);
      const prevClose = pop.close; pop.close = reason => { trigger.removeEventListener('keydown', onKey); prevClose(reason); };
      search?.addEventListener('input', () => { query = search.value; renderList(); });
      renderList();
      (search || pop.el).focus?.({ preventScroll: true });
    }
    trigger.addEventListener('click', () => pop?.isOpen() ? pop.close() : openList());
    trigger.addEventListener('keydown', event => { if (!pop && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); openList(); } });
    return {
      el: wrap, trigger, value: () => value, current,
      setValue(next) { value = next == null ? '' : String(next); paintTrigger(); },
      setOptions(next) { options = (next || []).map(norm); paintTrigger(); },
      setDisabled(next) { disabled = !!next; trigger.disabled = disabled; if (disabled) pop?.close('disabled'); },
      open: openList, close: reason => pop?.close(reason), isOpen: () => !!pop?.isOpen()
    };
  }

  // Native <select> -> Select. The native element stays (visually hidden) and keeps value/change semantics.
  const enhanced = new WeakMap();
  function optionsOfNative(node) {
    const out = [];
    const read = (option, group) => out.push({ value: option.value, label: (option.label || option.textContent || option.value || '').trim(), group: group || undefined, disabled: option.disabled });
    for (const child of node.children) {
      if (child.tagName === 'OPTGROUP') for (const option of child.children) read(option, child.label);
      else if (child.tagName === 'OPTION') read(child);
    }
    return out;
  }
  // Real engines take select.value; some DOM shims only expose it read-only, so mark the option as well.
  function setNative(node, next) {
    try { node.value = next; } catch (_) { /* read-only value */ }
    for (const option of node.querySelectorAll('option')) { if (option.value === next) option.setAttribute('selected', ''); else option.removeAttribute('selected'); }
  }
  function enhanceSelect(node, config = {}) {
    if (!node || node.tagName !== 'SELECT' || node.multiple || node.size > 1) return null;
    if (enhanced.has(node)) return enhanced.get(node);
    // The native shell's bridge may have wrapped this select first; UIKit takes over.
    if (node.classList.contains('native-choice-source')) {
      node.classList.remove('native-choice-source');
      const sibling = node.nextElementSibling;
      if (sibling && /native-(select-trigger|choices)/.test(sibling.className)) sibling.remove();
    }
    const component = select({ label: node.getAttribute('aria-label') || undefined, disabled: node.disabled, ...config,
      className: `${(node.className || '').replace(/\bsetting-input\b/, '')} ${/\bsetting-input\b/.test(node.className || '') ? 'uk-block' : ''} ${config.className || ''}`.trim(), options: optionsOfNative(node), value: node.value,
      onChange(next) { setNative(node, next); node.dispatchEvent(new root.Event('change', { bubbles: true })); config.onChange?.(next); } });
    node.classList.add('uk-native'); node.setAttribute('tabindex', '-1'); node.setAttribute('aria-hidden', 'true');
    node.after(component.el);
    const labelled = node.id && node.ownerDocument.querySelector(`label[for="${node.id}"]`);
    if (labelled) { labelled.id ||= uid('uk-label'); component.trigger.setAttribute('aria-labelledby', labelled.id); }
    else if (!component.trigger.getAttribute('aria-label')) component.trigger.setAttribute('aria-label', node.getAttribute('aria-label') || node.title || '');
    const sync = () => { component.setOptions(optionsOfNative(node)); component.setValue(node.value); component.setDisabled(node.disabled); component.el.hidden = node.hidden || node.closest('[hidden]') === node; };
    // Programmatic writes to select.value (no event) must repaint too.
    const proto = Object.getPrototypeOf(node), descriptor = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(root.HTMLSelectElement?.prototype || {}, 'value');
    if (descriptor?.set) Object.defineProperty(node, 'value', { configurable: true, get() { return descriptor.get.call(this); }, set(next) { descriptor.set.call(this, next); component.setValue(descriptor.get.call(this)); } });
    node.focus = () => component.trigger.focus();
    node.addEventListener('change', () => component.setValue(node.value));
    if (root.MutationObserver) new root.MutationObserver(sync).observe(node, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'label', 'selected'] });
    enhanced.set(node, component);
    return component;
  }
  function enhanceAll(scope = doc(), selector = 'select', config = {}) {
    const nodes = scope.querySelectorAll ? [...scope.querySelectorAll(selector)] : [];
    return nodes.map(node => enhanceSelect(node, config)).filter(Boolean);
  }

  // Halaska KitSelect already pairs its native select with its own presentation layer; enhancing it again duplicates the control and desyncs disabled state.
  // Enhance every <select> that exists now or appears later (settings pages re-render their DOM). Opt out with data-native.
  let observer = null;
  function autoEnhance({ scope = doc().body, skip = node => node.dataset?.native !== undefined || node.closest?.('.uk-pop,[data-native-selects],.kit-select-wrap') } = {}) {
    const visit = node => {
      if (!node || node.nodeType !== 1) return;
      const nodes = node.tagName === 'SELECT' ? [node] : [...node.querySelectorAll?.('select') || []];
      for (const select of nodes) if (!skip(select)) enhanceSelect(select);
    };
    visit(scope);
    if (!observer && root.MutationObserver) {
      observer = new root.MutationObserver(records => { for (const record of records) record.addedNodes.forEach(visit); });
      observer.observe(scope, { childList: true, subtree: true });
    }
    return observer;
  }

  // ---- Segmented control (sliding thumb) ----
  function segmented(config = {}) {
    let options = (config.options || []).map(norm), value = config.value == null ? '' : String(config.value), disabled = !!config.disabled;
    const thumb = h('span', { class: 'uk-seg-thumb', 'aria-hidden': 'true' });
    const el = h('div', { class: `uk-seg ${config.className || ''}`.trim(), role: 'radiogroup', 'aria-label': config.label || null, 'data-size': config.size || 'md', ...(config.stretch ? { 'data-stretch': '' } : {}) }, thumb);
    const buttons = () => [...el.querySelectorAll('.uk-seg-item')];
    function placeThumb() {
      const selected = buttons().find(button => button.dataset.value === value);
      if (!selected || !selected.offsetWidth) { thumb.style.opacity = '0'; return; }
      thumb.style.opacity = '1'; thumb.style.width = `${selected.offsetWidth}px`; thumb.style.transform = `translateX(${selected.offsetLeft}px)`;
    }
    function render() {
      buttons().forEach(button => button.remove());
      for (const option of options) {
        const selected = option.value === value;
        el.append(h('button', { type: 'button', class: `uk-seg-item${selected ? ' is-selected' : ''}`, role: 'radio', 'aria-checked': String(selected), tabindex: selected || (!options.some(o => o.value === value) && option === options[0]) ? '0' : '-1', dataset: { value: option.value }, ...(disabled || option.disabled ? { disabled: true } : {}), title: option.title || null,
          onclick: () => pick(option) }, option.icon ? iconTile(option.icon, option.label, 16) : null, h('span', { text: option.label })));
      }
      placeThumb();
    }
    function pick(option) { if (disabled || option.disabled || option.value === value) return; value = option.value; render(); config.onChange?.(value, option); }
    el.addEventListener('keydown', event => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]; if (!step) return;
      const enabled = options.filter(option => !option.disabled); if (!enabled.length) return;
      event.preventDefault(); const index = Math.max(0, enabled.findIndex(option => option.value === value));
      pick(enabled[(index + step + enabled.length) % enabled.length]); buttons().find(button => button.dataset.value === value)?.focus();
    });
    render();
    if (root.ResizeObserver) new root.ResizeObserver(placeThumb).observe(el);
    root.requestAnimationFrame?.(placeThumb);
    return { el, value: () => value, setValue(next) { value = next == null ? '' : String(next); render(); }, setOptions(next) { options = (next || []).map(norm); render(); }, setDisabled(next) { disabled = !!next; render(); }, refresh: placeThumb };
  }

  // ---- Switch ----
  function switchControl(config = {}) {
    let checked = !!config.checked, disabled = !!config.disabled;
    const button = h('button', { type: 'button', class: 'uk-switch', role: 'switch', 'aria-checked': String(checked), 'aria-label': config.label || null, id: config.id || null, ...(disabled ? { disabled: true } : {}) }, h('span', { class: 'uk-switch-knob' }));
    button.addEventListener('click', () => { if (disabled) return; checked = !checked; button.setAttribute('aria-checked', String(checked)); config.onChange?.(checked); });
    return { el: button, checked: () => checked, setChecked(next) { checked = !!next; button.setAttribute('aria-checked', String(checked)); }, setDisabled(next) { disabled = !!next; button.disabled = disabled; } };
  }

  // ---- Badge ----
  function badge(text, { tone = 'neutral', title = '' } = {}) {
    return h('span', { class: 'uk-badge', 'data-tone': tone, title: title || null, text });
  }

  // ---- Card list row ----
  function row({ icon, name, title, sub, badges = [], trailing, selected = false, onClick, as = 'div', className = '' } = {}) {
    const el = h(as, { class: `uk-row${selected ? ' is-selected' : ''} ${className}`.trim(), ...(onClick ? { role: 'button', tabindex: '0' } : {}), ...(selected ? { 'aria-current': 'true' } : {}) },
      iconTile(icon, name || title, 34),
      h('span', { class: 'uk-row-text' }, h('span', { class: 'uk-row-title' }, title, ...badges.map(item => item.nodeType ? item : badge(item.text || item, { tone: item.tone }))), sub ? h('span', { class: 'uk-row-sub', text: sub }) : null),
      trailing || null);
    if (onClick) {
      el.addEventListener('click', onClick);
      el.addEventListener('keydown', event => { if (event.target === el && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onClick(event); } });
    }
    return el;
  }

  // ---- Effort picker: a stepped track with labelled stops; first stop is "model default" ----
  function effortPicker(config = {}) {
    const levels = (config.levels || []).map(norm);
    const stops = [{ value: '', label: config.defaultLabel || t('默认', 'Default') }, ...levels];
    const component = segmented({ options: stops, value: config.value || '', label: config.label || t('推理强度', 'Reasoning effort'), className: 'uk-effort', size: 'sm', stretch: true, onChange: value => config.onChange?.(value) });
    component.el.dataset.steps = String(stops.length);
    return component;
  }

  const api = { h, glyph, iconTile, popover, select, enhanceSelect, enhanceAll, autoEnhance, segmented, switch: switchControl, badge, row, effortPicker, closeAll: () => [...openPopovers].forEach(item => item.close('close')), t };
  const UIKit = api;
  return api;
}));
