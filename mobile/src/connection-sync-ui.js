import { loadMobileHalaska } from './ui/halaska-loader.js';
import './connection-sync.css';
const registered = new WeakSet();
const navigationRegistered = new WeakSet();
function themedIsland(kit, element, name, props) {
  const media = matchMedia('(prefers-color-scheme: dark)');
  const theme = () => media.matches ? 'dark' : 'light';
  const island = kit.mount(element, name, { ...props, theme: theme() });
  const repaint = () => island.update({ theme: theme() });
  media.addEventListener('change', repaint);
  return { update: next => island.update({ ...next, theme: theme() }), unmount() { media.removeEventListener('change', repaint); island.unmount(); } };
}
const summaries = {
  idle: ['从 Mac 带来模型配置', '连接同一云账号后，配对一次即可接收 Mac 上的配置更新。'],
  'native-required': ['请在手机 App 中配对', '模型配置和密钥使用原生安全存储；网页预览不提供此功能。'],
  disconnected: ['先连接云账号', '与 Mac 使用同一服务和账号，再接收模型配置。'],
  available: ['可以连接这台手机', '在 Mac 和手机之间核对指纹后，接收对话与语音识别配置。'],
  pairing: ['核对你的 Mac', '先在 Mac 上核对下面的手机指纹，再把 Mac 的配对信息复制到这里。'],
  pending: ['等待 Mac 批准', '在 Mac「配置同步」中核对手机指纹并批准，随后检查更新。'],
  ready: ['配置已同步', '选择对话和语音使用的模型。密钥保存在此手机的安全存储。'],
  unsupported: ['服务器暂未支持', '此同步服务尚未提供模型配置同步，资料同步不受影响。'],
  blocked: ['设备授权需处理', '请在 Mac 上检查此手机的授权，处理后再次检查更新。'],
  reconnect: ['请重新连接云账号', '当前登录缺少设备身份或已失效。重新连接即可，不需要重新填写所有 API。'],
  error: ['暂未完成同步', '检查云同步连接后重试，原来的手动模型配置仍保留。'],
};
export async function mountConnectionSync(element, manager, options = {}) {
  const kit = await loadMobileHalaska();
  if (!element.isConnected || element.childNodes.length) return null;
  if (!registered.has(kit)) {
    const { createElement: h, useState, useRef, useEffect } = kit.React;
    kit.register('MobileConnectionSync', ({ state, manager, options }) => {
      const [text, setText] = useState(''), [preview, setPreview] = useState(null), [confirmed, setConfirmed] = useState(false);
      const [actionError, setActionError] = useState(''), [working, setWorking] = useState(false);
      const mounted = useRef(true), running = useRef(false);
      useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
      const invoke = work => async () => {
        if (running.current) return;
        running.current = true; setWorking(true); setActionError('');
        try { await work(); } catch (error) { if (mounted.current) setActionError(error?.message || '操作未完成，请重试。'); }
        finally { running.current = false; if (mounted.current) setWorking(false); }
      };
      const busy = state.busy || working;
      const action = (label, work, props = {}) => kit.node({ component: 'Button', props: { children: label, type: 'button',
        variant: 'secondary', disabled: busy, onClick: invoke(work), style: { minHeight: 44, padding: '8px 14px', borderRadius: 11, fontFamily: 'inherit' }, ...props } });
      const [title, detail] = summaries[state.stage] || summaries.error;
      const selections = state.selections || {};
      return h('section', { className: 'settings-card connection-sync', 'data-connection-stage': state.stage },
        h('div', { className: 'connection-sync__heading' }, h('h2', null, '从 Mac 同步模型'),
          ['disconnected', 'reconnect'].includes(state.stage) && options.onConnectCloud
            ? action('连接云账号', options.onConnectCloud)
            : !['native-required', 'disconnected'].includes(state.stage) && action(state.busy ? '检查中…' : state.stage === 'available' ? '连接这台手机' : '检查更新', () => manager.refresh({ register: state.stage === 'available' }))),
        h('div', { className: 'connection-sync__status', role: 'status', 'aria-live': 'polite' }, h('strong', null, title), h('p', { className: 'hint' }, detail)),
        (state.profiles.length > 0 || selections.chat || selections.speech) && h('div', { className: 'connection-sync__choices' },
          ...['chat', 'speech'].map(purpose => {
            const choices = state.profiles.filter(p => p.purpose === purpose), selected = selections[purpose]?.profileId || '';
            const view = options.selectionView?.(purpose, state);
            return h('div', { key: purpose }, h('label', null, purpose === 'chat' ? '对话使用' : '语音识别使用',
              h('select', { value: selected, disabled: busy, onChange: event => invoke(() => manager.choose(purpose, event.target.value))() },
                h('option', { value: '' }, '此手机 · 手动配置'),
                selected && !choices.some(p => p.id === selected) && h('option', { value: selected, disabled: true }, view?.label || '同步配置当前不可用'),
                ...choices.map(p => h('option', { key: p.id, value: p.id, disabled: !p.supported }, `Mac · ${p.model}${p.supported ? '' : '（暂不支持）'}`)))),
              selected && view?.detail && h('p', { className: 'hint', 'data-connection-selection-state': view.state }, view.detail));
          }),
          ...state.profiles.filter(p => !p.supported).map(p => h('p', { key: p.id, className: 'hint' }, `${p.purposeLabel} · ${p.model}：${p.limitation || '手机尚未适配此接口。'}`))),
        state.deviceFingerprint && h('details', { className: 'connection-sync__identity', open: ['pairing', 'pending'].includes(state.stage) },
          h('summary', null, '这台手机的指纹'), h('code', { 'data-device-fingerprint': true }, state.deviceFingerprint),
          action('复制手机指纹', () => navigator.clipboard.writeText(state.deviceFingerprint))),
        !state.ownerFingerprint && state.deviceFingerprint && h('div', { className: 'connection-sync__pair' },
          h('label', null, 'Mac 配对信息', h('textarea', { value: text, rows: 3, maxLength: 4096, spellCheck: false,
            placeholder: '粘贴 Mac「配置同步」中复制的配对信息', disabled: busy,
            onChange: event => { setText(event.target.value); setPreview(null); setConfirmed(false); setActionError(''); } })),
          action('读取并核对指纹', async () => { const next = await manager.previewPairing(text); if (mounted.current) { setPreview(next); setConfirmed(false); } }, { disabled: busy || !text.trim() }),
          preview && h('div', { className: 'connection-sync__verification' }, h('span', null, 'Mac 指纹'), h('code', { 'data-owner-preview': true }, preview.fingerprint),
            h('label', { className: 'check' }, h('input', { type: 'checkbox', checked: confirmed, disabled: busy, onChange: e => setConfirmed(e.target.checked) }), '我已核对，与 Mac 显示的整串指纹一致'),
            action('信任此 Mac', async () => { await manager.pinOwner(preview, confirmed); if (mounted.current) { setText(''); setPreview(null); setConfirmed(false); } }, { disabled: busy || !confirmed, variant: 'primary' }))),
        state.ownerFingerprint && h('details', { className: 'connection-sync__identity' }, h('summary', null, '已配对的 Mac'), h('code', null, state.ownerFingerprint)),
        state.lastSync && h('p', { className: 'hint connection-sync__time' }, `最近检查 ${new Date(state.lastSync).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`),
        (actionError || state.error) && h('p', { className: 'connection-sync__error', role: 'alert' }, actionError || state.error));
    });
    registered.add(kit);
  }
  const island = themedIsland(kit, element, 'MobileConnectionSync', { state: manager.snapshot(), manager, options });
  return { update: state => island.update({ state, manager, options }), unmount: () => island.unmount() };
}

export async function mountConnectionNavigation(element, onNavigate) {
  const kit = await loadMobileHalaska();
  if (!element.isConnected) return null;
  if (!navigationRegistered.has(kit)) {
    kit.register('MobileConnectionNavigation', ({ onNavigate }) => kit.React.createElement('div', { className: 'connection-navigation', role: 'group', 'aria-label': '连接设置快捷入口' },
      ...[['Mac 配置', '#connection-sync-root'], ['手动模型', '#model-form'], ['语音', '#speech-form'], ['云账号', '#sync-form']].map(([label, target]) => kit.node({ component: 'Button', key: target, props: {
        children: label, type: 'button', variant: 'secondary', onClick: () => onNavigate(target),
        style: { minHeight: 44, padding: '8px 10px', fontFamily: 'inherit', fontSize: 13 },
      } }))));
    navigationRegistered.add(kit);
  }
  return themedIsland(kit, element, 'MobileConnectionNavigation', { onNavigate });
}
