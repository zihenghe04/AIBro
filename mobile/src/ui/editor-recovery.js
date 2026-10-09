import { loadMobileHalaska } from "./halaska-loader.js";
import "./editor-recovery.css";

const registered = new WeakSet();
const componentName = "MobileEditorRecovery";

function register(kit) {
  if (registered.has(kit)) return;
  const { createElement: h, useState, useRef, useEffect } = kit.React;
  function EditorRecovery(props) {
    const state = ["changed", "legacy"].includes(props.state) ? props.state : "invalid";
    const [pending, setPending] = useState(false), [error, setError] = useState("");
    const executing = useRef(false), mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    useEffect(() => { setError(""); }, [props.state]);
    const invoke = callback => async () => {
      if (props.busy || executing.current || !mounted.current || typeof callback !== "function") return;
      executing.current = true; setPending(true); setError("");
      try { await callback(); }
      catch (failure) { if (mounted.current) setError(failure?.message || "操作未完成，草稿仍保留。"); }
      finally { executing.current = false; if (mounted.current) setPending(false); }
    };
    const control = (key, children, callback, variant) => kit.node({ component: "Button", key, props: {
      type: "button", children, variant, disabled: !!props.busy || pending || typeof callback !== "function",
      onClick: invoke(callback), style: { minHeight: 44, borderRadius: 12, padding: "10px 12px", width: "100%", fontFamily: "inherit", fontSize: 14 },
    } });
    const message = state === "changed" ? "这份资料在其他地方更新过。你的草稿仍在，原文没有被覆盖。"
      : state === "legacy" ? "这份旧草稿没有原始版本。你的草稿仍在，原文没有被覆盖。"
      : "这份草稿暂时无法读取。原文没有被覆盖。";
    return h("section", { className: "editor-recovery", "data-editor-recovery": state,
      "aria-label": props.kind === "capture" ? "随记草稿处理" : "笔记草稿处理", "aria-busy": !!props.busy || pending },
    h("p", { className: "editor-recovery__message", role: "status", "aria-live": "polite" }, message),
    h("div", { className: "editor-recovery__actions" },
      control("latest", "查看最新内容", props.onLatest, "secondary"),
      state !== "invalid" ? control("copy", "另存为新资料", props.onSaveCopy, "primary") : null),
    error ? h("p", { className: "editor-recovery__error", role: "alert" }, error) : null);
  }
  kit.register(componentName, EditorRecovery);
  registered.add(kit);
}

// Owns only this empty island. The DOM editor owns drafts, comparisons, routes
// and persistence; callbacks complete only when that owner reports completion.
export async function mountEditorRecovery(element, props, { bridge } = {}) {
  if (!element || element.nodeType !== 1 || element.childNodes.length)
    throw Error("草稿处理组件需要独立的空容器");
  const kit = bridge || await loadMobileHalaska();
  if (!element.isConnected || element.childNodes.length) throw Error("草稿处理容器已关闭或已有内容");
  register(kit);
  element.classList.add("editor-recovery-root");
  const island = kit.mount(element, componentName, props || {});
  let disposed = false;
  return Object.freeze({ element,
    update(next) {
      if (disposed) return false;
      if (!element.isConnected) { disposed = true; island.unmount(); return false; }
      island.update(next); return true;
    },
    unmount() {
      if (disposed) return;
      disposed = true; island.unmount(); element.classList.remove("editor-recovery-root");
    },
  });
}
