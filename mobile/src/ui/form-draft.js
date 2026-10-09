import { loadMobileHalaska } from "./halaska-loader.js";
import "./form-draft.css";

const registered = new WeakSet();
export async function mountFormDraft(element, props) {
  const kit = await loadMobileHalaska();
  if (!element.isConnected || element.childNodes.length) return null;
  if (!registered.has(kit)) {
    const h = kit.React.createElement;
    kit.register("MobileFormDraft", ({ state, retained, busy, viewingLatest, onLatest, onDraft, onDiscard }) => {
      const conflict = state === "changed" || state === "invalid";
      if (!conflict && !retained) return null;
      const action = (children, onClick) => kit.node({ component: "Button", props: { children, onClick,
        variant: "secondary", type: "button", disabled: busy, style: { minHeight: 44, borderRadius: 10, padding: "8px 12px", fontFamily: "inherit" } } });
      return h("section", { className: "form-draft-status", "data-form-draft-state": state, "aria-busy": busy },
        h("p", { role: "status", "aria-live": "polite" }, conflict
          ? state === "invalid" ? "草稿暂时无法读取。已保存的内容没有改变。"
            : viewingLatest ? "正在查看最新内容，未保存的草稿仍留在本机。" : "原内容在其他地方更新或移除了。草稿已保留，保存已暂停。"
          : "草稿保存在本机"),
        h("div", { className: "form-draft-actions" }, conflict && (viewingLatest ? action("返回草稿", onDraft) : action("查看最新内容", onLatest)),
          action("丢弃草稿", onDiscard)));
    });
    registered.add(kit);
  }
  const island = kit.mount(element, "MobileFormDraft", props);
  return { update: island.update, unmount: island.unmount };
}
