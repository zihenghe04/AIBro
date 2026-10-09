import { loadMobileHalaska } from "./halaska-loader.js";
import "./document-toolbar.css";

const registered = new WeakSet();
const toolbarName = "MobileDocumentToolbar", saveBarName = "MobileDocumentSaveBar", originName = "MobileDocumentOrigin";
const formatGroups = [
  [["undo", "↶", "撤销"], ["redo", "↷", "重做"]],
  [["heading1", "H1", "一级标题"], ["heading2", "H2", "二级标题"], ["heading3", "H3", "三级标题"]],
  [["bold", "B", "粗体"], ["italic", "I", "斜体"], ["strike", "S", "删除线"]],
  [["bullet", "• ≡", "无序列表"], ["number", "1. ≡", "有序列表"], ["checklist", "☑", "待办清单"], ["quote", "❞", "引用"]],
  [["inline-code", "‹›", "行内代码"], ["code-block", "{ }", "代码块"], ["link", "↗", "插入链接"], ["rule", "—", "分隔线"]],
];

function register(kit) {
  if (registered.has(kit)) return;
  const { createElement: h, useEffect, useLayoutEffect, useRef, useState, useId } = kit.React;
  function Control({ name, children, className = "", menuItem = false, hasPopup = false, preserveSelection = false, ...props }) {
    const host = useRef(null);
    // The reviewed Kit forwards supported aria props; attach the test identity
    // and menu role to its actual button without introducing delegated actions.
    useLayoutEffect(() => {
      const button = host.current?.querySelector("button");
      if (!button) return;
      button.dataset.documentControl = name;
      if (menuItem) button.setAttribute("role", "menuitem");
      if (hasPopup) button.setAttribute("aria-haspopup", "menu");
    }, [name, menuItem, hasPopup]);
    return h("span", { ref: host, className: `document-toolbar__control ${className}`,
      onPointerDown: preserveSelection ? event => {
        // Preserve a desktop/pointer selection without cancelling touch panning
        // along the format strip. The owner also captures the textarea range.
        if (event.pointerType === "mouse" && event.button === 0) event.preventDefault();
      } : undefined,
    }, kit.node({ component: "Button", props: {
      size: "sm", type: "button", variant: "ghost", ...props, children,
      style: { minWidth: 44, minHeight: 44, height: "auto", borderRadius: 10, padding: "0 10px", fontSize: 13, fontFamily: "inherit", boxShadow: "none", ...props.style },
    } }));
  }
  function useAction(props, fallback) {
    const mounted = useRef(true), executing = useRef(false);
    const [pending, setPending] = useState(false), [error, setError] = useState("");
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const invoke = (callback, ...args) => async event => {
      event?.stopPropagation();
      if (props.busy || executing.current || !mounted.current || typeof callback !== "function") return;
      executing.current = true; setPending(true); setError("");
      try { await callback(...args); }
      catch (failure) {
        if (mounted.current) setError(failure?.message || fallback);
        try { props.onError?.(failure); } catch { /* The owning editor can also report the error. */ }
      } finally {
        executing.current = false;
        if (mounted.current) setPending(false);
      }
    };
    return { invoke, pending, error };
  }
  function DocumentToolbar(props) {
    const mode = props.mode === "edit" ? "edit" : "read";
    const host = useRef(null), menu = useRef(null), menuId = useId();
    const [open, setOpen] = useState(false);
    const { invoke, pending, error } = useAction(props, "操作未完成，请重试。");
    const busy = !!props.busy || pending;
    const trigger = () => host.current?.querySelector('[data-document-control="more"]');
    const closeMenu = restoreFocus => { setOpen(false); if (restoreFocus) trigger()?.focus({ preventScroll: true }); };
    useEffect(() => { setOpen(false); }, [mode, props.busy]);
    useEffect(() => {
      if (!open) return;
      const document = host.current.ownerDocument;
      menu.current?.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
      const outside = event => { if (!menu.current?.contains(event.target) && !trigger()?.contains(event.target)) setOpen(false); };
      const escape = event => {
        if (event.key !== "Escape") return;
        event.preventDefault(); event.stopPropagation(); closeMenu(true);
      };
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("focusin", outside, true);
      document.addEventListener("keydown", escape, true);
      return () => {
        document.removeEventListener("pointerdown", outside, true);
        document.removeEventListener("focusin", outside, true);
        document.removeEventListener("keydown", escape, true);
      };
    }, [open]);
    const menuKey = event => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const buttons = [...(menu.current?.querySelectorAll('button:not(:disabled)') || [])];
      if (!buttons.length) return;
      event.preventDefault(); event.stopPropagation();
      const current = buttons.indexOf(event.target), direction = event.key === "ArrowUp" ? -1 : 1;
      const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + direction + buttons.length) % buttons.length;
      buttons[index].focus({ preventScroll: true });
    };
    const items = [
      ["rewrite", props.hasUnsavedDraft ? "保存并改写" : "AI 改写", props.onRewrite],
      ...(props.hasAIDraft ? [["review-draft", "审阅 AI 草稿", props.onReviewDraft]] : []),
      ["schedule", "安排日程", props.onSchedule],
      ["export", "导出 Markdown", props.onExport],
      ["trash", "移入回收站", props.onTrash],
    ];
    return h("section", { ref: host, className: "document-toolbar", "aria-label": "文档工具", "data-document-mode": mode },
      h("div", { className: "document-toolbar__main" },
        h("div", { className: "document-toolbar__modes", role: "group", "aria-label": "文档模式" },
          ...[["read", "阅读"], ["edit", "编辑"]].map(([value, title]) => h(Control, { key: value, name: value,
            "aria-pressed": mode === value, disabled: busy || typeof props.onMode !== "function",
            onClick: mode === value ? event => event.stopPropagation() : invoke(props.onMode, value), children: title }))),
        h("div", { className: "document-toolbar__primary" },
          h(Control, { name: "discuss", children: props.hasUnsavedDraft ? "保存并讨论" : "与 AI 讨论", disabled: busy || !!props.disabled || typeof props.onDiscuss !== "function", onClick: invoke(props.onDiscuss), style: { padding: "0 8px" } }),
          h(Control, { name: "more", children: "•••", "aria-label": "更多文档操作", "aria-expanded": open, "aria-controls": menuId, hasPopup: true, disabled: busy,
            onClick: event => { event.stopPropagation(); setOpen(value => !value); }, style: { padding: 0, width: 44, fontSize: 17, letterSpacing: 1 } }))),
      open ? h("div", { ref: menu, id: menuId, role: "menu", "aria-label": "更多文档操作", className: "document-toolbar__menu", onKeyDown: menuKey },
        ...items.map(([name, title, callback]) => h(Control, { key: name, name, menuItem: true, className: name === "trash" ? "document-toolbar__danger" : "",
          children: title, disabled: busy || !!props.disabled && ["rewrite", "review-draft", "schedule"].includes(name) || typeof callback !== "function", onClick: event => { closeMenu(true); return invoke(callback)(event); }, style: { width: "100%", justifyContent: "flex-start", padding: "0 12px" } }))) : null,
      mode === "edit" ? h("div", { className: "document-toolbar__formats", role: "group", "aria-label": "文本格式", tabIndex: 0 },
        ...formatGroups.map((group, index) => h("div", { key: index, className: "document-toolbar__format-group" },
          ...group.map(([action, symbol, label]) => h(Control, { key: action, name: `format-${action}`, className: `document-toolbar__format document-toolbar__format--${action}`,
            children: symbol, "aria-label": label, title: label, preserveSelection: true, disabled: busy || !!props.disabled || typeof props.onFormat !== "function", onClick: invoke(props.onFormat, action), style: { padding: "0 8px", fontSize: 15 } }))))) : null,
      error ? h("p", { className: "document-toolbar__error", role: "alert" }, error) : null);
  }
  function DocumentSaveBar(props) {
    const { invoke, pending, error } = useAction(props, "尚未保存，请重试。");
    const busy = !!props.busy || pending;
    return h("div", { className: "document-savebar", "aria-busy": busy },
      h("div", { className: "document-savebar__row" },
        h("p", { className: "document-savebar__status", "data-document-status": true }, props.status || ""),
        h(Control, { name: "save", children: busy ? "保存中…" : "保存", "aria-label": busy ? "正在保存文档" : "保存文档", variant: "primary", loading: busy,
          disabled: busy || !!props.disabled || typeof props.onSave !== "function", onClick: invoke(props.onSave), style: { minWidth: 88, padding: "0 18px" } })),
      error ? h("p", { className: "document-toolbar__error", role: "alert" }, error) : null);
  }
  function DocumentOrigin(props) {
    const { invoke, pending, error } = useAction(props, "未能打开来源资料，请重试。");
    const title = String(props.title || "未命名资料");
    return h("section", { className: "document-origin", "aria-label": "当前对话来源" },
      h("div", { className: "document-origin__row" },
        h(Control, { name: "source", className: "document-origin__source", children: h("span", { className: "document-origin__label" }, props.unavailable ? "来源资料不可用" : `来源资料：${title}`),
          "aria-label": props.unavailable ? `来源资料不可用：${title}` : `打开来源资料：${title}`, title,
          disabled: !!props.unavailable || !!props.busy || pending || typeof props.onSource !== "function", onClick: invoke(props.onSource), style: { width: "100%", minWidth: 0, padding: "0 8px", justifyContent: "flex-start", color: "var(--muted)" } }),
        props.hasParentConversation ? h(Control, { name: "parent", children: "原对话", "aria-label": "返回原对话", disabled: !!props.busy || pending || typeof props.onParent !== "function", onClick: invoke(props.onParent), style: { flexShrink: 0, padding: "0 8px", color: "var(--accent)" } }) : null),
      error ? h("p", { className: "document-toolbar__error", role: "alert" }, error) : null);
  }
  kit.register(toolbarName, DocumentToolbar);
  kit.register(saveBarName, DocumentSaveBar);
  kit.register(originName, DocumentOrigin);
  registered.add(kit);
}

async function mount(element, name, props, { bridge } = {}) {
  if (!element || element.nodeType !== 1 || element.childNodes.length) throw Error("文档工具栏需要独立的空容器");
  const kit = bridge || await loadMobileHalaska();
  if (!element.isConnected || element.childNodes.length) throw Error("文档工具栏容器已关闭或已有内容");
  register(kit);
  element.classList.add("document-controls-root");
  const island = kit.mount(element, name, props || {});
  let disposed = false;
  return Object.freeze({ element,
    update(next) {
      if (disposed) return false;
      if (!element.isConnected) { disposed = true; island.unmount(); return false; }
      island.update(next); return true;
    },
    unmount() {
      if (disposed) return;
      disposed = true; island.unmount(); element.classList.remove("document-controls-root");
    },
  });
}

// Each empty root has one owner. The host controls mode, text selections,
// drafts, navigation and durable saves; these islands only invoke callbacks.
export const mountDocumentToolbar = (element, props, options) => mount(element, toolbarName, props, options);
export const mountDocumentSaveBar = (element, props, options) => mount(element, saveBarName, props, options);
export const mountDocumentOrigin = (element, props, options) => mount(element, originName, props, options);
