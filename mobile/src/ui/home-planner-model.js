// Calendar-day arithmetic deliberately stays in the device's local time zone.
// Parsing YYYY-MM-DD with Date.parse would move dates west of UTC to yesterday.
export function localDay(value = new Date()) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(0);
    date.setFullYear(year, month - 1, day);
    date.setHours(12, 0, 0, 0);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
  }
  if (value == null || value === "") return null;
  const date = new Date(value);
  if (!Number.isFinite(+date)) return null;
  date.setHours(12, 0, 0, 0);
  return date;
}

export function plannerDayKey(value) {
  const date = localDay(value);
  return date ? `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}` : null;
}

export function shiftPlannerDay(value, offset) {
  const date = localDay(value);
  if (!date || !Number.isInteger(offset)) return null;
  date.setDate(date.getDate() + offset);
  return plannerDayKey(date);
}

export function plannerDayBounds(value) {
  const start = localDay(value);
  if (!start) return null;
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { from: +start, to: +end };
}

export function plannerWeek(selectedDay, today) {
  const selected = plannerDayKey(selectedDay), current = plannerDayKey(today);
  const date = localDay(selected);
  if (!date) return [];
  const monday = shiftPlannerDay(selected, -((date.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, index) => {
    const key = shiftPlannerDay(monday, index), day = localDay(key);
    return { key, day: day.getDate(), weekday: ["一", "二", "三", "四", "五", "六", "日"][index], selected: key === selected, today: key === current };
  });
}

const live = record => record && !record.archived && !record.deletedAt && !record.deleted;
const text = value => typeof value === "string" ? value.trim() : "";
const numeric = value => Number.isFinite(Number(value)) ? Number(value) : 0;

export function taskDue(task) {
  const raw = task?.dueAt;
  if (raw == null || raw === "") return null;
  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const bounds = plannerDayBounds(raw);
    return bounds ? { day: raw, stamp: bounds.from, dateOnly: true } : null;
  }
  const date = new Date(raw);
  return Number.isFinite(+date) ? { day: plannerDayKey(date), stamp: +date, dateOnly: false } : null;
}

export function plannerTasks(tasks = [], { today, showCompleted = false } = {}) {
  const current = plannerDayKey(today ?? new Date());
  const rows = tasks.filter(live).filter(task => (canonicalTaskStatus(task.status) === "done") === Boolean(showCompleted)).map(task => ({ task, due: taskDue(task), statusLabel: plannerTaskStatus(task) }));
  if (showCompleted) return rows.length ? [{ key: "completed", title: "已完成", rows: rows.sort((a, b) =>
    numeric(b.task.completedAt || b.task.updatedAt || b.task.createdAt) - numeric(a.task.completedAt || a.task.updatedAt || a.task.createdAt) || String(a.task.id).localeCompare(String(b.task.id))) }] : [];
  rows.sort((a, b) => (a.due?.stamp ?? Infinity) - (b.due?.stamp ?? Infinity) || numeric(a.task.createdAt) - numeric(b.task.createdAt) || String(a.task.id).localeCompare(String(b.task.id)));
  return [["overdue", "逾期"], ["today", "今天"], ["upcoming", "接下来"], ["unscheduled", "未排期"]].map(([key, title]) => ({ key, title,
    rows: rows.filter(({ due }) => (!due ? "unscheduled" : due.day < current ? "overdue" : due.day === current ? "today" : "upcoming") === key),
  })).filter(group => group.rows.length);
}

export function plannerTaskStatus(task) {
  const status = canonicalTaskStatus(task?.status);
  return status === 'todo' || status === 'done' || task?.status == null || task.status === '' ? '' : taskStatusLabel(task.status);
}

export function plannerEvents(events = [], selectedDay) {
  const bounds = plannerDayBounds(selectedDay);
  if (!bounds) return [];
  return events.filter(event => live(event) && Number.isFinite(event.start) && Number.isFinite(event.end) && event.end > event.start && event.start < bounds.to && event.end > bounds.from)
    .slice().sort((a, b) => Number(Boolean(b.allDay)) - Number(Boolean(a.allDay)) || a.start - b.start || a.end - b.end || String(a.occurrenceID || a.id).localeCompare(String(b.occurrenceID || b.id)));
}

export function plannerProjectLabel(record, projects = []) {
  if (!record?.projectId) return "";
  return text(projects.find(project => project.id === record.projectId)?.name) || "项目任务";
}

export function plannerDateLabel(day, { weekday = false, year = false } = {}) {
  const date = localDay(day);
  return date ? date.toLocaleDateString("zh-CN", { ...(year ? { year: "numeric" } : {}), month: "long", day: "numeric", ...(weekday ? { weekday: "long" } : {}) }) : "";
}

export function plannerTime(stamp) {
  return new Date(stamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function plannerEventTime(event, selectedDay) {
  if (event.allDay) return { start: "全天", end: "" };
  const format = stamp => plannerDayKey(stamp) === selectedDay ? plannerTime(stamp) : `${plannerDateLabel(stamp)} ${plannerTime(stamp)}`;
  return { start: format(event.start), end: event.task ? "截止" : format(event.end) };
}
import { canonicalTaskStatus, taskStatusLabel } from '../task-status.js';
