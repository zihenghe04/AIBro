/* Add-provider page: preset library (search + categories), custom provider and the one-step form.
   The key lives only in the password input and in the save callback; it is never put in a view model, attribute or storage. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProvidersAddUI = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const Library = () => root.ProviderLibrary || (typeof require === 'function' ? require('./provider-library.js') : null);
  const english = () => root.WorkstationI18n?.getLanguage?.() === 'en' || /^en(?:-|$)/i.test(root.document?.documentElement?.lang || '');
  const t = (zh, en) => english() ? en : zh;
  const PROTOCOL_CHOICES = [['auto', '自动识别', 'Auto-detect'], ['responses', 'Responses', 'Responses'], ['chat', 'Chat Completions', 'Chat Completions'], ['anthropic', 'Anthropic Messages', 'Anthropic Messages']];
  const PROTOCOL_LABEL = { auto: ['自动识别', 'auto-detected'], responses: ['Responses', 'Responses'], chat: ['Chat Completions', 'Chat Completions'], anthropic: ['Anthropic Messages', 'Anthropic Messages'] };
  const CAP_KEYS = [['text', '文', 'Tool use'], ['vision', '视', 'Vision'], ['think', '思', 'Thinking'], ['image', '图', 'Image generation']];

  function mount(hostEl, options = {}) {
    const doc = hostEl.ownerDocument, L = Library();
    const state = { view: 'grid', query: '', category: 'all', presetId: '', form: null, busy: false, message: '', messageTone: '', fetched: [] };
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
    const logo = name => el('span', { class: 'pv-logo', 'aria-hidden': 'true', text: Array.from(name || '?')[0].toUpperCase() });

    // ---- 预设选择 ----
    const gridHost = el('div', { class: 'pa-grid', id: 'providerAddGrid' });
    const rail = el('nav', { class: 'pa-cats', 'aria-label': t('分类', 'Categories') });
    function paintGrid() {
      const rows = L.rows({ query: state.query, category: state.category === 'account' ? '__none' : state.category, english: english() });
      const existingIds = new Set(options.existing?.() || []);
      const tiles = [];
      const top = [];
      if (!state.query) {
        if (options.onImport) top.push(el('button', { class: 'pa-tile pa-wide', type: 'button', id: 'providerAddImport', onclick: () => options.onImport() },
          el('span', { class: 'pv-logo', 'aria-hidden': 'true', text: '⇩' }), el('span', { class: 'pv-text' }, el('b', { text: t('从 CC Switch 导入', 'Import from CC Switch') }), el('small', { text: t('选择它的数据库文件，预览后批量带过来（只在你点击时读取）', 'Pick its database file and preview before importing (read only when you choose a file)') }))));
        top.push(el('button', { class: 'pa-tile pa-wide', type: 'button', id: 'providerAddCustom', onclick: () => openForm('') },
          el('span', { class: 'pv-logo', 'aria-hidden': 'true', text: '⚙' }), el('span', { class: 'pv-text' }, el('b', { text: t('自定义', 'Custom') }), el('small', { text: t('填 API 地址和密钥，其余自动识别', 'Enter the API address and key; the rest is detected') }))));
        for (const extra of options.extraTiles?.() || []) top.push(extra(el));
      }
      tiles.push(...top);
      const accounts = L.ACCOUNTS.filter(account => (state.category === 'all' || state.category === 'account') && (!state.query || `${account.zh} ${account.en}`.toLowerCase().includes(state.query.toLowerCase())));
      if (accounts.length) {
        tiles.push(el('h3', { class: 'pa-section', text: t('账号登录', 'Sign in') }));
        for (const account of accounts) {
          const added = existingIds.has(account.providerId);
          tiles.push(el('button', { class: 'pa-tile', type: 'button', 'data-account': account.id, ...(added ? { disabled: true } : {}), onclick: () => options.onAddAccount?.(account.id) },
            logo(t(account.zh, account.en)), el('span', { class: 'pv-text' }, el('b', { text: t(account.zh, account.en) }), el('small', { text: added ? t('已添加', 'Already added') : t(account.descZh, account.descEn) }))));
        }
      }
      if (state.category !== 'account') {
        const order = [['vendor', t('模型厂商', 'Model makers')], ['platform', t('第三方平台', 'Platforms')], ['cloud', t('云服务商', 'Cloud')], ['local', t('本地', 'Local')]];
        for (const [category, label] of order) {
          const part = rows.filter(row => row.category === category);
          if (!part.length) continue;
          if (state.category === 'all') tiles.push(el('h3', { class: 'pa-section', text: label }));
          for (const row of part) {
            tiles.push(el('button', { class: 'pa-tile', type: 'button', 'data-preset': row.id, onclick: () => openForm(row.id) },
              logo(row.name), el('span', { class: 'pv-text' }, el('b', { text: row.name }), el('small', { text: row.versions.length > 1 ? `${row.host} · ${t(`${row.versions.length} 个版本`, `${row.versions.length} versions`)}` : row.host }))));
          }
        }
      }
      if (!rows.length && !accounts.length) tiles.push(el('p', { class: 'pv-note', text: t('没有匹配的供应商。可以用“自定义”直接填地址和密钥。', 'No provider matches. Use Custom to enter an address and key.') }));
      gridHost.replaceChildren(...tiles);
      const counts = L.counts();
      rail.replaceChildren(...L.CATEGORIES.map(category => el('button', { type: 'button', class: 'pa-cat', 'data-category': category.id, ...(state.category === category.id ? { 'aria-current': 'true' } : {}), onclick: () => { state.category = category.id; paintGrid(); } },
        el('span', { text: t(category.zh, category.en) }), el('span', { class: 'pv-note', text: String(counts[category.id] ?? 0) }))));
    }

    function pageGrid() {
      const search = el('input', { type: 'search', id: 'providerAddSearch', class: 'pa-search', value: state.query, placeholder: t('搜索名称或网址，例如 kimi、智谱、openrouter', 'Search by name or address, e.g. kimi, openrouter'), 'aria-label': t('搜索供应商', 'Search providers') });
      search.addEventListener('input', () => { state.query = search.value; paintGrid(); });
      paintGrid();
      hostEl.replaceChildren(
        el('button', { class: 'pa-back', type: 'button', id: 'providerAddBack', text: t('‹ 返回', '‹ Back'), onclick: () => options.onClose?.() }),
        el('h2', { text: t('添加供应商', 'Add a provider') }), search,
        el('div', { class: 'pa-layout' }, rail, gridHost),
        el('p', { class: 'pv-note', text: t('点一张卡片，只需填密钥：地址、协议和模型清单已带好。', 'Pick a card and enter the key: address, protocol and models are filled in.') }));
      search.focus?.({ preventScroll: true });
    }

    // ---- 表单 ----
    function openForm(presetId) {
      const preset = presetId ? L.get(presetId) : null;
      state.view = 'form'; state.presetId = presetId; state.message = ''; state.messageTone = ''; state.fetched = [];
      state.form = {
        name: preset ? preset.name : '', base: preset ? preset.baseUrl : '', protocol: preset ? preset.protocol : 'auto', makeDefault: false,
        models: preset ? preset.models.map(model => ({ ...model, caps: { ...(model.caps || {}) } })) : [], recognized: ''
      };
      pageForm();
    }

    function recognize(base) {
      const result = L.normalizeAddress(base);
      if (!result.ok) return { ok: false, text: result.reason === 'empty' ? '' : t('这个地址看起来不对：请填 https:// 开头的 API 地址。', 'This address does not look right: use an https:// API address.') };
      const protocol = result.protocol;
      const proto = protocol === 'auto' ? t('协议将自动判断', 'protocol will be detected') : t(`协议 ${PROTOCOL_LABEL[protocol][0]}`, `protocol ${PROTOCOL_LABEL[protocol][1]}`);
      return { ok: true, result, text: `${result.changed ? t(`已整理为 ${result.base}`, `Tidied to ${result.base}`) : t(`地址正常：${result.base}`, `Address looks fine: ${result.base}`)}，${proto}。${result.insecure ? t(' 注意：这是未加密的 http 地址，密钥会明文发送。', ' Warning: plain http sends the key unencrypted.') : ''}` };
    }

    function pageForm() {
      const form = state.form, preset = state.presetId ? L.get(state.presetId) : null;
      const versions = state.presetId ? L.versions(state.presetId, english()) : [];
      const nameInput = el('input', { type: 'text', id: 'providerFormName', maxlength: '80', value: form.name, placeholder: t('例如 我的服务', 'e.g. My service'), 'aria-label': t('名称', 'Name') });
      nameInput.addEventListener('input', () => { form.name = nameInput.value; });
      const baseInput = el('input', { type: 'text', id: 'providerFormBase', value: form.base, placeholder: 'https://api.example.com/v1', autocomplete: 'off', spellcheck: 'false', 'aria-label': t('API 地址', 'API address') });
      const hint = el('p', { class: 'pv-note', id: 'providerFormHint', 'aria-live': 'polite', text: recognize(form.base).text });
      baseInput.addEventListener('input', () => { form.base = baseInput.value; });
      baseInput.addEventListener('change', () => {
        const seen = recognize(baseInput.value);
        if (seen.ok) { baseInput.value = seen.result.base; form.base = seen.result.base; if (form.protocol === 'auto' || !preset) form.protocol = seen.result.protocol === 'auto' && preset ? form.protocol : seen.result.protocol; setSelect(protocolSelect, form.protocol); }
        hint.textContent = seen.text;
        if (seen.ok && !form.name) { form.name = (seen.result.preset ? L.get(seen.result.preset)?.name : '') || (/^[\d.]+$|^localhost$/.test(seen.result.host) ? t('本地服务', 'Local service') : seen.result.host.replace(/^(api|www)\./, '').split('.')[0]); nameInput.value = form.name; }
      });
      const keyInput = el('input', { type: 'password', id: 'providerFormKey', autocomplete: 'off', spellcheck: 'false', placeholder: t('粘贴 API 密钥', 'Paste the API key'), 'aria-label': t('API 密钥', 'API key') });
      const reveal = el('button', { class: 'secondary pv-small', type: 'button', id: 'providerFormReveal', text: t('显示', 'Show'), onclick: () => { const shown = keyInput.type === 'text'; keyInput.type = shown ? 'password' : 'text'; reveal.textContent = shown ? t('显示', 'Show') : t('隐藏', 'Hide'); } });
      const protocolSelect = el('select', { id: 'providerFormProtocol', 'aria-label': t('协议', 'Protocol'), onchange: event => { form.protocol = event.target.value; } }, PROTOCOL_CHOICES.map(([value, zh, en]) => el('option', { value, text: t(zh, en), ...(value === form.protocol ? { selected: true } : {}) })));
      const status = el('p', { class: 'pv-note', id: 'providerFormStatus', role: 'status', 'aria-live': 'polite', ...(state.messageTone ? { 'data-tone': state.messageTone } : {}), text: state.message });
      const modelBox = el('div', { class: 'pv-models', id: 'providerFormModels' });
      const datalist = el('datalist', { id: 'providerFormModelOptions' }, state.fetched.map(id => el('option', { value: id })));
      const addInput = el('input', { type: 'text', id: 'providerFormAddModel', maxlength: '200', list: 'providerFormModelOptions', placeholder: t('模型名，例如 model-name', 'Model name'), 'aria-label': t('添加模型', 'Add a model') });
      function paintModels() {
        modelBox.replaceChildren(...(form.models.length ? form.models.map((model, index) => el('div', { class: 'pv-model', 'data-model': model.model },
          el('span', { class: 'pv-tag', ...(index === 0 ? { 'data-primary': '1' } : {}), text: index === 0 ? t('主模型', 'Primary') : t(`备用 ${index}`, `Fallback ${index}`) }),
          el('b', { text: model.model }),
          capButtons(model.caps, (key, on) => { model.caps[key] = on; paintModels(); }),
          el('span', { class: 'pv-actions' },
            el('button', { class: 'secondary pv-small', type: 'button', 'aria-label': t('上移', 'Move up'), ...(index === 0 ? { disabled: true } : {}), text: '↑', onclick: () => { form.models.splice(index - 1, 0, form.models.splice(index, 1)[0]); paintModels(); } }),
            el('button', { class: 'secondary pv-small', type: 'button', 'aria-label': t('下移', 'Move down'), ...(index === form.models.length - 1 ? { disabled: true } : {}), text: '↓', onclick: () => { form.models.splice(index + 1, 0, form.models.splice(index, 1)[0]); paintModels(); } }),
            el('button', { class: 'secondary pv-small', type: 'button', 'aria-label': t('移除', 'Remove'), text: '✕', onclick: () => { form.models.splice(index, 1); paintModels(); } })))) : [el('span', { class: 'pv-note', text: t('还没有模型：保存后可点“获取模型列表”，或在下面手动添加。', 'No models yet: fetch the list after saving, or add one below.') })]));
      }
      const addModel = () => { const name = addInput.value.trim(); if (name && !form.models.some(model => model.model === name)) { form.models.push({ model: name, label: name, caps: { text: true } }); addInput.value = ''; paintModels(); } };
      addInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addModel(); } });
      paintModels();
      const save = el('button', { class: 'primary', type: 'button', id: 'providerFormSave', text: t('保存并测试连接', 'Save and test connection') });
      const setStatus = (message, tone = '') => { state.message = message; state.messageTone = tone; status.textContent = message; if (tone) status.setAttribute('data-tone', tone); else status.removeAttribute('data-tone'); };
      save.addEventListener('click', async () => {
        if (state.busy) return;
        const seen = recognize(baseInput.value);
        if (!seen.ok) { setStatus(seen.text || t('请填写 API 地址。', 'Enter the API address.'), 'bad'); baseInput.focus?.(); return; }
        const token = keyInput.value.trim();
        if (!token && !(preset && preset.category === 'local')) { setStatus(t('请填写 API 密钥。', 'Enter the API key.'), 'bad'); keyInput.focus?.(); return; }
        state.busy = true; save.disabled = true; setStatus(t('正在保存并读取模型列表…', 'Saving and reading the model list…'));
        try {
          const outcome = await options.onSave({ presetId: state.presetId, name: form.name.trim() || seen.result.host, base: seen.result.base, protocol: form.protocol === 'auto' ? seen.result.protocol : form.protocol, token, models: form.models.map(model => ({ ...model })), makeDefault: form.makeDefault });
          keyInput.value = '';
          state.busy = false;
          if (outcome && outcome.error) { save.disabled = false; setStatus(outcome.error, 'bad'); return; }
          options.onDone?.(outcome);
        } catch (error) { state.busy = false; save.disabled = false; setStatus(error && error.message ? error.message : t('保存失败。', 'Saving failed.'), 'bad'); }
      });
      hostEl.replaceChildren(
        el('button', { class: 'pa-back', type: 'button', id: 'providerFormBack', text: t('‹ 返回', '‹ Back'), onclick: () => { state.view = 'grid'; pageGrid(); } }),
        el('h2', { text: preset ? t(`添加 ${preset.familyName || preset.name}`, `Add ${preset.familyName || preset.name}`) : t('自定义供应商', 'Custom provider') }),
        versions.length > 1 ? el('div', { class: 'pa-versions', role: 'group', 'aria-label': t('版本', 'Version') }, versions.map(version => el('button', { type: 'button', class: 'secondary pv-small', 'data-version': version.id, ...(version.id === state.presetId ? { 'aria-pressed': 'true' } : {}), text: version.label, onclick: () => openForm(version.id) }))) : '',
        el('div', { class: 'pv-detail' },
          el('div', { class: 'pv-field' }, el('label', { for: 'providerFormBase', text: t('API 地址', 'API address') }), baseInput, hint),
          el('div', { class: 'pv-field' }, el('label', { for: 'providerFormKey', text: t('API 密钥', 'API key') }), el('div', { class: 'pv-add-model' }, keyInput, reveal),
            el('span', { class: 'pv-note', text: t('密钥只保存在系统钥匙串里。', 'The key is stored only in the system keychain.') }),
            preset && preset.apiKeyUrl ? el('span', { class: 'pv-note', text: t(`获取密钥：${preset.apiKeyUrl}`, `Get a key: ${preset.apiKeyUrl}`) }) : null),
          el('div', { class: 'pv-field' }, el('label', { for: 'providerFormName', text: t('名称', 'Name') }), nameInput),
          el('details', { class: 'pv-more' }, el('summary', { text: t('高级：协议', 'Advanced: protocol') }), el('div', { class: 'pv-field' }, protocolSelect, el('span', { class: 'pv-note', text: t('一般不用改：地址里能看出来时会自动识别。', 'Usually not needed: it is detected from the address when possible.') }))),
          el('div', { class: 'pv-field' }, el('label', { text: t('模型（主模型 + 备用，顺序即优先级）', 'Models (primary + fallbacks, in priority order)') }), modelBox,
            el('div', { class: 'pv-add-model' }, addInput, datalist, el('button', { class: 'secondary', type: 'button', id: 'providerFormAddModelButton', text: t('添加模型', 'Add model'), onclick: addModel }))),
          el('label', { class: 'pv-check' }, el('input', { type: 'checkbox', id: 'providerFormDefault', onchange: event => { form.makeDefault = event.target.checked; } }), el('span', { text: ' ' + t('保存后设为默认模型', 'Make it the default model after saving') })),
          el('div', { class: 'pv-actions' }, save, el('span', { class: 'pv-note', text: t('测试只查询模型列表，不发对话请求。', 'The test only asks for the model list; no chat request is sent.') })), status));
      (state.presetId ? keyInput : baseInput).focus?.({ preventScroll: true });
    }

    // 真实浏览器要设属性 value，测试用的 DOM 只认 selected 特性：两边都设。
    function setSelect(select, value) {
      for (const option of [...select.options]) { if (option.value === value) option.setAttribute('selected', ''); else option.removeAttribute('selected'); }
      try { select.value = value; } catch (_) { /* attribute already updated */ }
    }

    function capButtons(caps, onToggle) {
      return el('span', { class: 'pv-caps', role: 'group', 'aria-label': t('能力', 'Capabilities') }, CAP_KEYS.map(([key, zh, en]) => {
        const on = caps && caps[key] === true;
        return el('button', { type: 'button', class: 'pv-cap', 'data-cap': key, 'aria-pressed': on ? 'true' : 'false', title: t(`${zh}：${on ? '已标记' : '未标记'}`, `${en}: ${on ? 'on' : 'off'}`), text: zh, onclick: () => onToggle(key, !on) });
      }));
    }

    pageGrid();
    return { openForm, showGrid() { state.view = 'grid'; pageGrid(); }, setFetched(ids) { state.fetched = ids; }, state: () => ({ view: state.view, presetId: state.presetId, query: state.query, category: state.category }) };
  }

  return Object.freeze({ mount, CAP_KEYS });
}));
