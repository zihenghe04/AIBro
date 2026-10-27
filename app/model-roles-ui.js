/* Settings → Models → Embedding / Speech-to-text panes. Same layout as the chat page: what is in use now, a switch,
   a test button, a status line.
   Embedding: the existing semantic-search card (#embeddingSettings, owned by vector-knowledge-ui.js) is moved in here and
   fronted by a provider picker. Speech: the native shell owns the schemes and keys; this page reads their public state through
   workstationDesktop.speech and asks the shell to switch, test or open its editor. No key ever reaches this file. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ModelRolesUI = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const Roles = () => root.ModelRoles || (typeof require === 'function' ? require('./model-roles.js') : null);
  const Providers = () => root.Providers || (typeof require === 'function' ? require('./providers.js') : null);
  const english = () => root.WorkstationI18n?.getLanguage?.() === 'en' || /^en(?:-|$)/i.test(root.document?.documentElement?.lang || '');
  const t = (zh, en) => english() ? en : zh;
  const POLL_MS = 700, POLL_MAX = 60;

  function create(options = {}) {
    const doc = () => root.document;
    const settings = () => options.getSettings?.();
    const speechBridge = () => options.speech || root.workstationDesktop?.speech || null;
    const vector = () => options.vector || root.VectorKnowledge || null;
    const kit = () => root.UIKit || null;
    const el = (tag, props = {}, ...children) => {
      const node = doc().createElement(tag);
      for (const [key, value] of Object.entries(props)) {
        if (value == null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value === true ? '' : String(value));
      }
      for (const child of children.flat()) if (child != null && child !== false) node.append(child.nodeType ? child : doc().createTextNode(String(child)));
      return node;
    };
    const state = { embedding: null, speech: null, speechRaw: null, pollTimer: 0, polls: 0, attached: '', busy: false, note: { embedding: '', cloud: '', realtime: '', general: '' }, speechLoaded: false, awaiting: null, edit: null, sel: '', root };

    // ---------- shared pieces ----------
    const summaryRow = info => {
      const badge = kit() ? kit().badge(info.badge, { tone: info.tone }) : el('span', { class: 'uk-badge', 'data-tone': info.tone, text: info.badge });
      if (kit()) return kit().row({ name: info.title, title: info.title, sub: info.sub, badges: [badge], className: 'mr-now' });
      return el('div', { class: 'mr-now' }, el('strong', { text: info.title }), el('span', { class: 'pv-note', text: info.sub }), badge);
    };
    const field = (label, control, id) => el('div', { class: 'mr-field' }, el('label', { class: 'mr-label', ...(id ? { for: id } : {}), text: label }), control);
    const section = (title, help, ...children) => el('section', { class: 'mr-section' }, el('h3', { text: title }), help ? el('p', { class: 'pv-note', text: help }) : null, ...children);
    const persist = () => Promise.resolve(options.onChange?.({ defaultChanged: false }));

    // ---------- embedding ----------
    function providersNow() { try { return Roles().embeddingProviders(settings()); } catch (_) { return []; } }
    function formBase() { return doc().getElementById('embeddingBase')?.value || ''; }
    function embeddingStatus() { try { return vector()?.status?.() || null; } catch (_) { return null; } }

    // Mirrors the engine's saved config into settings.roles.embedding. The engine stays the source of truth (localStorage keeps
    // the old key), so a downgrade or a missing role loses nothing.
    function syncEmbeddingRole() {
      const s = settings(); if (!s || !Providers()) return false;
      const status = embeddingStatus(); if (!status) return false;
      const role = Roles().embeddingRole(status.config, providersNow());
      const changed = Providers().setPurposeRole(s, 'embedding', role);
      if (changed) void persist();
      return changed;
    }
    const listRow = (info, selected, onClick) => kit()
      ? kit().row({ name: info.title, title: info.title, sub: info.sub, badges: info.badge ? [kit().badge(info.badge, { tone: info.tone || 'neutral' })] : [], selected, onClick, className: 'mr-item' })
      : el('button', { type: 'button', class: 'secondary mr-item', onclick: onClick, text: `${info.title} · ${info.sub || ''}` });
    const split = (head, rows, extra, detail) => el('div', { class: 'mr-split' },
      el('aside', { class: 'mr-list' }, el('div', { class: 'mr-list-head' }, el('strong', { text: head[0] }), el('span', { class: 'pv-note', text: head[1] })), el('div', { class: 'mr-rows' }, rows), extra),
      el('div', { class: 'mr-detail' }, detail));
    // ----- detail header and structured card -----
    const headerRow = (info, name, host, badges) => el('div', { class: 'mr-head' },
      kit() ? kit().iconTile('', name, 40) : el('span', { class: 'pv-logo', text: Array.from(name || '?')[0].toUpperCase() }),
      el('div', { class: 'mr-head-text' }, el('div', { class: 'mr-head-title' }, el('strong', { text: name }), ...badges),
        el('span', { class: 'pv-note', text: info.configured ? `${info.title}${host ? ' · ' + host : ''}` : [info.title, info.sub].filter(Boolean).join(t('；', '; ')) })));
    const badge = (text, tone) => kit() ? kit().badge(text, { tone }) : el('span', { class: 'uk-badge', 'data-tone': tone, text });
    function statusBadges(status, info) {
      const out = [badge(info.badge, info.tone)];
      out.push(status?.config?.enabled ? badge(t('混合检索', 'Hybrid search'), 'success') : badge(t('关键词检索', 'Keyword search'), 'neutral'));
      return out;
    }
    const $ = id => doc().getElementById(id);
    // Switches mirror the original checkboxes (still the source of truth for vector-knowledge-ui.js).
    function syncEmbeddingControls() {
      const pane = state.embedding; if (!pane || !pane.switches) return;
      for (const [id, control] of Object.entries(pane.switches)) {
        const box = $(id); if (!box) continue;
        control.setChecked(box.checked); control.setDisabled(box.disabled);
      }
      const key = $('embeddingKey'), none = $('embeddingNoKey');
      if (key && none) key.closest('.mr-field')?.toggleAttribute('hidden', none.checked);
    }
    function structureCard(card, pane) {
      if (card.dataset.mrStructured === '1') return;
      if (!['embeddingBase', 'embeddingModel', 'embeddingKey', 'embeddingNoKey', 'embeddingEnabled', 'embeddingAuto', 'embeddingDimensions', 'embeddingSave', 'embeddingTest', 'embeddingUpdate', 'embeddingStop'].every(id => $(id))) return;
      card.dataset.mrStructured = '1';
      const bin = el('div', { class: 'mr-bin', hidden: true });
      const take = id => $(id), labelOf = id => card.querySelector(`label[for="${id}"]`);
      const field = (id, labelText, help) => {
        const input = take(id), label = labelOf(id);
        if (label && labelText) label.textContent = labelText;
        return el('div', { class: 'mr-field' }, label, input, help ? el('p', { class: 'pv-note', text: help }) : null);
      };
      const switchRow = (id, title, help) => {
        const box = take(id); bin.append(box.closest('label') || box);
        const control = kit()
          ? kit().switch({ id: `${id}Switch`, label: title, checked: box.checked, onChange: on => { box.checked = on; box.dispatchEvent(new root.Event('input', { bubbles: true })); box.dispatchEvent(new root.Event('change', { bubbles: true })); } })
          : { el: el('input', { type: 'checkbox', onchange: event => { box.checked = event.target.checked; box.dispatchEvent(new root.Event('input', { bubbles: true })); } }), setChecked(v) { this.el.checked = v; }, setDisabled(v) { this.el.disabled = v; } };
        pane.switches = pane.switches || {}; pane.switches[id] = control;
        return el('div', { class: 'mr-switchrow' }, el('div', {}, el('strong', { text: title }), help ? el('p', { class: 'pv-note', text: help }) : null), control.el);
      };
      const group = (title, ...children) => el('section', { class: 'mr-card' }, el('h3', { text: title }), ...children);
      // connection
      const keyField = field('embeddingKey', t('API Key', 'API key'));
      const reveal = el('button', { type: 'button', class: 'secondary mr-reveal', text: t('显示', 'Show'), onclick: () => { const input = take('embeddingKey'); const show = input.type === 'password'; input.type = show ? 'text' : 'password'; reveal.textContent = show ? t('隐藏', 'Hide') : t('显示', 'Show'); } });
      keyField.append(reveal);
      const modelField = field('embeddingModel', t('模型名称', 'Model name'));
      const chips = el('div', { class: 'mr-chips', id: 'rolesEmbeddingChips' }); modelField.append(chips); pane.chips = chips;
      const connection = group(t('连接', 'Connection'), field('embeddingBase', t('API 地址', 'API address'), t('填服务商的基础地址或完整的 /embeddings 地址。', 'The provider base URL or a full /embeddings URL.')), modelField, keyField,
        switchRow('embeddingNoKey', t('此服务无需 Key', 'No key needed'), t('例如本机运行的服务。', 'For example a service running on this Mac.')),
);
      const keyHelp = take('embeddingKeyHelp'); if (keyHelp) connection.append(keyHelp);
      const readiness = take('embeddingReadiness'); readiness?.classList.add('mr-readiness');
      const retrieval = group(t('检索', 'Search'), switchRow('embeddingEnabled', t('混合检索（关键词 + 向量）', 'Hybrid search (keyword + vector)'), t('关闭时只用关键词检索。', 'When off, only keyword search is used.')),
        switchRow('embeddingAuto', t('资料保存后自动增量更新', 'Update automatically after saving'), t('只处理有变化的资料。', 'Only changed material is processed.')), readiness);
      const dims = field('embeddingDimensions', t('向量维度（留空使用模型默认值）', 'Vector dimensions (empty = model default)'));
      const profilesHost = take('embeddingProfiles');
      const privacy = [...card.querySelectorAll('p.setting-help')].find(node => node.id !== 'embeddingKeyHelp' && node.id !== 'embeddingStatus');
      const advanced = el('details', { class: 'mr-card mr-advanced', id: 'rolesEmbeddingAdvanced' }, el('summary', { text: t('高级', 'Advanced') }), dims,
        profilesHost ? el('div', { class: 'mr-field' }, el('span', { class: 'mr-label', text: t('已存方案', 'Saved schemes') }), profilesHost) : null, privacy || null,
        take('embeddingClearKey') || null);
      // actions
      const save = take('embeddingSave'), test = take('embeddingTest'), update = take('embeddingUpdate'), stop = take('embeddingStop');
      save?.classList.replace('secondary', 'primary');
      const actions = el('div', { class: 'mr-actions mr-card-actions' }, save, test, take('embeddingUnlockHost') || null, update, stop);
      const feedback = el('div', { class: 'mr-feedback' }, take('embeddingProgress'), take('embeddingCounts'), take('embeddingStatus'));
      const keep = new Set([connection, retrieval, advanced, actions, feedback]);
      card.replaceChildren(connection, retrieval, advanced, actions, feedback, bin);
      // drop leftovers (old title, intro, empty action rows) without touching moved nodes
      void keep;
    }
    function paintChips() {
      const pane = state.embedding; if (!pane || !pane.chips) return;
      const matched = Roles().matchProvider(formBase(), providersNow());
      const model = $('embeddingModel');
      pane.chips.replaceChildren(...(matched ? matched.models : []).map(name => el('button', { type: 'button', class: `mr-chip${model && model.value === name ? ' is-on' : ''}`, text: name, onclick: () => { if (model) { model.value = name; model.dispatchEvent(new root.Event('input', { bubbles: true })); paintChips(); } } })));
    }
    function paintEmbedding() {
      const pane = state.embedding; if (!pane) return;
      const status = embeddingStatus(), list = providersNow();
      const info = Roles().describeEmbedding(status?.config || null, list, { credentialState: status?.credentialState, failed: status?.failed });
      const shown = Roles().matchProvider(formBase(), list);
      pane.summary.replaceChildren(headerRow(info, shown ? shown.name : t('自定义地址', 'Custom address'), shown ? shown.host : '', statusBadges(status, info)));
      syncEmbeddingControls();
      const matched = Roles().matchProvider(formBase(), list);
      const inUse = Roles().matchProvider(status?.config?.base || '', list);
      pane.rows.replaceChildren(
        ...list.map(item => listRow({ title: item.name, sub: item.host, badge: inUse && inUse.id === item.id && status?.config?.enabled ? t('使用中', 'In use') : '', tone: 'success' }, !!matched && matched.id === item.id, () => pickEmbeddingProvider(item.id))),
        listRow({ title: t('自定义地址', 'Custom address'), sub: t('手动填写地址和模型', 'Type the address and model'), badge: !inUse && status?.config?.enabled ? t('使用中', 'In use') : '', tone: 'success' }, !matched, () => pickEmbeddingProvider('')));
      pane.note.textContent = state.note.embedding || '';
      paintChips();
      pane.datalist.replaceChildren(...(matched ? matched.models : []).map(name => el('option', { value: name })));
    }
    function pickEmbeddingProvider(id) {
      const list = providersNow(), item = list.find(entry => entry.id === id);
      if (!item) { const base = doc().getElementById('embeddingBase'); if (base && matched0(base.value)) { base.value = ''; base.dispatchEvent(new root.Event('input', { bubbles: true })); } state.note.embedding = t('自定义：直接在右边填写地址和模型。', 'Custom: type the address and model on the right.'); paintEmbedding(); return; }
      const base = doc().getElementById('embeddingBase'), model = doc().getElementById('embeddingModel');
      const fill = (node, value) => { if (!node || node.value === value) return; node.value = value; node.dispatchEvent(new root.Event('input', { bubbles: true })); };
      fill(base, item.base);
      if (model && (!model.value || !item.models.includes(model.value)) && item.models.length) fill(model, item.models[0]);
      state.note.embedding = item.models.length
        ? t(`已填入 ${item.name} 的地址。嵌入服务的 Key 与对话 Key 分开保存；确认后点“保存 embedding 配置”。`, `Filled in the address of ${item.name}. The embedding key is stored separately from chat keys; press “Save embedding settings” to apply.`)
        : t(`已填入 ${item.name} 的地址。请填写它提供的嵌入模型名，再保存。`, `Filled in the address of ${item.name}. Enter the embedding model it offers, then save.`);
      paintEmbedding();
    }
    const matched0 = value => !!Roles().matchProvider(value, providersNow());
    function buildEmbedding() {
      const summary = el('div', { class: 'mr-summary', id: 'rolesEmbeddingNow', role: 'status', 'aria-live': 'polite' });
      const note = el('p', { class: 'pv-note', id: 'rolesEmbeddingNote', role: 'status', 'aria-live': 'polite' });
      const datalist = el('datalist', { id: 'embeddingModelList' });
      const rows = el('div', { class: 'mr-rows-inner', id: 'rolesEmbeddingProvider' });
      const detailBox = el('div', { class: 'mr-detail-box', id: 'rolesEmbeddingDetail' }, summary, note, datalist);
      const host = el('div', { class: 'mr-pane', id: 'rolesEmbedding', 'data-role': 'embedding' },
        el('p', { class: 'muted', text: t('知识库的语义检索用它：把资料变成向量，在本机搜索。没配置时自动用关键词检索。', 'Semantic search over your library uses it: text becomes vectors searched on this Mac. Without it, keyword search is used.') }),
        split([t('嵌入服务', 'Embedding services'), t('选一个服务商，右边补全模型和 Key', 'Pick a provider, finish the model and key on the right')], rows, null, detailBox));
      state.embedding = { host, summary, note, datalist, rows, detailBox };
      return state.embedding;
    }
    function refreshProviderOptions() { paintEmbedding(); }
    function mountEmbedding(host) {
      const pane = state.embedding || buildEmbedding();
      const card = doc().getElementById('embeddingSettings');
      host.replaceChildren(pane.host);
      if (!card) {
        pane.detailBox.append(el('p', { class: 'pv-note', id: 'rolesEmbeddingMissing', text: t('语义检索组件还没有加载，请稍后再打开这一页。', 'The semantic search component has not loaded yet; reopen this page in a moment.') }));
        paintEmbedding(); return;
      }
      pane.detailBox.querySelector('#rolesEmbeddingMissing')?.remove();
      card.classList.add('mr-embed-card');
      structureCard(card, pane);
      pane.detailBox.append(card);
      const model = doc().getElementById('embeddingModel'); model?.setAttribute('list', 'embeddingModelList');
      refreshProviderOptions(); paintEmbedding();
    }

    // ---------- speech ----------
    const userGesture = () => { try { const activation = root.navigator?.userActivation; return !activation || activation.isActive !== false; } catch (_) { return true; } };
    async function loadSpeech() {
      const bridge = speechBridge();
      if (!bridge || typeof bridge.state !== 'function') { state.speechRaw = null; state.speech = Roles().normalizeSpeech(null); state.speechLoaded = true; return state.speech; }
      let reply = null;
      try { reply = await bridge.state(); } catch (_) { reply = null; }
      state.speechRaw = reply; state.speech = Roles().normalizeSpeech(reply); state.speechLoaded = true;
      // Cache a public summary next to the other roles (no scheme secrets exist on this side).
      const s = settings();
      if (s && Providers() && state.speech.available) { if (Providers().setPurposeRole(s, 'transcription', Roles().transcriptionRole(state.speech))) void persist(); }
      return state.speech;
    }
    function stopPolling() { if (state.pollTimer) { root.clearTimeout(state.pollTimer); state.pollTimer = 0; } state.polls = 0; }
    function schedulePolling() {
      stopPolling();
      const tick = async () => {
        state.pollTimer = 0;
        if (state.attached !== 'transcription') return;
        await loadSpeech();
        settleAwaiting(); paintSpeech();
        const sp = state.speech;
        const working = sp && (sp.cloud.busy || sp.cloud.testing || sp.realtime.busy || sp.realtime.testing || state.awaiting);
        if (working && ++state.polls < POLL_MAX) state.pollTimer = root.setTimeout(tick, POLL_MS);
        else state.polls = 0;
      };
      state.pollTimer = root.setTimeout(tick, POLL_MS);
    }
    // A save/delete runs asynchronously in the native shell; its outcome arrives as `result` (with a rising `seq`) in the next state.
    function settleAwaiting() {
      const wait = state.awaiting, sp = state.speech; if (!wait || !sp || !sp.result) return;
      if (sp.result.seq <= wait.seq) return;
      state.awaiting = null;
      if (sp.result.ok) { state.note[wait.noteKey] = ''; if (wait.onOk) wait.onOk(sp.result); }
      else state.note[wait.noteKey] = sp.result.message || t('没有完成，请检查输入后重试。', 'That did not complete; check the input and try again.');
    }
    // Bridge call. Writes need a live user gesture (the bridge enforces it too); the Key travels once, in the draft, and is never kept here.
    async function call(name, noteKey, ...args) {
      const bridge = speechBridge();
      if (!bridge || typeof bridge[name] !== 'function') return null;
      if (!userGesture()) return null;
      let reply;
      try { reply = await bridge[name](...args); } catch (error) { reply = { status: 'error', reason: error && error.message ? error.message : 'error' }; }
      if (reply && reply.status === 'error') { state.note[noteKey] = reasonText(reply.reason); state.awaiting = null; }
      else state.note[noteKey] = '';
      await loadSpeech(); paintSpeech(); schedulePolling();
      return reply;
    }
    function reasonText(reason) {
      const map = { settings_not_visible: t('请在设置页里操作。', 'Use this from the Settings page.'), busy: t('正在忙，稍后再试。', 'Busy; try again shortly.'), recording: t('正在录音，结束后再改。', 'A recording is in progress; change this after it ends.'),
        not_configured: t('还没有可用的方案，请先添加一个。', 'No scheme yet; add one first.'), unavailable: t('原生壳暂时不可用。', 'The app shell is unavailable right now.'), invalid_request: t('请求无效。', 'Invalid request.'),
        invalid_config: t('设置无效，请检查地址、模型和语言。', 'The settings are not valid; check the address, model and language.'), key_required: t('缺少 Key：请填写此服务的 Key。', 'Key missing: enter the Key for this service.'),
        user_gesture_required: t('请直接点击按钮操作。', 'Please click the button yourself.') };
      return map[reason] || t('操作没有完成。', 'That did not complete.');
    }
    const button = (id, text, onclick, { primary = false, disabled = false, danger = false } = {}) => el('button', { type: 'button', class: primary ? 'primary' : (danger ? 'secondary danger' : 'secondary'), id, text, onclick, ...(disabled ? { disabled: true } : {}) });
    const input = (id, value, { type = 'text', placeholder = '', onInput } = {}) => {
      const node = el('input', { id, type, value: value == null ? '' : String(value), placeholder, autocomplete: 'off', spellcheck: 'false' });
      node.addEventListener('input', () => onInput && onInput(node.value));
      return node;
    };
    const selectBox = (id, options, value, onChange) => {
      const node = el('select', { id }, options.map(([val, label]) => { const o = el('option', { value: val, text: label }); if (val === value) o.setAttribute('selected', ''); return o; }));
      node.addEventListener('change', () => onChange(node.value));
      return node;
    };
    const switchRow = (id, label, checked, onChange, help) => el('div', { class: 'mr-switchrow' }, el('div', {}, el('strong', { text: label }), help ? el('p', { class: 'pv-note', text: help }) : null),
      kit() ? kit().switch({ id, label, checked, onChange }).el : el('input', { type: 'checkbox', id, ...(checked ? { checked: true } : {}), onchange: event => onChange(event.target.checked) }));
    const LANGS = () => [['', t('自动识别', 'Auto detect')], ['zh', t('中文', 'Chinese')], ['en', t('英文', 'English')], ['yue', t('粤语', 'Cantonese')], ['ja', t('日语', 'Japanese')], ['ko', t('韩语', 'Korean')], ['de', t('德语', 'German')], ['fr', t('法语', 'French')], ['es', t('西班牙语', 'Spanish')]];
    const providerName = provider => { const pair = Roles().providerLabels[provider]; return pair ? t(pair[0], pair[1]) : provider; };

    function buildSpeech() {
      const host = el('div', { class: 'mr-pane', id: 'rolesSpeech', 'data-role': 'transcription' });
      state.speechPane = { host };
      return state.speechPane;
    }
    // ----- editing: the draft lives only in this page; the Key field is write-only -----
    function newCloudDraft() { const d = Roles().cloudDefaults('selfHosted'); return { kind: 'cloud', id: '', name: t('自部署服务', 'Self-hosted service'), provider: 'selfHosted', baseURL: d.baseURL, model: d.model, language: '', timeoutSeconds: 180, key: '', touched: {} }; }
    function cloudDraftOf(item) { return { kind: 'cloud', id: item.id, name: item.name, provider: item.provider, baseURL: item.baseURL, model: item.model, language: item.language, timeoutSeconds: item.timeoutSeconds || 180, key: '', touched: { baseURL: true, model: true } }; }
    function newRealtimeDraft(sp) {
      const reusable = Roles().reusableCloud(sp);
      return { kind: 'realtime', id: '', name: t('实时转写', 'Live transcription'), provider: reusable.length ? 'selfHosted' : 'bailian', region: 'beijing', workspaceID: '', serverURL: '', language: reusable.length ? '' : 'zh', enabled: true, key: '', reuseCloudID: reusable.length ? reusable[0].id : '' };
    }
    function realtimeDraftOf(item) { return { kind: 'realtime', id: item.id, name: item.name, provider: item.provider || 'bailian', region: item.region || 'beijing', workspaceID: item.workspaceID, serverURL: item.serverURL, language: item.language, enabled: item.enabled, key: '', reuseCloudID: '' }; }
    const cloudPayload = d => ({ ...(d.id ? { id: d.id } : {}), name: d.name.trim(), provider: d.provider, baseURL: d.baseURL.trim(), model: d.model.trim(), language: d.language.trim(), ...(d.provider === 'selfHosted' ? { timeoutSeconds: Number(d.timeoutSeconds) || 0 } : {}), ...(d.key.trim() ? { key: d.key.trim() } : {}) });
    const realtimePayload = d => ({ ...(d.id ? { id: d.id } : {}), name: d.name.trim(), provider: d.provider, language: d.language, enabled: d.enabled,
      ...(d.provider === 'bailian' ? { region: d.region, ...(d.workspaceID.trim() ? { workspaceID: d.workspaceID.trim() } : {}) } : {}),
      ...(d.provider === 'selfHosted' ? (d.reuseCloudID ? { reuseCloudID: d.reuseCloudID, serverURL: '' } : { serverURL: d.serverURL.trim() }) : {}), ...(d.key.trim() && !d.reuseCloudID ? { key: d.key.trim() } : {}) });
    function afterSave(kind, noteKey) {
      return result => { state.edit = null; state.sel = (kind === 'cloud' ? 'cloud:' : 'rt:') + result.id; state.note[noteKey] = t('已保存。', 'Saved.'); };
    }
    function editorForm(sp) {
      const d = state.edit, isCloud = d.kind === 'cloud';
      const existing = isCloud ? sp.cloud.schemes.find(item => item.id === d.id) : sp.realtime.profiles.find(item => item.id === d.id);
      const problem = isCloud ? Roles().cloudProblem(d, existing) : Roles().realtimeProblem(d, existing, sp);
      const noteKey = isCloud ? 'cloud' : 'realtime';
      const repaint = () => paintSpeech();
      const keyField = (hide = false) => hide ? null : field(t('API Key', 'API Key'), input(isCloud ? 'rolesCloudKey' : 'rolesRealtimeKey', d.key, { type: 'password', placeholder: existing && existing.keySaved ? t('已保存，留空保留', 'Saved; leave blank to keep') : t('请填写此服务的 Key', 'Enter this service\'s Key'), onInput: v => { d.key = v; refreshActions(); } }), isCloud ? 'rolesCloudKey' : 'rolesRealtimeKey');
      const fields = [];
      fields.push(field(t('名称', 'Name'), input(isCloud ? 'rolesCloudName' : 'rolesRealtimeName', d.name, { onInput: v => { d.name = v; refreshActions(); } })));
      if (isCloud) {
        fields.push(field(t('协议', 'Protocol'), selectBox('rolesCloudProvider', Roles().CLOUD_PROVIDERS.map(p => [p, providerName(p)]), d.provider, next => {
          const old = Roles().cloudDefaults(d.provider), fresh = Roles().cloudDefaults(next);
          if (!d.baseURL || d.baseURL === old.baseURL) d.baseURL = fresh.baseURL; if (!d.model || d.model === old.model) d.model = fresh.model; d.provider = next; repaint(); })));
        fields.push(field(t('服务地址', 'Server address'), input('rolesCloudBase', d.baseURL, { placeholder: d.provider === 'selfHosted' ? 'http://<server>:8000/v1' : 'https://…', onInput: v => { d.baseURL = v; refreshActions(); } })));
        fields.push(field(t('模型', 'Model'), input('rolesCloudModel', d.model, { placeholder: Roles().cloudDefaults(d.provider).model, onInput: v => { d.model = v; refreshActions(); } })));
        if (d.provider === 'selfHosted') fields.push(field(t('超时（秒）', 'Timeout (s)'), input('rolesCloudTimeout', d.timeoutSeconds, { type: 'number', placeholder: '180', onInput: v => { d.timeoutSeconds = v; } })));
        fields.push(field(t('语言', 'Language'), input('rolesCloudLanguage', d.language, { placeholder: t('留空自动识别，如 zh / en / auto', 'Blank = auto, e.g. zh / en / auto'), onInput: v => { d.language = v; refreshActions(); } })));
        fields.push(keyField());
      } else {
        fields.push(field(t('服务', 'Service'), selectBox('rolesRealtimeProvider', [['bailian', t('通义百炼', 'Alibaba Model Studio')], ['elevenLabs', 'ElevenLabs Scribe'], ['selfHosted', t('自部署（OpenAI 兼容服务流）', 'Self-hosted (OpenAI-compatible stream)')]], d.provider, next => {
          d.provider = next; if (next === 'selfHosted' && !d.reuseCloudID) { const r = Roles().reusableCloud(sp); if (r.length && !d.serverURL) d.reuseCloudID = r[0].id; } if (next !== 'selfHosted') d.reuseCloudID = ''; if (next === 'selfHosted' && !['', 'zh', 'en'].includes(d.language)) d.language = ''; repaint(); })));
        if (d.provider === 'bailian') {
          fields.push(field(t('地区', 'Region'), selectBox('rolesRealtimeRegion', [['beijing', t('中国 · 北京', 'China · Beijing')], ['singapore', t('新加坡', 'Singapore')]], d.region, v => { d.region = v; refreshActions(); })));
          fields.push(field(t('工作空间', 'Workspace'), input('rolesRealtimeWorkspace', d.workspaceID, { placeholder: t('可选 Workspace ID', 'Optional Workspace ID'), onInput: v => { d.workspaceID = v; refreshActions(); } })));
        }
        const reusable = Roles().reusableCloud(sp);
        if (d.provider === 'selfHosted') {
          if (reusable.length) {
            fields.push(switchRow('rolesRealtimeReuse', t('与云转写使用同一服务', 'Use the same service as cloud transcription'), !!d.reuseCloudID, on => { d.reuseCloudID = on ? reusable[0].id : ''; repaint(); },
              t('复用云转写方案的地址和 Key，不用再填；Key 只在原生加密存储里复用。', 'Reuses the cloud scheme\'s address and Key; the Key stays in native encrypted storage.')));
            if (d.reuseCloudID && reusable.length > 1) fields.push(field(t('云转写方案', 'Cloud scheme'), selectBox('rolesRealtimeReuseWhich', reusable.map(item => [item.id, item.name || item.model]), d.reuseCloudID, v => { d.reuseCloudID = v; repaint(); })));
          }
          const reused = d.reuseCloudID ? reusable.find(item => item.id === d.reuseCloudID) : null;
          const address = reused ? reused.baseURL : d.serverURL;
          if (!reused) fields.push(field(t('服务地址', 'Server address'), input('rolesRealtimeServer', d.serverURL, { placeholder: 'http://<server>:8000', onInput: v => { d.serverURL = v; refreshActions(); const p = doc().getElementById('rolesRealtimeTarget'); if (p) p.textContent = targetText(v); } })));
          fields.push(el('p', { class: 'pv-note', id: 'rolesRealtimeTarget', text: targetText(address) }));
        }
        fields.push(field(t('语言', 'Language'), d.provider === 'selfHosted'
          ? selectBox('rolesRealtimeLanguage', [['', t('自动识别', 'Auto detect')], ['zh', t('中文', 'Chinese')], ['en', t('英文', 'English')]], d.language, v => { d.language = v; })
          : selectBox('rolesRealtimeLanguage', LANGS(), d.language, v => { d.language = v; })));
        fields.push(keyField(!!d.reuseCloudID && d.provider === 'selfHosted'));
        fields.push(switchRow('rolesRealtimeEnabled', t('保存后启用实时转写', 'Turn live transcription on after saving'), d.enabled, on => { d.enabled = on; }));
      }
      const actions = el('div', { class: 'mr-actions' });
      const reason = el('p', { class: 'pv-note mr-reason', id: isCloud ? 'rolesCloudReason' : 'rolesRealtimeReason', role: 'status', 'aria-live': 'polite' });
      const status = el('p', { class: 'pv-note', id: isCloud ? 'rolesCloudStatus' : 'rolesRealtimeStatus', role: 'status', 'aria-live': 'polite' });
      function refreshActions() {
        const sp2 = state.speech || sp, ex = isCloud ? sp2.cloud.schemes.find(item => item.id === d.id) : sp2.realtime.profiles.find(item => item.id === d.id);
        const p = isCloud ? Roles().cloudProblem(d, ex) : Roles().realtimeProblem(d, ex, sp2);
        const busy = isCloud ? (sp2.cloud.busy || sp2.cloud.testing) : sp2.realtime.testing;
        const testBtn = actions.querySelector('[data-act="test"]'), saveBtn = actions.querySelector('[data-act="save"]');
        for (const b of [testBtn, saveBtn]) { if (!b) continue; if (p || busy) b.setAttribute('disabled', ''); else b.removeAttribute('disabled'); }
        reason.textContent = p ? t('还不能保存或测试：', 'Cannot save or test yet: ') + p : '';
      }
      const test = button(isCloud ? 'rolesCloudTestDraft' : 'rolesRealtimeTestDraft', t('测试连接', 'Test connection'), () => void call(isCloud ? 'testCloud' : 'testRealtime', noteKey, isCloud ? cloudPayload(d) : realtimePayload(d)), { disabled: !!problem });
      const save = button(isCloud ? 'rolesCloudSave' : 'rolesRealtimeSave', t('保存并使用', 'Save and use'), () => {
        state.awaiting = { seq: (state.speech && state.speech.result ? state.speech.result.seq : 0), noteKey, onOk: afterSave(d.kind, noteKey) };
        void call(isCloud ? 'saveCloud' : 'saveRealtime', noteKey, isCloud ? cloudPayload(d) : realtimePayload(d)); }, { primary: true, disabled: !!problem });
      test.dataset.act = 'test'; save.dataset.act = 'save';
      actions.append(test, save, button(isCloud ? 'rolesCloudCancel' : 'rolesRealtimeCancel', t('取消', 'Cancel'), () => { state.edit = null; state.note[noteKey] = ''; paintSpeech(); }));
      reason.textContent = problem ? t('还不能保存或测试：', 'Cannot save or test yet: ') + problem : '';
      const cloud = sp.cloud, rt = sp.realtime;
      status.textContent = state.note[noteKey] || (isCloud ? (cloud.testing ? t('正在测试…', 'Testing…') : (cloud.error || cloud.testMessage || '')) : (rt.testing ? t('正在测试…', 'Testing…') : (rt.error || rt.testMessage || '')));
      return el('div', { class: 'mr-detail-box', id: 'rolesSpeechEditor' },
        el('div', { class: 'mr-head' }, kit() ? kit().iconTile('', d.name || '?', 40) : el('span', { class: 'pv-logo', text: '?' }), el('div', { class: 'mr-head-text' }, el('div', { class: 'mr-head-title' }, el('strong', { text: existing ? t('编辑方案', 'Edit scheme') : (isCloud ? t('添加云转写方案', 'Add a cloud scheme') : t('添加实时转写方案', 'Add a live scheme')) })))),
        el('section', { class: 'mr-card' }, el('h3', { text: t('连接', 'Connection') }), ...fields), el('section', { class: 'mr-card' }, actions, reason, status));
    }
    const targetText = address => { const addr = Roles().streamAddress(address); return addr ? t('将连接到 ', 'Will connect to ') + addr : t('填写地址后，这里会显示实际连接的 ws:// 地址。', 'Once you enter the address, the ws:// address that will be used shows here.'); };
    function silenceCard(sp) {
      const options = [[0, t('关闭', 'Off')], [1, t('1 秒', '1 s')], [1.5, t('1.5 秒', '1.5 s')], [2, t('2 秒', '2 s')], [3, t('3 秒', '3 s')]];
      const node = selectBox('rolesSilence', options.map(([v, l]) => [String(v), l]), String(sp.silenceSeconds), v => void call('setSilence', 'general', Number(v)));
      return el('section', { class: 'mr-card', id: 'rolesSilenceCard' }, el('h3', { text: t('说完自动结束', 'Stop when you stop talking') }),
        el('p', { class: 'pv-note', text: t('点击开始的语音输入，在你说完后静音达到这个时间就自动结束并进入确认；按住说话时松开即结束，不受影响。', 'Voice input started by a click ends by itself after this much silence and goes to the confirmation; hold-to-talk still ends when you release.') }), node);
    }
    function removeButton(id, onConfirm) {
      const node = button(id, t('删除…', 'Delete…'), () => {
        if (node.dataset.armed === '1') { onConfirm(); return; }
        node.dataset.armed = '1'; node.textContent = t('再点一次确认删除', 'Click again to delete'); root.setTimeout(() => { node.dataset.armed = ''; node.textContent = t('删除…', 'Delete…'); }, 4000);
      }, { danger: true });
      return node;
    }
    function paintSpeech() {
      const pane = state.speechPane; if (!pane) return;
      const sp = state.speech || Roles().normalizeSpeech(null);
      const intro = el('p', { class: 'muted', text: t('这里是一份语音识别配置：云转写方案（录完再转写）加实时转写方案（边说边出字），录音、灵动岛语音、快捷键听写和输入框语音都用它。录音文件和 Key 只保存在这台 Mac；转写时音频会发送到你配置的服务。', 'One speech-recognition setup: cloud schemes (transcribe after recording) plus live schemes (text as you speak). Recording, island voice, the dictation shortcut and composer voice all use it. Audio files and keys stay on this Mac; audio is sent to the service you configure.') });
      if (!state.speechLoaded) { pane.host.replaceChildren(intro, el('p', { class: 'pv-note', id: 'rolesSpeechLoading', text: t('正在读取…', 'Loading…') })); return; }
      if (!sp.available) {
        pane.host.replaceChildren(intro, el('p', { class: 'pv-note', id: 'rolesSpeechUnavailable', text: speechBridge()
          ? t('语音识别还没准备好（录音资料库未启用或正在载入）。稍后再回到这一页。', 'Speech recognition is not ready yet (the recordings library is off or still loading). Come back in a moment.')
          : t('语音识别由 AI Bro 桌面版提供；在浏览器里无法配置。', 'Speech recognition is provided by the AI Bro desktop app and cannot be configured in a browser.') }));
        return;
      }
      const cloud = sp.cloud, rt = sp.realtime;
      if (!state.sel || (!state.edit && !(state.sel.startsWith('cloud:') ? cloud.schemes.some(i => 'cloud:' + i.id === state.sel) : rt.profiles.some(i => 'rt:' + i.id === state.sel)))) {
        state.sel = cloud.schemes.length ? 'cloud:' + (cloud.selectedId || cloud.schemes[0].id) : rt.profiles.length ? 'rt:' + (rt.activeId || rt.profiles[0].id) : '';
      }
      const rows = [
        ...cloud.schemes.map(item => listRow({ title: item.name || item.model, sub: `${providerName(item.provider)} · ${item.host || item.model}`, badge: item.id === cloud.selectedId ? t('使用中', 'In use') : '', tone: 'success' }, !state.edit && state.sel === 'cloud:' + item.id, () => { state.edit = null; state.sel = 'cloud:' + item.id; paintSpeech(); })),
        ...rt.profiles.map(item => listRow({ title: item.name || t('实时转写', 'Live'), sub: t('实时 · ', 'Live · ') + ({ bailian: t('通义百炼', 'Model Studio'), elevenLabs: 'ElevenLabs Scribe', selfHosted: t('自部署服务', 'Self-hosted') }[item.provider] || item.provider), badge: item.id === rt.activeId ? (rt.enabled ? t('已开启', 'On') : t('已关闭', 'Off')) : '', tone: 'success' }, !state.edit && state.sel === 'rt:' + item.id, () => { state.edit = null; state.sel = 'rt:' + item.id; paintSpeech(); }))];
      if (!rows.length) rows.push(el('p', { class: 'pv-note', id: 'rolesSpeechEmpty', text: t('还没有方案。先添加一个云转写方案或实时转写方案。', 'No schemes yet. Add a cloud or live scheme first.') }));
      const add = el('div', { class: 'mr-add-group' },
        button('rolesCloudAdd', t('+ 添加云转写方案…', '+ Add cloud scheme…'), () => { state.edit = newCloudDraft(); state.note.cloud = ''; paintSpeech(); }),
        button('rolesRealtimeAdd', t('+ 添加实时转写方案…', '+ Add live scheme…'), () => { state.edit = newRealtimeDraft(sp); state.note.realtime = ''; paintSpeech(); }));
      let detail;
      if (state.edit) detail = editorForm(sp);
      else if (state.sel.startsWith('rt:')) {
        const id = state.sel.slice(3), item = rt.profiles.find(p => p.id === id), active = id === rt.activeId;
        const info = Roles().describeRealtime({ ...sp, realtime: { ...rt, activeId: id } });
        const status = rt.testing ? t('正在测试…', 'Testing…') : (state.note.realtime || rt.error || rt.testMessage || '');
        detail = el('div', { class: 'mr-detail-box' }, headerRow(info, item.name || t('实时转写', 'Live transcription'), item.host, [badge(active ? info.badge : t('未使用', 'Not in use'), active ? info.tone : 'neutral')]),
          el('section', { class: 'mr-card' }, el('h3', { text: t('实时转写', 'Live transcription') }),
            switchRow('rolesRealtimeSwitch', t('实时转写', 'Live transcription'), active && rt.enabled, on => void call('setRealtime', 'realtime', on),
              t('开启后，录音以及灵动岛语音、快捷键听写、输入框语音都会边说边出字，说完自动结束并进入确认。实时转写出问题时，会自动改用云转写。', 'When on, recording and voice input (island, shortcut, composer) show text as you speak and stop by themselves, then ask you to confirm. If live transcription fails, the cloud scheme takes over.'))),
          el('section', { class: 'mr-card' }, el('h3', { text: t('服务', 'Service') }), el('p', { class: 'pv-note', text: `${info.sub}` }),
            el('div', { class: 'mr-actions' },
              button('rolesRealtimeUse', active ? t('使用中', 'In use') : t('设为使用中', 'Use this scheme'), () => void call('selectRealtime', 'realtime', id), { primary: !active, disabled: active || rt.testing }),
              button('rolesRealtimeTest', rt.testing ? t('测试中…', 'Testing…') : t('测试连接', 'Test connection'), () => void call('testRealtime', 'realtime', realtimePayload({ ...realtimeDraftOf(item), reuseCloudID: '' })), { disabled: rt.testing }),
              button('rolesRealtimeEdit', t('编辑…', 'Edit…'), () => { state.edit = realtimeDraftOf(item); paintSpeech(); }),
              removeButton('rolesRealtimeDelete', () => { state.awaiting = null; void call('deleteRealtime', 'realtime', id); })),
            el('p', { class: 'pv-note', id: 'rolesRealtimeStatus', role: 'status', 'aria-live': 'polite', text: status || t('测试只建立连接，不会采集麦克风。', 'The test only opens a connection; the microphone is not used.') })),
          silenceCard(sp));
      } else if (state.sel.startsWith('cloud:')) {
        const id = state.sel.slice(6), scheme = cloud.schemes.find(item => item.id === id), active = id === cloud.selectedId;
        const info = { configured: true, title: scheme.model, sub: [providerName(scheme.provider), scheme.host, Roles().languageLabel(scheme.language)].filter(Boolean).join(' · '), tone: active ? 'success' : 'neutral', badge: active ? t('使用中', 'In use') : t('未使用', 'Not in use') };
        const status = cloud.testing ? t('正在测试…', 'Testing…') : (state.note.cloud || cloud.error || cloud.testMessage || '');
        detail = el('div', { class: 'mr-detail-box' }, headerRow(info, scheme.name || scheme.model, scheme.host, [badge(info.badge, info.tone)]),
          el('section', { class: 'mr-card' }, el('h3', { text: t('服务', 'Service') }), el('p', { class: 'pv-note', text: `${info.sub} · ${t('把录音或听写的音频发给云端模型转成文字（没有实时方案，或实时方案出问题时用它）。', 'Sends recorded or dictated audio to a cloud model for transcription (used when there is no live scheme, or when the live one fails).')}` }),
            el('div', { class: 'mr-actions' },
              button('rolesCloudUse', active ? t('使用中', 'In use') : t('设为使用中', 'Use this scheme'), () => void call('select', 'cloud', id), { primary: !active, disabled: active || cloud.busy }),
              button('rolesCloudTest', cloud.testing ? t('测试中…', 'Testing…') : t('测试连接', 'Test connection'), () => void call('testCloud', 'cloud', cloudPayload({ ...cloudDraftOf(scheme), key: '' })), { disabled: cloud.busy || cloud.testing }),
              button('rolesCloudEdit', t('编辑…', 'Edit…'), () => { state.edit = cloudDraftOf(scheme); paintSpeech(); }),
              removeButton('rolesCloudDelete', () => { state.awaiting = null; void call('deleteCloud', 'cloud', id); })),
            el('p', { class: 'pv-note', id: 'rolesCloudStatus', role: 'status', 'aria-live': 'polite', text: status || (scheme.provider === 'selfHosted' ? t('测试只查询服务的 /health 和 /v1/models，不发送音频。', 'The test only queries /health and /v1/models; no audio is sent.') : t('测试只发一小段合成静音，不会上传你的录音。', 'The test sends a short generated silence, never your recordings.'))})),
          silenceCard(sp));
      } else detail = el('div', { class: 'mr-detail-box' }, el('section', { class: 'mr-card' }, el('p', { class: 'pv-note', text: t('从左边选一个方案，或添加新的。', 'Pick a scheme on the left, or add a new one.') })), silenceCard(sp));
      pane.host.replaceChildren(intro, split([t('语音识别', 'Speech recognition'), t('云转写与实时转写方案', 'Cloud and live schemes')], rows, add, detail));
    }
    function mountSpeech(host) {
      const pane = state.speechPane || buildSpeech();
      host.replaceChildren(pane.host);
      paintSpeech();
      void loadSpeech().then(() => { if (state.attached === 'transcription') { paintSpeech(); const sp = state.speech; if (sp && (sp.cloud.busy || sp.cloud.testing || sp.realtime.busy || sp.realtime.testing)) schedulePolling(); } });
    }

    // ---------- public ----------
    // The semantic-search card must stay in the document (its code looks nodes up by id), so leaving the pane parks it.
    function park() {
      stopPolling(); state.attached = '';
      const card = doc()?.getElementById('embeddingSettings');
      const home = doc()?.getElementById('embeddingParking') || doc()?.getElementById('settings');
      if (card && home && card.closest('#rolesEmbedding')) { card.classList.remove('mr-embed-card'); home.append(card); }
    }
    function mount(host, which) {
      park(); state.attached = which;
      if (which === 'embedding') mountEmbedding(host); else if (which === 'transcription') mountSpeech(host);
    }
    function refresh() {
      if (state.attached === 'embedding') { refreshProviderOptions(); paintEmbedding(); }
      else if (state.attached === 'transcription') void loadSpeech().then(paintSpeech);
    }
    if (doc() && doc().addEventListener) {
      doc().addEventListener('aibro-embedding-change', () => { syncEmbeddingRole(); if (state.attached === 'embedding') paintEmbedding(); });
      doc().addEventListener('workstation-language-change', () => { if (state.attached === 'embedding') { refreshProviderOptions(); paintEmbedding(); } else if (state.attached === 'transcription') paintSpeech(); });
    }
    if (root.addEventListener) root.addEventListener('focus', () => { if (state.attached === 'transcription') void loadSpeech().then(paintSpeech); });
    return { mount, park, refresh, syncEmbeddingRole, loadSpeech, state: () => state };
  }
  return Object.freeze({ create });
}));
