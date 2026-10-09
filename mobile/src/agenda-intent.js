import { Temporal } from "@js-temporal/polyfill";

const numberPattern = "[0-9零〇一二三四五六七八九十两]{1,3}";
const datePattern = "今天|明天|后天|\\d{4}-\\d{2}-\\d{2}|\\d{4}年\\d{1,2}月\\d{1,2}日";
const command = "(?:请)?(?:帮我)?(?:新建|创建|新增|添加|安排)(?:一个|一项|个)?日程";
const prefix = new RegExp(`^${command}[：:，,\\s]*(.+)$`);
const suffix = new RegExp(`^(.+?)[，,；;\\s]*${command}[。！!]*$`);
const clock = new RegExp(`^(${datePattern})\\s*(凌晨|早上|上午|中午|下午|晚上|晚间)?\\s*(${numberPattern})(?:点(半|一刻|三刻|${numberPattern}分?)?|[:：]([0-9]{2}))(?:整)?\\s*(.+)$`);

function number(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const digits = "零一二三四五六七八九";
  const normalized = value.replaceAll("两", "二").replaceAll("〇", "零");
  if (/^[一二三四五六七八九]?十[一二三四五六七八九]?$/.test(normalized)) {
    const [tens, units] = normalized.split("十");
    return (tens ? digits.indexOf(tens) : 1) * 10 + (units ? digits.indexOf(units) : 0);
  }
  return normalized.length === 1 ? digits.indexOf(normalized) : NaN;
}

// This only selects the stricter no-false-receipt path; it does not authorize a write.
export function isAgendaMutationRequest(prompt) {
  return /(?:新建|创建|新增|添加|安排|修改|更改|调整|改期|取消|删除).{0,12}日程|日程.{0,12}(?:改为|改到|改成|推迟|提前)/.test(prompt);
}

export function agendaTimeSummary(event) {
  const format = new Intl.DateTimeFormat("zh-CN", {
    timeZone: event.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  return `${format.format(event.start)} 至 ${format.format(event.end)}（${event.timeZone}）`;
}

// Deliberately bounded: one explicit create command, date, clock time and title.
// Complex/recurring requests remain with the Agent; ambiguous times never become writes.
export function parseAgendaIntent(prompt, { now = Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  const text = String(prompt).normalize("NFKC").trim();
  const envelope = prefix.exec(text) || suffix.exec(text);
  if (!envelope || /(?:不要|别|无需|不想|取消|修改|更改|改到|改成)/.test(text)) return null;
  const body = envelope[1].trim().replace(/[。！!]+$/, "");
  const match = clock.exec(body);
  if (!match) return null;
  let [, date, period, hourText, minuteText, colonMinute, title] = match;
  // Never silently flatten a range, second event, recurrence, reminder or named zone.
  if (/^(?:到|至|[-–—])/.test(title) || new RegExp(datePattern).test(title) ||
      /每天|每周|每月|每年|每逢|重复|提醒|时区|北京时间|上海时间|UTC|GMT|纽约|东京|伦敦|[，,；;].*(?:然后|再|还有)/i.test(title)) return null;
  let durationMinutes = 60, defaultDuration = true;
  const duration = new RegExp(`[，,\\s]*(?:持续|时长)\\s*(半|${numberPattern})(?:个)?(小时|分钟)$`).exec(title);
  if (duration) {
    durationMinutes = duration[1] === "半" && duration[2] === "小时" ? 30 : number(duration[1]) * (duration[2] === "小时" ? 60 : 1);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440)
      return { error: "日程时长应为 1 分钟到 24 小时，请重新指定。" };
    title = title.slice(0, duration.index).trim();
    defaultDuration = false;
  } else if (/持续|时长|小时|分钟/.test(title)) return null;
  title = title.replace(/^[，,：:\s]+|[，,\s]+$/g, "");
  if (!title || title.length > 120 || /[；;]/.test(title)) return null;
  let hour = number(hourText);
  const minute = colonMinute ? Number(colonMinute) : minuteText === "半" ? 30 : minuteText === "一刻" ? 15 : minuteText === "三刻" ? 45 : minuteText ? number(minuteText.replace(/分$/, "")) : 0;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59 ||
      period && (hour > 12 || ["下午", "晚上", "晚间", "中午"].includes(period) && hour === 0))
    return { error: "日程时间无效，请提供准确的日期和时间。" };
  if (!period && hour > 0 && hour < 12 && !/^0\d$/.test(hourText))
    return { error: "请明确上午或下午，或使用 24 小时时间，例如「明天 15:00 打篮球，帮我新建日程」。" };
  if (["下午", "晚上", "晚间"].includes(period) && hour < 12) hour += 12;
  if (period === "中午" && hour < 11) hour += 12;
  if (period === "凌晨" && hour === 12) hour = 0;
  try {
    const current = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timeZone);
    const relative = ["今天", "明天", "后天"].indexOf(date);
    const day = relative >= 0 ? current.toPlainDate().add({ days: relative }) : Temporal.PlainDate.from(
      date.includes("年") ? { year: Number(date.match(/^\d+/)[0]), month: Number(date.match(/年(\d+)/)[1]), day: Number(date.match(/月(\d+)/)[1]) } : date,
      { overflow: "reject" },
    );
    const start = day.toPlainDateTime({ hour, minute }).toZonedDateTime(timeZone, { disambiguation: "reject" }).epochMilliseconds;
    if (start <= now) return { error: "这个日程时间已经过去，请重新指定日期和时间。" };
    const event = { title, start, end: start + durationMinutes * 60000, timeZone, allDay: false, reminderMinutes: null };
    return { event, durationMinutes, defaultDuration };
  } catch {
    return { error: "日期、时区或当地时间无效，或处于夏令时切换的重复时段，请提供明确的日期与时区偏移。" };
  }
}
