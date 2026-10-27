/* "Import from CC Switch" page: opens straight onto the default database (read on click) → or choose a file / paste a link → preview with keys masked to the last four characters → import the ticked rows.
   The only visible mention of the other application is this feature's own name. Keys are never shown; the full values live in the server's one-time import and reach the keychain through the host. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProvidersImportUI = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const english = () => root.WorkstationI18n?.getLanguage?.() === 'en' || /^en(?:-|$)/i.test(root.document?.documentElement?.lang || '');
  const t = (zh, en) => english() ? en : zh;
  const PROTOCOL = { responses: 'Responses', chat: 'Chat', anthropic: 'Anthropic', auto: '—' };
  const REASON = { account: ['请在 AI Bro 里用账号登录添加。', 'Add it in AI Bro by signing in with the account.'], unsupported: ['暂不支持', 'Not supported'], invalid: ['内容无效', 'Invalid'], no_address: ['没有地址', 'No address'], no_usable_key: ['Claude 官方账号不通过 API 密钥使用，无需导入。', 'The official Claude account does not use an API key; nothing to import.'] };
  const NO_KEY = ['配置中没有 API 密钥，导入后请自己补上。', 'No API key in this configuration; add one after importing.'];

  // 预览行 → 界面状态：没有密钥的不可导入；已有同地址供应商的默认不勾选。
  function rowsOf(items, existingBases, apiId) {
    return items.map(item => {
      const id = item.base ? apiId(item.base) : '';
      const exists = !!id && existingBases.has(id);
      const state = item.status === 'ready' ? (exists ? 'exists' : 'new') : item.status === 'no_key' ? (exists ? 'exists' : 'no_key') : 'skipped';
      return { ...item, id, state, checked: state === 'new' };
    });
  }

  function mount(hostEl, options = {}) {
    const doc = hostEl.ownerDocument;
    const state = { step: options.loadDefault ? 'loading' : 'choose', dbPath: '', busy: false, message: '', tone: '', importId: '', rows: [], keysOnly: false, updateKeys: false };
    const el = (tag, props = {}, ...children) => {
      const node = doc.createElement(tag);
      for (const [key, value] of Object.entries(props)) {
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
        else if (value !== false && value != null) node.setAttribute(key, value === true ? '' : value);
      }
      for (const child of children.flat()) if (child) node.append(child);
      return node;
    };
    const say = (message, tone = '') => { state.message = message; state.tone = tone; const node = hostEl.querySelector('#ccStatus'); if (node) { node.textContent = message; if (tone) node.setAttribute('data-tone', tone); else node.removeAttribute('data-tone'); } };
    const back = el('button', { class: 'pa-back', type: 'button', id: 'ccBack', text: t('‹ 返回', '‹ Back'), onclick: () => { void cancel(); options.onClose?.(); } });
    async function cancel() { if (state.importId && options.cancel) { const id = state.importId; state.importId = ''; try { await options.cancel(id); } catch (_) { /* expired anyway */ } } }

    async function preview(send, label = '') {
      if (state.busy) return;
      state.busy = true; say(t('正在解析…', 'Reading…'));
      try {
        const result = await send();
        await cancel();
        state.importId = result.importId; state.dbPath = label || result.path || '';
        state.rows = rowsOf(result.items || [], new Set(options.existing?.() || []), options.apiId);
        state.step = 'preview'; state.busy = false; paint();
      } catch (error) { state.busy = false; if (state.step === 'preview') { say(error && error.message ? error.message : t('无法解析这个文件。', 'Could not read this file.'), 'bad'); } else { state.step = 'choose'; paint(); say(error && error.message ? error.message : t('无法解析这个文件。', 'Could not read this file.'), 'bad'); } }
    }

    // 点击“从 CC Switch 导入”后只读默认位置的数据库；没有就回到手动选择。
    async function loadDefault() {
      state.busy = true;
      try {
        const result = await options.loadDefault();
        state.busy = false;
        if (result && result.found) { state.importId = result.importId; state.dbPath = result.path || ''; state.rows = rowsOf(result.items || [], new Set(options.existing?.() || []), options.apiId); state.step = 'preview'; paint(); return; }
        state.step = 'choose'; state.message = t(`没有在默认位置找到数据库${result && result.path ? '（' + result.path + '）' : ''}，请手动选择。`, `No database at the default location${result && result.path ? ' (' + result.path + ')' : ''}. Please choose it yourself.`); paint();
      } catch (error) { state.busy = false; state.step = 'choose'; state.message = error && error.message ? error.message : t('无法读取默认位置的数据库。', 'Could not read the default database.'); state.tone = 'bad'; paint(); }
    }

    function paintChoose() {
      const file = el('input', { type: 'file', id: 'ccFile', hidden: true, accept: '.db,.sqlite,.sqlite3,.sql,application/octet-stream,application/x-sqlite3,text/plain' });
      file.addEventListener('change', () => { const chosen = file.files && file.files[0]; if (chosen) void preview(() => options.preview({ file: chosen }), chosen.name || ''); file.value = ''; });
      const link = el('input', { type: 'text', id: 'ccLink', autocomplete: 'off', spellcheck: 'false', placeholder: t('粘贴导入链接', 'Paste an import link'), 'aria-label': t('导入链接', 'Import link') });
      const parse = () => { const value = link.value.trim(); if (value) void preview(() => options.preview({ link: value })); };
      link.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); parse(); } });
      hostEl.replaceChildren(back, el('h2', { text: t('从 CC Switch 导入', 'Import from CC Switch') }),
        el('p', { class: 'pv-note', text: t('选择它的数据库文件（cc-switch.db）或导出的 SQL，预览后再批量带过来。只在你点击并选择文件时才读取；AI Bro 不会读取其他应用的目录。', 'Choose its database file (cc-switch.db) or an exported SQL file, preview, then bring the providers over. Nothing is read until you pick a file; AI Bro never reads other applications\' folders.') }),
        el('div', { class: 'pv-detail' },
          el('div', { class: 'pv-actions' }, el('button', { class: 'primary', type: 'button', id: 'ccChoose', text: t('选择文件…', 'Choose file…'), onclick: () => file.click() }), file),
          el('div', { class: 'pv-field' }, el('label', { for: 'ccLink', text: t('或粘贴导入链接', 'Or paste an import link') }), el('div', { class: 'pv-add-model' }, link, el('button', { class: 'secondary', type: 'button', id: 'ccParseLink', text: t('解析链接', 'Read link'), onclick: parse }))),
          el('p', { class: 'pv-note', id: 'ccStatus', role: 'status', 'aria-live': 'polite', text: state.message })));
    }

    function paintLoading() {
      hostEl.replaceChildren(back, el('h2', { text: t('从 CC Switch 导入', 'Import from CC Switch') }), el('p', { class: 'pv-note', id: 'ccStatus', role: 'status', 'aria-live': 'polite', text: t('正在读取…', 'Reading…') }));
    }

    function paintPreview() {
      const rows = state.rows;
      const selected = () => rows.filter(row => row.checked && row.state !== 'skipped');
      const importButton = el('button', { class: 'primary', type: 'button', id: 'ccImport' });
      const refresh = () => { const n = selected().length; importButton.textContent = t(`导入 ${n} 个供应商`, `Import ${n} provider${n === 1 ? '' : 's'}`); if (n === 0 || state.busy) importButton.setAttribute('disabled', ''); else importButton.removeAttribute('disabled'); };
      const file = el('input', { type: 'file', id: 'ccFile', hidden: true, accept: '.db,.sqlite,.sqlite3,.sql,application/octet-stream,application/x-sqlite3,text/plain' });
      file.addEventListener('change', () => { const chosen = file.files && file.files[0]; if (chosen) void preview(() => options.preview({ file: chosen }), chosen.name || ''); file.value = ''; });
      const list = el('div', { class: 'pv-cc-list', id: 'ccList' }, rows.map((row, index) => {
        const usable = row.state !== 'skipped';
        const reason = row.state === 'no_key' ? t(...NO_KEY) : row.state === 'skipped' ? (row.reason && REASON[row.reason] ? t(...REASON[row.reason]) : t('已跳过', 'Skipped')) : '';
        const box = el('input', { type: 'checkbox', 'data-row': String(index), 'aria-label': t(`选择 ${row.name}`, `Select ${row.name}`), ...(row.checked ? { checked: true } : {}), ...(usable ? {} : { disabled: true }) });
        box.addEventListener('change', () => { row.checked = box.checked; refresh(); });
        const title = [row.name, row.notes, row.app].filter(Boolean).join(' · ');
        const detail = usable ? [
          el('div', { class: 'pv-cc-base', text: row.base || row.host || '' }),
          el('div', { class: 'pv-cc-meta', text: [row.hasKey ? t(`API 密钥: ••••${row.keyLast4}`, `API key: ••••${row.keyLast4}`) : t('API 密钥: 无', 'API key: none'), row.models && row.models.length ? t(`${row.models.length} 个模型：`, `${row.models.length} model${row.models.length === 1 ? '' : 's'}: `) + row.models.join(', ') : ''].filter(Boolean).join('    ') })
        ] : [el('div', { class: 'pv-cc-meta', text: reason })];
        if (row.state === 'no_key') detail.push(el('div', { class: 'pv-cc-meta', text: reason }));
        return el('label', { class: 'pv-cc-row' + (usable ? '' : ' pv-dim'), 'data-state': row.state, ...(row.current ? { 'data-current': 'true' } : {}) },
          box, el('div', { class: 'pv-cc-body' },
            el('div', { class: 'pv-cc-title' }, el('span', { class: 'pv-cc-name', text: title }),
              row.current ? el('span', { class: 'pv-chip', 'data-tone': 'accent', text: t('CC Switch 当前使用', 'In use in CC Switch') }) : null,
              !usable ? el('span', { class: 'pv-chip', text: t('不可导入', 'Cannot import') }) : null,
              row.state === 'no_key' ? el('span', { class: 'pv-chip', 'data-tone': 'warn', text: t('需补密钥', 'Key needed') }) : null,
              row.state === 'exists' ? el('span', { class: 'pv-chip', text: t('已存在', 'Exists') }) : null),
            detail));
      }));
      importButton.addEventListener('click', async () => {
        if (state.busy) return;
        const picked = selected();
        if (!picked.length) return;
        state.busy = true; refresh(); say(t('正在导入…', 'Importing…'));
        try {
          const result = await options.commit({ importId: state.importId, selected: picked.map(row => row.index), includeKeys: !state.keysOnly });
          state.importId = '';
          const outcome = await options.apply(result.items || [], { updateKeys: state.updateKeys });
          state.busy = false;
          options.onDone?.(outcome);
        } catch (error) { state.busy = false; refresh(); say(error && error.message ? error.message : t('导入失败。', 'Import failed.'), 'bad'); }
      });
      refresh();
      hostEl.replaceChildren(back, el('h2', { text: t('从 CC Switch 导入', 'Import from CC Switch') }),
        el('p', { class: 'pv-note', text: t('选择要加入 AI Bro 的供应商。导入不会测试连接，也不会切换当前默认模型。', 'Choose the providers to add to AI Bro. Importing does not test the connection or change your default model.') }),
        el('p', { class: 'pv-cc-info', text: t('AI Bro 只读访问 CC Switch 数据库，不会修改其中的配置。API 密钥仅以脱敏形式预览，导入后保存到系统钥匙串。', 'AI Bro opens the CC Switch database read-only and never changes it. Keys are previewed masked and go to the system keychain after import.') }),
        state.dbPath ? el('p', { class: 'pv-note', id: 'ccDbPath', text: t('数据库: ', 'Database: ') + state.dbPath }) : null,
        list,
        el('label', { class: 'pv-check' }, el('input', { type: 'checkbox', id: 'ccAddressOnly', onchange: event => { state.keysOnly = event.target.checked; } }), el('span', { text: ' ' + t('只导入地址，密钥我自己填', 'Import addresses only; I will enter the keys myself') })),
        el('label', { class: 'pv-check' }, el('input', { type: 'checkbox', id: 'ccUpdateKeys', onchange: event => { state.updateKeys = event.target.checked; } }), el('span', { text: ' ' + t('已存在的供应商也更新密钥', 'Also update the key of providers that already exist') })),
        el('div', { class: 'pv-actions pv-cc-footer' }, el('span', { class: 'pv-spacer' }),
          el('button', { class: 'secondary', type: 'button', id: 'ccCancel', text: t('取消', 'Cancel'), onclick: () => { void cancel(); options.onClose?.(); } }),
          el('button', { class: 'secondary', type: 'button', id: 'ccChooseOther', text: t('选择数据库文件', 'Choose database file'), onclick: () => file.click() }), file, importButton),
        el('p', { class: 'pv-note', id: 'ccStatus', role: 'status', 'aria-live': 'polite', text: state.message }));
    }
    function paint() { if (state.step === 'preview') paintPreview(); else if (state.step === 'loading') paintLoading(); else paintChoose(); }
    paint();
    if (state.step === 'loading') void loadDefault();
    return { state: () => ({ step: state.step, rows: state.rows.map(row => ({ ...row, token: undefined })) }), cancel };
  }

  return Object.freeze({ mount, rowsOf });
}));
