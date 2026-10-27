/* Unified connection list: API services, Codex CLI and the (hidden) Claude CLI, plus per-role model choice. Public metadata only; keys stay in the keychain. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Connections = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  // 数据格式（state.settings.connections，version 1）：
  // { version:1, items:[{id,kind,name,base?,protocol?,login?,models:[…]}], claudeCli:false, claudeNoticeShown:false }
  // 角色选择（state.settings.modelRoles，version 1）：
  // { version:1, qa:{connection,model,effort}, translate:{…}, vision:{…}|null, kernel:{…}|null }
  // kernel（P9b）：后台运行内核用的模型（API 或 Codex CLI）；没选时跟随问答。单个 run 可用 request.model 覆盖。
  // 模型条目沿用 ModelCatalog 的格式；旧的 modelCatalog 与 localStorage 键保持不动，降级后旧版照常工作。
  const VERSION = 1, MAX_ITEMS = 40;
  const KINDS = ['api', 'codex-cli', 'claude-cli'];
  // oauth = AI Bro's own ChatGPT sign-in; private = a Codex CLI login kept inside AI Bro; shared = the Codex login already on this Mac.
  const LOGINS = ['oauth', 'private', 'shared'];
  const PROTOCOLS = ['auto', 'responses', 'chat', 'anthropic'];
  const ROLES = ['qa', 'translate', 'vision', 'kernel'];
  const PROVIDER_OF = { api: 'api', 'codex-cli': 'openai-auth', 'claude-cli': 'claude-auth' };
  const KIND_OF_PROVIDER = { api: 'api', 'openai-auth': 'codex-cli', 'claude-auth': 'claude-cli' };
  const CODEX_ID = 'codex-cli', CLAUDE_ID = 'claude-cli';
  const catalog = () => root.ModelCatalog || (typeof require === 'function' ? require('./model-catalog.js') : null);
  const text = (value, max) => String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  const copy = value => JSON.parse(JSON.stringify(value));

  const serviceKey = base => catalog()?.serviceKey(base) || '';
  const apiId = base => { const key = serviceKey(base); return key ? `api:${key}` : ''; };
  const hostOf = base => { try { return new URL(String(base || '').trim()).hostname.toLowerCase(); } catch (_) { return ''; } };

  // 只认官方地址：“自动”不按模型名猜 Anthropic，也不把第三方中转当成 Messages。
  function isOfficialAnthropic(base) {
    try {
      const url = new URL(String(base || '').trim());
      return url.protocol === 'https:' && url.hostname.toLowerCase() === 'api.anthropic.com' && !url.port && !url.username && !url.password;
    } catch (_) { return false; }
  }
  // 返回 'anthropic'，或 ''（交给 agent-transport 原有的 responses/chat 判定）。
  function detectProtocol(base, protocol) {
    if (protocol === 'anthropic') return 'anthropic';
    if (protocol === 'responses' || protocol === 'chat') return protocol;
    return isOfficialAnthropic(base) ? 'anthropic' : '';
  }

  function normalizeItem(raw) {
    if (!raw || typeof raw !== 'object' || !KINDS.includes(raw.kind)) return null;
    const cat = catalog();
    const models = cat ? cat.normalizeList(raw.models) : [];
    if (raw.kind === 'api') {
      const id = apiId(raw.base);
      if (!id) return null;
      const url = new URL(String(raw.base).trim());
      const protocol = PROTOCOLS.includes(raw.protocol) ? raw.protocol : 'auto';
      return { id, kind: 'api', name: text(raw.name, 80) || url.hostname, base: serviceKey(raw.base), protocol, models };
    }
    if (raw.kind === 'codex-cli') {
      return { id: CODEX_ID, kind: 'codex-cli', name: text(raw.name, 80) || 'Codex CLI', login: loginOf(raw.login), models };
    }
    return { id: CLAUDE_ID, kind: 'claude-cli', name: text(raw.name, 80) || 'Claude Code', models };
  }

  function stateOf(settings) {
    const value = settings && settings.connections;
    return value && typeof value === 'object' && value.version === VERSION && Array.isArray(value.items) ? value : null;
  }

  function items(settings, { includeHidden = false } = {}) {
    const state = stateOf(settings);
    if (!state) return [];
    const out = [], seen = new Set();
    for (const raw of state.items) {
      const item = normalizeItem(raw);
      if (!item || seen.has(item.id)) continue;
      if (item.kind === 'claude-cli' && !includeHidden && !claudeCliEnabled(settings)) continue;
      seen.add(item.id); out.push(item);
      if (out.length >= MAX_ITEMS) break;
    }
    return out;
  }

  function get(settings, id) { return items(settings, { includeHidden: true }).find(item => item.id === id) || null; }

  function claudeCliEnabled(settings) { return stateOf(settings)?.claudeCli === true; }

  function ensureState(settings) {
    if (!settings) return null;
    // 未来版本或损坏的清单不覆盖，避免降级写回丢数据。
    if (settings.connections && !stateOf(settings)) {
      if (Number(settings.connections.version) > VERSION) return null;
      settings.connectionsBackup = settings.connections;
    }
    return stateOf(settings) || (settings.connections = { version: VERSION, items: [], claudeCli: false, claudeNoticeShown: false });
  }

  function upsert(settings, raw) {
    const state = ensureState(settings), item = normalizeItem(raw);
    if (!state || !item) return null;
    const index = state.items.findIndex(existing => existing && existing.id === item.id);
    if (index >= 0) state.items[index] = item;
    else if (state.items.length < MAX_ITEMS) state.items.push(item);
    else return null;
    return copy(item);
  }

  function remove(settings, id) {
    const state = stateOf(settings);
    if (!state) return false;
    const before = state.items.length;
    state.items = state.items.filter(item => item && item.id !== id);
    return state.items.length < before;
  }

  function loginOf(value) { return LOGINS.includes(value) ? value : 'oauth'; }
  function codexLogin(settings) { return loginOf(get(settings, CODEX_ID)?.login); }
  function setCodexLogin(settings, mode) {
    const state = ensureState(settings);
    if (!state) return false;
    const item = state.items.find(existing => existing && existing.id === CODEX_ID);
    if (!item) return !!upsert(settings, { kind: 'codex-cli', login: mode });
    item.login = loginOf(mode);
    return true;
  }

  function setClaudeCliEnabled(settings, enabled) {
    const state = ensureState(settings);
    if (!state) return false;
    state.claudeCli = enabled === true;
    return true;
  }

  // 旧配置 → 清单。只补空缺，从不覆盖已有条目；旧键一个都不改。
  // legacy: { provider, base, model, protocol, profiles:[{base,model,settings:{protocol}}], codexModel, claudeModel }
  function migrate(settings, legacy = {}) {
    if (!settings) return 0;
    const state = ensureState(settings);
    if (!state) return 0;
    const cat = catalog();
    let added = 0;
    const sources = [];
    if (legacy.base) sources.push({ base: legacy.base, model: legacy.model, protocol: legacy.protocol });
    for (const profile of Array.isArray(legacy.profiles) ? legacy.profiles : []) {
      sources.push({ base: profile?.base, model: profile?.model, protocol: profile?.settings?.protocol, name: profile?.name });
    }
    for (const source of sources) {
      const id = apiId(source.base);
      if (!id || state.items.some(item => item && item.id === id)) continue;
      const models = cat ? cat.ensureModel(cat.read(settings, source.base), source.model) : [];
      const item = normalizeItem({ kind: 'api', base: source.base, protocol: source.protocol, name: source.name, models });
      if (item) { state.items.push(item); added += 1; }
    }
    if (!state.items.some(item => item && item.id === CODEX_ID)) {
      const models = cat && legacy.codexModel ? cat.ensureModel([], legacy.codexModel) : [];
      // 默认用 AI Bro 自己的 ChatGPT 账号登录（oauth）；用过 Codex 单独登录的人保持原样，复用本机 Codex 登录只在“更多”里手动开启。
      state.items.push(normalizeItem({ kind: 'codex-cli', models, login: legacy.provider === 'openai-auth' ? 'private' : 'oauth' })); added += 1;
    }
    // Claude 条目仍保留（代码保留、默认关闭），只是不出现在界面里。
    if (!state.items.some(item => item && item.id === CLAUDE_ID)) {
      const models = cat && legacy.claudeModel ? cat.ensureModel([], legacy.claudeModel) : [];
      state.items.push(normalizeItem({ kind: 'claude-cli', models })); added += 1;
    }
    seedRoles(settings, legacy);
    return added;
  }

  const normalizeRole = raw => {
    if (!raw || typeof raw !== 'object') return null;
    const connection = text(raw.connection, 300), model = text(raw.model, 200);
    if (!connection) return null;
    return { connection, model, effort: text(raw.effort, 20) };
  };

  function rolesOf(settings) {
    const value = settings && settings.modelRoles;
    return value && typeof value === 'object' && value.version === VERSION ? value : null;
  }

  function seedRoles(settings, legacy) {
    if (settings.modelRoles && !rolesOf(settings)) return;
    if (rolesOf(settings)) return;
    const kind = KIND_OF_PROVIDER[legacy.provider] || 'api';
    const connection = kind === 'api' ? apiId(legacy.base) : kind === 'codex-cli' ? CODEX_ID : CLAUDE_ID;
    if (!connection) return;
    const model = kind === 'api' ? legacy.model : kind === 'codex-cli' ? legacy.codexModel : legacy.claudeModel;
    // 问答沿用现有默认；翻译默认跟随问答（不写入，读取时回退）。
    settings.modelRoles = { version: VERSION, qa: normalizeRole({ connection, model, effort: '' }), translate: null, vision: null, kernel: null };
  }

  function setRole(settings, role, selection) {
    if (!ROLES.includes(role) || !settings) return false;
    if (settings.modelRoles && !rolesOf(settings)) { if (Number(settings.modelRoles.version) > VERSION) return false; settings.modelRoles = null; }
    const roles = rolesOf(settings) || (settings.modelRoles = { version: VERSION, qa: null, translate: null, vision: null, kernel: null });
    if (selection == null) { roles[role] = null; return true; }
    const value = normalizeRole(selection);
    if (!value) return false;
    roles[role] = value; return true;
  }

  // 解析某个角色最终用哪个连接/模型/强度。translate、vision、kernel 没单独选时跟随问答。
  // Claude 登录入口撤下后，选了 claude-cli 的角色回退到问答；问答本身也是 claude-cli 时返回 null。
  function resolveRole(settings, role) {
    const roles = rolesOf(settings);
    if (!roles || !ROLES.includes(role)) return null;
    let chosen = normalizeRole(roles[role]) || (role === 'qa' ? null : normalizeRole(roles.qa));
    if (!chosen) return null;
    let item = get(settings, chosen.connection);
    if (item && item.kind === 'claude-cli' && !claudeCliEnabled(settings)) {
      chosen = role === 'qa' ? null : normalizeRole(roles.qa);
      item = chosen ? get(settings, chosen.connection) : null;
      if (item && item.kind === 'claude-cli') item = null;
    }
    if (!chosen || !item) return null;
    const entry = catalog()?.find(item.models, chosen.model) || null;
    const wire = item.kind === 'api' ? (detectProtocol(item.base, item.protocol) || (item.protocol === 'auto' ? '' : item.protocol)) : '';
    return { role, connection: item.id, kind: item.kind, provider: PROVIDER_OF[item.kind], base: item.base || '', protocol: wire, configuredProtocol: item.protocol || '', model: chosen.model, effort: chosen.effort, entry, followsQa: !normalizeRole(roles[role]) && role !== 'qa' };
  }

  // 旧对话用过 Claude 账号登录：入口撤下后改用默认模型（问答角色），提示只出现一次。
  function claudeFallback(settings, modelConfig) {
    if (!modelConfig || modelConfig.provider !== 'claude-auth' || claudeCliEnabled(settings)) return null;
    const fallback = resolveRole(settings, 'qa');
    const state = stateOf(settings);
    const notice = !!state && !state.claudeNoticeShown;
    if (notice) state.claudeNoticeShown = true;
    return { config: fallback ? { provider: fallback.provider, model: fallback.model, effort: fallback.effort } : null, notice, message: notice ? { zh: '这个对话原来使用 Claude 账号登录，该入口已撤下，现已改用默认模型。', en: 'This conversation used Claude account login, which has been retired. It now uses the default model.' } : null };
  }

  // 各协议能表达的思考强度档位（协议字段对用户不可见，只在请求层使用）。
  const ANTHROPIC_BUDGETS = Object.freeze({ minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32768, max: 49152 });
  function effortLevels(kind, protocol) {
    if (kind === 'api' && protocol === 'anthropic') return ['none', ...Object.keys(ANTHROPIC_BUDGETS)];
    const cat = catalog();
    return cat ? cat.protocolEfforts(kind === 'api' && (protocol === 'responses' || protocol === 'chat') ? protocol : 'auto') : [];
  }
  function anthropicBudget(effort) { return ANTHROPIC_BUDGETS[effort] || null; }

  return Object.freeze({ VERSION, KINDS, LOGINS, PROTOCOLS, ROLES, CODEX_ID, CLAUDE_ID, PROVIDER_OF, KIND_OF_PROVIDER, apiId, hostOf, isOfficialAnthropic, detectProtocol, normalizeItem, items, get, upsert, remove, claudeCliEnabled, setClaudeCliEnabled, codexLogin, setCodexLogin, migrate, normalizeRole, setRole, resolveRole, claudeFallback, effortLevels, anthropicBudget });
}));
