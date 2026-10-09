import { loadMobileHalaska } from "./halaska-loader.js";
import "./sync-group-review.css";

const registered = new WeakSet();
const kinds = { projects: "项目", tasks: "任务", notes: "笔记或日程", conversations: "对话", messages: "消息", trash: "回收站记录", imports: "资料", links: "关联", attachments: "附件关联" };
const titleOf = row => row.local.data?.title || row.local.data?.name || row.remote.data?.title || row.remote.data?.name || kinds[row.key.split(":")[0]] || "内容";
const description = (value, remote = false) => value.deleted ? remote ? "云端没有这条内容；采用后本机也会移除。" : "本机已删除。" : JSON.stringify(value.data, null, 2);

function register(kit) {
  if (registered.has(kit)) return;
  const { createElement: h, useState, useRef, useEffect } = kit.React;
  function SyncGroupReview({ reviews, unavailable = [], onResolve, onSync, onBusy }) {
    const [busy, setBusy] = useState(null), [failure, setFailure] = useState(null);
    const running = useRef(false), mounted = useRef(true);
    useEffect(() => () => { mounted.current = false; }, []);
    const invoke = (groupId, callback) => async event => {
      event.stopPropagation();
      if (running.current) return;
      running.current = true; setBusy(groupId); setFailure(null); onBusy?.(true);
      try { await callback(); }
      catch (e) { if (mounted.current) setFailure({ groupId, text: e.message || "未采用云端内容，请重新打开审阅" }); }
      finally { running.current = false; onBusy?.(false); if (mounted.current) setBusy(null); }
    };
    return h("div", { className: "sync-group-review" }, ...unavailable.map(group =>
      h("section", { key: group.groupId, className: "sync-group-review__group", "data-sync-group": group.groupId },
        kit.node({ component: "Text", props: { as: "h3", children: "整组冲突待比较", weight: "semibold", style: { fontSize: 18, fontFamily: "inherit" } } }),
        h("p", null, group.error), h("p", null, "本机内容和待同步队列仍保留。请先读取完整云端内容，再审阅整组差异。"),
        failure?.groupId === group.groupId ? h("p", { role: "alert", className: "sync-group-review__error" }, failure.text) : null,
        kit.node({ component: "Button", props: { children: "读取整组云端内容", type: "button", variant: "secondary", disabled: !!busy,
          loading: busy === group.groupId, onClick: invoke(group.groupId, onSync), style: { minHeight: 46, maxWidth: "100%", borderRadius: 12, fontFamily: "inherit" } } }))),
      ...reviews.map(review =>
      h("section", { key: review.groupId, className: "sync-group-review__group", "data-sync-group": review.groupId, "aria-label": "整组同步冲突" },
        kit.node({ component: "Text", props: { as: "h3", children: `整组同步冲突 · ${review.records.length} 条内容`, weight: "semibold",
          style: { margin: 0, fontSize: 18, lineHeight: 1.5, fontFamily: "inherit" } } }),
        h("p", null, review.direction === "incoming" ? "收到的一组云端修改与本机内容冲突，尚未合并。" : "这组修改已保存在本机，但尚未同步到其他设备。"),
        review.reason ? h("p", { className: "sync-group-review__reason" }, review.reason) : null,
        h("p", null, "请一起比较这组内容。采用云端会替换下列本机版本；仍需要的修改请重新生成并审阅方案。"),
        ...review.records.map(row => h("details", { key: row.key, className: "sync-group-review__record" },
          h("summary", null, titleOf(row)),
          h("h4", null, "本机"), h("pre", null, description(row.local)),
          h("h4", null, "云端"), h("pre", null, description(row.remote, true)))),
        failure?.groupId === review.groupId ? h("p", { role: "alert", className: "sync-group-review__error" }, failure.text) : null,
        kit.node({ component: "Button", props: { children: "采用整组云端内容", type: "button", variant: "secondary", disabled: !!busy,
          loading: busy === review.groupId, onClick: invoke(review.groupId, () => onResolve(review)), "data-resolve-sync-group": review.groupId,
          style: { minHeight: 46, maxWidth: "100%", borderRadius: 12, padding: "0 14px", fontFamily: "inherit", marginTop: 14 } } }))));
  }
  kit.register("MobileSyncGroupReview", SyncGroupReview); registered.add(kit);
}
export async function mountSyncGroupReview(element, props) {
  if (!element || element.childNodes.length) throw Error("整组冲突需要独立的空容器");
  const kit = await loadMobileHalaska();
  if (!element.isConnected || element.childNodes.length) throw Error("整组冲突页面已关闭");
  register(kit); element.classList.add("sync-group-root");
  const root = kit.mount(element, "MobileSyncGroupReview", props);
  return { unmount() { root.unmount(); element.classList.remove("sync-group-root"); } };
}
