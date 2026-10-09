import { apiProfiles, activeApiProfile, profileSlot } from './api-profiles.js';
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fields = purpose => purpose === 'chat' ? ['base', 'model', 'format'] : ['provider', 'base', 'model', 'language'];
const publicValues = (purpose, values) => Object.fromEntries(['profileName', ...fields(purpose)].map(k => [k, String(values[k] ?? '')]));
const defaults = purpose => purpose === 'chat' ? { base: '', model: '', format: 'chat' }
  : { provider: 'aliyun', base: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'qwen-audio-3.0-asr-flash', language: '' };

// This controller owns editor drafts, not active settings. Secret draft values
// are memory-only; only the explicit save operation writes the native vault.
export function createApiProfileEditor({ store, purpose, save, use, remove, test }) {
  const drafts = new Map(), listeners = new Set();
  let editing = activeApiProfile(store.state.settings, purpose), values, working = false, operation = null, outcome = null;
  const key = id => `api-profile:${purpose}:${id || 'new'}`;
  const list = () => apiProfiles(store.state.settings, purpose);
  function baseline(id) {
    const p = list().find(p => p.id === id);
    return publicValues(purpose, { ...defaults(purpose), ...p?.config, profileName: p?.name || (purpose === 'chat' ? '新模型方案' : '新语音方案') });
  }
  function load(id) {
    const saved = drafts.get(id) || store.state.drafts[key(id)];
    values = { ...baseline(id), ...(saved ? publicValues(purpose, saved) : {}), key: drafts.get(id)?.key || '', profileId: id };
  }
  load(editing);
  const snapshot = () => ({ editingId: editing, activeId: activeApiProfile(store.state.settings, purpose), profiles: list(),
    synced: !!store.state.settings.connectionProfiles?.[purpose], values: structuredClone(values), busy: working, operation,
    dirty: !!values.key || !equal(publicValues(purpose, values), baseline(editing)), outcome: outcome && { ...outcome } });
  const notify = event => { for (const listener of listeners) { try { listener(event); } catch { /* A detached view must not turn a committed save into a failed save. */ } } };
  async function retain() {
    const captured = structuredClone(values), id = editing;
    drafts.set(id, captured);
    const visible = publicValues(purpose, captured), base = baseline(id);
    await store.tx(s => { if (equal(visible, base)) delete s.drafts[key(id)]; else s.drafts[key(id)] = visible; });
  }
  async function invoke(kind, fn) {
    if (working) throw Error('正在处理此方案，请稍候');
    working = true; operation = kind; outcome = null; notify({ stage: 'start', kind });
    try {
      const result = await fn();
      outcome = { kind, ok: true, message: kind === 'test' ? String(result?.message || '')
        : ({ select: '', save: '方案已保存并启用。', use: '已使用此方案；Mac 同步配置仍保留。', remove: '方案已删除。' })[kind] };
      return result;
    } catch (error) {
      outcome = { kind, ok: false, message: error?.message || '操作未完成，原设置与输入已保留。' };
      throw error;
    } finally { working = false; operation = null; notify({ stage: 'finish', ...outcome }); }
  }
  return {
    snapshot, retain,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setValues(next) { if (working) throw Error('正在处理此方案，请稍候'); outcome = null; values = { ...values, ...publicValues(purpose, next), key: String(next.key || ''), profileId: editing }; drafts.set(editing, structuredClone(values)); },
    select(id) { return invoke('select', async () => {
      if (id && !list().some(p => p.id === id)) throw Error('方案已变化，请重新选择');
      await retain(); editing = id; load(id); return snapshot();
    }); },
    save() { return invoke('save', async () => {
      const captured = structuredClone(values), old = editing;
      await save(captured);
      editing = activeApiProfile(store.state.settings, purpose);
      drafts.delete(old); drafts.delete(editing); load(editing);
      // Draft cleanup is part of save's Store transaction in the credential
      // adapters. Do not turn a successful activation into a second DB operation.
      return snapshot();
    }); },
    use() { return invoke('use', async () => {
      if (!editing) throw Error('请先保存新方案');
      if (snapshot().dirty) throw Error('当前方案有未保存修改，请先保存并使用；切换其他方案会保留这些输入');
      await use(editing); return snapshot();
    }); },
    remove() { return invoke('remove', async () => {
      if (!editing) throw Error('此方案尚未保存');
      if (snapshot().dirty) throw Error('请先保留或处理当前草稿，再删除方案');
      const old = editing; await remove(old); drafts.delete(old);
      editing = activeApiProfile(store.state.settings, purpose); load(editing); return snapshot();
    }); },
    test() { return invoke('test', async () => { if (!test) throw Error('此用途暂不支持测试'); return test(structuredClone(values)); }); },
  };
}

export function clearSavedApiDraft(state, purpose, values) {
  if (Object.hasOwn(values, 'profileName')) delete state.drafts[`api-profile:${purpose}:${values.profileId || 'new'}`];
}
