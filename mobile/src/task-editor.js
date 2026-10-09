// Preserve desktop fields and legacy checklist identities while editing the
// subset shown by the phone. An untouched date-only deadline stays date-only.
export function taskChecklistRows(task) {
  return (Array.isArray(task?.checklist) ? task.checklist : []).map((item, index) => ({
    index, text: typeof item === "string" ? item : String(item?.text ?? item?.title ?? ""),
    done: !!(item && typeof item === "object" && item.done),
  }));
}

export function editedChecklist(task, rows) {
  if (rows.length > 100) throw Error("清单最多 100 项，请拆分任务");
  return rows.map(row => {
    const text = String(row.text || "").trim();
    if (!text) throw Error("填写清单内容，或移除空白项");
    if (text.length > 1000) throw Error("单项清单最多 1000 字");
    const original = Number.isInteger(row.index) ? task?.checklist?.[row.index] : undefined;
    if (typeof original === "string" && !row.done) return text;
    if (original && typeof original === "object" && !Array.isArray(original)) {
      const key = typeof original.text === "string" || typeof original.title !== "string" ? "text" : "title";
      return { ...original, [key]: text, done: !!row.done };
    }
    return { text, done: !!row.done };
  });
}

export function unchangedTaskDate(input, rendered, previous) {
  if (input === rendered) return previous ?? null;
  if (!input) return null;
  const date = new Date(input);
  if (!Number.isFinite(+date)) throw Error("填写有效的日期与时间");
  return date.toISOString();
}
