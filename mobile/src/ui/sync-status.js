import { loadMobileHalaska } from "./halaska-loader.js";
import { syncStatusModel } from "./sync-status-model.js";
import "./sync-status.css";

const registered = new WeakSet();
const componentName = "MobileSyncStatus";

function register(kit) {
  if (registered.has(kit)) return;
  const { createElement: h, useState, useRef, useEffect } = kit.React;
  const control = (key, props) => kit.node({ component: "Button", key, props: {
    size: "sm", type: "button", style: { minHeight: 44, height: 44, borderRadius: 12, padding: "0 12px", fontFamily: "inherit" }, ...props,
  } });
  function MobileSyncStatus(props) {
    const model = syncStatusModel(props);
    const [actionError, setActionError] = useState("");
    const [pendingAction, setPendingAction] = useState(null);
    const mounted = useRef(true), executing = useRef(new Set());
    useEffect(() => () => { mounted.current = false; }, []);
    useEffect(() => { setActionError(""); }, [props.state, props.lastSyncedAt, props.lastSync]);
    const invoke = (name, callback) => async () => {
      if (typeof callback !== "function" || executing.current.has(name)) return;
      executing.current.add(name); setPendingAction(name); setActionError("");
      try { await callback(); }
      catch (failure) {
        const error = failure instanceof Error ? failure : Error(String(failure));
        if (mounted.current) setActionError(error.message || "操作未完成，请重试");
        try { props.onError?.(error); } catch { /* Error reporting does not own the action. */ }
      } finally {
        executing.current.delete(name);
        if (mounted.current) setPendingAction(null);
      }
    };
    if (props.compact) return h("section", { className: "mobile-sync-status mobile-sync-status--compact", "data-sync-state": model.state, "aria-label": "设备同步" },
      control("open", {
        children: h("span", { className: "mobile-sync-status__compact-label" },
          h("span", { className: "mobile-sync-status__dot", "aria-hidden": "true" }),
          h("span", { className: "mobile-sync-status__short-title" }, model.shortTitle)),
        "aria-label": `${model.title}。${model.detail} 打开同步详情`, variant: "secondary",
        disabled: typeof props.onOpen !== "function", onClick: invoke("open", props.onOpen),
        // Reserve four CJK glyphs plus the 7px dot, 6px gap and 20px padding.
        // An auto-sized parent + percentage max-width can shrink native WebView
        // buttons below their label width; these bounded titles must stay whole.
        style: { minHeight: 44, height: 44, borderRadius: 12, padding: "0 10px", width: "max-content", minWidth: "calc(4em + 33px)", fontSize: 12, fontFamily: "inherit" },
      }));
    const actions = [control("sync", {
      children: model.syncing ? "同步中" : "同步", "aria-label": "立即同步",
      variant: "secondary", disabled: !model.canSync || typeof props.onSync !== "function" || pendingAction === "sync",
      onClick: invoke("sync", props.onSync),
    })];
    if (model.showConflicts) actions.push(control("conflicts", {
      children: "查看冲突", variant: "secondary", disabled: typeof props.onConflicts !== "function",
      onClick: invoke("conflicts", props.onConflicts),
    }));
    actions.push(control("settings", {
      children: "设置", "aria-label": "打开同步设置", variant: model.settingsPrimary ? "primary" : "ghost",
      disabled: typeof props.onSettings !== "function", onClick: invoke("settings", props.onSettings),
    }));
    return h("section", { className: "mobile-sync-status", "data-sync-state": model.state, "aria-label": "设备同步" },
      h("div", { className: "mobile-sync-status__summary", role: "status", "aria-live": "polite", "aria-atomic": "true" },
        h("span", { className: "mobile-sync-status__dot", "aria-hidden": "true" }),
        h("div", { className: "mobile-sync-status__copy" },
          kit.node({ component: "Text", props: { as: "strong", children: model.title, weight: "semibold", style: { fontSize: 14, fontFamily: "inherit", lineHeight: 1.45 } } }),
          h("p", { className: "mobile-sync-status__detail" }, model.detail))),
      h("div", { className: "mobile-sync-status__actions", "aria-label": "同步操作" }, ...actions),
      actionError || props.error ? h("p", { className: "mobile-sync-status__error", role: "alert" },
        actionError || (props.error instanceof Error ? props.error.message : String(props.error))) : null);
  }
  kit.register(componentName, MobileSyncStatus);
  registered.add(kit);
}

// The caller must provide an empty, explicitly owned root. Routing, credentials,
// sync runs and retries stay outside this module. Update rather than remount it.
export async function mountSyncStatus(element, initialProps, { bridge } = {}) {
  if (!element || element.nodeType !== 1 || element.childNodes.length)
    throw Error("同步状态组件需要独立的空容器");
  const kit = bridge || await loadMobileHalaska();
  if (!element.isConnected) throw Error("同步状态容器已关闭");
  if (element.childNodes.length) throw Error("同步状态容器已有内容，未覆盖");
  register(kit);
  element.classList.add("mobile-sync-root");
  const island = kit.mount(element, componentName, initialProps || {});
  let disposed = false;
  return Object.freeze({ element,
    update(props) {
      if (disposed) return false;
      if (!element.isConnected) { disposed = true; kit.unmount(element); return false; }
      island.update(props); return true;
    },
    unmount() { if (disposed) return; disposed = true; island.unmount(); element.classList.remove("mobile-sync-root"); },
  });
}
