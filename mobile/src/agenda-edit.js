import { Temporal } from "@js-temporal/polyfill";
import ICAL from "ical.js";
import { recurringOccurrences } from "./agenda-recurrence.js";
import { equal } from "./store.js";

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const recurring = e => !!e?.ics || !!e?.recurrence && e.recurrence.frequency !== "none";
export const isRepeatingEvent = recurring;
const normalizedRule = rule => rule ? { frequency: rule.frequency, interval: rule.interval,
  weekdays: [...new Set(rule.weekdays || [])].sort(), count: rule.count ?? null, until: rule.until ?? null } : null;
function instant(value) {
  const n = typeof value === "number" ? value : typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    ? Number(Temporal.Instant.from(value).epochMilliseconds) : NaN;
  if (!Number.isFinite(n) || Math.abs(n) >= 8640000000000000) throw Error("日程需要准确日期、时间与时区");
  return n;
}
const zoned = (stamp, zone) => Temporal.Instant.fromEpochMilliseconds(Math.round(stamp)).toZonedDateTimeISO(zone);
export function eventLocalInput(stamp, zone) {
  return zoned(stamp, zone).toPlainDateTime().toString({ smallestUnit: "minute" });
}
export function eventLocalInstant(value, zone) {
  // Do not silently move a nonexistent or ambiguous DST wall-clock time.
  try { return Temporal.PlainDateTime.from(value).toZonedDateTime(zone, { disambiguation: "reject" }).epochMilliseconds; }
  catch { throw Error("此时区的时刻不存在或有夏令时歧义，请选择明确的时间"); }
}
function validateRule(e) {
  if (!e.recurrence) return;
  const r = e.recurrence;
  if (typeof r !== "object" || Array.isArray(r) || !["none", "daily", "weekly", "monthly"].includes(r.frequency) ||
      !Number.isInteger(r.interval) || r.interval < 1 || r.interval > 52 || !Array.isArray(r.weekdays) ||
      r.weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7) ||
      (r.count != null && (!Number.isInteger(r.count) || r.count < 1)) ||
      (r.until != null && (!Number.isFinite(r.until) || r.until < e.start))) throw Error("重复规则无效，请检查间隔、星期与结束条件");
  if (Object.keys(r).some(key => !["frequency", "interval", "weekdays", "count", "until"].includes(key))) throw Error("包含当前不支持的重复规则字段");
}
function updateICS(old, next, timeChanged) {
  const calendar = new ICAL.Component(ICAL.parse(old.ics));
  const components = calendar.getAllSubcomponents("vevent");
  if (components.length !== 1 || components[0].hasProperty("recurrence-id")) throw Error("含单次改期的原始课表请在原日历修改后重新导入");
  for (const zone of calendar.getAllSubcomponents("vtimezone")) {
    const tz = new ICAL.Timezone(zone); ICAL.TimezoneService.register(tz.tzid, tz);
  }
  const component = components[0], event = new ICAL.Event(component);
  if (Math.abs(event.startDate.toJSDate().getTime() - old.start) > 1 || Math.abs(event.endDate.toJSDate().getTime() - old.end) > 1)
    throw Error("日程与课表原始时间不一致，请保留原件后重新导入");
  if (next.timeZone !== old.timeZone || !!next.allDay !== !!old.allDay || own(next, "recurrence") && next.recurrence)
    throw Error("导入课表的时区、全天状态和原始重复规则请在原日历修改");
  if (timeChanged) {
    if (!zoned(old.start, old.timeZone).toPlainDate().equals(zoned(next.start, next.timeZone).toPlainDate()))
      throw Error("导入课表可调整整组的每天时刻；移动首次日期请在原日历修改后重新导入");
    if (component.hasProperty("rdate") || component.hasProperty("exrule") || component.getAllProperties("rrule").length > 1)
      throw Error("含附加日期或复杂排除规则的课表，请在原日历修改后重新导入");
    const rrule = component.getFirstPropertyValue("rrule");
    if (rrule && ["BYHOUR", "BYMINUTE", "BYSECOND"].some(key => rrule.parts[key]))
      throw Error("此课表在重复规则中指定了时刻，请在原日历修改后重新导入");
    const zone = event.startDate.zone;
    const makeTime = stamp => {
      const wall = zoned(stamp, next.timeZone);
      return new ICAL.Time({ year: wall.year, month: wall.month, day: wall.day, hour: wall.hour,
        minute: wall.minute, second: wall.second, isDate: !!next.allDay }, zone);
    };
    // Preserve the last included recurrence date instead of moving an arbitrary
    // UNTIL clock time (which could accidentally include another occurrence).
    const allDates = new ICAL.Component(ICAL.parse(component.toString()));
    allDates.removeAllProperties("exdate");
    const allEvent = new ICAL.Event(allDates);
    // ICAL.js and Foundation resolve DST gaps differently. Do not rewrite an
    // imported series across a clock transition until both representations agree.
    const transition = zoned(old.start, old.timeZone).getTimeZoneTransition("next");
    let finalDay = null, finalStamp = old.start;
    if (rrule?.until || rrule?.count) {
      const iterator = allEvent.iterator(); let time, exhausted = false;
      for (let i = 0; i < 10000; i++) {
        time = iterator.next();
        if (!time) { exhausted = true; break; }
        finalStamp = time.toJSDate().getTime();
        finalDay = zoned(finalStamp, old.timeZone).toPlainDate();
      }
      if (!exhausted || !finalDay) throw Error("此课表的结束规则超出可安全修改范围，请在原日历修改");
    }
    if (transition && rrule && (!(rrule.until || rrule.count) || transition.epochMilliseconds <= Math.max(finalStamp, next.end)))
      throw Error("导入的重复系列跨夏令时切换，暂不修改整组时刻；请在原日历调整后重新导入");
    component.updatePropertyWithValue("dtstart", makeTime(next.start));
    component.removeAllProperties("duration");
    component.updatePropertyWithValue("dtend", makeTime(next.end));
    // EXDATE and UNTIL keep their local calendar date and follow the new time.
    const atNewTime = stamp => {
      const date = zoned(stamp, old.timeZone).toPlainDate(), time = zoned(next.start, next.timeZone).toPlainTime();
      return date.toPlainDateTime(time).toZonedDateTime(next.timeZone, { disambiguation: "compatible" }).epochMilliseconds;
    };
    for (const property of component.getAllProperties("exdate")) {
      const mapped = property.getValues().map(value => {
        const stamp = atNewTime(value.toJSDate().getTime());
        return next.allDay ? makeTime(stamp) : ICAL.Time.fromJSDate(new Date(stamp), true);
      });
      property.removeParameter("tzid");
      property.setValues(mapped);
    }
    if (rrule?.until) {
      const endStamp = finalDay.toPlainDateTime(zoned(next.start, next.timeZone).toPlainTime())
        .toZonedDateTime(next.timeZone, { disambiguation: "compatible" }).epochMilliseconds;
      rrule.until = ICAL.Time.fromJSDate(new Date(endStamp), true);
      component.updatePropertyWithValue("rrule", rrule);
    }
  }
  component.updatePropertyWithValue("summary", next.title);
  component.updatePropertyWithValue("location", next.location || "");
  component.updatePropertyWithValue("description", next.details || "");
  return calendar.toString();
}

