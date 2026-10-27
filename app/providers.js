/* Provider list (version 2): ordered providers, the first one is the default model; per-purpose overrides only store what differs.
   Public metadata only; keys stay in the keychain. The v1 lists (settings.connections / settings.modelRoles) are kept in step
   as a projection so every existing reader and a downgraded app keep working. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Providers = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  // 数据格式（state.settings.providers，version 2）：
  // { version:2, items:[{ id, kind:'api'|'account', preset?, name, base?, protocol:'auto'|'responses'|'chat'|'anthropic',
  //   account?:{service:'chatgpt', login:'oauth'|'private'|'shared'}, models:[{model,label,contextWindow,efforts,role:'primary'|'fallback',caps,effort}] }] }
  // 用途覆盖（state.settings.roles，version 2）：{ version:2, overrides:{ translate?:{provider,model,effort}, vision?:…, kernel?:… },
  //   embedding?:{ provider, base, model, dimensions, enabled }, transcription?:{ source, scheme, model, realtime } }
  // embedding / transcription 与 overrides 并列：前者镜像知识库语义检索的服务（旧键 aibro-embedding-settings-v1 仍是引擎的事实来源），
  // 后者只是原生壳语音转文字配置的公开摘要（密钥与方案由原生壳独立保存）。重写 overrides 时必须保留它们。
  // 默认模型 = items[0] 的主模型；问答永远跟随默认，不单独存。
  const VERSION = 2, MAX_ITEMS = 40, MAX_MODELS = 200;
  const OVERRIDE_ROLES = ['translate', 'vision', 'kernel'];
  const KINDS = ['api', 'account'];
  const PROTOCOLS = ['auto', 'responses', 'chat', 'anthropic'];
  const CAPS = ['image', 'text', 'vision', 'think'];
  const ACCOUNT_SERVICES = ['chatgpt'];
  const CHATGPT_ID = 'codex-cli';
  const connections = () => root.Connections || (typeof require === 'function' ? require('./connections.js') : null);
  const catalog = () => root.ModelCatalog || (typeof require === 'function' ? require('./model-catalog.js') : null);
  const text = (value, max) => String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  const copy = value => JSON.parse(JSON.stringify(value));
  const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

  function normalizeCaps(raw) {
    if (!isObject(raw)) return {};
    const caps = {};
    for (const key of CAPS) if (typeof raw[key] === 'boolean') caps[key] = raw[key];
    return caps;
  }

  function normalizeModel(raw, index) {
    const cat = catalog();
    const base = cat ? cat.normalizeList([raw])[0] : null;
    if (!base) return null;
    return { ...base, role: index === 0 ? 'primary' : 'fallback', caps: normalizeCaps(raw.caps), effort: text(raw.effort, 20) };
  }

  // 主模型永远是第一项；其余都是备用，顺序即切换顺序。
  function normalizeModels(list) {
    const seen = new Set(), out = [];
    for (const raw of Array.isArray(list) ? list : []) {
      const key = isObject(raw) ? text(raw.model, 200) : '';
      if (!key || seen.has(key)) continue;
      const entry = normalizeModel(raw, out.length);
      if (!entry) continue;
      seen.add(key); out.push(entry);
      if (out.length >= MAX_MODELS) break;
    }
    return out;
  }

  function normalizeItem(raw) {
    if (!isObject(raw) || !KINDS.includes(raw.kind)) return null;
    const models = normalizeModels(raw.models);
    if (raw.kind === 'api') {
      const C = connections(), id = C.apiId(raw.base);
      if (!id) return null;
      const protocol = PROTOCOLS.includes(raw.protocol) ? raw.protocol : 'auto';
      const item = { id, kind: 'api', name: text(raw.name, 80) || C.hostOf(raw.base) || id, base: catalog().serviceKey(raw.base), protocol, models };
      if (raw.preset) item.preset = text(raw.preset, 60);
      if (raw.needsKey === true) item.needsKey = true;
      const check = normalizeCheck(raw.check);
      if (check) item.check = check;
      return item;
    }
    const service = isObject(raw.account) && ACCOUNT_SERVICES.includes(raw.account.service) ? raw.account.service : '';
    if (!service) return null;
    return { id: CHATGPT_ID, kind: 'account', name: text(raw.name, 80) || 'ChatGPT', account: { service, login: connections().LOGINS.includes(raw.account.login) ? raw.account.login : 'oauth' }, models };
  }

  // 最近一次“测试连接”的结果（只记时间、是否成功、状态，不记服务返回的任何内容）。
  const CHECK_STATES = ['ok', 'reachable', 'auth', 'error', 'timeout', 'unreachable', 'invalid'];
  function normalizeCheck(raw) {
    if (!isObject(raw) || !Number.isFinite(raw.at) || !CHECK_STATES.includes(raw.state)) return null;
    return { at: Math.floor(raw.at), ok: raw.state === 'ok' || raw.state === 'reachable', state: raw.state };
  }

  function normalizeOverride(raw) {
    if (!isObject(raw)) return null;
    const provider = text(raw.provider, 300);
    return provider ? { provider, model: text(raw.model, 200), effort: text(raw.effort, 20) } : null;
  }

  // 重写 overrides 时保留并列的 embedding / transcription，旧版本也不会因此丢字段。
  const rolesWith = (settings, kept) => ({ ...(isObject(settings.roles) ? settings.roles : {}), version: VERSION, overrides: kept });
  const isV2 = value => isObject(value) && value.version === VERSION && Array.isArray(value.items);
  const isFuture = value => isObject(value) && Number(value.version) > VERSION;

  // 读取：只返回规范化后的副本，损坏的条目跳过。
  function items(settings) {
    if (!isV2(settings && settings.providers)) return [];
    const out = [], seen = new Set();
    for (const raw of settings.providers.items) {
      const item = normalizeItem(raw);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id); out.push(item);
      if (out.length >= MAX_ITEMS) break;
    }
    return out;
  }
  const get = (settings, id) => items(settings).find(item => item.id === id) || null;
  // 用户亲手删掉的供应商：旧入口（设置页的“模型连接”卡）还留着它时，不再自动加回来。
  const removedIds = settings => (isV2(settings && settings.providers) && Array.isArray(settings.providers.removed) ? settings.providers.removed : []).filter(id => typeof id === 'string').slice(-100);
  function overrides(settings) {
    const value = settings && settings.roles;
    const out = {};
    if (!isObject(value) || value.version !== VERSION || !isObject(value.overrides)) return out;
    for (const role of OVERRIDE_ROLES) {
      const entry = normalizeOverride(value.overrides[role]);
      if (entry) out[role] = entry;
    }
    return out;
  }

  const primaryOf = item => (item && item.models[0] && item.models[0].model) || '';
  function defaultSelection(settings) {
    const first = items(settings).find(item => !item.needsKey);
    return first ? { provider: first.id, model: primaryOf(first), effort: first.models[0]?.effort || '' } : null;
  }

  // 视觉“自动”：默认模型自己带“视”（或还没人标过任何能力）就跟随默认；否则取列表里第一个带“视”的模型。
  function visionAuto(settings) {
    const list = items(settings).filter(item => !item.needsKey), def = list[0];
    if (!def) return null;
    const flagged = item => item.models.some(model => model.caps.vision === true);
    if (!list.some(flagged)) return { provider: def.id, model: primaryOf(def), effort: '', auto: 'default' };
    const first = def.models[0];
    if (first && first.caps.vision === true) return { provider: def.id, model: first.model, effort: first.effort, auto: 'default' };
    for (const item of list) {
      const model = item.models.find(entry => entry.caps.vision === true);
      if (model) return { provider: item.id, model: model.model, effort: model.effort, auto: 'vision' };
    }
    return { provider: def.id, model: primaryOf(def), effort: '', auto: 'default' };
  }

  // ---- v1 → v2 迁移（纯函数）----
  // 返回 { providers, roles } 的新对象，或 null（输入来自未来版本，调用方什么都不写）。
  // 空数据、损坏数据都得到一个空清单；v1 的数据本身一个字都不改。
  // options.matchPreset(host) 可选：命中预设时返回 {preset,name?,protocol?,caps?:{model:caps}}，用来补图标和能力标签。
  function migrateFromV1(settings, options = {}) {
    const source = isObject(settings) ? settings : {};
    if (isFuture(source.connections) || isFuture(source.modelRoles)) return null;
    const C = connections();
    const v1 = isObject(source.connections) && source.connections.version === 1 && Array.isArray(source.connections.items) ? source.connections : null;
    const roles1 = isObject(source.modelRoles) && source.modelRoles.version === 1 ? source.modelRoles : null;
    const qa = roles1 ? C.normalizeRole(roles1.qa) : null;
    const list = [];
    const seen = new Set();
    for (const raw of v1 ? v1.items : []) {
      let legacy = null;
      try { legacy = C.normalizeItem(raw); } catch (_) { legacy = null; }
      if (!legacy || legacy.kind === 'claude-cli' || seen.has(legacy.id)) continue;
      seen.add(legacy.id);
      const models = legacy.models.map(entry => ({ ...entry }));
      let item;
      if (legacy.kind === 'api') {
        const match = typeof options.matchPreset === 'function' ? options.matchPreset : (root.ProviderLibrary && root.ProviderLibrary.matchHost);
        const preset = typeof match === 'function' ? match(C.hostOf(legacy.base)) : null;
        if (preset && preset.caps) for (const entry of models) if (preset.caps[entry.model]) entry.caps = preset.caps[entry.model];
        item = { kind: 'api', preset: preset && preset.preset, name: legacy.name, base: legacy.base, protocol: legacy.protocol, models };
      } else {
        item = { kind: 'account', name: 'ChatGPT', account: { service: 'chatgpt', login: legacy.login }, models };
      }
      // 默认模型当前选的那个排到主位；其余保持旧顺序，全部当备用。
      if (qa && qa.connection === legacy.id && qa.model) {
        const at = models.findIndex(entry => entry.model === qa.model);
        const chosen = at >= 0 ? models.splice(at, 1)[0] : { model: qa.model };
        if (qa.effort) chosen.effort = qa.effort;
        models.unshift(chosen);
      }
      list.push({ id: legacy.id, item });
    }
    // 默认（问答当前选的）连接排到首位，其余按旧顺序。
    if (qa) {
      const at = list.findIndex(entry => entry.id === qa.connection);
      if (at > 0) list.unshift(...list.splice(at, 1));
    }
    const providers = { version: VERSION, items: list.map(entry => normalizeItem(entry.item)).filter(Boolean) };
    const overridesOut = {};
    const def = providers.items[0] ? { provider: providers.items[0].id, model: primaryOf(providers.items[0]), effort: providers.items[0].models[0]?.effort || '' } : null;
    for (const role of OVERRIDE_ROLES) {
      const chosen = roles1 ? C.normalizeRole(roles1[role]) : null;
      if (!chosen || !providers.items.some(item => item.id === chosen.connection)) continue;
      // 与默认（供应商 + 模型 + 强度）完全相同就不存覆盖。
      if (def && chosen.connection === def.provider && chosen.model === def.model && chosen.effort === def.effort) continue;
      overridesOut[role] = { provider: chosen.connection, model: chosen.model, effort: chosen.effort };
    }
    return { providers, roles: { version: VERSION, overrides: overridesOut } };
  }

  // 首次使用：把 v1 迁移成 v2 并写入 settings。已有有效 v2 不动；未来版本不覆盖，返回 false。
  function ensure(settings, options = {}) {
    if (!isObject(settings)) return false;
    if (isFuture(settings.providers) || isFuture(settings.roles)) return false;
    if (isV2(settings.providers)) {
      if (!isObject(settings.roles) || settings.roles.version !== VERSION) settings.roles = { version: VERSION, overrides: {} };
      return true;
    }
    const migrated = migrateFromV1(settings, options);
    if (!migrated) return false;
    // 损坏的旧值留一份备份，便于以后手工恢复。
    if (settings.providers != null) settings.providersBackup = settings.providers;
    settings.providers = migrated.providers;
    settings.roles = migrated.roles;
    return true;
  }

  // 旧入口（设置页的“模型连接”卡、对话里的模型选择）可能改了 v1：把差异并回 v2。只补空缺，不删除。
  function reconcile(settings, options = {}) {
    if (!ensure(settings, options)) return false;
    const C = connections();
    const list = items(settings), gone = new Set(removedIds(settings));
    let changed = false;
    const v1 = C.items(settings, { includeHidden: false });
    for (const legacy of v1) {
      if (legacy.kind === 'claude-cli' || gone.has(legacy.kind === 'codex-cli' ? CHATGPT_ID : legacy.id)) continue;
      const existing = list.find(item => item.id === (legacy.kind === 'codex-cli' ? CHATGPT_ID : legacy.id));
      if (!existing) {
        const migrated = migrateFromV1({ connections: { version: 1, items: [legacy] } }, options);
        const added = migrated && migrated.providers.items[0];
        if (added && list.length < MAX_ITEMS) { list.push(added); changed = true; }
        continue;
      }
      for (const entry of legacy.models) {
        if (!existing.models.some(model => model.model === entry.model) && existing.models.length < MAX_MODELS) { existing.models.push({ ...entry, role: 'fallback', caps: {}, effort: '' }); changed = true; }
      }
    }
    const qa = C.normalizeRole(settings.modelRoles && settings.modelRoles.version === 1 ? settings.modelRoles.qa : null);
    if (qa && list.length) {
      const at = list.findIndex(item => item.id === qa.connection);
      if (at >= 0) {
        if (at > 0) { list.unshift(...list.splice(at, 1)); changed = true; }
        const item = list[0];
        if (qa.model && primaryOf(item) !== qa.model) {
          const found = item.models.findIndex(model => model.model === qa.model);
          const chosen = found >= 0 ? item.models.splice(found, 1)[0] : { model: qa.model };
          item.models.unshift(chosen); changed = true;
        }
        if (item.models[0] && item.models[0].effort !== qa.effort && qa.model) { item.models[0].effort = qa.effort; changed = true; }
      }
    }
    if (changed) settings.providers = { version: VERSION, items: list.map(item => normalizeItem(item)).filter(Boolean), removed: removedIds(settings) };
    return true;
  }

  // ---- 修改（都作用在 settings 上，调用方负责 project + save）----
  function write(settings, list, removed) {
    if (!ensure(settings)) return false;
    settings.providers = { version: VERSION, items: list.slice(0, MAX_ITEMS).map(normalizeItem).filter(Boolean), removed: removed || removedIds(settings) };
    return true;
  }
  function mutate(settings, id, change) {
    if (!ensure(settings)) return false;
    const list = items(settings), item = list.find(entry => entry.id === id);
    if (!item) return false;
    change(item, list);
    return write(settings, list);
  }

  function upsert(settings, raw) {
    if (!ensure(settings)) return null;
    const item = normalizeItem(raw);
    if (!item) return null;
    const list = items(settings), at = list.findIndex(entry => entry.id === item.id);
    if (at >= 0) list[at] = { ...list[at], ...item, models: item.models.length ? item.models : list[at].models };
    else if (list.length < MAX_ITEMS) list.push(item);
    else return null;
    return write(settings, list, removedIds(settings).filter(id => id !== item.id)) ? get(settings, item.id) : null;
  }

  // 导入时没有密钥的供应商先标“待补密钥”：补上密钥之前不参与默认模型和各用途的选择。
  function setNeedsKey(settings, id, needsKey) {
    if (!ensure(settings)) return false;
    const list = items(settings), at = list.findIndex(entry => entry.id === id);
    if (at < 0 || list[at].kind !== 'api') return false;
    const next = { ...list[at] };
    if (needsKey) next.needsKey = true; else delete next.needsKey;
    list[at] = next;
    return write(settings, list);
  }

  // 删除供应商：覆盖里指向它的用途回到“跟随默认”。账号类（ChatGPT）也可以从列表移除，重新添加时再检测。
  function remove(settings, id) {
    if (!ensure(settings)) return false;
    const list = items(settings), next = list.filter(item => item.id !== id);
    if (next.length === list.length) return false;
    write(settings, next, [...removedIds(settings).filter(entry => entry !== id), id]);
    const kept = overrides(settings);
    for (const role of OVERRIDE_ROLES) if (kept[role] && kept[role].provider === id) delete kept[role];
    settings.roles = rolesWith(settings, kept);
    const emb = purposeRole(settings, 'embedding');
    if (emb && emb.provider === id) setPurposeRole(settings, 'embedding', { ...emb, provider: '' });
    return true;
  }

  // 改地址 / 协议（只对 API 类）。地址变了 id 也变：覆盖里的指向、已删除记录一并换新；目标地址已存在时拒绝。
  function setConnection(settings, id, change) {
    if (!ensure(settings) || !isObject(change)) return null;
    const list = items(settings), item = list.find(entry => entry.id === id);
    if (!item || item.kind !== 'api') return null;
    const protocol = change.protocol == null ? item.protocol : change.protocol;
    if (!PROTOCOLS.includes(protocol)) return null;
    const base = change.base == null || !String(change.base).trim() ? item.base : String(change.base).trim();
    const nextId = connections().apiId(base);
    if (!nextId) return null;
    if (nextId !== id && list.some(entry => entry.id === nextId)) return null;
    const next = normalizeItem({ ...item, base, protocol });
    if (!next) return null;
    list[list.indexOf(item)] = { ...item, ...next, name: item.name, models: item.models };
    let removed = removedIds(settings);
    if (nextId !== id) {
      removed = [...removed.filter(entry => entry !== nextId), id];
      const kept = overrides(settings);
      for (const role of OVERRIDE_ROLES) if (kept[role] && kept[role].provider === id) kept[role] = { ...kept[role], provider: nextId };
      settings.roles = rolesWith(settings, kept);
      const emb = purposeRole(settings, 'embedding');
      if (emb && emb.provider === id) setPurposeRole(settings, 'embedding', { ...emb, provider: nextId });
    }
    return write(settings, list, removed) ? get(settings, nextId) : null;
  }

  function rename(settings, id, name) {
    const value = text(name, 80);
    return !!value && mutate(settings, id, item => { item.name = value; });
  }

  // 拖拽 / 上下移动：from → to（下标）。首位变化即默认变化。
  function move(settings, id, toIndex) {
    return mutate(settings, id, (item, list) => {
      const at = list.indexOf(item);
      list.splice(at, 1);
      list.splice(Math.max(0, Math.min(list.length, toIndex)), 0, item);
    });
  }
  const makeDefault = (settings, id) => move(settings, id, 0);

  // 模型：主模型 + 备用，顺序即优先级。
  function moveModel(settings, id, model, toIndex) {
    return mutate(settings, id, item => {
      const at = item.models.findIndex(entry => entry.model === model);
      if (at < 0) return;
      const [entry] = item.models.splice(at, 1);
      item.models.splice(Math.max(0, Math.min(item.models.length, toIndex)), 0, entry);
    });
  }
  function addModel(settings, id, raw) {
    const entry = typeof raw === 'string' ? { model: raw } : raw;
    return mutate(settings, id, item => {
      if (!isObject(entry) || !text(entry.model, 200) || item.models.some(model => model.model === text(entry.model, 200))) return;
      item.models.push({ ...entry, caps: entry.caps || {} });
    });
  }
  function removeModel(settings, id, model) {
    return mutate(settings, id, item => { item.models = item.models.filter(entry => entry.model !== model); });
  }
  function setModelCaps(settings, id, model, caps) {
    return mutate(settings, id, item => { const entry = item.models.find(candidate => candidate.model === model); if (entry) entry.caps = normalizeCaps(caps); });
  }
  function setModelEffort(settings, id, model, effort) {
    return mutate(settings, id, item => { const entry = item.models.find(candidate => candidate.model === model); if (entry) entry.effort = text(effort, 20); });
  }

  // 同一供应商里排在当前模型后面的模型，按顺序作备用；明确标了“不支持工具调用”的跳过。账号类没有备用。
  function fallbackModels(settings, id, model) {
    const item = get(settings, id);
    if (!item || item.kind !== 'api') return [];
    const at = item.models.findIndex(entry => entry.model === model);
    if (at < 0) return [];
    return item.models.slice(at + 1).filter(entry => entry.caps.text !== false).map(entry => entry.model);
  }

  function setCheck(settings, id, result) {
    const check = normalizeCheck({ at: Date.now(), state: result && result.state });
    return !!check && mutate(settings, id, item => { item.check = check; });
  }

  function setOverride(settings, role, selection) {
    if (!OVERRIDE_ROLES.includes(role) || !ensure(settings)) return false;
    const kept = overrides(settings);
    if (selection == null) delete kept[role];
    else {
      const entry = normalizeOverride(selection);
      if (!entry || !get(settings, entry.provider)) return false;
      kept[role] = entry;
    }
    settings.roles = rolesWith(settings, kept);
    return true;
  }

  // ---- 按用途的非对话角色：embedding（嵌入）/ transcription（语音转文字） ----
  const PURPOSE_ROLES = ['embedding', 'transcription'];
  function normalizePurpose(role, raw) {
    if (!isObject(raw)) return null;
    if (role === 'embedding') {
      const dimensions = Number(raw.dimensions);
      return { provider: text(raw.provider, 300), base: text(raw.base, 2048), model: text(raw.model, 512),
        dimensions: Number.isInteger(dimensions) && dimensions > 0 && dimensions <= 65536 ? dimensions : 0, enabled: raw.enabled === true };
    }
    const source = ['none', 'cloud', 'realtime'].includes(raw.source) ? raw.source : 'none';
    return { source, scheme: text(raw.scheme, 200), model: text(raw.model, 200), realtime: raw.realtime === true };
  }
  function purposeRole(settings, role) {
    if (!PURPOSE_ROLES.includes(role) || !isObject(settings) || !isObject(settings.roles) || settings.roles.version !== VERSION) return null;
    return normalizePurpose(role, settings.roles[role]);
  }
  // value 为 null 时删除。返回是否真的改变了存储（相同内容不重写，调用方据此决定要不要保存）。
  function setPurposeRole(settings, role, value) {
    if (!PURPOSE_ROLES.includes(role) || !ensure(settings)) return false;
    const next = value == null ? null : normalizePurpose(role, value);
    if (value != null && !next) return false;
    const base = isObject(settings.roles) ? settings.roles : { version: VERSION, overrides: {} };
    if (JSON.stringify(base[role] == null ? null : base[role]) === JSON.stringify(next)) return false;
    const out = { ...base, version: VERSION, overrides: isObject(base.overrides) ? base.overrides : {} };
    if (next) out[role] = next; else delete out[role];
    settings.roles = out;
    return true;
  }

  // ---- v2 → v1 投影 ----
  // 让所有还在读 settings.connections / settings.modelRoles 的地方照常工作。
  // 只通过 Connections 的公开方法写，所以未来版本 / 损坏的 v1 仍由它保护。
  function project(settings) {
    if (!isObject(settings) || !isV2(settings.providers)) return false;
    const C = connections(), list = items(settings);
    const keep = new Set(list.map(item => item.id));
    for (const legacy of C.items(settings, { includeHidden: true })) {
      if (legacy.kind === 'claude-cli') continue;
      if (!keep.has(legacy.id)) C.remove(settings, legacy.id);
    }
    for (const item of list) {
      const models = item.models.map(({ model, label, contextWindow, efforts }) => ({ model, label, contextWindow, efforts }));
      if (item.kind === 'api') {
        C.upsert(settings, { kind: 'api', base: item.base, name: item.name, protocol: item.protocol, models });
        // 旧的“模型连接”卡和对话里的模型选择读的是按地址分组的模型目录：保持同步。
        if (catalog() && models.length) catalog().write(settings, item.base, models);
      }
      else C.upsert(settings, { kind: 'codex-cli', login: item.account.login, models });
    }
    // 顺序：和供应商列表一致；隐藏的 Claude 条目留在末尾。
    const state = settings.connections;
    if (isObject(state) && state.version === 1 && Array.isArray(state.items)) {
      const rank = id => { const at = list.findIndex(item => item.id === id); return at < 0 ? list.length : at; };
      state.items = state.items.slice().sort((a, b) => rank(a && a.id) - rank(b && b.id));
    }
    const def = defaultSelection(settings), own = overrides(settings);
    if (def) C.setRole(settings, 'qa', { connection: def.provider, model: def.model, effort: def.effort });
    for (const role of OVERRIDE_ROLES) C.setRole(settings, role, own[role] ? { connection: own[role].provider, model: own[role].model, effort: own[role].effort } : null);
    return true;
  }

  return Object.freeze({ VERSION, KINDS, PROTOCOLS, CAPS, OVERRIDE_ROLES, CHATGPT_ID, normalizeItem, normalizeModels, setNeedsKey, items, get, overrides, defaultSelection, visionAuto, primaryOf,
    migrateFromV1, ensure, reconcile, upsert, remove, setConnection, rename, move, makeDefault, moveModel, addModel, removeModel, setModelCaps, setModelEffort, setCheck, fallbackModels, setOverride, purposeRole, setPurposeRole, PURPOSE_ROLES, project, copy });
}));
