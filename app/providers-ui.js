/* Settings → Models: purpose bar (default + overrides), ordered provider list and provider detail. Public metadata only; no keys. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProvidersUI = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const Providers = () => root.Providers || (typeof require === 'function' ? require('./providers.js') : null);
  const Connections = () => root.Connections || (typeof require === 'function' ? require('./connections.js') : null);
  const english = () => root.WorkstationI18n?.getLanguage?.() === 'en' || /^en(?:-|$)/i.test(root.document?.documentElement?.lang || '');
  const t = (zh, en) => english() ? en : zh;
  const EFFORT_LABELS = { none: ['不使用推理', 'No reasoning'], minimal: ['最少', 'Minimal'], low: ['低', 'Low'], medium: ['中', 'Medium'], high: ['高', 'High'], xhigh: ['非常高', 'Extra high'], max: ['最大', 'Maximum'], ultra: ['极高', 'Ultra'] };
  const effortLabel = level => EFFORT_LABELS[level] ? t(...EFFORT_LABELS[level]) : level;
  const PROTOCOL_LABELS = { responses: 'Responses', chat: 'Chat Completions', anthropic: 'Anthropic Messages' };
  const CAP_LABELS = { image: ['图', 'Image generation'], text: ['文', 'Tool use'], vision: ['视', 'Vision'], think: ['思', 'Thinking'] };
  const CHECK_TEXT = { auth: ['密钥无效', 'Key rejected'], error: ['服务异常', 'Server error'], timeout: ['连接超时', 'Timed out'], unreachable: ['无法连接', 'Unreachable'], invalid: ['地址无效', 'Bad address'] };
  let modelDrag = '';
  const PURPOSES = [
    { role: 'translate', zh: '翻译', en: 'Translation', helpZh: '选中文字翻译用的模型。', helpEn: 'The model used to translate selected text.' },
    { role: 'vision', zh: '视觉', en: 'Vision', helpZh: '读图片用的模型；不指定就跟随默认模型。', helpEn: 'The model that reads images; leave it unset to follow the default model.' },
    { role: 'kernel', zh: '内核', en: 'Background', helpZh: '后台运行和定时任务用的模型。选 ChatGPT 账号时只把它当模型用，工具和审批仍由 AI Bro 执行；额度用尽时运行会暂停并通知。', helpEn: 'The model for background runs and schedules. With a ChatGPT account it is used as a model only: AI Bro runs the tools and approvals, and a run pauses with a notification when the limit is reached.' }
  ];

  function wireOf(item) {
    if (!item || item.kind !== 'api') return '';
    const C = Connections();
    return C.detectProtocol(item.base, item.protocol) || (item.protocol === 'auto' ? 'auto' : item.protocol);
  }
  const hostOf = item => Connections().hostOf(item.base) || item.base || '';

  // Codex 的模型来自官方运行时（按 CLI 版本缓存），形状和模型清单对齐。
  function codexEntries(codex) {
    return (codex?.models || []).map(entry => ({ model: entry.model || entry.id, label: entry.displayName || entry.model || entry.id, efforts: (entry.supportedReasoningEfforts || []).map(option => typeof option === 'string' ? option : option.reasoningEffort).filter(Boolean), defaultEffort: entry.defaultReasoningEffort || '', caps: {} }));
  }
  function modelsOf(item, codex) {
    if (!item) return [];
    if (item.kind !== 'account') return item.models;
    const live = codexEntries(codex), stored = item.models.filter(entry => !live.some(other => other.model === entry.model));
    return [...item.models.filter(entry => live.some(other => other.model === entry.model)), ...live.filter(entry => !item.models.some(other => other.model === entry.model)), ...stored];
  }

  function statusOf(item, codex) {
    if (item.kind === 'account') {
      const d = codex?.detected;
      if (codex?.mode === 'oauth') {
        if (!d) return { tone: 'idle', text: t('尚未检测', 'Not checked yet'), short: '' };
        const who = (codex.account && codex.account.email) || t('ChatGPT 账号', 'ChatGPT account');
        if (d.needsReauth) return { tone: 'warn', text: t('登录已失效，请重新登录', 'Sign-in expired — please sign in again'), short: t('需重新登录', 'Sign in again') };
        if (codex.login && codex.login.pending) return { tone: 'idle', text: codex.login.userCode ? t(`等待授权 · 设备码 ${codex.login.userCode}`, `Waiting for approval · device code ${codex.login.userCode}`) : t('等待你在浏览器中完成登录…', 'Waiting for you to finish in the browser…'), short: t('登录中…', 'Signing in…') };
        return d.loggedIn
          ? { tone: 'ok', text: `${t('已登录', 'Signed in')} · ${who}${codex.account && codex.account.planType ? ' · ' + codex.account.planType : ''}`, short: `${t('已登录', 'Signed in')} · ${who}` }
          : { tone: 'warn', text: t('未登录', 'Not signed in'), short: t('未登录', 'Not signed in') };
      }
      const how = codex?.mode === 'private' ? t('在 AI Bro 里单独登录', 'signed in inside AI Bro') : t('复用现有账号', 'using your existing account');
      if (!d) return { tone: 'idle', text: t('尚未检测', 'Not checked yet'), short: '' };
      if (!d.installed) return { tone: 'bad', text: t('未找到官方 Codex CLI', 'Official Codex CLI not found'), short: t('未找到 Codex', 'Codex not found') };
      return d.loggedIn
        ? { tone: 'ok', text: `Codex ${d.version || ''} · ${t('已登录', 'signed in')} · ${how}`, short: `${t('已登录', 'Signed in')} · ${how}` }
        : { tone: 'warn', text: `Codex ${d.version || ''} · ${t('未登录', 'not signed in')}`, short: t('未登录', 'Not signed in') };
    }
    const wire = wireOf(item);
    const label = wire === 'auto' ? t('协议自动判断', 'Protocol: auto') : (PROTOCOL_LABELS[wire] || wire);
    const check = item.check;
    const badge = item.needsKey ? { tone: 'warn', text: t('待补密钥', 'Key needed') } : check ? (check.ok ? { tone: 'ok', text: t('已验证', 'Verified') } : { tone: 'warn', text: CHECK_TEXT[check.state] ? t(...CHECK_TEXT[check.state]) : t('未验证', 'Unverified') }) : { tone: 'warn', text: t('未验证', 'Unverified') };
    return { tone: 'idle', text: `${hostOf(item)} · ${label}`, short: primaryLabel(item), badge };
  }
  const primaryLabel = item => item.models[0] ? (item.models[0].label || item.models[0].model) : '';

  // 一个“供应商 · 模型”的候选项，用于默认模型和各用途的选择器。
  function optionsOf(list, codex, filter = () => true) {
    const out = [];
    for (const item of list) {
      if (item.needsKey) continue;
      const models = modelsOf(item, codex).filter(filter);
      const rows = models.length ? models : (item.kind === 'account' ? [{ model: '', label: t('账号默认模型', 'Account default model'), efforts: [] }] : []);
      for (const entry of rows) out.push({ provider: item.id, providerName: item.name, model: entry.model, label: entry.label || entry.model, efforts: entry.efforts || [], entry });
    }
    return out;
  }
  const optionText = option => `${option.providerName} · ${option.label}`;

  function effortChoices(item, option) {
    const C = Connections();
    const kind = item.kind === 'account' ? 'codex-cli' : 'api', wire = item.kind === 'api' ? wireOf(item) : '';
    const protocolLevels = C.effortLevels(kind, wire);
    const own = option && option.efforts && option.efforts.length ? option.efforts : null;
    return kind === 'codex-cli' ? (own || []) : (own ? own.filter(level => protocolLevels.includes(level)) : protocolLevels);
  }

  // 视图模型：只含公开信息，没有 Key。
  function buildView(settings, { codex = null, client = null, selected = '', fetched = [], checking = false, checkMessage = '', notice = '', tab = 'providers', balances = {}, balancing = '', codexTest = null, codexTesting = false, suggest = '', usage = null, usageBusy = false } = {}) {
    const P = Providers();
    const list = P.items(settings), over = P.overrides(settings), def = P.defaultSelection(settings);
    const defaultItem = def ? list.find(item => item.id === def.provider) : null;
    const rows = list.map((item, index) => ({ id: item.id, kind: item.kind, name: item.name, isDefault: index === 0, empty: !!(balances[item.id] && balances[item.id].ok && balances[item.id].items.length && balances[item.id].items.every(entry => entry.remaining <= 0)), ...statusOf(item, codex) }));
    const all = optionsOf(list, codex);
    const defaultValue = def ? Math.max(0, all.findIndex(option => option.provider === def.provider && option.model === def.model)) : -1;
    const defaultOptions = all.map((option, index) => ({ value: String(index), label: optionText(option), group: option.providerName, short: option.label, provider: option.provider, model: option.model }));
    const defaultEffortLevels = defaultItem ? effortChoices(defaultItem, all[defaultValue]) : [];
    const purposes = PURPOSES.map(purpose => {
      const own = over[purpose.role] || null;
      const pool = optionsOf(list, codex, purpose.role === 'kernel' ? entry => !(entry.caps && entry.caps.text === false) : () => true);
      const chosen = own ? pool.findIndex(option => option.provider === own.provider && option.model === own.model) : -1;
      const ownItem = own ? list.find(item => item.id === own.provider) : null;
      const options = [{ value: '', label: t('跟随默认', 'Same as default') }, ...pool.map((option, index) => ({ value: String(index), label: optionText(option), group: option.providerName, short: option.label }))];
      let selectedValue = own ? (chosen >= 0 ? String(chosen) : '') : '';
      if (own && chosen < 0) { options.push({ value: 'stale', label: `${ownItem ? ownItem.name : own.provider} · ${own.model}` }); selectedValue = 'stale'; }
      const summary = own ? `${ownItem ? ownItem.name : own.provider} · ${own.model || t('账号默认模型', 'Account default model')}`
        : t('跟随默认', 'Same as default');
      const effortOption = chosen >= 0 ? pool[chosen] : null;
      const levels = ownItem && effortOption ? effortChoices(ownItem, effortOption) : [];
      return { role: purpose.role, label: t(purpose.zh, purpose.en), help: t(purpose.helpZh, purpose.helpEn), summary, options, value: selectedValue, pool, effort: own ? own.effort : '',
        effortOptions: [{ value: '', label: t('模型默认（不发送强度字段）', 'Model default (no effort field sent)') }, ...levels.map(level => ({ value: level, label: effortLabel(level) })), ...(own && own.effort && !levels.includes(own.effort) ? [{ value: own.effort, label: own.effort }] : [])],
        canEffort: !!own };
    });
    const current = list.find(item => item.id === selected) || list[0] || null;
    const detail = current ? detailOf(current, list.indexOf(current) === 0, codex) : null;
    return { providers: rows, defaultBar: { value: String(defaultValue), options: defaultOptions, effort: def ? def.effort : '', effortLevels: defaultEffortLevels.map(level => ({ value: level, label: effortLabel(level) })), pool: all, empty: !list.length }, purposes, selected: current ? current.id : '', detail, client, fetched, checking, checkMessage, notice, tab, balance: balances[current ? current.id : ''] || null, balancing, codexTest, codexTesting, suggest, usage, usageBusy, accountMode: codex ? codex.mode : '', hasAccount: list.some(item => item.kind === 'account') };
  }
  function optionTextOf(list, selection) {
    const item = list.find(entry => entry.id === selection.provider);
    return `${item ? item.name : selection.provider} · ${selection.model}`;
  }
  function detailOf(item, isDefault, codex) {
    const status = statusOf(item, codex);
    const readOnly = item.kind === 'account';
    const models = modelsOf(item, codex).map((entry, index) => ({ model: entry.model, label: entry.label || entry.model, role: index === 0 ? 'primary' : 'fallback', effort: entry.effort || '', effortLevels: item.kind === 'api' ? effortChoices(item, entry) : [], caps: Object.keys(CAP_LABELS).map(key => ({ key, on: (entry.caps || {})[key] === true })), hasCaps: Object.keys(entry.caps || {}).length > 0 }));
    return { id: item.id, kind: item.kind, name: item.name, isDefault, status, base: item.base || '', host: item.kind === 'api' ? hostOf(item) : '', balanceAdapter: item.kind === 'api' ? ((root.ProviderBalance || (typeof require === 'function' ? require('./provider-balance.js') : null))?.detect(item.base) || '') : '', protocol: item.kind === 'api' ? wireOf(item) : '', protocolSetting: item.kind === 'api' ? (item.protocol || 'auto') : '', protocolLabel: item.kind === 'api' ? (wireOf(item) === 'auto' ? t('自动判断', 'Auto-detect') : PROTOCOL_LABELS[wireOf(item)] || wireOf(item)) : '', models, readOnly, modelsMissing: readOnly && !models.length, account: item.kind === 'account' ? { installed: !!codex?.detected?.installed, loggedIn: !!codex?.detected?.loggedIn, shared: codex?.mode === 'shared', oauth: codex?.mode === 'oauth', mode: codex ? codex.mode : '', needsReauth: !!codex?.detected?.needsReauth, pending: !!(codex?.login && codex.login.pending), userCode: (codex?.login && codex.login.userCode) || '', verificationUrl: (codex?.login && codex.login.verificationUrl) || '', email: (codex?.account && codex.account.email) || '', plan: (codex?.account && codex.account.planType) || '' } : null };
  }

  // ---- DOM ----
  function render(view, ctx, hostEl) {
    const doc = hostEl.ownerDocument;
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
    // With UIKit (the app) the pickers are grouped by provider with search; without it (tests, bare hosts) they stay native selects.
    const select = (id, label, options, value, onChange, disabled = false, compact = false) => {
      const kit = root.UIKit;
      if (kit && !compact) {
        const grouped = options.some(option => option.group);
        const control = kit.select({ id, label, disabled, value, className: 'uk-block', searchable: 'auto', searchPlaceholder: t('搜索模型或供应商', 'Search models or providers'),
          options: options.map(option => ({ value: option.value, label: option.short || option.label, group: option.group, keywords: [option.label] })),
          renderValue: grouped ? option => (option && option.group ? `${option.group} · ${option.label}` : option ? option.label : '') : undefined, onChange });
        return control.el;
      }
      const control = el('select', { class: compact ? 'setting-input pv-effort' : 'setting-input', id, 'aria-label': label, ...(disabled ? { disabled: true } : {}), onchange: event => onChange(event.target.value) }, options.map(option => el('option', { value: option.value, text: option.label, ...(option.value === value ? { selected: true } : {}) })));
      return control;
    };
    // 地址 / 协议 / 密钥：改完点保存。密钥只往外传，不回显；改地址时必须同时填密钥（钥匙串按地址存）。
    const connectionForm = d => {
      const baseInput = el('input', { type: 'text', id: 'providerBase', value: d.base, maxlength: '300', autocomplete: 'off', 'aria-label': t('API 地址', 'API address') });
      const keyInput = el('input', { type: 'password', id: 'providerKey', autocomplete: 'off', placeholder: t('留空表示不更换密钥', 'Leave empty to keep the current key'), 'aria-label': t('API 密钥', 'API key') });
      const protocolSelect = el('select', { class: 'setting-input', id: 'providerProtocol', 'aria-label': t('接口格式', 'API format') }, [['auto', '自动识别', 'Auto-detect'], ['responses', 'Responses', 'Responses'], ['chat', 'Chat Completions', 'Chat Completions'], ['anthropic', 'Anthropic Messages', 'Anthropic Messages']].map(([value, zh, en]) => el('option', { value, text: t(zh, en), ...(value === d.protocolSetting ? { selected: true } : {}) })));
      const status = el('span', { class: 'pv-note', id: 'providerConnectionStatus', role: 'status', 'aria-live': 'polite' });
      const save = el('button', { class: 'secondary', type: 'button', id: 'providerConnectionSave', text: t('保存连接', 'Save connection'), onclick: async () => {
        const base = baseInput.value.trim(), token = keyInput.value.trim();
        if (base !== d.base && !token) { status.textContent = t('改地址时请同时填写密钥：密钥按地址存放在钥匙串里。', 'Enter the key too when changing the address: keys are stored per address.'); return; }
        save.disabled = true; status.textContent = '';
        const error = await ctx.onConnection(d.id, { base, protocol: protocolSelect.value, token });
        if (error) { status.textContent = error; save.disabled = false; }
      } });
      return el('div', { class: 'pv-field pv-connection' },
        el('label', { for: 'providerBase', text: t('API 地址', 'API address') }), baseInput,
        el('label', { for: 'providerProtocol', text: t('接口格式', 'API format') }), protocolSelect,
        el('label', { for: 'providerKey', text: t('API 密钥', 'API key') }), keyInput,
        el('div', { class: 'pv-actions' }, save, status),
        el('span', { class: 'pv-note', text: t('密钥只保存在系统钥匙串里，这里不会显示。', 'The key lives in the system keychain and is never shown here.') }));
    };
    // 工作区默认模型 / 工具调用方式：原来在旧的“模型连接”卡里，现在从这里改（值仍存在原来的位置）。
    const workspaceSection = legacy => {
      const names = [['daily', t('日常', 'Daily')], ['course', t('课程', 'Course')], ['research', t('科研', 'Research')]];
      const toolSelect = el('select', { class: 'setting-input', id: 'providerToolProtocol', 'aria-label': t('工具调用方式', 'Tool-call mode'), onchange: event => legacy.setToolProtocol(event.target.value) },
        [['text', '文本协议（默认）', 'Text protocol (default)'], ['native', '原生工具调用（试验）', 'Native tool calls (experimental)']].map(([value, zh, en]) => el('option', { value, text: t(zh, en), ...(legacy.toolProtocol() === value ? { selected: true } : {}) })));
      return el('section', { class: 'pv-workspace', id: 'providerWorkspace' },
        el('h3', { text: t('工作区模型', 'Workspace models') }),
        el('p', { class: 'pv-note', text: t('留空表示跟随默认模型；对话和项目里的设定优先。只影响新的执行。', 'Empty follows the default model; chat and project settings win. Only affects new runs.') }),
        names.map(([key, label]) => el('div', { class: 'pv-field' }, el('label', { for: `providerWorkspace-${key}`, text: label }),
          el('input', { type: 'text', class: 'setting-input', id: `providerWorkspace-${key}`, value: legacy.workspace(key), maxlength: '200', placeholder: t('跟随默认', 'Follow default'), onchange: event => legacy.setWorkspace(key, event.target.value.trim()) }))),
        el('div', { class: 'pv-field' }, el('label', { for: 'providerToolProtocol', text: t('工具调用方式（自定义 API）', 'Tool-call mode (custom API)') }), toolSelect));
    };
    // 用途入口在左栏底部；点开后右栏显示该用途的选择（和选供应商一样，不整页跳动）。
    const bar = view.defaultBar;
    const sel = ctx.purposeSel?.() || '';
    const defaultOption = bar.options[Number(bar.value)] || null;
    const entries = [
      { id: 'default', label: t('默认模型（问答）', 'Default model (chat)'), summary: defaultOption ? (defaultOption.short || defaultOption.label) : t('还没有供应商', 'No providers yet') },
      ...view.purposes.map(purpose => ({ id: purpose.role, label: purpose.label, summary: purpose.summary })),
      ...(!bar.empty && bar.effortLevels.length ? [{ id: 'default-effort', label: t('思考强度', 'Effort'), summary: bar.effort ? effortLabel(bar.effort) : t('模型默认', 'Model default') }] : [])];
    const purposeEntries = el('ul', { class: 'pv-roles', id: 'providerPurposes', 'aria-label': t('用途', 'Purposes') },
      el('li', { class: 'pv-head', text: t('用途', 'Purposes') }),
      entries.map(entry => el('li', {}, el('button', { type: 'button', class: 'pv-role', 'data-role': entry.id, ...(sel === entry.id ? { 'aria-current': 'true' } : {}), onclick: () => ctx.onPurposeSel?.(entry.id) },
        el('span', { class: 'pv-role-name', text: entry.label }), el('small', { text: entry.summary })))));
    const purposePane = () => {
      const pane = (title, help, ...children) => el('div', { class: 'pv-detail pv-purpose-pane', id: 'providerPurposePane', 'data-role': sel }, el('h3', { text: title }), help ? el('p', { class: 'pv-note', text: help }) : null, ...children);
      if (sel === 'default') {
        return pane(t('默认模型（问答）', 'Default model (chat)'), t('问答永远用它；其余用途不指定时也跟随它。也可以在左边拖拽供应商，首位即默认。', 'Chat always uses it, and other purposes follow it unless set. You can also drag a provider to the top of the list.'),
          bar.empty ? el('span', { class: 'pv-note', text: t('还没有供应商：先添加一个。', 'No providers yet: add one first.') })
            : select('providerDefaultModel', t('默认模型', 'Default model'), bar.options, bar.value, value => ctx.onDefault(bar.pool[Number(value)])));
      }
      if (sel === 'default-effort') {
        return pane(t('思考强度', 'Effort'), t('默认模型的思考强度。', 'Thinking effort of the default model.'),
          select('providerDefaultEffort', t('默认模型的思考强度', 'Thinking effort of the default model'), [{ value: '', label: t('模型默认（不发送强度字段）', 'Model default (no effort field sent)') }, ...bar.effortLevels], bar.effort, value => ctx.onDefaultEffort(value)));
      }
      const purpose = view.purposes.find(entry => entry.role === sel);
      if (!purpose) return null;
      return pane(purpose.label, purpose.help,
        select(`purpose-${purpose.role}`, purpose.label, purpose.options, purpose.value, value => ctx.onPurpose(purpose.role, value === '' ? null : purpose.pool[Number(value)])),
        el('div', { class: 'pv-field' }, el('label', { text: t('思考强度', 'Thinking effort') }),
          select(`purpose-${purpose.role}-effort`, `${purpose.label} · ${t('思考强度', 'effort')}`, purpose.effortOptions, purpose.effort, value => ctx.onPurposeEffort(purpose.role, value), !purpose.canEffort)));
    };

    // 供应商列表
    const list = el('ul', { class: 'pv-list', id: 'providerList', 'aria-label': t('供应商列表', 'Providers') },
      el('li', { class: 'pv-head', text: t('已启用 · 拖拽排序，首位为默认', 'Enabled · drag to reorder, the first one is the default') }),
      view.providers.map((row, index) => el('li', {
        class: 'pv-row', 'data-id': row.id, 'data-kind': row.kind, draggable: 'true', tabindex: '0', ...(row.id === view.selected && !sel ? { 'aria-current': 'true' } : {}),
        onclick: () => ctx.onSelect(row.id),
        onkeydown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); ctx.onSelect(row.id); } else if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); ctx.onMove(row.id, index - 1); } else if (event.altKey && event.key === 'ArrowDown') { event.preventDefault(); ctx.onMove(row.id, index + 1); } },
        ondragstart: event => { event.dataTransfer?.setData('text/plain', row.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; ctx.onDrag?.(row.id); },
        ondragover: event => { event.preventDefault(); event.currentTarget.setAttribute('data-dragover', '1'); },
        ondragleave: event => event.currentTarget.removeAttribute('data-dragover'),
        ondrop: event => { event.preventDefault(); event.currentTarget.removeAttribute('data-dragover'); const from = ctx.dragging?.() || event.dataTransfer?.getData('text/plain'); if (from && from !== row.id) ctx.onMove(from, index); }
      },
      el('span', { class: 'pv-grip', 'aria-hidden': 'true', text: '⠿' }),
      el('span', { class: 'pv-logo', 'aria-hidden': 'true', text: Array.from(row.name || '?')[0].toUpperCase() }),
      el('span', { class: 'pv-text' }, el('span', {}, row.name, row.isDefault ? el('span', { class: 'pv-chip', 'data-tone': 'accent', text: t('默认', 'Default') }) : null, row.badge && row.badge.tone !== 'ok' ? el('span', { class: 'pv-chip', 'data-tone': row.badge.tone, text: row.badge.text }) : null, row.empty ? el('span', { class: 'pv-chip', 'data-tone': 'bad', text: t('余额用尽', 'Out of credit') }) : null),
        el('small', { text: row.short || row.text })))),
      el('li', {}, el('button', { class: 'pv-add', type: 'button', id: 'providerAdd', text: t('＋ 添加供应商', '+ Add a provider'), onclick: () => ctx.onAdd?.() })));

    // 详情
    const d = view.detail;
    // 额度窗口（5 小时 / 每周）：来自 wham/usage，只用 AI Bro 自己的令牌，点击或登录后才查询。
    const quotaField = v => {
      const names = { five_hour: ['5 小时', '5 hours'], seven_day: ['每周', 'Weekly'], thirty_day: ['每月', 'Monthly'] };
      const labelOf = w => names[w.name] ? t(...names[w.name]) : w.name;
      const windows = (v.usage && v.usage.windows) || [];
      const rows = windows.map(w => {
        const used = Math.max(0, Math.min(100, Math.round(w.usedPercent)));
        return el('div', { class: 'pv-quota-row' },
          el('span', { class: 'pv-quota-name', text: labelOf(w) }),
          el('span', { class: 'pv-quota-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(used), 'aria-label': labelOf(w) }, el('span', { class: 'pv-quota-fill', style: `width:${used}%`, 'data-high': used >= 90 ? '1' : '0' })),
          el('span', { class: 'pv-quota-text', text: `${t('已用', 'Used')} ${used}%${w.resetsAt ? ' · ' + t('重置于', 'resets') + ' ' + new Date(w.resetsAt * 1000).toLocaleString() : ''}` }));
      });
      const note = v.usage && v.usage.error ? v.usage.error : windows.length || (v.usage && !v.usage.error) ? '' : t('点“刷新额度”查询。', 'Press Refresh to look it up.');
      return el('div', { class: 'pv-field', id: 'providerQuota' }, el('label', { text: t('额度', 'Usage limits') }),
        el('div', { class: 'pv-quota' }, rows, note ? el('span', { class: 'pv-note', text: note }) : null, !rows.length && !note ? el('span', { class: 'pv-note', text: t('没有可显示的额度窗口。', 'No usage windows to show.') }) : null),
        el('button', { class: 'secondary pv-small', type: 'button', id: 'providerQuotaRefresh', text: t('刷新额度', 'Refresh'), ...(v.usageBusy ? { disabled: true } : {}), onclick: () => ctx.onUsage?.() }));
    };
    let detail;
    if (!d) detail = el('div', { class: 'pv-detail pv-empty', id: 'providerDetail', text: t('选择左边的供应商查看详情。', 'Select a provider on the left to see its details.') });
    else {
      // 每行：拖拽手柄 · 标签 · 名称 · 能力 · 紧凑强度；上移/下移/移除只在悬停或聚焦时出现。
      const dropModel = (event, index) => { event.preventDefault(); event.currentTarget.removeAttribute('data-dragover'); const from = modelDrag; modelDrag = ''; if (from && !d.readOnly) ctx.onModelMove(d.id, from, index); };
      const modelRows = d.models.map((model, index) => el('div', { class: 'pv-model', 'data-model': model.model, ...(d.readOnly ? {} : { draggable: 'true' }),
        ondragstart: event => { if (d.readOnly) return; modelDrag = model.model; if (event.dataTransfer) { event.dataTransfer.setData('text/plain', model.model); event.dataTransfer.effectAllowed = 'move'; } },
        ondragover: event => { if (modelDrag) { event.preventDefault(); event.currentTarget.setAttribute('data-dragover', '1'); } },
        ondragleave: event => event.currentTarget.removeAttribute('data-dragover'),
        ondragend: () => { modelDrag = ''; },
        ondrop: event => dropModel(event, index) },
        d.readOnly ? null : el('span', { class: 'pv-grip pv-model-grip', 'aria-hidden': 'true', title: t('拖拽排序', 'Drag to reorder'), text: '⠿' }),
        el('span', { class: 'pv-tag', ...(index === 0 ? { 'data-primary': '1' } : {}), text: d.readOnly ? (index === 0 ? t('默认', 'Default') : '') : index === 0 ? t('主模型', 'Primary') : t(`备用 ${index}`, `Fallback ${index}`) }),
        el('b', { text: model.label === model.model || !model.model ? (model.label || model.model) : `${model.label} (${model.model})` }),
        d.readOnly ? (model.hasCaps ? el('span', { class: 'pv-caps', 'aria-label': t('能力', 'Capabilities') }, model.caps.map(cap => el('span', { ...(cap.on ? {} : { 'data-off': '1' }), title: CAP_LABELS[cap.key][english() ? 1 : 0], text: CAP_LABELS[cap.key][0] }))) : null)
          : el('span', { class: 'pv-caps', role: 'group', 'aria-label': t('能力', 'Capabilities') }, model.caps.map(cap => el('button', { type: 'button', class: 'pv-cap', 'data-cap': cap.key, 'aria-pressed': cap.on ? 'true' : 'false', title: `${CAP_LABELS[cap.key][english() ? 1 : 0]}: ${cap.on ? t('已标记', 'on') : t('未标记', 'off')}`, text: CAP_LABELS[cap.key][0], onclick: () => ctx.onModelCaps(d.id, model.model, cap.key, !cap.on) }))),
        d.readOnly || !model.effortLevels.length ? null : select(`modelEffort-${index}`, `${model.model} · ${t('强度', 'effort')}`, [{ value: '', label: t('默认', 'Default') }, ...model.effortLevels.map(level => ({ value: level, label: effortLabel(level) }))], model.effort, value => ctx.onModelEffort(d.id, model.model, value), false, true),
        d.readOnly ? null : el('span', { class: 'pv-actions pv-row-actions' },
          el('button', { class: 'pv-icon', type: 'button', 'aria-label': t('上移', 'Move up'), title: t('上移', 'Move up'), ...(index === 0 ? { disabled: true } : {}), text: '↑', onclick: () => ctx.onModelMove(d.id, model.model, index - 1) }),
          el('button', { class: 'pv-icon', type: 'button', 'aria-label': t('下移', 'Move down'), title: t('下移', 'Move down'), ...(index === d.models.length - 1 ? { disabled: true } : {}), text: '↓', onclick: () => ctx.onModelMove(d.id, model.model, index + 1) }),
          el('button', { class: 'pv-icon', type: 'button', 'aria-label': t('移除', 'Remove'), title: t('移除', 'Remove'), text: '✕', onclick: () => ctx.onModelRemove(d.id, model.model) }))));
      const nameInput = el('input', { type: 'text', id: 'providerName', value: d.name, maxlength: '80', 'aria-label': t('名称', 'Name'), ...(d.readOnly ? { disabled: true } : {}) });
      if (!d.readOnly) nameInput.addEventListener('change', () => ctx.onRename(d.id, nameInput.value));
      // 添加模型：一个 Combobox。可以在获取到的列表里搜索选择，也可以直接手输后回车。
      const modelInput = el('input', { type: 'text', id: 'providerAddModel', maxlength: '200', autocomplete: 'off', role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': 'providerModelOptions', placeholder: view.fetched && view.fetched.length ? t('搜索或输入模型名', 'Search or type a model name') : t('模型名，例如 model-name', 'Model name'), 'aria-label': t('添加模型', 'Add a model') });
      const optionList = el('ul', { class: 'pv-combo-list', id: 'providerModelOptions', role: 'listbox', hidden: true });
      const taken = new Set(d.models.map(model => model.model));
      let active = -1;
      const addModel = value => { const name = (value == null ? modelInput.value : value).trim(); if (name) ctx.onModelAdd(d.id, name); };
      const choices = () => { const query = modelInput.value.trim().toLowerCase(); return (view.fetched || []).filter(id => !taken.has(id) && (!query || id.toLowerCase().includes(query))).slice(0, 80); };
      const closeList = () => { optionList.hidden = true; modelInput.setAttribute('aria-expanded', 'false'); active = -1; };
      const paintList = () => {
        const items = choices();
        optionList.replaceChildren(...items.map((id, index) => el('li', { role: 'option', 'data-value': id, id: `providerModelOption-${index}`, 'aria-selected': index === active ? 'true' : 'false', text: id,
          onmousedown: event => { event.preventDefault(); addModel(id); } })));
        if (!items.length) { optionList.hidden = !(view.fetched && view.fetched.length && modelInput.value.trim()); if (!optionList.hidden) optionList.append(el('li', { class: 'pv-combo-empty', text: t('没有匹配的模型，回车添加你输入的名称', 'No match; press Enter to add what you typed') })); }
        else optionList.hidden = false;
        modelInput.setAttribute('aria-expanded', optionList.hidden ? 'false' : 'true');
        if (active >= 0) modelInput.setAttribute('aria-activedescendant', `providerModelOption-${active}`); else modelInput.removeAttribute('aria-activedescendant');
      };
      modelInput.addEventListener('input', () => { active = -1; paintList(); });
      modelInput.addEventListener('focus', () => { if (view.fetched && view.fetched.length) paintList(); });
      modelInput.addEventListener('blur', () => setTimeout(closeList, 120));
      modelInput.addEventListener('keydown', event => {
        const items = choices();
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { if (!items.length) return; event.preventDefault(); active = (active + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; paintList(); optionList.children[active]?.scrollIntoView?.({ block: 'nearest' }); }
        else if (event.key === 'Enter') { event.preventDefault(); addModel(active >= 0 && items[active] ? items[active] : undefined); }
        else if (event.key === 'Escape' && !optionList.hidden) { event.preventDefault(); event.stopPropagation(); closeList(); }
      });
      const combo = el('div', { class: 'pv-combo' }, modelInput,
        el('button', { class: 'pv-combo-fetch', type: 'button', id: 'providerFetchModels', 'aria-label': t('获取模型列表', 'Fetch model list'), title: t('从服务读取模型列表', 'Read the model list from the service'), ...(view.checking ? { disabled: true } : {}), text: view.fetched && view.fetched.length ? t('刷新列表', 'Refresh') : t('获取列表', 'Fetch list'), onclick: () => ctx.onFetchModels(d.id) }),
        optionList);
      if (ctx.comboOpen?.() === d.id) setTimeout(() => { if (modelInput.isConnected) { modelInput.focus({ preventScroll: true }); paintList(); } }, 0);
      detail = el('div', { class: 'pv-detail', id: 'providerDetail', 'data-kind': d.kind },
        el('header', {}, el('span', { class: 'pv-logo', 'aria-hidden': 'true', text: Array.from(d.name || '?')[0].toUpperCase() }), el('h2', { text: d.name }),
          d.isDefault ? el('span', { class: 'pv-chip', 'data-tone': 'accent', text: t('默认', 'Default') }) : null,
          d.kind === 'account' ? el('span', { class: 'pv-chip', 'data-tone': d.status.tone, text: d.status.short || d.status.text }) : (d.status.badge ? el('span', { class: 'pv-chip', 'data-tone': d.status.badge.tone, text: d.status.badge.text }) : null)),
        d.kind === 'api' ? el('div', { class: 'pv-field' }, el('label', { for: 'providerName', text: t('名称', 'Name') }), nameInput) : null,
        d.kind === 'api' ? connectionForm(d) : null,
        d.balanceAdapter ? el('div', { class: 'pv-field', id: 'providerBalance' }, el('label', { text: t('余额', 'Balance') }),
          el('div', { class: 'pv-add-model' }, el('span', { class: 'pv-value', id: 'providerBalanceValue', text: view.balance ? (view.balance.ok ? view.balance.items.map(item => (root.ProviderBalance || {}).format ? root.ProviderBalance.format(item) : String(item.remaining)).join(' · ') : view.balance.message) : t('点“刷新余额”查询（只在你点击时联网）', 'Press Refresh to look it up (only when you press it)') }),
            el('button', { class: 'secondary pv-small', type: 'button', id: 'providerBalanceRefresh', text: t('刷新余额', 'Refresh balance'), ...(view.balancing === d.id ? { disabled: true } : {}), onclick: () => ctx.onBalance?.(d.id) }))) : null,
        d.kind === 'account' ? el('div', { class: 'pv-field' }, el('label', { text: t('账号', 'Account') }), el('span', { class: 'pv-value', id: 'providerStatus', text: d.status.text }),
          el('span', { class: 'pv-note', text: d.account && d.account.oauth ? t('由 AI Bro 直接用你的 ChatGPT 账号登录；令牌保存在 macOS 钥匙串，不经过 Codex CLI，也不读取本机 Codex 的登录。', 'AI Bro signs in to your ChatGPT account itself; the token is kept in the macOS keychain, not through the Codex CLI, and the Codex login on this Mac is never read.') : t('经官方 Codex 登录；AI Bro 不读取也不保存令牌。', 'Signed in through the official Codex; AI Bro never reads or stores the token.') })) : null,
        d.kind === 'account' && d.account && d.account.oauth && d.account.pending && d.account.userCode ? el('p', { class: 'pv-note', id: 'providerDeviceCode', role: 'status', 'aria-live': 'polite', text: t(`本机 1455 端口被其他程序占用，已改用设备码登录：请在 ${d.account.verificationUrl || 'auth.openai.com/codex/device'} 输入代码 ${d.account.userCode}。`, `Port 1455 on this Mac is in use, so device-code sign-in is used: enter code ${d.account.userCode} at ${d.account.verificationUrl || 'auth.openai.com/codex/device'}.`) }) : null,
        d.kind === 'account' && d.account && d.account.oauth && d.account.loggedIn ? quotaField(view) : null,
        el('div', { class: 'pv-field' }, el('label', { text: d.readOnly ? t('模型（来自官方列表，只读）', 'Models (from the official list, read-only)') : t('模型（主模型 + 备用，顺序即优先级）', 'Models (primary + fallbacks, in priority order)') }),
          el('div', { class: 'pv-models', id: 'providerModels' }, modelRows.length ? modelRows : el('span', { class: 'pv-note', text: d.modelsMissing ? t('还没有模型列表：点下面的“测试可用性”读取一次。', 'No model list yet: use “Test availability” once.') : t('还没有模型：在下面添加。', 'No models yet: add one below.') })),
          d.readOnly ? null : el('div', { class: 'pv-add-model' }, combo, el('button', { class: 'secondary', type: 'button', id: 'providerAddModelButton', text: t('添加', 'Add'), onclick: () => addModel() }))),
        el('div', { class: 'pv-footer' },
          el('div', { class: 'pv-actions pv-actions-main' },
            d.kind === 'api' ? el('button', { class: 'primary', type: 'button', id: 'providerTest', text: t('测试连接', 'Test connection'), ...(view.checking ? { disabled: true } : {}), onclick: () => ctx.onCheck(d.id) }) : null,
            d.kind === 'account' ? el('button', { class: 'primary', type: 'button', id: 'connectionsCodexTest', text: t('测试可用性', 'Test availability'), ...(view.codexTesting ? { disabled: true } : {}), onclick: () => ctx.onCodexTest?.() }) : null),
          el('div', { class: 'pv-actions pv-actions-more' },
            d.kind === 'account' ? el('button', { class: 'secondary', type: 'button', id: 'connectionsCodexCheck', text: t('重新检测', 'Check again'), onclick: () => ctx.onCodexCheck?.() }) : null,
            // 登录 / 退出登录只显示与当前状态相符的一个；复用现有账号时两者都在终端里做。
            d.kind === 'account' && ctx.legacy && d.account && !d.account.shared && d.account.installed && !d.account.loggedIn && !d.account.pending ? el('button', { class: 'secondary', type: 'button', id: 'connectionsCodexSignIn', text: d.account.needsReauth ? t('重新登录', 'Sign in again') : t('登录', 'Sign in'), onclick: () => ctx.legacy.signIn() }) : null,
            d.kind === 'account' && ctx.legacy && d.account && d.account.oauth && d.account.pending ? el('button', { class: 'secondary', type: 'button', id: 'connectionsCodexCancel', text: t('取消登录', 'Cancel sign-in'), onclick: () => ctx.legacy.cancelLogin() }) : null,
            d.kind === 'account' && ctx.legacy && d.account && !d.account.shared && d.account.loggedIn ? el('button', { class: 'secondary', type: 'button', id: 'connectionsCodexSignOut', text: t('退出登录', 'Sign out'), onclick: () => ctx.legacy.signOut() }) : null,
            d.isDefault ? null : el('button', { class: 'secondary', type: 'button', id: 'providerMakeDefault', text: t('设为默认', 'Make default'), onclick: () => ctx.onMove(d.id, 0) })),
          el('span', { class: 'pv-spacer' }),
          el('button', { class: 'pv-danger', type: 'button', id: 'providerRemove', text: d.kind === 'account' ? t('从列表移除', 'Remove from list') : t('删除', 'Delete'), onclick: () => ctx.onRemove(d.id, d.name) })),
        d.kind === 'account' && d.account && d.account.shared ? el('p', { class: 'pv-note', id: 'providerCodexSharedNote', text: d.account.loggedIn ? t('这是你平时在终端使用的 Codex 账号：退出登录请在终端运行 codex logout。', 'This is the Codex account you use in the terminal: run codex logout there to sign out.') : t('这是你平时在终端使用的 Codex 账号：请在终端运行 codex login 登录，然后点“重新检测”。', 'This is the Codex account you use in the terminal: run codex login there, then press Check again.') }) : null,
        d.kind === 'account' && d.account && d.account.mode && !d.account.oauth ? el('div', { class: 'pv-suggest', id: 'providerOauthHint', role: 'status' },
          el('span', { text: t('现在用的是本机 Codex 的登录。可以改用 AI Bro 自己登录 ChatGPT：不再依赖 Codex 的配置，也不会和 CC Switch 的路由混在一起。', 'This uses the Codex login on this Mac. You can switch to AI Bro signing in to ChatGPT itself: it no longer depends on Codex\'s configuration and cannot be mixed up with CC Switch routing.') }),
          el('button', { class: 'secondary pv-small', type: 'button', id: 'providerUseOauth', text: t('改用 AI Bro 自己登录', 'Sign in with AI Bro itself'), onclick: () => ctx.onLoginMode?.('oauth') })) : null,
        d.kind === 'account' && (view.codexTest || view.codexTesting) ? el('p', { class: 'pv-note', id: 'providerCodexTestResult', role: 'status', 'aria-live': 'polite', ...(view.codexTest && view.codexTest.ok === false ? { 'data-tone': 'bad' } : {}), text: view.codexTesting ? t('正在测试…', 'Testing…') : view.codexTest.message }) : null,
        d.kind === 'api' && view.suggest ? el('div', { class: 'pv-suggest', id: 'providerProtocolSuggest', role: 'status' },
          el('span', { text: view.suggest === 'chat' ? t('这个服务只认 Chat Completions，当前的 Responses 格式会被拒绝。', 'This service only accepts Chat Completions; the current Responses format would be rejected.') : t('这个服务只认 Responses，当前的 Chat Completions 格式会被拒绝。', 'This service only accepts Responses; the current Chat Completions format would be rejected.') }),
          el('button', { class: 'secondary pv-small', type: 'button', id: 'providerApplyProtocol', text: view.suggest === 'chat' ? t('改用 Chat Completions', 'Switch to Chat Completions') : t('改用 Responses', 'Switch to Responses'), onclick: () => ctx.onApplyProtocol(d.id, view.suggest) })) : null,
        d.kind === 'api' ? el('p', { class: 'pv-note', id: 'providerCheckStatus', role: 'status', 'aria-live': 'polite', text: view.checkMessage || t('测试只查询模型列表，不发对话请求。删除只移除列表项，钥匙串里的密钥不动。', 'The test only asks for the model list; no chat request is sent. Deleting only removes the list entry; the key in the keychain is left alone.') }) : null);
    }

    const client = view.client;
    const more = el('details', { class: 'pv-more', id: 'providerMore' }, el('summary', { text: t('更多', 'More') }),
      el('div', { class: 'pv-actions' }, el('button', { class: 'secondary', type: 'button', id: 'providerImportCc', text: t('从 CC Switch 导入…', 'Import from CC Switch…'), onclick: () => ctx.onImport?.() })),
      ctx.legacy ? workspaceSection(ctx.legacy) : null,
      !view.hasAccount ? null : el('section', { class: 'chatgpt-advanced' },
        el('h3', { text: t('ChatGPT 账号（高级）', 'ChatGPT account (advanced)') }),
        el('p', { class: 'pv-note', text: t('默认由 AI Bro 自己登录 ChatGPT。只有想和终端里的 Codex 共用同一个登录时才打开下面的选项。', 'By default AI Bro signs in to ChatGPT itself. Turn this on only if you want to share the login of the Codex in your terminal.') }),
        el('label', { class: 'client-api-toggle' }, el('input', { type: 'checkbox', id: 'providerReuseCodex', ...(view.accountMode === 'shared' ? { checked: true } : {}), onchange: event => ctx.onLoginMode?.(event.target.checked ? 'shared' : 'oauth') }), el('span', { text: ' ' + t('复用本机 Codex 登录', 'Reuse the Codex login on this Mac') }))),
      !client ? null : el('section', { class: 'client-api', 'data-enabled': client.enabled ? '1' : '0' },
        el('h3', { text: t('本机客户端接口', 'Local client interface') }),
        el('p', { class: 'pv-note', text: t('让本机其他程序通过回环地址和随机令牌调用：只有状态、模型、提问、取消四项，不会返回任何 Key。默认关闭。', 'Lets other programs on this Mac call in over loopback with a random token: status, models, ask and cancel only, never a key. Off by default.') }),
        el('label', { class: 'client-api-toggle' }, el('input', { type: 'checkbox', id: 'clientApiEnabled', ...(client.enabled ? { checked: true } : {}), onchange: event => ctx.onClientToggle?.(event.target.checked) }), el('span', { text: ' ' + t('开启本机客户端接口', 'Enable the local client interface') })),
        client.enabled ? el('p', { class: 'setting-help', id: 'clientApiInfo', text: t(`地址 http://${client.host}:${client.port}/__client/v1/ ；令牌在仅你可读的文件 ${client.infoFile} 里，界面不显示。`, `Address http://${client.host}:${client.port}/__client/v1/ ; the token is in ${client.infoFile} (readable only by you) and is never shown here.`) }) : null,
        client.enabled ? el('button', { class: 'secondary', type: 'button', id: 'clientApiRotate', text: t('更换令牌', 'Rotate token'), onclick: () => ctx.onClientRotate?.() }) : null,
        client.error ? el('p', { class: 'setting-help', text: client.error }) : null));
    if (ctx.moreOpen?.()) more.setAttribute('open', '');
    more.addEventListener('toggle', () => ctx.onMoreToggle?.(more.open));

    const tabItems = [['providers', ctx.roles ? t('文本生成', 'Text') : t('供应商', 'Providers')], ...(ctx.roles ? [['embedding', t('嵌入', 'Embedding')], ['transcription', t('语音识别', 'Speech')]] : []), ['stats', t('使用统计', 'Usage')]];
    ctx.park?.();
    const tabs = root.UIKit
      ? (() => {
        const seg = root.UIKit.segmented({ options: tabItems.map(([value, label]) => ({ value, label })), value: view.tab, label: t('模型页面', 'Models sections'), className: 'pv-tabs-seg', onChange: id => ctx.onTab?.(id) });
        seg.el.querySelectorAll('.uk-seg-item').forEach(button => { button.id = `providerTab-${button.dataset.value}`; });
        return seg.el;
      })()
      : el('div', { class: 'pv-tabs', role: 'tablist', 'aria-label': t('模型页面', 'Models sections') },
        tabItems.map(([id, label]) => el('button', { type: 'button', role: 'tab', class: 'secondary pv-small', id: `providerTab-${id}`, 'aria-selected': view.tab === id ? 'true' : 'false', text: label, onclick: () => ctx.onTab?.(id) })));
    if (ctx.roles && (view.tab === 'embedding' || view.tab === 'transcription')) {
      const rolesHost = el('div', { class: 'mr-host', id: 'providerRolesHost', 'data-tab': view.tab });
      hostEl.replaceChildren(el('h2', { text: t('模型', 'Models') }), tabs, rolesHost);
      ctx.mountRoles?.(rolesHost, view.tab);
      return;
    }
    if (view.tab === 'stats') {
      const statsHost = el('div', { class: 'pu-host', id: 'providerStatsHost' });
      hostEl.replaceChildren(el('h2', { text: t('模型', 'Models') }), tabs, statsHost);
      ctx.mountStats?.(statsHost);
      return;
    }
    hostEl.replaceChildren(
      el('h2', { text: t('模型', 'Models') }),
      el('p', { class: 'muted', text: t('选一个默认模型就能用；其余用途需要时再单独指定。密钥只保存在系统钥匙串里。', 'Pick a default model and you are set; give other purposes their own model only when needed. Keys stay in the system keychain.') }),
      tabs,
      ...(view.notice ? [el('p', { class: 'pv-note', id: 'providerNotice', role: 'status', text: view.notice })] : []),
      el('div', { class: 'pv-split' }, el('div', { class: 'pv-leftcol' }, list, purposeEntries), (sel && purposePane()) || detail), more);
  }

  // 滚动容器：宿主往上最近的可滚动祖先（设置页的内容区），找不到就用文档本身。
  function scrollerOf(hostEl) {
    const doc = hostEl.ownerDocument, view = doc.defaultView;
    for (let node = hostEl.parentElement; node && node !== doc.body; node = node.parentElement) {
      const overflow = view && view.getComputedStyle ? view.getComputedStyle(node).overflowY : '';
      if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) return node;
    }
    return doc.scrollingElement || doc.documentElement;
  }
  function captureView(hostEl) {
    const scroller = scrollerOf(hostEl), active = hostEl.ownerDocument.activeElement;
    const focus = active && active !== hostEl.ownerDocument.body && hostEl.contains(active) && active.id ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
    return { scroller, top: scroller.scrollTop || 0, left: scroller.scrollLeft || 0, focus };
  }
  function restoreView(hostEl, keep) {
    const apply = () => {
      if (!keep.scroller.isConnected && keep.scroller !== hostEl.ownerDocument.scrollingElement) return;
      keep.scroller.scrollTop = keep.top; keep.scroller.scrollLeft = keep.left;
    };
    apply();
    if (keep.focus) {
      const node = hostEl.ownerDocument.getElementById(keep.focus.id);
      if (node && typeof node.focus === 'function' && !node.disabled) {
        node.focus({ preventScroll: true });
        if (typeof keep.focus.start === 'number' && typeof node.setSelectionRange === 'function') { try { node.setSelectionRange(keep.focus.start, keep.focus.end); } catch (_) { /* not a text field */ } }
      }
    }
    apply();
    const win = hostEl.ownerDocument.defaultView;
    if (win && win.requestAnimationFrame) win.requestAnimationFrame(apply);
  }

  function create(options = {}) {
    const state = { codex: null, hostEl: null, client: null, selected: '', dragging: '', open: '', more: false, page: 'list', fetched: {}, checking: '', checkMessage: {}, notice: '', tab: 'providers', balance: {}, balancing: '', codexTest: null, codexTesting: false, suggest: {}, combo: '' };
    const call = async (path, init) => {
      const response = await (options.fetch || root.fetch)(path, init), data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data && data.error ? data.error : t(`请求失败（${response.status}）`, `Request failed (${response.status})`));
      return data;
    };
    const settings = () => options.getSettings();
    const P = () => Providers();
    const Check = () => root.ProviderCheck || (typeof require === 'function' ? require('./provider-check.js') : null);
    const view = () => buildView(settings(), { codex: state.codex, client: state.client, selected: state.selected, fetched: state.fetched[state.selected] || [], checking: !!state.checking, checkMessage: state.checkMessage[state.selected] || '', notice: state.notice, tab: state.tab, balances: state.balance, balancing: state.balancing, codexTest: state.codexTest, codexTesting: state.codexTesting, suggest: state.suggest[state.selected] || '', usage: state.usage, usageBusy: !!state.usageBusy });
    const paint = () => {
      if (!state.hostEl || state.page !== 'list') return;
      if (state.tab === 'stats' && state.hostEl.querySelector('#providerStatsHost')) return;
      if ((state.tab === 'embedding' || state.tab === 'transcription') && state.hostEl.querySelector(`#providerRolesHost[data-tab="${state.tab}"]`)) { options.roles?.refresh?.(); return; }
      try { P().reconcile(settings(), options.reconcileOptions?.()); } catch (_) { /* a failed reconcile must not blank the page */ }
      // 整块重绘会丢掉滚动位置和焦点：重绘前记下，重绘后放回去，操作时页面不跳。
      const keep = captureView(state.hostEl);
      render(view(), api, state.hostEl);
      restoreView(state.hostEl, keep);
    };
    // 修改 → 投影到旧清单 → 通知宿主保存 / 同步旧入口。
    function commit(change) {
      const before = P().defaultSelection(settings());
      if (change() === false) return false;
      const after = P().defaultSelection(settings());
      const defaultChanged = !!after && (!before || before.provider !== after.provider || before.model !== after.model || before.effort !== after.effort);
      P().project(settings());
      Promise.resolve(options.onChange?.({ defaultChanged })).finally(paint);
      paint();
      return true;
    }
    const api = {
      legacy: options.legacy || null,
      dragging: () => state.dragging,
      openPurpose: () => state.open,
      onPurposeToggle: (role, open) => { state.open = open ? role : (state.open === role ? '' : state.open); },
      moreOpen: () => state.more,
      onMoreToggle: open => { state.more = !!open; },
      comboOpen: () => { const id = state.combo; state.combo = ''; return id; },
      onSelect: id => { state.selected = id; state.purposeSel = ''; paint(); },
      purposeSel: () => state.purposeSel || '',
      onPurposeSel: id => { state.purposeSel = state.purposeSel === id ? '' : id; paint(); },
      onDrag: id => { state.dragging = id; },
      onMove: (id, index) => { state.dragging = ''; commit(() => P().move(settings(), id, index)); },
      onDefault: option => { if (option) commit(() => { P().makeDefault(settings(), option.provider); if (option.model) P().addModel(settings(), option.provider, { model: option.model, label: option.label }); return P().moveModel(settings(), option.provider, option.model, 0); }); },
      onDefaultEffort: effort => { const def = P().defaultSelection(settings()); if (def) commit(() => P().setModelEffort(settings(), def.provider, def.model, effort)); },
      onPurpose: (role, option) => commit(() => P().setOverride(settings(), role, option ? { provider: option.provider, model: option.model, effort: '' } : null)),
      onPurposeEffort: (role, effort) => { const own = P().overrides(settings())[role]; if (own) commit(() => P().setOverride(settings(), role, { ...own, effort })); },
      onRename: (id, name) => commit(() => P().rename(settings(), id, name)),
      onModelMove: (id, model, index) => commit(() => P().moveModel(settings(), id, model, index)),
      onModelEffort: (id, model, effort) => commit(() => P().setModelEffort(settings(), id, model, effort)),
      onConnection: async (id, { base, protocol, token }) => {
        const item = P().get(settings(), id);
        if (!item) return t('找不到这个供应商。', 'Provider not found.');
        const normalized = P().normalizeItem({ kind: 'api', base });
        if (!normalized) return t('地址无效。', 'The address is invalid.');
        const nextBase = normalized.base;
        if (token) {
          try { await options.saveKey({ name: item.name, base: nextBase, protocol, token, model: item.models[0]?.model || '' }); }
          catch (error) { return error && error.message ? error.message : t('密钥没有保存成功。', 'The key could not be saved.'); }
        }
        let next = null;
        commit(() => { next = P().setConnection(settings(), id, { base: nextBase, protocol }); if (next && token) P().setNeedsKey(settings(), next.id, false); return !!next; });
        if (!next) return t('地址无效，或已有同一地址的供应商。', 'The address is invalid or already used by another provider.');
        state.selected = next.id; paint();
        return '';
      },
      onModelAdd: (id, model) => commit(() => P().addModel(settings(), id, model)),
      onModelRemove: (id, model) => commit(() => P().removeModel(settings(), id, model)),
      onRemove: (id, name) => {
        if (options.confirm && !options.confirm(t(`删除“${name}”？密钥仍留在钥匙串里。`, `Delete “${name}”? Its key stays in the keychain.`))) return;
        if (state.selected === id) state.selected = '';
        commit(() => P().remove(settings(), id));
      },
      onModelCaps: (id, model, key, on) => commit(() => { const current = P().get(settings(), id)?.models.find(entry => entry.model === model); return current ? P().setModelCaps(settings(), id, model, { ...current.caps, [key]: on }) : false; }),
      onTab: id => { state.tab = id; paint(); },
      roles: options.roles || null,
      park: () => options.roles?.park?.(),
      mountRoles: (node, which) => options.roles?.mount(node, which),
      mountStats: node => {
        const Stats = root.UsageStatsUI || (typeof require === 'function' ? require('./usage-stats-ui.js') : null);
        if (!Stats) return;
        Stats.mount(node, {
          load: range => call(`/__usage/query?range=${encodeURIComponent(range)}`),
          providerName: id => P().get(settings(), id)?.name || (id === 'codex-cli' ? 'ChatGPT' : id.replace(/^api:https?:\/\//, '')),
          getPrices: () => (settings() && settings().modelPrices) || {},
          setPrice: (model, price) => { const s = settings(); if (!s) return; const next = { ...(s.modelPrices || {}) }; if (price) next[model] = price; else delete next[model]; s.modelPrices = next; options.onChange?.({ defaultChanged: false }); },
          setRetention: days => call('/__usage/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ retentionDays: days }) }),
          clear: () => call('/__usage/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
          confirm: options.confirm
        });
      },
      onAdd: () => openAdd(),
      onImport: () => openImport(),
      onCheck: id => void runCheck(id, false),
      onBalance: id => void runBalance(id),
      onFetchModels: id => void runCheck(id, true),
      onApplyProtocol: (id, protocol) => { const item = P().get(settings(), id); if (!item) return; delete state.suggest[id]; state.checkMessage[id] = t(`已改用 ${PROTOCOL_LABELS[protocol] || protocol}。`, `Switched to ${PROTOCOL_LABELS[protocol] || protocol}.`); commit(() => !!P().setConnection(settings(), id, { base: item.base, protocol })); },
      onCodexCheck: async () => { await options.codexCheck?.(); await loadCodex(); },
      onCodexTest: async () => {
        if (state.codexTesting) return;
        state.codexTesting = true; paint();
        try { const outcome = await options.codexTest?.(); state.codexTest = outcome && typeof outcome === 'object' ? { ok: outcome.ok !== false, message: outcome.message || '' } : null; }
        catch (error) { state.codexTest = { ok: false, message: error && error.message ? error.message : t('测试失败。', 'The test failed.') }; }
        state.codexTesting = false; await loadCodex();
      },
      onUsage: () => void loadUsage(),
      onLoginMode: mode => {
        const item = P().items(settings()).find(entry => entry.kind === 'account');
        if (!item) return;
        state.usage = null; state.codexTest = null; state.codex = null;
        commit(() => !!P().upsert(settings(), { ...item, account: { ...item.account, login: mode } }));
        Promise.resolve(options.onLoginChanged?.()).finally(() => loadCodex());
      },
      onClientToggle: enabled => void clientCall(() => options.clientApi.set(enabled)),
      onClientRotate: () => void clientCall(() => options.clientApi.rotate())
    };
    // 测试连接：只读模型列表。密钥由宿主从钥匙串取，这里拿到后只用于这一次请求。
    async function runCheck(id, fetchModels) {
      const item = P().get(settings(), id);
      if (!item || item.kind !== 'api' || !options.credentials || !options.request || state.checking) return null;
      state.checking = id; state.checkMessage[id] = t('正在读取模型列表…', 'Reading the model list…'); paint();
      let result;
      try {
        const { token } = await options.credentials(item.base);
        result = await Check().run({ base: item.base, protocol: wireOf(item), token, request: options.request });
      } catch (error) { result = { ok: false, state: 'error', message: error && error.message ? error.message : t('无法读取这个服务的密钥。', 'Could not read the key for this service.') }; }
      let suggestion = '';
      if (result.ok && item.protocol !== 'anthropic' && !Check().isAnthropicWire?.(item) && Check().probeProtocols) {
        try {
          const { token } = await options.credentials(item.base);
          const configured = wireOf(item);
          suggestion = Check().suggestProtocol(configured, await Check().probeProtocols({ base: item.base, token, request: options.request }));
        } catch (_) { /* the probe is best effort */ }
      }
      state.checking = '';
      if (suggestion) state.suggest[id] = suggestion; else delete state.suggest[id];
      state.checkMessage[id] = result.message || '';
      if (result.models && result.models.length) { state.fetched[id] = result.models; if (fetchModels) state.combo = id; }
      P().setCheck(settings(), id, result);
      commit(() => true);
      return result;
    }
    async function runBalance(id) {
      const item = P().get(settings(), id), Balance = root.ProviderBalance || (typeof require === 'function' ? require('./provider-balance.js') : null);
      if (!item || item.kind !== 'api' || !Balance || !options.credentials || !options.request || state.balancing) return;
      state.balancing = id; paint();
      let result;
      try { const { token } = await options.credentials(item.base); result = await Balance.run({ base: item.base, token, request: options.request }); }
      catch (error) { result = { ok: false, state: 'error', items: [], message: error && error.message ? error.message : t('无法读取这个服务的密钥。', 'Could not read the key for this service.') }; }
      state.balancing = ''; state.balance[id] = result; paint();
    }
    function openAdd() {
      const Add = root.ProvidersAddUI || (typeof require === 'function' ? require('./providers-add-ui.js') : null);
      if (!Add || !state.hostEl) return;
      state.page = 'add';
      Add.mount(state.hostEl, {
        existing: () => P().items(settings()).map(item => item.id),
        onImport: () => openImport(),
        onClose: () => { state.page = 'list'; paint(); },
        onAddAccount: service => {
          if (service !== 'chatgpt') return;
          const added = P().upsert(settings(), { kind: 'account', account: { service: 'chatgpt', login: 'oauth' }, models: [] });
          if (added) { state.selected = added.id; commit(() => true); }
          state.page = 'list'; paint(); void loadCodex();
        },
        onSave: async payload => {
          try { await options.saveKey({ name: payload.name, base: payload.base, protocol: payload.protocol, token: payload.token, model: payload.models[0]?.model || '' }); }
          catch (error) { return { error: error && error.message ? error.message : t('密钥没有保存成功。', 'The key could not be saved.') }; }
          const before = P().defaultSelection(settings());
          const preset = payload.presetId ? (root.ProviderLibrary || (typeof require === 'function' ? require('./provider-library.js') : null))?.get(payload.presetId) : null;
          const added = P().upsert(settings(), { kind: 'api', preset: preset ? preset.id : '', name: payload.name, base: payload.base, protocol: payload.protocol, models: payload.models });
          if (!added) return { error: t('供应商数量已达上限（40）。', 'The provider limit (40) has been reached.') };
          if (payload.makeDefault) { P().makeDefault(settings(), added.id); }
          let result = { state: 'error' };
          if (options.request) {
            result = await Check().run({ base: added.base, protocol: wireOf(added), token: payload.token, request: options.request });
            P().setCheck(settings(), added.id, result);
            if (result.models && result.models.length) state.fetched[added.id] = result.models;
            state.checkMessage[added.id] = result.message || '';
          }
          const after = P().defaultSelection(settings());
          P().project(settings());
          const defaultChanged = !!after && (!before || before.provider !== after.provider || before.model !== after.model);
          await Promise.resolve(options.onChange?.({ defaultChanged }));
          return { id: added.id, check: result };
        },
        onDone: outcome => { state.page = 'list'; if (outcome && outcome.id) state.selected = outcome.id; paint(); }
      });
    }
    // 导入：选择文件（原生文件选择）或粘贴链接 → 服务端只读解析 → 预览（密钥只露末 4 位）→ 导入所选。
    function openImport() {
      const Import = root.ProvidersImportUI || (typeof require === 'function' ? require('./providers-import-ui.js') : null);
      if (!Import || !state.hostEl) return;
      state.page = 'import'; state.notice = '';
      Import.mount(state.hostEl, {
        apiId: base => Connections().apiId(base),
        existing: () => P().items(settings()).map(item => item.id),
        loadDefault: () => call('/__providers/ccswitch/default', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
        preview: ({ file, link }) => link
          ? call('/__providers/ccswitch/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ link }) })
          : call('/__providers/ccswitch/preview', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file }),
        commit: body => call('/__providers/ccswitch/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        cancel: importId => call('/__providers/ccswitch/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ importId }) }),
        apply: (items, opts) => applyImport(items, opts),
        onClose: () => { state.page = 'list'; paint(); },
        onDone: outcome => { state.page = 'list'; if (outcome && outcome.firstId) state.selected = outcome.firstId; state.notice = outcome ? outcome.summary : ''; paint(); }
      });
    }
    async function applyImport(items, { updateKeys = false } = {}) {
      const Lib = root.ProviderLibrary || (typeof require === 'function' ? require('./provider-library.js') : null);
      const before = P().defaultSelection(settings());
      let added = 0, updated = 0, firstId = '';
      const failed = [];
      for (const item of items) {
        const id = Connections().apiId(item.base);
        if (!id) { failed.push(item.name); continue; }
        const match = Lib && Lib.matchHost(item.host);
        const models = (item.models || []).map(name => ({ model: name, label: name, caps: (match && match.caps[name]) || { text: true } }));
        const existing = P().get(settings(), id);
        try {
          if (existing) {
            for (const entry of models) if (!existing.models.some(model => model.model === entry.model)) P().addModel(settings(), id, entry);
            if (updateKeys && item.token && options.saveKey) { await options.saveKey({ name: existing.name, base: item.base, protocol: item.protocol, token: item.token, model: existing.models[0] ? existing.models[0].model : '' }); if (existing.needsKey) P().setNeedsKey(settings(), id, false); }
            updated += 1;
          } else {
            if (item.token && options.saveKey) await options.saveKey({ name: item.name, base: item.base, protocol: item.protocol, token: item.token, model: models[0] ? models[0].model : '' });
            if (!P().upsert(settings(), { kind: 'api', preset: match ? match.preset : '', name: item.name, base: item.base, protocol: item.protocol, models, ...(item.token ? {} : { needsKey: true }) })) throw new Error('limit');
            added += 1;
          }
          if (!firstId) firstId = id;
        } catch (_) { failed.push(item.name); }
        item.token = '';
      }
      const after = P().defaultSelection(settings());
      P().project(settings());
      await Promise.resolve(options.onChange?.({ defaultChanged: !!after && (!before || before.provider !== after.provider || before.model !== after.model) }));
      const parts = [t(`已导入 ${added} 个`, `Imported ${added}`)];
      if (updated) parts.push(t(`更新 ${updated} 个`, `updated ${updated}`));
      if (failed.length) parts.push(t(`${failed.length} 个失败：${failed.slice(0, 3).join('、')}`, `${failed.length} failed: ${failed.slice(0, 3).join(', ')}`));
      return { added, updated, failed, firstId, summary: parts.join(t('，', ', ')) + t('。新导入的供应商显示“未验证”，可逐个测试连接；标“待补密钥”的点进详情补上密钥后才能使用。', '. Newly imported providers show Unverified; test each connection. Ones marked Key needed work after you add a key in their details.') };
    }
    async function clientCall(action) {
      try { state.client = await action(); } catch (error) { state.client = { ...(state.client || { enabled: false }), error: error.message }; }
      paint();
    }
    async function loadCodex() {
      try { state.codex = await options.codexSnapshot?.() || null; } catch (_) { /* keep the previous snapshot */ }
      syncAccountModels();
      paint();
      // 登录后自动查一次额度（只用我们自己的令牌）；之后靠“刷新额度”。
      if (state.codex && state.codex.mode === 'oauth' && state.codex.detected && state.codex.detected.loggedIn && !state.usage && !state.usageBusy) void loadUsage();
      if (state.codex && state.codex.mode === 'oauth' && state.codex.detected && !state.codex.detected.loggedIn && state.usage) { state.usage = null; paint(); }
    }
    // 官方列表读到后，账号的模型清单以它为准：已不可用的旧名字（例如过去的预设）退出，新的补上；主模型保持第一项。
    function syncAccountModels() {
      const codex = state.codex;
      if (!codex || codex.mode !== 'oauth' || !codex.live) return;
      const live = codexEntries(codex);
      const item = P().items(settings()).find(entry => entry.kind === 'account');
      if (!item || !live.length) return;
      const kept = item.models.filter(entry => live.some(other => other.model === entry.model));
      const next = [...kept, ...live.filter(entry => !kept.some(other => other.model === entry.model))].map(({ model, label, contextWindow, efforts }) => ({ model, label, contextWindow, efforts }));
      if (next.length === item.models.length && next.every((entry, index) => entry.model === item.models[index].model)) return;
      commit(() => !!P().upsert(settings(), { ...item, models: next }));
    }
    async function loadUsage() {
      if (!options.codexUsage || state.usageBusy) return;
      state.usageBusy = true; paint();
      try { const result = await options.codexUsage(); state.usage = { windows: Array.isArray(result && result.windows) ? result.windows : [], at: Date.now() }; }
      catch (error) { state.usage = { windows: [], error: error && error.message ? error.message : t('暂时无法读取额度。', 'Usage is unavailable right now.') }; }
      state.usageBusy = false; paint();
    }
    return {
      showTab(id) { if (['providers', 'embedding', 'transcription', 'stats'].includes(id)) api.onTab(id); },
      mount(hostEl) { state.hostEl = hostEl; paint(); void loadCodex(); if (options.clientApi) void clientCall(() => options.clientApi.load()); },
      refresh: paint, reloadCodex: loadCodex, select(id) { state.selected = id; paint(); }, openAdd, openImport, page: () => state.page,
      view
    };
  }

  return Object.freeze({ buildView, render, create, wireOf, effortLabel, captureView, restoreView });
}));
