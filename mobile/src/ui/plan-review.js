import { taskStatusLabel } from "../task-status.js";
import { loadMobileHalaska } from "./halaska-loader.js";
import { readEvent } from "../agenda.js";
import { diffLines } from "diff";
import "./plan-review.css";

const registered = new WeakSet();
const kinds = { projects: "项目", tasks: "任务", notes: "笔记", agenda: "日程", imports: "资料", trash: "回收站内容" };
const operations = { create: "新建", update: "修改", remove: "移入回收站", restore: "恢复" };
const effects = { archive: "归档", unarchive: "恢复归档", "restore-trash": "从回收站恢复", trash: "移入回收站" };
const json = value => value ? JSON.stringify(value, null, 2) : "";
function dateTime(stamp, zone) {
  if (stamp == null) return "未设置";
  try { return new Date(stamp).toLocaleString("zh-CN", { timeZone: zone, year:"numeric", month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" }); }
  catch { return String(stamp); }
}
function repeat(event) {
  if (event.ics) return "保留导入的课表规则";
  const r = event.recurrence;
  if (!r || r.frequency === "none") return "不重复";
  const days = ["", "日", "一", "二", "三", "四", "五", "六"];
  return `每 ${r.interval} ${ { daily: "天", weekly: "周", monthly: "个月" }[r.frequency] }` +
    (r.frequency === "weekly" && r.weekdays?.length ? ` · 周${r.weekdays.map(d => days[d]).join("、")}` : "") +
    (r.count ? ` · 共 ${r.count} 次` : "") + (r.until ? ` · 至 ${dateTime(r.until, event.timeZone)}` : "");
}
function actionFields(action, projects) {
  const after = action.after, before = action.before;
  const rows = [];
  const add = (label, next, previous) => {
    if (next === undefined) return;
    rows.push({ label, value: String(next ?? "未设置"), previous: action.operation === "update" && previous !== undefined && String(previous) !== String(next) ? String(previous ?? "未设置") : null });
  };
  if (!after || action.lifecycleOperation) return rows;
  if (action.kind === "agenda") {
    const e = readEvent(after), old = before && readEvent(before);
    if (e) {
      add("开始", dateTime(e.start, e.timeZone), old && dateTime(old.start, old.timeZone));
      add("结束", dateTime(e.end, e.timeZone), old && dateTime(old.end, old.timeZone));
      add("时区", e.timeZone || "UTC", old?.timeZone || "UTC");
      add("重复", repeat(e), old && repeat(old));
      add("提醒", e.reminderMinutes == null ? "不提醒" : e.reminderMinutes === 0 ? "开始时" : `提前 ${e.reminderMinutes} 分钟`);
      if (e.location) add("地点", e.location, old?.location);
    }
  } else if (action.kind === "tasks") {
    if (after.dueAt) add("截止", /^\d{4}-\d{2}-\d{2}$/.test(after.dueAt) ? after.dueAt : dateTime(after.dueAt), before?.dueAt);
    const status = taskStatusLabel;
    add("状态", status(after.status), before && status(before.status));
    if (after.description) add("说明", after.description, before?.description);
  } else if (action.kind === "projects") {
    add("空间", after.workspace, before?.workspace);
    if (after.description) add("目标", after.description, before?.description);
  } else if (action.kind === "notes" && after.content != null) add("正文", after.content, before?.content);
  if (action.kind !== "projects" && after.projectId !== undefined)
    add("项目", after.projectId ? projects[after.projectId] || "已有项目" : "未归属", before?.projectId ? projects[before.projectId] || "已有项目" : before ? "未归属" : undefined);
  return rows;
}
function register(kit) {
  if (registered.has(kit)) return;
  const { createElement: h, useState, useRef, useEffect } = kit.React;
  function PlanReview({ plan, projects, onApply, onReject, onBusy }) {
    const [busy, setBusy] = useState(null), [error, setError] = useState("");
    const running = useRef(false), mounted = useRef(true);
    useEffect(() => () => { mounted.current = false; }, []);
    const invoke = (name, callback) => async event => {
      event.stopPropagation();
      if (running.current) return;
      running.current = true; setBusy(name); setError(""); onBusy?.(true);
      try { await callback(); }
      catch (e) { if (mounted.current) setError(e.message || "操作未完成，请重试"); }
      finally { running.current = false; onBusy?.(false); if (mounted.current) setBusy(null); }
    };
    const allProjects = { ...projects };
    for (const action of plan.actions) if (action.kind === "projects" && action.after) allProjects[action.targetId] = action.after.name || action.title;
    const control = (name, props) => kit.node({ component: "Button", key: name, props: {
      id: `${name}-plan`, type: "button", size: "md", disabled: !!busy, loading: busy === name,
      style: { minHeight: 46, borderRadius: 14, fontFamily: "inherit", padding: "0 16px" }, ...props,
    } });
    return h("section", { className: "mobile-plan-review", "aria-label": "修改方案" },
      h("p", { className: "mobile-plan-review__intro" }, `${plan.actions.length} 项操作，确认后一起生效。`),
      ...plan.actions.map((a, index) => {
        const rows = actionFields(a, allProjects);
        const restored = a.lifecycleReview?.entries || [];
        const diffBefore = a.before, diffAfter = a.lifecycleOperation === "restore-trash" ? Object.fromEntries(restored.map(entry => [entry.key, entry.data])) : a.after;
        return h("section", { className: "mobile-plan-review__item", key: `${index}:${a.targetId}` },
          h("div", { className: "mobile-plan-review__label" }, h("span", null, effects[a.lifecycleOperation] || operations[a.operation]), h("span", null, kinds[a.kind] || "内容")),
          kit.node({ component: "Text", props: { as: "h3", weight: "semibold", children: a.title,
            style: { fontSize: 18, lineHeight: 1.45, fontFamily: "inherit", margin: "7px 0 12px", overflowWrap: "anywhere" } } }),
          rows.length ? h("dl", { className: "mobile-plan-review__fields" }, ...rows.flatMap((row, i) => [
            h("dt", { key: `label-${i}` }, row.label), h("dd", { key: `value-${i}` }, row.previous != null ? h("del", null, row.previous) : null, h("span", null, row.value))])) : null,
          ...(a.warnings || []).map((text, i) => h("p", { key: i, className: "mobile-plan-review__notice" }, text)),
          restored.length ? h("ul", { className: "mobile-plan-review__restored" }, ...restored.map(entry => h("li", { key: entry.key }, `${entry.data.title || entry.data.name || "未命名内容"} · ${kinds[entry.kind] || "关联记录"}`))) : null,
          h("details", { className: "mobile-plan-review__data" }, h("summary", null, "查看具体字段"),
            h("div", { className: "diff" }, ...diffLines(json(diffBefore), json(diffAfter)).map((part, i) => h("pre", { key: i, className: part.added ? "added" : part.removed ? "removed" : "same" }, part.value)))));
      }),
      error ? h("p", { role: "alert", className: "mobile-plan-review__error" }, error) : null,
      h("div", { className: "mobile-plan-review__actions" },
        control("reject", { children: "不采用", variant: "secondary", onClick: invoke("reject", onReject) }),
        control("apply", { children: plan.actions.some(a => a.lifecycleOperation) ? "确认执行" : "确认保存", variant: "primary", onClick: invoke("apply", onApply) })));
  }
  kit.register("MobilePlanReview", PlanReview); registered.add(kit);
}

export async function mountPlanReview(element, props) {
  if (!element || element.childNodes.length) throw Error("修改方案需要独立的空容器");
  const kit = await loadMobileHalaska();
  if (!element.isConnected || element.childNodes.length) throw Error("修改方案已关闭");
  register(kit); element.classList.add("mobile-plan-root");
  const root = kit.mount(element, "MobilePlanReview", props);
  return { unmount() { root.unmount(); element.classList.remove("mobile-plan-root"); } };
}
