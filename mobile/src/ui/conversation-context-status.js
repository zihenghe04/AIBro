import { loadMobileHalaska } from './halaska-loader.js';
import './conversation-context-status.css';

const registered = new WeakSet(), name = 'MobileConversationContextStatus';
function register(kit) {
  if (registered.has(kit)) return;
  const { createElement: h, useEffect, useRef, useState } = kit.React;
  function ContextStatus({ view, busy = false, onChoose, onUseScope }) {
    const [pending, setPending] = useState(false), [error, setError] = useState('');
    const executing = useRef(false), mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    useEffect(() => { setError(''); }, [view?.state, view?.unavailableCount]);
    const invoke = callback => async event => {
      event?.stopPropagation();
      if (busy || executing.current || !mounted.current || typeof callback !== 'function') return;
      executing.current = true; setPending(true); setError('');
      try { await callback(); }
      catch (failure) { if (mounted.current) setError(failure?.message || '引用未调整，请重试。'); }
      finally { executing.current = false; if (mounted.current) setPending(false); }
    };
    if (!view || view.canSend) return null;
    const control = (key, title, callback) => kit.node({ component: 'Button', key, props: {
      type: 'button', variant: 'ghost', children: title, onClick: invoke(callback),
      disabled: busy || pending || typeof callback !== 'function',
      style: { minHeight: 44, minWidth: 44, padding: '8px 10px', height: 'auto', borderRadius: 10, fontSize: 13, fontFamily: 'inherit' },
    } });
    return h('section', { className: 'conversation-context-status', 'aria-label': '引用资料待处理', 'aria-busy': busy || pending },
      h('p', { className: 'conversation-context-status__message', role: 'status' }, view.message),
      h('div', { className: 'conversation-context-status__actions' },
        control('choose', '重新选择引用', onChoose),
        control('scope', view.resetLabel, onUseScope)),
      error ? h('p', { className: 'conversation-context-status__error', role: 'alert' }, error) : null);
  }
  kit.register(name, ContextStatus); registered.add(kit);
}

// Only this empty island belongs to React; the host retains the input and
// controls the current conversation, draft, scope confirmation, and transaction.
export async function mountConversationContextStatus(element, props, { bridge } = {}) {
  if (!element || element.nodeType !== 1 || element.childNodes.length) throw Error('引用状态需要独立的空容器');
  const kit = bridge || await loadMobileHalaska();
  if (!element.isConnected || element.childNodes.length) throw Error('引用状态容器已关闭或已有内容');
  register(kit);
  const island = kit.mount(element, name, props || {});
  let disposed = false;
  return Object.freeze({ element,
    update(next) {
      if (disposed) return false;
      if (!element.isConnected) { disposed = true; island.unmount(); return false; }
      island.update(next); return true;
    },
    unmount() { if (!disposed) { disposed = true; island.unmount(); } },
  });
}
