/* Model choices for the in-chat picker: the enabled providers (settings.providers, v2) as groups of models, and the mapping
   between a stored modelConfig and a (provider, model, effort) choice. Old v1 modelConfig ({provider:'api'|'openai-auth'|
   'claude-auth', model, effort} with no connection) maps onto v2 providers without losing anything.
   Public metadata only; no keys. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ModelChoices = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const Providers = () => root.Providers || (typeof require === 'function' ? require('./providers.js') : null);
  const Connections = () => root.Connections || (typeof require === 'function' ? require('./connections.js') : null);
  const CLAUDE_ALIASES = [{ model: '', zh: 'Claude 官方默认', en: 'Claude official default' }, { model: 'sonnet', zh: 'Sonnet', en: 'Sonnet' }, { model: 'opus', zh: 'Opus', en: 'Opus' }, { model: 'haiku', zh: 'Haiku', en: 'Haiku' }];
  const english = () => root.WorkstationI18n?.getLanguage?.() === 'en' || /^en(?:-|$)/i.test(root.document?.documentElement?.lang || '');
  const t = (zh, en) => english() ? en : zh;

  const wireOf = item => {
    if (!item || item.kind !== 'api') return '';
    const C = Connections();
    return C.detectProtocol(item.base, item.protocol) || (item.protocol === 'auto' ? 'auto' : item.protocol);
  };
  // Levels the model accepts: its own list when it has one, else what the wire protocol can express. "No thinking" models offer none.
  function effortsOf(item, entry) {
    if (!item || !entry) return [];
    if (entry.caps && entry.caps.think === false) return [];
    const own = Array.isArray(entry.efforts) ? entry.efforts : [];
    if (item.kind === 'account') return own.filter(Boolean);
    const levels = Connections().effortLevels('api', wireOf(item));
    return own.length ? own.filter(level => levels.includes(level)) : levels;
  }

  function accountModels(item, live) {
    const stored = item.models || [];
    const fresh = (live || []).map(entry => ({ model: entry.model || entry.id || '', label: entry.displayName || entry.label || entry.model || entry.id || '', efforts: (entry.supportedReasoningEfforts || entry.efforts || []).map(x => typeof x === 'string' ? x : x.reasoningEffort).filter(Boolean), caps: {} })).filter(entry => entry.model);
    const merged = [...fresh, ...stored.filter(entry => !fresh.some(other => other.model === entry.model))];
    return merged.length ? merged : [{ model: '', label: t('账号默认模型', 'Account default model'), efforts: [], caps: {} }];
  }

  /* groups(settings, {live, claudeEnabled}) -> [{ id, name, kind:'api'|'account'|'claude', host, isDefault, models:[{ model, label, caps, efforts, isDefault }] }] */
  function groups(settings, { live = [], claudeEnabled = false } = {}) {
    const P = Providers(), C = Connections(), list = P.items(settings), def = P.defaultSelection(settings);
    const out = list.map(item => ({
      id: item.id, name: item.name, kind: item.kind, host: item.kind === 'api' ? C.hostOf(item.base) : '', needsKey: item.needsKey === true, isDefault: !!def && def.provider === item.id,
      models: (item.kind === 'account' ? accountModels(item, live) : item.models).map(entry => ({ model: entry.model, label: entry.label || entry.model || t('账号默认模型', 'Account default model'), caps: entry.caps || {}, efforts: effortsOf(item, entry), isDefault: !!def && def.provider === item.id && def.model === entry.model }))
    })).filter(group => group.models.length);
    if (claudeEnabled) out.push({ id: C.CLAUDE_ID, name: 'Claude Code', kind: 'claude', host: '', isDefault: false, models: CLAUDE_ALIASES.map(entry => ({ model: entry.model, label: t(entry.zh, entry.en), caps: {}, efforts: [], isDefault: false })) });
    return out;
  }

  /* Which choice does a stored modelConfig stand for? v1 configs have no connection: find the provider by model name,
     preferring the one the legacy single connection pointed at. Unknown models keep their name (shown as "not in list"). */
  function selectionFrom(settings, config, { activeBase = '' } = {}) {
    const P = Providers(), C = Connections(), cfg = config || {};
    const effort = cfg.effort && cfg.effort !== 'auto' ? String(cfg.effort) : '';
    const model = String(cfg.model || '').trim();
    if (cfg.provider === 'openai-auth') return { connection: P.CHATGPT_ID, model, effort };
    if (cfg.provider === 'claude-auth') return { connection: C.CLAUDE_ID, model, effort: '' };
    const list = P.items(settings).filter(item => item.kind === 'api');
    if (cfg.connection && list.some(item => item.id === cfg.connection)) return { connection: cfg.connection, model, effort };
    const active = activeBase ? C.apiId(activeBase) : '';
    const holders = list.filter(item => item.models.some(entry => entry.model === model));
    const chosen = holders.find(item => item.id === active) || holders[0] || list.find(item => item.id === active) || null;
    return { connection: chosen ? chosen.id : '', model, effort };
  }

  // The stored form. `connection` is only written for custom-API choices; accounts keep the old provider names.
  function toConfig(selection) {
    const P = Providers(), C = Connections();
    if (selection.connection === P.CHATGPT_ID) return { provider: 'openai-auth', model: selection.model || '', effort: selection.effort || '' };
    if (selection.connection === C.CLAUDE_ID) return { provider: 'claude-auth', model: selection.model || '', effort: '' };
    return { provider: 'api', ...(selection.connection ? { connection: selection.connection } : {}), model: selection.model || '', effort: selection.effort || '' };
  }

  function findChoice(groupList, selection) {
    const group = groupList.find(item => item.id === selection.connection) || null;
    const model = group ? group.models.find(entry => entry.model === selection.model) || null : null;
    return { group, model };
  }

  // Keep the effort only if the chosen model still offers it.
  const fitEffort = (model, effort) => model && effort && model.efforts.includes(effort) ? effort : '';

  const CAP_LABELS = { image: ['图', 'Image'], text: ['文', 'Tools'], vision: ['视', 'Vision'], think: ['思', 'Thinking'] };
  const capTags = caps => Object.keys(CAP_LABELS).filter(key => caps && caps[key] === true).map(key => ({ key, text: t(...CAP_LABELS[key]) }));

  return Object.freeze({ groups, selectionFrom, toConfig, findChoice, fitEffort, effortsOf, capTags, CAP_LABELS });
}));
