import { loadMobileHalaska } from './halaska-loader.js';
import './api-profile-settings.css';
const registered = new WeakSet();
export async function mountApiProfileSettings(root, form, editor, { purpose, onSaved = () => {}, onError = () => {} } = {}) {
  const kit = await loadMobileHalaska();
  if (!root.isConnected || !form.isConnected) return null;
  if (!registered.has(kit)) {
    kit.register('MobileApiProfiles', ({ state, purpose, action, select, message }) => {
      const h = kit.React.createElement;
      const button = (label, name, disabled = false) => kit.node({ component: 'Button', props: { id: `api-${purpose}-${name}`,
        children: label, type: 'button', variant: 'secondary', disabled: state.busy || disabled, onClick: () => action(name),
        style: { minHeight: 44, padding: '8px 12px', fontFamily: 'inherit' } } });
      const active = state.profiles.find(p => p.id === state.activeId);
      return h('div', { className: 'api-profile-controls' },
        h('p', { className: 'hint', 'data-api-active': purpose }, `当前启用：${state.synced ? 'Mac 同步配置' : active?.name || '尚未保存'}`),
        h('label', null, '正在编辑的方案', h('select', { value: state.editingId, disabled: state.busy, onChange: e => select(e.target.value), 'aria-label': '正在编辑的方案' },
          h('option', { value: '' }, '新方案'), ...state.profiles.map(p => h('option', { key: p.id, value: p.id }, p.name)))),
        h('div', { className: 'api-profile-actions' }, button('新建方案', 'new'), button('使用已保存方案', 'use', !state.editingId),
          button('删除方案', 'remove', !state.editingId || state.editingId === state.activeId)),
        h('p', { className: 'hint', role: 'status' }, state.busy
          ? ({ save: '正在保存方案…', select: '正在切换编辑方案…', use: '正在启用方案…', remove: '正在删除方案…', test: '正在测试连接…' })[state.operation] || '正在处理方案…'
          : state.dirty ? '有未保存修改；切换编辑方案会保留输入。' : '选择方案只加载编辑内容；点击“使用已保存方案”才切换。'),
        purpose === 'speech' && h('div', { className: 'api-profile-test' }, button('测试连接', 'test'), h('p', { className: 'hint' }, '发送 1 秒合成静音，可能产生少量费用；不录音、不保存设置。')),
        message && h('p', { className: 'api-profile-message', role: 'status' }, message));
    });
    registered.add(kit);
  }
  let disposed = false, message = editor.snapshot().outcome?.message || '', timer = null, disabled = null;
  const themeMedia = matchMedia('(prefers-color-scheme: dark)'), theme = () => themeMedia.matches ? 'dark' : 'light';
  const fill = () => { for (const [key, value] of Object.entries(editor.snapshot().values)) if (form.elements.namedItem(key)) form.elements.namedItem(key).value = value; };
  const capture = () => editor.setValues(Object.fromEntries(new FormData(form)));
  const paint = () => { if (!disposed) island.update({ state: editor.snapshot(), message, theme: theme() }); };
  const syncBusy = () => {
    if (editor.snapshot().busy) {
      if (!disabled) disabled = [...form.elements].map(e => [e, e.disabled]);
      for (const [e] of disabled) e.disabled = true;
    } else if (disabled) {
      for (const [e, old] of disabled) e.disabled = old;
      disabled = null;
    }
  };
  const persist = () => { clearTimeout(timer); timer = null; return editor.retain().catch(error => { if (!disposed) { message = '草稿尚未保存到设备，请保留此页并重试。'; paint(); } onError(error); }); };
  async function invoke(work) {
    if (disposed || editor.snapshot().busy) return;
    clearTimeout(timer); timer = null; capture(); message = '';
    // The editor publishes completion to the currently mounted view. The view
    // that started an operation may already have been replaced by navigation.
    try { await work(); } catch { /* The editor's actual failure is rendered by its subscriber. */ }
  }
  const select = id => invoke(() => editor.select(id));
  const action = name => name === 'new' ? select('')
    : name === 'use' ? invoke(() => editor.use())
    : name === 'remove' ? invoke(() => editor.remove())
    : invoke(() => editor.test());
  const island = kit.mount(root, 'MobileApiProfiles', { state: editor.snapshot(), purpose, action, select, message, theme: theme() });
  fill();
  const unsubscribe = editor.subscribe(event => {
    if (disposed) return;
    try {
      syncBusy();
      if (event.stage === 'finish') {
        if (event.ok && ['select', 'save', 'remove'].includes(event.kind)) fill();
        message = event.message;
        paint();
        if (event.ok) onSaved();
      } else { message = ''; paint(); }
    } catch (error) { onError(error); }
  });
  const input = () => { if (editor.snapshot().busy) return; capture(); message = ''; paint(); clearTimeout(timer); timer = setTimeout(persist, 300); };
  const submit = event => { event.preventDefault(); event.stopPropagation(); return invoke(() => editor.save()); };
  form.addEventListener('input', input); form.addEventListener('change', input); form.addEventListener('submit', submit);
  themeMedia.addEventListener('change', paint);
  // The initial fieldset prevents input from racing the asynchronous Kit load.
  // Release it before capturing busy-disabled state, so completion cannot leave
  // a reopened form permanently disabled by this one-time loading gate.
  const loadingFields = form.querySelector('[data-api-profile-fields]');
  if (loadingFields) loadingFields.disabled = false;
  form.querySelector('[data-api-profile-loading]')?.remove();
  syncBusy();
  return { update: paint, unmount() { if (disposed) return; disposed = true; unsubscribe(); clearTimeout(timer);
    if (!editor.snapshot().busy) { capture(); editor.retain().catch(onError); }
    form.removeEventListener('input', input); form.removeEventListener('change', input); form.removeEventListener('submit', submit);
    themeMedia.removeEventListener('change', paint); island.unmount();
  } };
}