/** Edit one persisted event. Repeated edits apply to the whole series explicitly. */
export function editAgendaEvent(before, changes, { scope } = {}) {
  const old = before ? structuredClone(before) : null;
  if (old) old.timeZone ||= "UTC"; // Same fallback as the persisted recurrence wire.
  const next = { ...structuredClone(old), ...structuredClone(changes) };
  scope ||= next.editScope; delete next.editScope;
  next.start = instant(next.start); next.end = instant(next.end);
  if (next.end <= next.start || !String(next.title || "").trim()) throw Error("请填写标题，并让结束时间晚于开始时间");
  next.timeZone ||= Intl.DateTimeFormat().resolvedOptions().timeZone;
  try { zoned(next.start, next.timeZone); } catch { throw Error("日程时区无效"); }
  if (next.allDay != null && typeof next.allDay !== "boolean") throw Error("全天状态无效");
  if (next.reminderMinutes != null && (!Number.isInteger(next.reminderMinutes) || next.reminderMinutes < 0 || next.reminderMinutes > 10080)) throw Error("提醒分钟数无效");
  const timeChanged = old && ["start", "end", "timeZone", "allDay"].some(key => next[key] !== old[key]);
  const ruleChanged = old && !equal(normalizedRule(next.recurrence), normalizedRule(old.recurrence));
  if (old) validateRule(old);
  if (recurring(old) && (timeChanged || ruleChanged) && scope !== "series") throw Error("这是重复日程，请明确选择修改整个系列（editScope: series）；未更改任何日期");
  if (scope != null && scope !== "series") throw Error("此入口只修改整个系列；单次改期需要独立安排");
  if (recurring(old) && timeChanged) {
    const hasExceptions = (old.excluded?.length || 0) + (old.completed?.length || 0);
    if (hasExceptions && (old.timeZone !== next.timeZone || ruleChanged ||
        !zoned(old.start, old.timeZone).toPlainDate().equals(zoned(next.start, next.timeZone).toPlainDate())))
      throw Error("此系列有取消或完成记录，不能同时移动首次日期、时区或重复规则；可调整整组时刻并保留这些记录");
    if (!old.ics) {
      if (!ruleChanged && old.recurrence?.until != null && old.start !== next.start) {
        const occurrences = recurringOccurrences({ ...old, excluded: [] }, old.start - 1, old.recurrence.until + 1);
        const last = occurrences.at(-1);
        if (!last) throw Error("找不到原重复系列的最后日期，未修改结束规则");
        const lastDate = zoned(last.start, old.timeZone).toPlainDate();
        next.recurrence.until = lastDate.toPlainDateTime(zoned(next.start, next.timeZone).toPlainTime())
          .toZonedDateTime(next.timeZone, { disambiguation: "compatible" }).epochMilliseconds;
      }
      for (const field of ["excluded", "completed"]) if (old[field]?.length) {
        next[field] = old[field].map(stamp => {
          const day = zoned(stamp, old.timeZone).toPlainDate();
          const from = day.toZonedDateTime(next.timeZone).epochMilliseconds;
          const to = day.add({ days: 1 }).toZonedDateTime(next.timeZone).epochMilliseconds;
          const occurrence = recurringOccurrences({ ...next, excluded: [] }, from, to);
          if (occurrence.length !== 1) throw Error("修改会使既有取消或完成日期失去对应关系，请保留原系列");
          return occurrence[0].start;
        });
      }
    }
  } else if (ruleChanged && ((old.excluded?.length || 0) + (old.completed?.length || 0))) {
    throw Error("此系列有取消或完成记录，请保留重复规则或另建系列");
  }
  if (old?.ics) {
    next.ics = updateICS(old, next, timeChanged);
    if (timeChanged) for (const field of ["excluded", "completed"]) if (old[field]?.length) {
      const component = new ICAL.Component(ICAL.parse(next.ics)).getFirstSubcomponent("vevent");
      component.removeAllProperties("exdate");
      const event = new ICAL.Event(component);
      next[field] = old[field].map(stamp => {
        const target = zoned(stamp, old.timeZone).toPlainDate(), iterator = event.iterator();
        for (let i = 0; i < 10000; i++) {
          const time = iterator.next(); if (!time) break;
          const current = time.toJSDate().getTime(), day = zoned(current, next.timeZone).toPlainDate();
          const cmp = Temporal.PlainDate.compare(day, target);
          if (cmp === 0) return current;
          if (cmp > 0) break;
        }
        throw Error("课表例外日期无法对应，未修改原日程");
      });
    }
  }
  validateRule(next);
  return next;
}
