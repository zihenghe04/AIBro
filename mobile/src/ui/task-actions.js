import { loadMobileHalaska } from "./halaska-loader.js";
import "./task-editor.css";

const registered = new WeakSet();
export async function mountTaskActions(element, props) {
  const kit = await loadMobileHalaska();
  if (!element.isConnected || element.childNodes.length) return null;
  if (!registered.has(kit)) {
    const h = kit.React.createElement;
    kit.register("MobileTaskActions", ({ existing, completed, busy, onComplete }) =>
      h("div", { className: "task-save-actions" },
        existing && kit.node({ component: "Button", props: { children: completed ? "重新打开" : "标记完成", variant: "secondary", disabled: busy,
          onClick: onComplete, style: { minHeight: 46, borderRadius: 14, fontFamily: "inherit", width: "100%" } } }),
        kit.node({ component: "Button", props: { children: "保存任务", variant: "primary", type: "submit", loading: busy, disabled: busy,
          style: { minHeight: 46, borderRadius: 14, fontFamily: "inherit", width: "100%" } } })));
    registered.add(kit);
  }
  const handle = kit.mount(element, "MobileTaskActions", props);
  return { update: handle.update, unmount: handle.unmount };
}
