import ICAL from "ical.js";
import { id } from "./store.js";
import { recurringOccurrences } from "./agenda-recurrence.js";
export const dayKey = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
export function agendaNote(event, previous) {
  return {
    ...previous,
    id: previous?.id || id(),
    title: event.title,
    kind: "日程",
    workspace: event.workspace || previous?.workspace || "日常",
    projectId: event.projectId || null,
    createdAt: previous?.createdAt || Date.now(),
    updatedAt: Date.now(),
    content: JSON.stringify({ ...event, format: "aibro.agenda.v1" }),
    sourceNoteIds: event.sourceNoteIds || [],
  };
}
export function readEvent(note) {
  try {
    const e = JSON.parse(note.content);
    for (const key of ["excluded", "completed"]) {
      if (
        e[key] != null &&
        (!Array.isArray(e[key]) || !e[key].every(Number.isFinite))
      )
        return null;
    }
    const r = e.recurrence;
    if (
      r &&
      (typeof r !== "object" ||
        !["none", "daily", "weekly", "monthly"].includes(r.frequency) ||
        !Number.isInteger(r.interval) ||
        r.interval < 1 ||
        r.interval > 52 ||
        !Array.isArray(r.weekdays) ||
        !r.weekdays.every((x) => Number.isInteger(x) && x >= 1 && x <= 7) ||
        (r.count != null && (!Number.isInteger(r.count) || r.count < 1)) ||
        (r.until != null && (!Number.isFinite(r.until) || r.until < e.start)))
    )
      return null;
    if (e.timeZone) new Intl.DateTimeFormat("en", { timeZone: e.timeZone });
    return e.format === "aibro.agenda.v1" &&
      Number.isFinite(e.start) &&
      Number.isFinite(e.end) &&
      e.end > e.start
      ? { ...e, id: note.id }
      : null;
  } catch {
    return null;
  }
}
function registerZones(c) {
  for (const z of c.getAllSubcomponents("vtimezone")) {
    const tz = new ICAL.Timezone(z);
    ICAL.TimezoneService.register(tz.tzid, tz);
  }
}
function calendar(text) {
  const c = new ICAL.Component(ICAL.parse(text));
  registerZones(c);
  return c;
}
export function eventsFor(store, from, to) {
  const events = [];
  for (const note of store
    .list("notes")
    .filter((x) => x.kind === "日程" && !x.archived && !x.deletedAt)) {
    const e = readEvent(note);
    if (!e || e.deleted) continue;
    if (e.ics) {
      try {
        const c = calendar(e.ics);
        const v = new ICAL.Event(c.getFirstSubcomponent("vevent"));
        const it = v.iterator();
        let time;
        for (let i = 0; i < 10000 && (time = it.next()); i++) {
          const info = v.getOccurrenceDetails(time),
            start = info.startDate.toJSDate().getTime(),
            end = info.endDate.toJSDate().getTime();
          if (start >= to) break;
          if (
            v.component
              .getAllProperties("exdate")
              .some((p) =>
                p.getValues().some((x) => x.toUnixTime() === time.toUnixTime()),
              )
          )
            continue;
          if (end > from)
            events.push({ ...e, start, end, occurrenceID: e.id + "@" + start });
        }
      } catch {}
    } else {
      for (const occurrence of recurringOccurrences(e, from, to)) {
        if (
          occurrence.start < to &&
          occurrence.end > from &&
          !(e.excluded || []).includes(occurrence.start)
        )
          events.push({
            ...e,
            ...occurrence,
            occurrenceID: e.id + "@" + occurrence.start,
          });
      }
    }
  }
  for (const t of store
    .list("tasks")
    .filter((x) => x.status !== "done" && !x.archived && !x.deletedAt)) {
    const due = typeof t.dueAt === "number" ? t.dueAt : Date.parse(t.dueAt);
    if (due >= from && due < to)
      events.push({
        id: t.id,
        title: t.title,
        start: due,
        end: due + 60000,
        task: true,
        reminderMinutes: 15,
        occurrenceID: "task:" + t.id,
      });
  }
  return events
    .sort((a, b) => a.start - b.start)
    .map((e) => ({
      ...e,
      reminderAt:
        e.reminderMinutes == null || (e.completed || []).includes(e.start)
          ? null
          : e.start - e.reminderMinutes * 60000,
    }));
}
export function parseICS(text) {
  const c = calendar(text);
  if (c.name !== "vcalendar") throw Error("这不是有效的日历文件");
  const result = [],
    warnings = [],
    overrides = new Set(
      c
        .getAllSubcomponents("vevent")
        .filter((v) => v.hasProperty("recurrence-id"))
        .map((v) => v.getFirstPropertyValue("uid")),
    );
  for (const v of c.getAllSubcomponents("vevent")) {
    try {
      if (overrides.has(v.getFirstPropertyValue("uid")))
        throw Error("包含单次改期，整组暂未导入，避免保留错误日期");
      const tz = v.getFirstProperty("dtstart")?.getParameter("tzid");
      // Modern Chinese timetables commonly omit VTIMEZONE. China has used UTC+08 since 1992.
      if (
        tz &&
        !c
          .getAllSubcomponents("vtimezone")
          .some((z) => z.getFirstPropertyValue("tzid") === tz)
      ) {
        if (
          tz === "Asia/Shanghai" &&
          Number(v.getFirstPropertyValue("dtstart")?.year) >= 1992
        ) {
          const zone = new ICAL.Component(
            ICAL.parse(
              `BEGIN:VTIMEZONE\r\nTZID:Asia/Shanghai\r\nBEGIN:STANDARD\r\nDTSTART:19920101T000000\r\nTZOFFSETFROM:+0800\r\nTZOFFSETTO:+0800\r\nTZNAME:CST\r\nEND:STANDARD\r\nEND:VTIMEZONE`,
            ),
          );
          c.addSubcomponent(zone);
          registerZones(c);
        } else throw Error("文件没有提供 " + tz + " 时区定义，未猜测时间");
      }
      const root = new ICAL.Component(["vcalendar", [], []]);
      root.addPropertyWithValue("version", "2.0");
      for (const z of c.getAllSubcomponents("vtimezone"))
        root.addSubcomponent(new ICAL.Component(structuredClone(z.toJSON())));
      root.addSubcomponent(new ICAL.Component(structuredClone(v.toJSON())));
      // Reparse after registering timezone; ICAL caches hydrated date properties.
      const fresh = calendar(root.toString()),
        e = new ICAL.Event(fresh.getFirstSubcomponent("vevent"));
      if (!e.uid || !e.summary || !e.startDate)
        throw Error("缺少 UID、标题或日期");
      const start = e.startDate.toJSDate().getTime(),
        end = e.endDate.toJSDate().getTime();
      if (!(end > start)) throw Error("结束时间必须晚于开始时间");
      result.push({
        title: e.summary,
        start,
        end,
        allDay: e.startDate.isDate,
        timeZone:
          e.startDate.zone.tzid === "floating"
            ? Intl.DateTimeFormat().resolvedOptions().timeZone
            : e.startDate.zone.tzid,
        location: e.location || "",
        details: e.description || "",
        ics: root.toString(),
        sourceUID: e.uid,
        reminderMinutes: 15,
        workspace: "课程",
      });
    } catch (e) {
      warnings.push(
        (v.getFirstPropertyValue("summary") || "日程") + "：" + e.message,
      );
    }
  }
  return { events: result, warnings };
}
