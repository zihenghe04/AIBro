// Public metadata only. A failed network refresh does not invalidate the native
// vault: the request path still checks the captured session and whole bundle.
export function connectionSelectionView(snapshot, settings = {}, binding = null, purpose = 'chat') {
  const selected = settings.connectionProfiles?.[purpose] ?? snapshot.selections?.[purpose];
  const local = settings[purpose === 'speech' ? 'speech' : 'model'];
  if (!selected) return { state: 'manual', label: local?.model || '配置模型', detail: '', target: purpose === 'speech' ? '#speech-form' : '#model-form' };
  const result = (state, label, detail) => ({ state, label, detail, target: '#connection-sync-root' });
  let origin;
  try { origin = new URL(binding?.base).origin; } catch { /* no current binding */ }
  const matches = value => value && value.serverOrigin === origin && value.accountId === binding?.accountID;
  if (!matches(selected) || ['disconnected', 'reconnect'].includes(snapshot.stage))
    return result('unavailable', '同步配置 · 需连接', '请连接原来的云账号，再使用此 Mac 配置。');
  if (matches(settings.connectionBlocked) || snapshot.stage === 'blocked')
    return result('unavailable', '同步配置 · 未授权', '此手机的授权已失效，请在 Mac 检查授权后重新检查更新。');
  if (snapshot.stage === 'native-required')
    return result('unavailable', '同步配置 · 需 App', '请在手机 App 中使用安全存储的同步配置。');
  const profile = snapshot.profiles?.find(p => p.id === selected.profileId && p.purpose === purpose);
  if (profile && !profile.supported)
    return result('unavailable', '同步配置 · 暂不支持', profile.limitation || '手机暂不支持此接口，请选择其他配置。');
  if (snapshot.stage === 'ready' && !profile)
    return result('unavailable', '同步配置 · 已移除', 'Mac 已停止共享此配置，请重新选择。');
  if (profile && ['ready', 'error'].includes(snapshot.stage))
    return result('available', profile.model, snapshot.stage === 'error' ? '暂未检查到更新，将使用本机已有配置。' : '');
  return result('pending', '同步配置 · 待检查', snapshot.stage === 'pending'
    ? '等待 Mac 批准后即可使用。' : '尚未确认此配置；已有本机配置不会因网络中断而清除。');
}

export function paintConnectionSelection(document, view) {
  const chip = document.querySelector('[data-action="model-settings"]');
  if (chip) {
    chip.textContent = view.label;
    chip.dataset.connectionState = view.state;
    chip.title = view.detail || view.label;
    chip.setAttribute('aria-label', `模型设置：${view.label}${view.detail ? '。' + view.detail : ''}`);
  }
  const hint = document.querySelector('[data-model-connection-hint]');
  if (hint) { hint.textContent = view.detail; hint.hidden = !view.detail; }
}

export function revealSettingsTarget(document, selector) {
  const target = document.querySelector(selector);
  if (!target) return false;
  for (let parent = target.parentElement; parent; parent = parent.parentElement)
    if (parent.tagName === 'DETAILS') parent.open = true;
  target.scrollIntoView({ block: 'start', behavior: 'auto' });
  return true;
}
