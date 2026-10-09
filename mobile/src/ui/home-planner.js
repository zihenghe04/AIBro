import { loadMobileHalaska } from "./halaska-loader.js";
import { plannerDateLabel, plannerDayKey, plannerEventTime, plannerEvents, plannerProjectLabel, plannerTasks, plannerTime, plannerWeek, shiftPlannerDay } from "./home-planner-model.js";
import "./home-planner.css";

const registered = new WeakSet();
const componentName = "MobileHomePlanner";

function register(kit) {
  if (registered.has(kit)) return;
  const { createElement: h, useEffect, useRef, useState } = kit.React;
  const control = (key, props) => kit.node({ component: "Button", key, props: {
    size: "sm", type: "button", ...props, style: { minWidth: 44, minHeight: 44, height: "auto", borderRadius: 11, padding: "0 12px", fontSize: 13, fontFamily: "inherit", boxShadow: "none", ...props.style },
  } });
  const heading = text => kit.node({ component: "Text", props: { as: "strong", children: text, weight: "semibold", style: { fontSize: 17, fontFamily: "inherit", lineHeight: 1.4 } } });
  function MobileHomePlanner(props) {
    const mode = props.mode === "tasks" ? "tasks" : "agenda";
    const today = plannerDayKey(props.today ?? new Date());
    const selected = plannerDayKey(props.selectedDay) || today;
    const tasks = props.tasks || [], projects = props.projects || [];
    const groups = plannerTasks(tasks, { today, showCompleted: props.showCompleted });
    const remaining = tasks.filter(task => task && !task.archived && !task.deletedAt && !task.deleted && task.status !== "done").length;
    const events = plannerEvents(props.events, selected);
    const week = plannerWeek(selected, today);
    const [error, setError] = useState("");
    const mounted = useRef(true), pending = useRef(new Set());
    useEffect(() => () => { mounted.current = false; }, []);
    useEffect(() => { setError(""); }, [mode, selected, props.showCompleted]);
    const invoke = (name, callback, ...args) => async event => {
      event?.stopPropagation();
      if (typeof callback !== "function" || pending.current.has(name)) return;
      pending.current.add(name); setError("");
      try { await callback(...args); }
      catch (failure) {
        const issue = failure instanceof Error ? failure : Error(String(failure));
        if (mounted.current) setError(issue.message || "未能打开，请重试");
        try { props.onError?.(issue); } catch { /* The owner may report the same failure separately. */ }
      } finally { pending.current.delete(name); }
    };
    const newAction = control("new", { children: mode === "agenda" ? "＋ 新日程" : "＋ 新待办", variant: "secondary", "aria-label": mode === "agenda" ? "新建日程" : "新建待办",
      disabled: typeof (mode === "agenda" ? props.onNewEvent : props.onNewTask) !== "function",
      onClick: mode === "agenda" ? invoke("new-event", props.onNewEvent, selected) : invoke("new-task", props.onNewTask) });
    const eventRow = event => {
      const time = plannerEventTime(event, selected), completed = (event.completed || []).includes(event.start);
      const project = plannerProjectLabel(event.task ? tasks.find(task => task.id === event.id) || event : event, projects);
      const detail = [event.task ? "任务截止" : "", event.location, project].filter(Boolean).join(" · ");
      return h("li", { key: event.occurrenceID || `${event.id}@${event.start}` }, h("button", {
        className: `mobile-planner__event${completed ? " is-completed" : ""}`, type: "button", "data-planner-id": event.id, "data-planner-type": event.task ? "task" : "event",
        disabled: typeof (event.task ? props.onTask : props.onEvent) !== "function",
        onClick: event.task ? invoke(`task:${event.id}`, props.onTask, tasks.find(task => task.id === event.id) || event) : invoke(`event:${event.occurrenceID || event.id}`, props.onEvent, event),
      }, h("span", { className: "mobile-planner__time" }, h("strong", null, time.start), h("small", null, completed ? "已完成" : time.end)),
      h("span", { className: "mobile-planner__record" }, h("strong", { className: "mobile-planner__title" }, event.title || "未命名日程"), detail ? h("span", { className: "mobile-planner__meta" }, detail) : null),
      h("span", { className: "mobile-planner__chevron", "aria-hidden": "true" }, "›")));
    };
    const taskRow = ({ task, due, statusLabel }, group) => {
      const project = plannerProjectLabel(task, projects), status = task.status && !["todo", "done"].includes(task.status) ? statusLabel : "";
      const dueLabel = due ? `${due.day === today ? "今天" : plannerDateLabel(due.day, { year: due.day.slice(0, 4) !== today.slice(0, 4) })}${due.dateOnly ? "" : ` ${plannerTime(due.stamp)}`}` : "";
      const meta = [dueLabel, project, status].filter(Boolean).join(" · ");
      return h("li", { key: task.id }, h("button", { type: "button", className: `mobile-planner__task${task.status === "done" ? " is-completed" : ""}`, "data-planner-id": task.id, "data-planner-type": "task",
        disabled: typeof props.onTask !== "function", onClick: invoke(`task:${task.id}`, props.onTask, task),
      }, h("span", { className: "mobile-planner__task-mark", "aria-hidden": "true" }, task.status === "done" ? "✓" : ""),
      h("span", { className: "mobile-planner__record" }, h("strong", { className: "mobile-planner__title" }, task.title || "未命名待办"),
        task.description ? h("span", { className: "mobile-planner__description" }, task.description) : null,
        meta ? h("span", { className: `mobile-planner__meta${group === "overdue" ? " is-overdue" : ""}` }, meta) : null),
      h("span", { className: "mobile-planner__chevron", "aria-hidden": "true" }, "›")));
    };
    return h("section", { className: "mobile-planner", "aria-label": "我的安排" },
      h("div", { className: "mobile-planner__heading" }, heading("我的安排"), props.onCourses ? control("courses", { children: "课程", variant: "ghost", "aria-label": "打开课程", onClick: invoke("courses", props.onCourses) }) : null),
      h("div", { className: "mobile-planner__toolbar" }, h("div", { className: "mobile-planner__modes", role: "group", "aria-label": "安排视图" },
        control("agenda", { children: "日程", variant: "ghost", "aria-pressed": mode === "agenda", disabled: typeof props.onMode !== "function", onClick: invoke("mode", props.onMode, "agenda") }),
        control("tasks", { children: h("span", { className: "mobile-planner__mode-label" }, "待办", remaining ? h("span", { className: "mobile-planner__count" }, remaining) : null), variant: "ghost", "aria-pressed": mode === "tasks", disabled: typeof props.onMode !== "function", onClick: invoke("mode", props.onMode, "tasks") })), newAction),
      mode === "agenda" ? h("div", { className: "mobile-planner__agenda" },
        h("div", { className: "mobile-planner__calendar-nav" },
          h("input", { type: "date", id: "home-planner-day", className: "mobile-planner__date", "aria-label": "选择日期", value: selected, onChange: event => { const key = plannerDayKey(event.target.value); if (key) invoke("day", props.onDay, key)(event); } }),
          h("div", { className: "mobile-planner__week-nav" },
            control("previous-week", { children: "‹", variant: "ghost", "aria-label": "上一周", disabled: typeof props.onDay !== "function", onClick: invoke("day", props.onDay, shiftPlannerDay(selected, -7)), style: { width: 44, padding: 0, fontSize: 24 } }),
            control("today", { children: "今天", variant: "ghost", disabled: selected === today || typeof props.onDay !== "function", "aria-label": "回到今天", onClick: invoke("day", props.onDay, today), style: { padding: "0 6px" } }),
            control("next-week", { children: "›", variant: "ghost", "aria-label": "下一周", disabled: typeof props.onDay !== "function", onClick: invoke("day", props.onDay, shiftPlannerDay(selected, 7)), style: { width: 44, padding: 0, fontSize: 24 } }))),
        h("div", { className: "mobile-planner__week", role: "group", "aria-label": "本周日期" }, ...week.map(day => h("button", { key: day.key, type: "button", className: "mobile-planner__day", "data-planner-day": day.key, "aria-pressed": day.selected, "aria-current": day.today ? "date" : undefined, "aria-label": `${plannerDateLabel(day.key, { weekday: true, year: true })}${day.today ? "，今天" : ""}`, disabled: typeof props.onDay !== "function", onClick: invoke("day", props.onDay, day.key) }, h("small", null, day.weekday), h("strong", null, day.day)))),
        h("div", { className: "mobile-planner__list-heading" }, h("h3", null, selected === today ? "今天" : plannerDateLabel(selected, { weekday: true })), h("span", null, events.length ? `${events.length} 项安排` : "")),
        events.length ? h("ul", { className: "mobile-planner__list", "aria-label": `${selected} 的安排` }, ...events.map(eventRow)) : h("p", { className: "mobile-planner__empty" }, selected === today ? "今天还没有安排" : "这天还没有安排"),
        props.onImport ? h("div", { className: "mobile-planner__footer" }, control("import", { children: "导入日历 .ics", variant: "ghost", onClick: invoke("import", props.onImport) })) : null)
        : h("div", { className: "mobile-planner__tasks" },
          h("div", { className: "mobile-planner__task-filter" }, h("span", null, props.showCompleted ? "完成记录" : `${remaining} 项待办`),
            control("completed", { children: props.showCompleted ? "查看待办" : "已完成", variant: "ghost", "aria-pressed": Boolean(props.showCompleted), "aria-label": props.showCompleted ? "查看未完成待办" : "查看已完成待办", disabled: typeof props.onShowCompleted !== "function", onClick: invoke("completed", props.onShowCompleted, !props.showCompleted) })),
          groups.length ? groups.map(group => h("section", { key: group.key, className: "mobile-planner__task-group", "aria-label": group.title }, h("h3", null, group.title, h("span", null, group.rows.length)), h("ul", { className: "mobile-planner__list" }, ...group.rows.map(row => taskRow(row, group.key))))) : h("p", { className: "mobile-planner__empty" }, props.showCompleted ? "还没有已完成的待办" : "暂时没有待办")),
      error ? h("p", { className: "mobile-planner__error", role: "alert" }, error) : null);
  }
  kit.register(componentName, MobileHomePlanner);
  registered.add(kit);
}

// This island owns only the empty planner root, never the home composer/draft.
// All edits and navigation are delegated to the host's existing controllers.
export async function mountHomePlanner(element, initialProps, { bridge } = {}) {
  if (!element || element.nodeType !== 1 || element.childNodes.length) throw Error("日程组件需要独立的空容器");
  const kit = bridge || await loadMobileHalaska();
  if (!element.isConnected) throw Error("日程容器已关闭");
  if (element.childNodes.length) throw Error("日程容器已有内容，未覆盖");
  register(kit);
  element.classList.add("mobile-planner-root");
  const island = kit.mount(element, componentName, initialProps || {});
  let disposed = false;
  return Object.freeze({ element,
    update(props) { if (disposed) return false; if (!element.isConnected) { disposed = true; kit.unmount(element); return false; } island.update(props); return true; },
    unmount() { if (disposed) return; disposed = true; island.unmount(); element.classList.remove("mobile-planner-root"); },
  });
}
