import { Temporal } from "@js-temporal/polyfill";
// Canonical native recurrence, expressed in the event's wall-clock time zone.
export function recurringOccurrences(event, from, to) {
  const rule = event.recurrence;
  if (!rule || rule.frequency === "none")
    return [{ start: event.start, end: event.end }];
  if (
    !["daily", "weekly", "monthly"].includes(rule.frequency) ||
    !Number.isInteger(rule.interval) ||
    rule.interval < 1 ||
    rule.interval > 52
  )
    throw Error("不支持的重复规则");
  const zone = event.timeZone || "UTC";
  const original = Temporal.Instant.fromEpochMilliseconds(
    Math.round(event.start),
  ).toZonedDateTimeISO(zone);
  const base = original.toPlainDate(),
    stop = Temporal.Instant.fromEpochMilliseconds(
      Math.round(Math.min(to, rule.until ?? to)),
    )
      .toZonedDateTimeISO(zone)
      .toPlainDate();
  const days = base.until(stop).days;
  if (days < 0) return [];
  if (days > 366000) throw Error("日程跨度过大");
  const weekdays = rule.weekdays?.length
    ? rule.weekdays
    : [(original.dayOfWeek % 7) + 1];
  const excluded = new Set(event.excluded || []),
    result = [];
  let count = 0;
  for (let i = 0; i <= days; i++) {
    const day = base.add({ days: i });
    const matches =
      rule.frequency === "daily"
        ? i % rule.interval === 0
        : rule.frequency === "weekly"
          ? Math.floor((i + base.dayOfWeek - 1) / 7) % rule.interval === 0 &&
            weekdays.includes((day.dayOfWeek % 7) + 1)
          : ((day.year - base.year) * 12 + day.month - base.month) %
              rule.interval ===
              0 && day.day === base.day;
    if (!matches) continue;
    const wall = day.toPlainDateTime(original.toPlainTime());
    let instant = wall.toZonedDateTime(zone, { disambiguation: "compatible" });
    // Foundation Calendar uses nextTime: a nonexistent time advances to the
    // first valid clock minute, not by the length of the DST gap.
    if (!instant.toPlainDateTime().equals(wall)) {
      let candidate = wall;
      for (let minute = 0; minute < 1440; minute++) {
        candidate = candidate
          .add({ minutes: 1 })
          .with({ second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 });
        const resolved = candidate.toZonedDateTime(zone, {
          disambiguation: "compatible",
        });
        if (resolved.toPlainDateTime().equals(candidate)) {
          instant = resolved;
          break;
        }
      }
    }
    const start = instant.epochMilliseconds;
    if (start < event.start) continue;
    if (start > Math.min(to, rule.until ?? to)) break;
    count++;
    if (rule.count != null && count > rule.count) break;
    const end = event.allDay
      ? instant.add({
          days: Math.max(
            1,
            base.until(
              Temporal.Instant.fromEpochMilliseconds(Math.round(event.end))
                .toZonedDateTimeISO(zone)
                .toPlainDate(),
            ).days,
          ),
        }).epochMilliseconds
      : start + event.end - event.start;
    if (start < to && end > from && !excluded.has(start))
      result.push({ start, end });
  }
  return result;
}
