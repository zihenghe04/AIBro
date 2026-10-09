import React, { useState } from 'react';
import { Button, Caption, StatusBadge } from './halaska-kit.jsx';
import { KitCheckbox, KitSelect } from './kit-controls.jsx';
import styles from './connection-sync-settings.css';

if (!document.getElementById('connection-sync-settings-styles')) {
  const style = document.createElement('style'); style.id = 'connection-sync-settings-styles'; style.textContent = styles; document.head.append(style);
}
const t = (zh, en) => /^en(?:-|$)/i.test(document.documentElement.lang) ? en : zh;
const formatFingerprint = value => (value || '').match(/.{1,6}/g)?.join(' ') || '';

function Device({ device, disabled, onApprove, onRevoke }) {
  const [confirmed, setConfirmed] = useState(false), pending = device.status === 'pending';
  if (device.status === 'revoked') return <li className="connection-device revoked"><span>{t('已撤销的设备', 'Revoked device')}</span><code>{formatFingerprint(device.deviceId)}</code></li>;
  return <li className="connection-device">
    <div className="connection-row"><strong>{pending ? t('手机请求接入', 'Device requesting access') : t('已批准的设备', 'Approved device')}</strong><StatusBadge status={pending ? 'pending' : 'online'}>{pending ? t('待核对', 'Verify') : t('可同步', 'Enabled')}</StatusBadge></div>
    <code aria-label={t('设备指纹', 'Device fingerprint')}>{formatFingerprint(device.deviceId)}</code>
    <KitCheckbox checked={confirmed} disabled={disabled} onChange={setConfirmed}
      label={pending ? t('与手机显示的指纹一致', 'Matches the fingerprint on my phone') : t('我确认要撤销这台设备', 'Revoke this device’s access')} />
    <Button size="sm" variant={pending ? 'accent' : 'secondary'} disabled={disabled || !confirmed}
      onClick={() => pending ? onApprove(device.deviceId, confirmed) : onRevoke(device.deviceId, confirmed)}>
      {pending ? t('批准并发送配置', 'Approve & send settings') : t('撤销设备', 'Revoke device')}
    </Button>
  </li>;
}
export function ConnectionSyncSettingsSurface({ state, onRefresh, onConfirmOrigin, onInitialize, onPreview, onPublish, onCancelPreview,
  onApprove, onRevoke, onRetry, onRemove, onCopy, onProtocol, onPurpose }) {
  const { busy, phase, preview, devices, profiles } = state;
  const [removeConfirmed, setRemoveConfirmed] = useState({chat:false,speech:false});
  const selected = state.selectedPurposes || {chat:true,speech:false}, following = state.followingPurposes || {chat:state.following,speech:false};
  const previews = state.previews?.length ? state.previews : preview ? [preview] : [];
  const purposeLabel = purpose => purpose === 'speech' ? t('语音识别', 'Speech recognition') : t('对话', 'Chat');
  return <div className="connection-settings" aria-busy={busy}>
    <header className="connection-row"><div><h2>{t('把模型配置带到手机', 'Bring model settings to your phone')}</h2><p>{t('在 Mac 配置一次，已批准的手机继续使用。', 'Set up on your Mac. Continue on your approved phone.')}</p></div><Button size="sm" variant="ghost" loading={busy} onClick={onRefresh}>{t('刷新', 'Refresh')}</Button></header>
    {['idle', 'checking'].includes(phase) && <Caption>{busy ? t('正在检查同步连接…', 'Checking sync connection…') : t('登录同一同步账号后，在这里连接手机。', 'Sign in to the same sync account to connect your phone here.')}</Caption>}
    {phase === 'disconnected' && <p>{t('先在上方连接同步服务器，再刷新此处。', 'Connect to your sync server above, then refresh here.')}</p>}
    {phase === 'unsupported' && <p>{t('此同步服务尚未提供模型配置同步，资料同步不受影响。', 'This sync service does not yet support model settings. Content sync is unaffected.')}</p>}
    {phase === 'confirm-origin' && <section className="connection-section"><h3>{t('确认手机使用的同步地址', 'Confirm your phone’s sync address')}</h3><p>{t('Mac 可通过 SSH 连接；手机需要访问下面这个地址。', 'Your Mac can connect over SSH. Your phone needs access to this address.')}</p><code>{state.capability.origin}</code><Button size="sm" disabled={busy} onClick={onConfirmOrigin}>{t('使用此地址', 'Use this address')}</Button></section>}
    {phase === 'ready' && <section className="connection-section"><p>{t('将这台 Mac 设为配置来源，再逐台批准手机。API Key 加密后同步，云账号密码不会包含在配置里。', 'Use this Mac as the settings source, then approve each phone. API keys are encrypted before syncing; your sync-account password is not included.')}</p><Button disabled={busy} onClick={onInitialize}>{t('从这台 Mac 开始', 'Start from this Mac')}</Button></section>}
    {phase === 'pending' && <section className="connection-section"><p>{t('上一次提交的结果尚未确认。先核对它，避免重复提交。', 'The previous submission is not confirmed. Check its result before submitting more changes.')}</p><Button disabled={busy} onClick={onRetry}>{t('核对上次操作', 'Check previous operation')}</Button></section>}
    {phase === 'owner' && <>
      <section className="connection-section"><div className="connection-row"><h3>{t('连接手机', 'Connect your phone')}</h3><Button size="sm" variant="secondary" disabled={busy} onClick={onCopy}>{t('复制配对信息', 'Copy pairing info')}</Button></div>
        <p>{t('在手机的「设置 → 模型配置同步」粘贴配对信息，核对这台 Mac 的指纹，然后回到这里批准手机。', 'Paste this into Settings → Model settings sync on your phone. Verify this Mac’s fingerprint, then approve the phone here.')}</p>
        <code aria-label={t('此 Mac 指纹', 'This Mac’s fingerprint')}>{formatFingerprint(state.info?.deviceId)}</code>
        <details><summary>{t('显示配对信息', 'Show pairing info')}</summary><textarea readOnly aria-label={t('公开配对信息', 'Public pairing info')} value={state.pairingCode} rows={5} spellCheck={false} /></details>
      </section>
      {devices.length > 0 && <ul className="connection-devices">{devices.map(device => <Device key={device.deviceId + ':' + device.status} device={device} disabled={busy || !!preview} onApprove={onApprove} onRevoke={onRevoke} />)}</ul>}
      <section className="connection-section"><h3>{t('共享已保存的连接', 'Share saved connections')}</h3>
        {profiles.length > 0 && <ul className="connection-profiles">{profiles.map(profile => <li key={profile.id}><strong>{purposeLabel(profile.purpose)} · {profile.model}</strong><span>{profile.baseUrl}</span><Caption>{profile.apiFormat}{profile.language ? ` · ${profile.language}` : ''}</Caption></li>)}</ul>}
        <div className="connection-purpose-options" role="group" aria-label={t('本次共享用途', 'Purposes to share')}>
          {['chat','speech'].map(purpose => <div key={purpose} className="connection-purpose">
            <KitCheckbox id={`connectionShare-${purpose}`} checked={!!selected[purpose]} disabled={busy || !!preview} onChange={enabled => onPurpose(purpose,enabled)} label={t(`共享${purposeLabel(purpose)}配置`, `Share ${purposeLabel(purpose).toLowerCase()} settings`)} />
            <Caption>{following[purpose] ? t('已开启：保存此用途的配置时自动同步。', 'Enabled: saved changes for this purpose sync automatically.') : t('尚未自动共享。预览并确认后才会开启。', 'Not shared automatically. Preview and confirm to enable.')}</Caption>
          </div>)}
        </div>
        {selected.chat && <KitSelect label={t('对话 API 协议', 'Chat API protocol')} value={state.apiFormat} disabled={busy || !!preview} placeholder={t('选择已在 Mac 使用的协议', 'Choose the protocol used on your Mac')}
          options={[{ value: 'chat-completions', label: 'Chat Completions' }, { value: 'responses', label: 'Responses API' }]} onChange={onProtocol} />}
        <p>{t('只读取已经保存的配置。语音从语音设置读取，包含语言偏好；不会改用聊天 Key 或未保存的输入。勾选用于本次发布，已开启的共享需在下方单独停止。', 'Only saved settings are read. Speech uses its saved connection and language, never the chat key or unsaved edits. Checkboxes select this publication; stop existing sharing separately below.')}</p>
        {!preview && <Button size="sm" variant="secondary" disabled={busy || (!selected.chat && !selected.speech) || (selected.chat && !state.apiFormat)} onClick={onPreview}>{t('预览所选配置', 'Preview selected settings')}</Button>}
        {preview && <div className="connection-preview-batch">
          {previews.map(item => <div key={item.id} className="connection-preview"><strong>{purposeLabel(item.purpose)} · {item.model}</strong><span>{item.baseUrl}</span><Caption>{item.apiFormat}{item.language ? ` · ${item.language}` : ''} · {t('API Key 已包含，不显示明文', 'API key included, never displayed')}</Caption></div>)}
          <p>{t('所选用途将一起提交；若其中一项发生变化或不可用，本批不会部分共享。', 'Selected purposes are submitted together. If any source changes or is unavailable, this batch is not partially shared.')}</p>
          <div className="connection-actions"><Button size="sm" disabled={busy} onClick={onPublish}>{t('同步这些已保存配置', 'Sync these saved settings')}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={onCancelPreview}>{t('取消', 'Cancel')}</Button></div>
        </div>}
        {['chat','speech'].filter(purpose => profiles.some(profile => profile.id === `mac-${purpose}`)).map(purpose => <details key={purpose}><summary>{t(`停止共享${purposeLabel(purpose)}配置`, `Stop sharing ${purposeLabel(purpose).toLowerCase()}`)}</summary><KitCheckbox checked={removeConfirmed[purpose]} onChange={confirmed => setRemoveConfirmed(current => ({...current,[purpose]:confirmed}))} disabled={busy || !!preview} label={t('从手机同步配置中移除，此 Mac 的配置保留', 'Remove from synced phone settings; keep this Mac’s settings')} /><Button size="sm" variant="secondary" disabled={busy || !!preview || !removeConfirmed[purpose]} onClick={() => onRemove(purpose)}>{t(`移除${purposeLabel(purpose)}共享`, `Remove shared ${purposeLabel(purpose).toLowerCase()}`)}</Button></details>)}
      </section>
    </>}
    <div className="connection-feedback" role={state.failure ? 'alert' : 'status'} aria-live="polite">{state.message}</div>
    <footer><Caption>{t('当前可共享自定义聊天与语音 API；知识库向量尚未共享。Claude / OpenAI 的订阅登录分别由官方登录流程管理，不会作为 API Key 复制。', 'Custom chat and speech APIs are shared here; embedding settings are not shared yet. Claude and OpenAI subscription sign-ins use their official flows and are not copied as API keys.')}</Caption></footer>
  </div>;
}
