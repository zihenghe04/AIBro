// Device-local public metadata. Secrets remain in the purpose's native vault.
export const MAX_API_PROFILES = 12;
export const profileSlot = purpose => purpose === 'chat' ? 'model' : purpose === 'speech' ? 'speech' : (() => { throw Error('手机暂未启用此用途'); })();
const copy = v => v == null ? null : structuredClone(v);
const equal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export function apiProfiles(settings, purpose) {
  const slot = profileSlot(purpose), entries = settings.apiProfiles?.[purpose];
  if (entries !== undefined) {
    if (!Array.isArray(entries) || entries.length > MAX_API_PROFILES || entries.some(p => !p || !/^[a-zA-Z0-9_-]{1,80}$/.test(p.id) || typeof p.name !== 'string' || !p.config) || new Set(entries.map(p => p.id)).size !== entries.length) throw Error('本机方案记录异常，原设置已保留');
    return copy(entries);
  }
  return settings[slot]?.base ? [{ id: 'legacy-' + purpose, name: purpose === 'chat' ? '原有模型' : '原有语音', config: copy(settings[slot]) }] : [];
}
export function activeApiProfile(settings, purpose) {
  return settings.apiProfileSelection?.[purpose] || (settings.apiProfiles?.[purpose] === undefined && settings[profileSlot(purpose)]?.base ? 'legacy-' + purpose : '');
}
export function apiProfileSnapshot(settings, purpose) {
  return copy({ config: settings[profileSlot(purpose)] ?? null, profiles: settings.apiProfiles?.[purpose] ?? null,
    selection: settings.apiProfileSelection?.[purpose] ?? null, synced: settings.connectionProfiles?.[purpose] ?? null,
    manual: settings.connectionManual?.[purpose] ?? null });
}
export function assertApiProfileCurrent(settings, purpose, before) {
  if (!equal(apiProfileSnapshot(settings, purpose), before)) throw Error('连接设置已在保存期间变化，请重新核对后保存');
}
export function profileEdit(settings, purpose, values) {
  if (!Object.hasOwn(values, 'profileName')) return null;
  const name = String(values.profileName || '').trim(), id = String(values.profileId || '');
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw Error('请填写 1–80 字的方案名称');
  const profiles = apiProfiles(settings, purpose), target = id ? profiles.find(p => p.id === id) : null;
  if (id && !target) throw Error('方案已变化，请重新选择');
  if (!target && profiles.length >= MAX_API_PROFILES) throw Error('每个用途最多保存 12 个方案，请先删除不用的方案');
  return { profiles, target, id: target?.id || crypto.randomUUID().replaceAll('-', ''), name };
}
export function applyApiProfile(settings, purpose, config, edit) {
  settings[profileSlot(purpose)] = copy(config);
  if (edit) {
    const next = { id: edit.id, name: edit.name, config: copy(config) };
    settings.apiProfiles = { ...settings.apiProfiles, [purpose]: edit.target ? edit.profiles.map(p => p.id === edit.id ? next : p) : [...edit.profiles, next] };
    settings.apiProfileSelection = { ...settings.apiProfileSelection, [purpose]: edit.id };
  }
  settings.connectionProfiles = { ...settings.connectionProfiles };
  delete settings.connectionProfiles[purpose];
  settings.connectionManual = { ...settings.connectionManual, [purpose]: true };
}
export async function deleteApiProfile(store, purpose, id) {
  await store.tx(state => {
    if (activeApiProfile(state.settings, purpose) === id) throw Error('请先使用另一个方案，再删除此方案');
    const profiles = apiProfiles(state.settings, purpose);
    if (!profiles.some(p => p.id === id)) throw Error('方案已变化，请重新选择');
    state.settings.apiProfiles = { ...state.settings.apiProfiles, [purpose]: profiles.filter(p => p.id !== id) };
  });
}
