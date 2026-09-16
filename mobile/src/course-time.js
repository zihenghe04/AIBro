// iClass uses Asia/Shanghai regardless of the phone's current time zone.
export function schoolDay(now = Date.now()) {
  return new Date(now + 8 * 3600000)
    .toISOString()
    .slice(0, 10)
    .replaceAll("-", "");
}
export function courseInstant(day, raw) {
  let text = String(raw || "")
    .trim()
    .replaceAll("：", ":")
    .replace(" ", "T");
  const date = String(day).replace(/[-/]/g, "").slice(0, 8);
  if (!text.includes("T")) {
    if (/^\d{3,4}$/.test(text)) {
      text = text.padStart(4, "0");
      text = text.slice(0, 2) + ":" + text.slice(2);
    }
    if (/^\d{6}$/.test(text))
      text = text.slice(0, 2) + ":" + text.slice(2, 4) + ":" + text.slice(4);
    text =
      date.slice(0, 4) +
      "-" +
      date.slice(4, 6) +
      "-" +
      date.slice(6) +
      "T" +
      text;
  }
  text = text.replace(/T(\d):/, "T0$1:");
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.test(
      text,
    )
  )
    return NaN;
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(text)) text += "+08:00";
  return Date.parse(text);
}
export function inCourseWindow(c, now = Date.now()) {
  const start = courseInstant(c.day, c.start),
    end = courseInstant(c.day, c.end);
  return end > start && now >= start - 25 * 60000 && now < end;
}
export function currentAndNext(courses, now = Date.now()) {
  const list = courses
    .filter((c) => c.day.replaceAll("-", "") === schoolDay(now))
    .filter((c) => Number.isFinite(courseInstant(c.day, c.start)))
    .sort(
      (a, b) => courseInstant(a.day, a.start) - courseInstant(b.day, b.start),
    );
  const current = list.find((c) => inCourseWindow(c, now));
  const next = list.find((c) =>
    current
      ? c.id !== current.id &&
        c.title.trim() !== current.title.trim() &&
        courseInstant(c.day, c.start) >
          courseInstant(current.day, current.start)
      : courseInstant(c.day, c.start) > now,
  );
  return { current, next };
}
// Reserves before the network call. Uncertain results never trigger an automatic retry.
export async function autoAttend({
  ucas,
  store,
  courses,
  now = Date.now(),
  visible = true,
}) {
  const epoch = ucas.epoch;
  const opt = store.state.settings.ucasAuto;
  if (!visible || opt?.day !== schoolDay(now) || !opt.enabled) return [];
  const outcomes = [];
  for (const course of courses.filter(
    (c) => !c.signed && inCourseWindow(c, now),
  )) {
    if (epoch !== ucas.epoch) break;
    const key = course.day + ":" + course.id;
    let reserved = false;
    await store.tx((s) => {
      if (
        epoch !== ucas.epoch ||
        s.settings.ucasAuto?.day !== opt.day ||
        !s.settings.ucasAuto.enabled
      )
        return;
      const attempts = (s.settings.ucasAuto.attempts ||= {});
      if (attempts[key]) return;
      attempts[key] = { status: "pending", at: now };
      reserved = true;
    });
    if (!reserved) continue;
    let result;
    try {
      result = await ucas.sign(course);
    } catch {
      result = { status: "unknown", message: "自动签到未确认，请刷新课程核对" };
    }
    await store.tx((s) => {
      if (
        epoch === ucas.epoch &&
        s.settings.ucasAuto?.day === opt.day &&
        s.settings.ucasAuto.attempts?.[key]
      )
        s.settings.ucasAuto.attempts[key] = { ...result, at: now };
    });
    if (epoch === ucas.epoch) outcomes.push({ course, ...result });
  }
  return outcomes;
}
