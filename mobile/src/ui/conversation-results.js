import { loadMobileHalaska } from "./halaska-loader.js";
import "./conversation-results.css";

const registered = new WeakSet();
function register(kit) {
  if (registered.has(kit)) return;
  const { createElement: h, useState, useRef, useEffect } = kit.React;
  function ConversationResults({ model, onOpen }) {
    const [failure, setFailure] = useState("");
    const mounted = useRef(true);
    useEffect(() => () => { mounted.current = false; }, []);
    const open = item => event => {
      event.stopPropagation();
      setFailure("");
      Promise.resolve().then(() => onOpen(item.key)).catch(e => { if (mounted.current) setFailure(e.message || "内容暂时无法打开"); });
    };
    return h("section", { className: "conversation-results", "data-result-state": model.state, "aria-label": "操作结果" },
      kit.node({ component: "Text", props: { as: "strong", children: model.title, weight: "semibold",
        style: { fontSize: 14, lineHeight: 1.5, fontFamily: "inherit" } } }),
      h("p", { className: "conversation-results__detail" }, model.detail),
      ...model.items.map(item => h("div", { key: item.key, className: "conversation-results__item" },
        h("span", { className: "conversation-results__operation" }, item.action),
        h("strong", { className: "conversation-results__title" }, item.title),
        item.detail ? h("p", { className: "conversation-results__detail" }, item.detail) : null,
        item.buttonLabel ? kit.node({ component: "Button", key: `open-${item.key}`, props: {
          children: item.buttonLabel, type: "button", variant: "secondary", size: "sm", onClick: open(item),
          "aria-label": `${item.buttonLabel}：${item.title}`, "data-result-key": item.key,
          style: { minHeight: 44, maxWidth: "100%", borderRadius: 12, padding: "0 14px", fontFamily: "inherit" },
        } }) : null)),
      failure ? h("p", { role: "alert", className: "conversation-results__error" }, failure) : null);
  }
  kit.register("MobileConversationResults", ConversationResults); registered.add(kit);
}

export async function mountConversationResults(element, props) {
  if (!element || element.childNodes.length) throw Error("操作结果需要独立的空容器");
  const kit = await loadMobileHalaska();
  if (!element.isConnected || element.childNodes.length) throw Error("操作结果容器已关闭");
  register(kit); element.classList.add("conversation-results-root");
  const root = kit.mount(element, "MobileConversationResults", props);
  return { unmount() { root.unmount(); element.classList.remove("conversation-results-root"); } };
}
