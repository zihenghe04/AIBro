import { clone, equal, id, putRecord } from "./store.js";
import { agendaNote, readEvent, eventsFor } from "./agenda.js";
import { agendaTimeSummary } from "./agenda-intent.js";
import { editAgendaEvent } from "./agenda-edit.js";
import { reviewRemoval, reviewRestore, applyRemovalReview, applyRestoreReview } from "./lifecycle.js";
import { freezeDecisionGroup } from "./sync-groups.js";
import { taskStatuses, taskStatusMatches, taskStatePatch } from "./task-status.js";
import { editedProject } from "./record-project.js";

const kinds = new Set(["notes", "imports", "tasks", "projects", "agenda"]);
const writable = new Set(["notes", "tasks", "projects", "agenda"]);
const readable = new Set([...kinds, "trash"]);
const lifecycleKinds = new Set([...kinds, "trash"]);
const physicalKind = (kind) => kind === "agenda" ? "notes" : kind;
const clarificationFields = {
  agenda: ['target', 'title', 'start', 'end', 'timeZone', 'recurrence', 'scope', 'projectId'],
  tasks: ['target', 'title', 'dueAt', 'description', 'projectId'],
  notes: ['target', 'title', 'content', 'projectId'],
  projects: ['target', 'name', 'workspace'],
};
const clarificationLabels = { target: '要操作的具体记录（标题或 ID）', title: '标题', name: '项目名称',
  start: '开始日期和时间', end: '结束时间或持续时长', timeZone: '时区', recurrence: '重复频率与结束条件',
  scope: '修改单次还是整个重复系列', projectId: '所属项目或独立保存', dueAt: '截止日期和时间',
  description: '需要修改的说明', content: '要保存的正文', workspace: '工作空间（日常、课程或科研）' };
const archived = (data) => !!(data?.archived || data?.archivedAt || data?.status === "archived");
const publicData = (data) => data && !data.private && !data.ephemeral && !data.incognito && !data.hidden;
const live = (data) => publicData(data) && !archived(data) && !data.deletedAt && !data.deleted;
const titleOf = (data) => String(data.title || data.name || data.originalName || "未命名");
const checkAbort = (signal) => {
  if (signal?.aborted) throw Object.assign(Error("已停止生成"), { name: "AbortError" });
};
const validID = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const validRef = (value) => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);
const recordKind = (kind, data) => kind === "notes" && data?.kind === "日程" ? "agenda" : kind;
const recoveryTarget = (entry) => ({ key: entry.key, kind: recordKind(entry.kind, entry.data),
  id: entry.data.id, title: titleOf(entry.data) });
const readCall = (kind, recordID, recovery = false, range = {}) => ({ tool: "knowledge_read",
  arguments: { kind, id: recordID, ...(recovery ? { archived: true } : {}), ...range } });

function trashSnapshots(trash) {
  const readableSnapshots = new Set([...kinds, "links", "attachments"]);
  return Object.entries(trash.data || {}).flatMap(([collection, rows]) =>
    readableSnapshots.has(collection) && Array.isArray(rows) ? rows.filter((data) =>
      data && typeof data === "object" && !Array.isArray(data) && validID(data.id)).map((data) =>
      ({ key: `${collection}:${data.id}`, kind: recordKind(collection, data), data })) : []);
}

// Never serialize the stored record wholesale: recovery snapshots can contain
// old credentials, private revision history or arbitrary imported metadata.
function snapshotFields(data, kind) {
  const fields = fieldsOf(data, kind), safe = {};
  for (const [key, value] of Object.entries(fields))
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) safe[key] = value;
  safe.projectId = typeof data.projectId === "string" ? data.projectId : null;
  // Absence in a snapshot is unknown, not a fabricated workspace assignment.
  safe.workspace = typeof data.workspace === "string" ? data.workspace : null;
  if (Array.isArray(fields.checklist)) safe.checklist = fields.checklist.map((item) => ({
    text: typeof item?.text === "string" ? item.text : "", done: item?.done === true,
  }));
  if (fields.recurrence && typeof fields.recurrence === "object") {
    safe.recurrence = {};
    for (const key of ["frequency", "interval", "count", "until"]) {
      const value = fields.recurrence[key];
      if (value === null || ["string", "number"].includes(typeof value)) safe.recurrence[key] = value;
    }
    if (Array.isArray(fields.recurrence.weekdays)) safe.recurrence.weekdays = fields.recurrence.weekdays.filter((day) => Number.isInteger(day) && day >= 1 && day <= 7);
  }
  return safe;
}

function recoverySnapshotText(trash) {
  return trashSnapshots(trash).map(({ kind, data }) => {
    const fields = snapshotFields(data, kind);
    const storedText = (key) => typeof data[key] === "string" ? data[key] : "";
    let body = "";
    if (kind === "agenda" && Number.isFinite(fields.start) && Number.isFinite(fields.end))
      body = [fields.title, `${new Date(fields.start).toISOString()} – ${new Date(fields.end).toISOString()}`, fields.location, fields.details].filter(Boolean).join("\n");
    else if (kind === "tasks") body = [fields.description, storedText("content"), fields.status, fields.dueAt,
      ...(fields.checklist || []).map((item) => `${item.done ? "✓" : "○"} ${item.text}`)].filter(Boolean).join("\n");
    else if (["notes", "imports", "projects"].includes(kind)) body = storedText("content") || storedText("description");
    // Relationship/attachment snapshots expose identity only, never arbitrary
    // content fields, embedded payloads, request headers or source metadata.
    return `回收包内的 ${kind} 存储快照（原 ID 不是当前活动读取目标）\n${JSON.stringify(fields, null, 2)}\n正文：\n${body}`;
  }).join("\n\n");
}

function recoveryTargets(review, record, kind) {
  const snapshots = new Map(kind === "trash" ? trashSnapshots(record.data).map((entry) => [entry.key, entry.data]) : []);
  return (review.entries || [{ key: review.key, kind, data: review.after }]).map((entry) => {
    const original = snapshots.get(entry.key) || record.data;
    return { ...recoveryTarget(entry), projectId: typeof original.projectId === "string" ? original.projectId : null,
      workspace: typeof original.workspace === "string" ? original.workspace : null,
      restoreProjectId: typeof entry.data.projectId === "string" ? entry.data.projectId : null,
      source: kind === "trash" ? "trash-snapshot" : "archived-record" };
  });
}

function accessible(state, kind, data, scope, { forWrite = false, includeArchived = false } = {}) {
  if (!publicData(data) || !includeArchived && !live(data)) return false;
  if (kind !== "trash" && (data.deleted || data.deletedAt)) return false;
  if (kind === "trash") {
    if (!includeArchived || !data.data || typeof data.data !== "object") return false;
    // A trash title alone must not expose private or out-of-scope originals.
    const entries = Object.entries(data.data).flatMap(([collection, rows]) =>
      Array.isArray(rows) ? rows.map((entry) => [collection, entry]) : [[collection, null]]);
    return entries.length > 0 && entries.every(([collection, entry]) =>
      publicData(entry) && accessible(state, collection, entry, scope, { forWrite, includeArchived: true }));
  }
  const project = data.projectId && state.records["projects:" + data.projectId];
  if (project?.data && (!publicData(project.data) || !includeArchived && !live(project.data))) return false;
  const owner = data.sourceConversationId && state.records["conversations:" + data.sourceConversationId];
  if (owner?.data && (!publicData(owner.data) || !includeArchived && !live(owner.data))) return false;
  if (scope.projectID && kind === "projects") return data.id === scope.projectID;
  const selected = scope.contextKeys || [];
  if (scope.projectID && data.projectId !== scope.projectID && !selected.includes(`${physicalKind(kind)}:${data.id}`)) return false;
  if (!forWrite && selected.length && !selected.includes(`${physicalKind(kind)}:${data.id}`) &&
      !(data.projectMemoryType && data.projectId === scope.projectID) && !["tasks", "projects", "agenda"].includes(kind)) return false;
  return true;
}
const stopwords = new Set(["请", "请帮", "帮我", "一下", "这个", "那个", "什么", "如何", "哪些", "一下", "里面", "资料", "内容", "查找", "搜索", "告诉", "总结", "的", "了", "是", "我", "在", "和", "与", "及", "the", "a", "an", "and", "please", "summarize", "find"]);

function termsFor(query) {
  const text = String(query || "").normalize("NFKC").toLowerCase();
  const words = text.match(/[a-z0-9][a-z0-9_-]+/g) || [];
  if (typeof Intl.Segmenter === "function")
    for (const part of new Intl.Segmenter("zh", { granularity: "word" }).segment(text))
      if (part.isWordLike && part.segment.length > 1) words.push(part.segment);
  for (const run of text.match(/[\p{Script=Han}]+/gu) || [])
    for (let i = 0; i < run.length - 1; i++) words.push(run.slice(i, i + 2));
  return [...new Set(words)].filter((word) => !stopwords.has(word));
}

function textOf(data, kind) {
  if (kind === "trash") return recoverySnapshotText(data);
  if (kind === "agenda") {
    const event = readEvent(data);
    return event ? `${event.title}\n${new Date(event.start).toISOString()} – ${new Date(event.end).toISOString()}\n${event.location || ""}\n${event.details || ""}` : "";
  }
  if (kind === "tasks") return [data.description, data.content, data.status,
    data.dueAt, ...(data.checklist || []).map((item) => `${item.done ? "✓" : "○"} ${item.text || ""}`)].filter(Boolean).join("\n");
  return String(data.content || data.description || "");
}

function chunks(text, size = 1400) {
  const result = [];
  if (!text) return [{ offset: 0, end: 0, content: "" }];
  for (let offset = 0; offset < text.length; offset += size - 160)
    result.push({ offset, end: Math.min(text.length, offset + size), content: text.slice(offset, offset + size) });
  return result;
}

function score(chunk, title, terms) {
  const body = chunk.toLowerCase(), heading = title.toLowerCase();
  return terms.reduce((sum, term) => sum + (body.includes(term) ? 2 + Math.min(8, term.length) / 4 : 0) + (heading.includes(term) ? 5 : 0), 0);
}

function fieldsOf(data, kind) {
  // A recovery container has no workspace/project of its own. Its members do.
  if (kind === "trash") return { id: data.id, title: titleOf(data), deletedAt: Number.isFinite(data.deletedAt) ? data.deletedAt : null };
  const fields = { id: data.id, title: titleOf(data), projectId: data.projectId || null, workspace: data.workspace || "日常" };
  if (kind === "tasks") for (const key of ["description", "status", "priority", "dueAt", "startAt", "reminderMinutes", "checklist"])
    if (Object.hasOwn(data, key)) fields[key] = clone(data[key]);
  if (kind === "projects") {
    fields.name = data.name || data.title;
    for (const key of ["description", "status", "dueAt"]) if (Object.hasOwn(data, key)) fields[key] = clone(data[key]);
  }
  if (kind === "agenda") {
    const event = readEvent(data);
    if (event) for (const key of ["start", "end", "timeZone", "location", "details", "reminderMinutes", "allDay", "recurrence"])
      if (Object.hasOwn(event, key)) fields[key] = event[key];
  }
  return fields;
}

export function createAgentTools({ store, conversationID, projectID = null, contextKeys = [], signal, allowWritePlans = true, onProgress = () => {} }) {
  const explicit = new Set(contextKeys), readVersions = new Map(), readCoverage = new Map(), sources = [], sourceIndex = new Map();
  let pendingPlan = null, clarifications = [];
  for (const key of contextKeys) {
    const data = store.state.records[key]?.data;
    if (key.startsWith("notes:")) for (const attachment of data?.sourceAttachmentIds || []) explicit.add("imports:" + attachment);
  }
  function available(kind, data, { forWrite = false } = {}) {
    return accessible(store.state, kind, data, { projectID, contextKeys: [...explicit] }, { forWrite });
  }
  function get(kind, recordID, options, state = store.state) {
    if (!readable.has(kind) || !validID(recordID)) throw Error("资料类型或标识无效");
    const record = state.records[`${physicalKind(kind)}:${recordID}`];
    if (!record || record.deleted || !accessible(state, kind, record.data,
      { projectID, contextKeys: [...explicit] }, options)) throw Error("资料不存在或不在当前项目与引用范围内");
    if (kind === "agenda" && !readEvent(record.data) || kind === "notes" && record.data.kind === "日程")
      throw Error("请使用正确的笔记或日程类型读取此记录");
    return record;
  }
  function cite(kind, data, part) {
    const key = `${kind}:${data.id}:${part.offset}:${part.end}`;
    if (sourceIndex.has(key)) return sources[sourceIndex.get(key)];
    const source = { id: data.id, kind, title: titleOf(data), content: part.content,
      offset: part.offset, end: part.end, totalCharacters: textOf(data, kind).length, citation: sources.length + 1 };
    sourceIndex.set(key, sources.length);
    sources.push(source);
    return source;
  }
  function search({ query, kind, limit = 8 } = {}) {
    if (typeof query !== "string" || !query.trim() || query.length > 2000) throw Error("请提供 2000 字以内的检索词");
    if (kind !== undefined && !kinds.has(kind)) throw Error("资料类型无效");
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw Error("检索条数应为 1 到 20");
    const terms = termsFor(query), hits = [], browse = query.trim() === "*";
    for (const [key, record] of Object.entries(store.state.records)) {
      if (record.deleted) continue;
      let currentKind = key.split(":")[0];
      if (currentKind === "notes" && record.data.kind === "日程") currentKind = "agenda";
      if (!kinds.has(currentKind) || kind && currentKind !== kind || !available(currentKind, record.data)) continue;
      const text = textOf(record.data, currentKind), title = titleOf(record.data);
      for (const part of chunks(text)) {
        if (browse && part.offset) continue;
        const rank = browse ? 1 : score(part.content, title, terms);
        if (rank > 0) hits.push({ kind: currentKind, data: record.data, part, rank });
      }
    }
    hits.sort((a, b) => b.rank - a.rank || a.part.offset - b.part.offset);
    // Diversify before spending the remaining slots on the same long source.
    const first = [], rest = [], seen = new Set();
    for (const hit of hits) {
      const key = hit.kind + ":" + hit.data.id;
      if (seen.has(key)) rest.push(hit);
      else { seen.add(key); first.push(hit); }
    }
    const chosen = [...first, ...rest].slice(0, limit);
    return { entries: chosen.map((hit) => cite(hit.kind, hit.data, hit.part)), matchedChunks: hits.length,
      returnedChunks: chosen.length, scope: projectID ? { projectID } : explicit.size ? { selected: [...explicit] } : { workspace: "当前工作区" } };
  }
  function read({ kind, id: recordID, offset = 0, limit = 6000, archived: archivedOption } = {}) {
    // Selecting the trash kind already explicitly selects recovery storage.
    // Ordinary records still require archived:true; explicit false is not ignored.
    const includeArchived = archivedOption === undefined ? kind === "trash" : archivedOption;
    if (typeof includeArchived !== "boolean") throw Error("archived 必须为布尔值");
    if (kind === "trash" && !includeArchived) throw Error("kind: trash 与 archived: false 冲突；请使用目录 entry.read.arguments 读取回收包");
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 12000)
      throw Error("读取范围无效：offset 非负，limit 为 1 到 12000");
    const record = get(kind, recordID, { includeArchived }), text = textOf(record.data, kind);
    if (offset > text.length) throw Error("读取位置超出正文范围");
    const key = `${physicalKind(kind)}:${recordID}`;
    if (!equal(readVersions.get(key), record.data)) readCoverage.set(key, []);
    readVersions.set(key, clone(record.data));
    readCoverage.get(key).push([offset, Math.min(offset + limit, text.length)]);
    const source = cite(kind, record.data, { offset, end: Math.min(offset + limit, text.length), content: text.slice(offset, offset + limit) });
    let recovery;
    if (kind === "trash" || archived(record.data)) {
      try {
        const review = reviewRestore(store, key);
        recovery = { canRestore: true, operation: review.operation, warnings: review.warnings,
          targets: recoveryTargets(review, record, kind), restoreAction: { operation: "restore", kind, id: recordID },
          ...(kind === "trash" ? { note: "content 是包内白名单字段与正文的存储快照，可按 nextRead 分页。targets 是恢复后的原记录标识，恢复前不要按原 ID 读取；生成恢复方案请使用 restoreAction。originalRead 仅表示未读取来源原文件。" } : {}) };
      } catch (error) { recovery = { canRestore: false, reason: error.message }; }
    }
    const nextOffset = source.end < text.length ? source.end : null;
    return { ...fieldsOf(record.data, kind), kind, citation: source.citation, content: source.content, offset,
      totalCharacters: text.length, nextOffset,
      editable: writable.has(kind) && live(record.data) && !record.conflict, originalRead: false,
      read: readCall(kind, recordID, includeArchived),
      nextRead: nextOffset === null ? null : readCall(kind, recordID, includeArchived, { offset: nextOffset, limit }),
      ...(kind === "trash" ? { contentSource: "stored-recovery-snapshot" } : {}),
      ...(recovery ? { recovery } : {}) };
  }
  function directory({ kind, state = "active", query = "", projectId, status, dateFrom, dateTo, offset = 0, limit = 20 } = {}) {
    if (kind !== undefined && !readable.has(kind)) throw Error("目录类型无效");
    if (!["active", "archived", "trash", "recoverable"].includes(state)) throw Error("目录状态无效");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw Error("目录分页要求 offset 非负，limit 为 1 到 50");
    if (typeof query !== "string" || query.length > 2000) throw Error("目录检索词应为 2000 字以内");
    if (projectId !== undefined && !validID(projectId)) throw Error("项目筛选标识无效");
    if (status !== undefined && !(kind === "tasks" ? taskStatuses : kind === "projects" ? ["active", "paused", "done"] : []).includes(status)) throw Error("状态筛选仅支持任务或项目的有效状态");
    const hasDates = dateFrom !== undefined || dateTo !== undefined;
    if (hasDates && !["agenda", "tasks"].includes(kind)) throw Error("日期筛选需要指定 agenda 或 tasks");
    if (hasDates && state !== "active") throw Error("日期筛选仅支持有效任务或日程，恢复目录请按名称和种类查找");
    const from = dateFrom === undefined ? -Infinity : filterInstant(dateFrom);
    const to = dateTo === undefined ? Infinity : filterInstant(dateTo);
    if (!(to > from)) throw Error("目录结束时间必须晚于开始时间");
    if (kind === "agenda" && hasDates && (!Number.isFinite(from) || !Number.isFinite(to) || to - from > 366 * 86400000))
      throw Error("日程目录请提供完整起止时间，范围最多一年");
    const needle = query.trim().normalize("NFKC").toLowerCase(), candidates = [];
    for (const [key, record] of Object.entries(store.state.records)) {
      if (record.deleted || !record.data) continue;
      let currentKind = key.split(":")[0];
      if (currentKind === "notes" && record.data.kind === "日程") currentKind = "agenda";
      if (!readable.has(currentKind)) continue;
      const containedKinds = currentKind === "trash" ? Object.entries(record.data.data || {}).flatMap(([collection, rows]) =>
        Array.isArray(rows) ? rows.map((row) => recordKind(collection, row)) : []) : [];
      if (kind && kind !== currentKind && !containedKinds.includes(kind)) continue;
      const inactive = archived(record.data), trash = currentKind === "trash";
      if (state === "active" ? inactive || trash : state === "archived" ? !inactive || trash : state === "trash" ? !trash : !inactive && !trash) continue;
      if (!accessible(store.state, currentKind, record.data, { projectID, contextKeys: [...explicit] }, { includeArchived: state !== "active" })) continue;
      if (projectId !== undefined) {
        const projectIDs = currentKind === "trash" ? Object.values(record.data.data || {}).flatMap((rows) => Array.isArray(rows) ? rows.map((row) => row?.projectId) : [])
          : [currentKind === "projects" ? record.data.id : record.data.projectId];
        if (!projectIDs.includes(projectId)) continue;
      }
      if (status !== undefined && !(currentKind === "tasks" ? taskStatusMatches(record.data.status, status) : record.data.status === status)) continue;
      if (needle && ![titleOf(record.data), record.data.description || ""].join(" ").normalize("NFKC").toLowerCase().includes(needle)) continue;
      candidates.push({ key, kind: currentKind, record });
    }
    let entries = candidates.map(({ key, kind: currentKind, record }) => {
      const entry = { ...fieldsOf(record.data, currentKind), key, kind: currentKind,
        updatedAt: [record.data.updatedAt, record.data.createdAt, record.data.deletedAt].find(Number.isFinite) || 0, conflict: !!record.conflict,
        read: readCall(currentKind, record.data.id, state !== "active") };
      if (state !== "active") {
        try {
          const review = reviewRestore(store, key); entry.canRestore = true; entry.lifecycleOperation = review.operation; entry.warnings = review.warnings;
          entry.recoveryTargets = recoveryTargets(review, record, currentKind);
        }
        catch (error) { entry.canRestore = false; entry.reason = error.message; }
      }
      return entry;
    });
    if (kind === "agenda" && hasDates) {
      const byID = new Map(entries.map((entry) => [entry.id, entry]));
      entries = eventsFor({ list: (collection) => collection === "notes" ? candidates.map(({ record }) => clone(record.data)) : [] }, from, to)
        .map((event) => ({ ...byID.get(event.id), start: event.start, end: event.end,
          timeZone: event.timeZone, occurrenceID: event.occurrenceID }));
    } else if (kind === "tasks" && hasDates) {
      entries = entries.filter((entry) => {
        if (entry.dueAt === undefined || entry.dueAt === null) return false;
        try {
          const at = filterInstant(entry.dueAt);
          if (typeof entry.dueAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry.dueAt)) {
            const end = new Date(at); end.setDate(end.getDate() + 1);
            return at < to && +end > from;
          }
          return at >= from && at < to;
        } catch { return false; }
      });
    }
    entries.sort((a, b) => hasDates ? (a.start ?? filterInstant(a.dueAt)) - (b.start ?? filterInstant(b.dueAt)) || a.key.localeCompare(b.key)
      : b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
    return { entries: entries.slice(offset, offset + limit), total: entries.length, offset,
      nextOffset: offset + limit < entries.length ? offset + limit : null,
      scope: projectID ? { projectID } : explicit.size ? { selected: [...explicit] } : { workspace: "当前工作区" },
      ...(hasDates ? { dateRange: { from: Number.isFinite(from) ? from : null, to: Number.isFinite(to) ? to : null, endExclusive: true } } : {}) };
  }
  function initial(query) {
    let remaining = 48000;
    for (const key of explicit) {
      const record = store.state.records[key], kind = key.split(":")[0];
      if (!record || record.deleted || !["notes", "imports"].includes(kind) || !available(kind, record.data))
        throw Error("引用资料已变化");
      if (!remaining) continue;
      const text = textOf(record.data, kind), terms = termsFor(query);
      const parts = chunks(text).map((part) => ({ ...part, rank: score(part.content, titleOf(record.data), terms) }));
      parts.sort((a, b) => b.rank - a.rank || a.offset - b.offset);
      // Short documents stay whole; long documents include the best matching passage.
      const best = parts[0];
      const selected = text.length <= 6000 ? { offset: 0, end: text.length, content: text } : best;
      const content = selected.content.slice(0, remaining);
      cite(kind, record.data, { offset: selected.offset, end: selected.offset + content.length, content });
      remaining -= content.length;
    }
    if (projectID) for (const note of store.list("notes").filter((note) => note.projectId === projectID && note.projectMemoryType && live(note)).slice(0, 4))
      cite("notes", note, { offset: 0, end: Math.min(3000, String(note.content || "").length), content: String(note.content || "").slice(0, 3000) });
    return clone(sources);
  }
  function propose({ actions } = {}) {
    if (!allowWritePlans) throw Error("本次仅生成正文或建议，不生成工作区修改方案");
    if (clarifications.length) throw Error('本轮已请求补充信息，请等用户回答后再生成方案');
    if (!Array.isArray(actions) || !actions.length || actions.length > 10) throw Error("请提供 1 到 10 项可审阅修改");
    const prior = pendingPlan?.actions || [];
    if (prior.length + actions.length > 10) throw Error("本次待审阅修改最多 10 项，请分批处理");
    const plan = pendingPlan ? clone(pendingPlan) : { schema: 2, id: id(), status: "pending", conversationID, projectID,
      contextKeys: [...explicit], createdAt: Date.now(), refMap: {}, actions: [] };
    const overlay = prior.length ? validateActions(store.state, plan, { requireConversation: false }).overlay : clone(store.state);
    const refMap = new Map(Object.entries(plan.refMap || {}));
    const touched = new Set(prior.flatMap(actionKeys));
    for (const request of actions) {
      if (!request || typeof request !== "object" || Array.isArray(request) ||
          Object.keys(request).some((key) => !["operation", "kind", "id", "ref", "changes"].includes(key)) ||
          !["create", "update", "remove", "restore"].includes(request.operation))
        throw Error("仅支持 create/update/remove/restore 可审阅操作");
      const lifecycle = ["remove", "restore"].includes(request.operation);
      if (!(lifecycle ? lifecycleKinds : writable).has(request.kind) || request.operation === "remove" && request.kind === "trash")
        throw Error("此类内容不支持所请求的操作");
      if (request.ref !== undefined && (request.operation !== "create" || request.kind !== "projects" || !validRef(request.ref) || refMap.has(request.ref)))
        throw Error("ref 仅用于新建项目，须为不重复的字母开头标识");
      if (request.operation === "create" && request.id !== undefined) throw Error("新建资料使用 ref 引用，不指定已有 id");
      const targetId = request.operation === "create" ? id() : request.id;
      if (!validID(targetId)) throw Error("修改目标标识无效");
      const key = `${physicalKind(request.kind)}:${targetId}`;
      if (touched.has(key)) throw Error("同一份资料请合并为一项修改");
      let before = null;
      if (request.operation !== "create") {
        const current = get(request.kind, targetId, { forWrite: true, includeArchived: request.operation === "restore" }, overlay);
        if (current.conflict) throw Error("目标资料存在同步冲突，请先处理冲突");
        before = readVersions.get(key);
        if (!before) throw Error("更新、移除或恢复前请先调用 knowledge_read 阅读目标资料");
        if (!equal(current.data, before)) throw Error("资料在读取后已变化，请重新读取再提议");
        if (request.operation === "update" && request.kind === "notes" && Object.hasOwn(request.changes || {}, "content")) {
          let readThrough = 0;
          for (const [start, end] of [...readCoverage.get(key)].sort((a, b) => a[0] - b[0])) {
            if (start > readThrough) break;
            readThrough = Math.max(readThrough, end);
          }
          if (readThrough < String(before.content || "").length) throw Error("替换正文前请继续分段读取完整原文，避免丢失尚未读到的内容");
        }
      }
      const timestamp = Date.now();
      let action;
      if (lifecycle) {
        if (request.changes !== undefined && (!request.changes || typeof request.changes !== "object" || Array.isArray(request.changes) || Object.keys(request.changes).length))
          throw Error("移除和恢复不得夹带内容修改");
        const review = request.operation === "remove" ? reviewRemoval(overlay, key) : reviewRestore(overlay, key);
        action = { operation: request.operation, kind: request.kind, targetId, title: review.title, before: clone(before),
          changes: {}, lifecycleReview: review, lifecycleOperation: review.operation, warnings: clone(review.warnings), timestamp,
          ...(review.operation === "trash" ? { trashId: "trash_" + id() } : {}) };
        for (const target of actionKeys(action)) if (touched.has(target)) throw Error("方案中的恢复或移除涉及重复目标，请合并后重新提议");
        if (request.operation === "remove") applyRemovalReview(overlay, review, { now: timestamp, trashId: action.trashId });
        else applyRestoreReview(overlay, review, { now: timestamp });
        action.after = clone(overlay.records[key]?.data || null);
      } else {
        const changes = resolveReferences(request.changes, refMap);
        const after = buildRecord(overlay, request.kind, targetId, before, changes, { conversationID, projectID, timestamp });
        action = { operation: request.operation, kind: request.kind, targetId, title: titleOf(after),
          changes: clone(request.changes), before: clone(before), after, ...(request.ref ? { ref: request.ref } : {}) };
        putRecord(overlay, physicalKind(request.kind), after, before ?? undefined);
        if (request.ref) refMap.set(request.ref, { kind: "projects", id: targetId });
      }
      plan.actions.push(action);
      for (const target of actionKeys(action)) touched.add(target);
      if (plan.actions.reduce((sum, item) => sum + actionSize(item), 0) > 10)
        throw Error("本次方案涉及的内容最多 10 条，请缩小恢复范围或分批处理");
    }
    plan.refMap = Object.fromEntries(refMap);
    // Rebuild from current durable state before publishing even a pending plan.
    validateActions(store.state, plan, { requireConversation: false });
    pendingPlan = plan;
    return { status: "awaiting_user_review", planId: pendingPlan.id, executed: false, refMap: clone(plan.refMap),
      actions: plan.actions.slice(prior.length).map(({ operation, kind, targetId, title, ref, lifecycleOperation, warnings }) =>
        ({ operation, kind, id: targetId, title, ...(ref ? { ref } : {}), ...(lifecycleOperation ? { lifecycleOperation, warnings } : {}) })) };
  }
  function clarify(args) {
    if (!allowWritePlans) throw Error('本次仅生成正文或建议，不请求工作区修改信息');
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['kind', 'operation', 'fields'].includes(key)) ||
        !Object.hasOwn(clarificationFields, args.kind) || !['create', 'update', 'remove', 'restore'].includes(args.operation) ||
        !Array.isArray(args.fields) || !args.fields.length || args.fields.length > 8 ||
        args.fields.some(field => !clarificationFields[args.kind].includes(field))) throw Error('请提供具体内容类型、操作和缺少的字段，不填写回复正文');
    if (pendingPlan) throw Error('已有待审阅方案，不能同时结束为信息澄清');
    const request = { kind: args.kind, operation: args.operation, fields: [...new Set(args.fields)] };
    const previous = clarifications.find(item => item.kind === request.kind && item.operation === request.operation);
    if (previous) previous.fields = [...new Set([...previous.fields, ...request.fields])]; else clarifications.push(request);
    return { status: 'needs_input', executed: false, request: clone(request),
      missing: request.fields.map(field => ({ field, label: clarificationLabels[field] })) };
  }
  async function execute(name, args) {
    checkAbort(signal);
    onProgress({ type: "tool-start", title: name, input: clone(args) });
    try {
      const output = name === "knowledge_search" ? search(args) : name === "knowledge_read" ? read(args) : name === "workspace_list" ? directory(args) : name === "propose_changes" ? propose(args) : name === 'request_clarification' ? clarify(args) : (() => { throw Error("不支持此工具"); })();
      checkAbort(signal);
      onProgress({ type: "tool-result", title: name, output: clone(output) });
      return output;
    } catch (error) {
      onProgress({ type: "tool-result", title: name, error: error.message });
      if (error.name === "AbortError") throw error;
      return { error: error.message, executed: false };
    }
  }
  return { execute, initial, sources: () => clone(sources), pendingPlan: () => clone(pendingPlan), clarifications: () => clone(clarifications) };
}

export function clarificationText(requests) {
  const names = { agenda: '日程', tasks: '任务', notes: '笔记', projects: '项目' };
  return requests.map(request => `请补充${names[request.kind]}的${request.fields.map(field => clarificationLabels[field]).join('、')}。`).join('\n') +
    '\n目前尚未保存或执行任何修改；补充信息后会先提供方案供你审阅。';
}

const allowed = {
  tasks: new Set(["title", "description", "status", "priority", "dueAt", "startAt", "reminderMinutes", "checklist", "projectId", "workspace"]),
  notes: new Set(["title", "content", "tags", "projectId", "workspace"]),
  projects: new Set(["name", "description", "status", "workspace", "dueAt"]),
  agenda: new Set(["title", "start", "end", "timeZone", "location", "details", "reminderMinutes", "allDay", "projectId", "workspace", "recurrence", "editScope"]),
};
function instant(value, nullable = true) {
  if (value === null && nullable) return null;
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)))
    throw Error("时间需要明确的 ISO 日期、时间与时区偏移，不能猜测日期");
  const number = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(number) || Math.abs(number) > 8640000000000000) throw Error("日期时间无效");
  if (typeof value === "string") {
    const [year, month, day, hour, minute, second = 0] = value.match(/\d+/g).slice(0, 6).map(Number);
    const calendar = new Date(Date.UTC(year, month - 1, day));
    if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59)
      throw Error("日期或时刻不存在，请提供准确时间");
  }
  return number;
}
function filterInstant(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    instant(value + "T00:00:00Z", false);
    return new Date(value + "T00:00:00").getTime();
  }
  return instant(value, false);
}
function resolveReferences(changes, refs) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw Error("请提供修改字段");
  const resolved = clone(changes);
  if (Object.hasOwn(resolved, "projectRef")) {
    if (Object.hasOwn(resolved, "projectId") || !validRef(resolved.projectRef)) throw Error("projectRef 与 projectId 互斥，且引用标识必须有效");
    const project = refs.get(resolved.projectRef);
    if (!project || project.kind !== "projects") throw Error("projectRef 必须引用本方案中已先创建的项目");
    resolved.projectId = project.id;
    delete resolved.projectRef;
  }
  return resolved;
}
function actionKeys(action) {
  const key = `${physicalKind(action.kind)}:${action.targetId}`;
  return [...new Set([key, ...(action.lifecycleOperation === "trash" ? ["trash:" + action.trashId] : []),
    ...(action.lifecycleOperation === "restore-trash" ? (action.lifecycleReview?.entries || []).map((entry) => entry.key) : [])])];
}
function actionSize(action) {
  return action.lifecycleOperation === "restore-trash" ? action.lifecycleReview?.entries?.length || 0 : 1;
}
function buildRecord(state, kind, targetId, before, changes, scope) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes) || !Object.keys(changes).length) throw Error("请提供修改字段");
  if (Object.keys(changes).some((key) => !allowed[kind].has(key))) throw Error("修改包含不支持的字段");
  const data = clone(changes), now = scope.timestamp ?? Date.now();
  for (const key of ["title", "name", "description", "content", "location", "details"])
    if (Object.hasOwn(data, key) && (typeof data[key] !== "string" || data[key].length > (key === "content" ? 100000 : 12000)))
      throw Error("文字字段格式或长度无效");
  const explicitProject = Object.hasOwn(data, "projectId");
  const projectID = kind === "projects" ? null : explicitProject ? data.projectId : before ? before.projectId || null : scope.projectID;
  if (scope.projectID && (kind === "projects" ? targetId !== scope.projectID : projectID !== scope.projectID))
    throw Error("本次修改必须留在当前项目中");
  const project = projectID && state.records["projects:" + projectID];
  if (projectID && (!validID(projectID) || !project || project.deleted || project.conflict || !live(project.data))) throw Error("关联项目不存在、已归档或存在同步冲突");
  const workspace = project?.data.workspace || data.workspace || before?.workspace || "日常";
  if (!["日常", "课程", "科研"].includes(workspace)) throw Error("工作空间无效");
  const projectChange = kind !== "projects" && (!before || explicitProject)
    ? editedProject(before, projectID, Object.entries(state.records).filter(([key, record]) => key.startsWith('projects:') && !record.deleted && record.data).map(([, record]) => record.data)) : {};
  // An explicitly supplied projectId is a relationship write, even when the
  // caller repeats null. Clear/synchronize the Mac name alias with that ID.
  if (kind !== "projects" && explicitProject) Object.assign(projectChange,
    { projectId: projectID || null, project: project ? project.data.name || project.data.title || null : null });
  if (Object.hasOwn(data, "reminderMinutes") && data.reminderMinutes !== null &&
      (!Number.isInteger(data.reminderMinutes) || data.reminderMinutes < 0 || data.reminderMinutes > 10080)) throw Error("提醒应为 0 到 10080 分钟，或 null 关闭");
  if (Object.hasOwn(data, "tags") && (!Array.isArray(data.tags) || data.tags.length > 50 || data.tags.some((tag) => typeof tag !== "string" || tag.length > 100))) throw Error("标签格式无效");
  if (Object.hasOwn(data, "checklist") && (!Array.isArray(data.checklist) || data.checklist.length > 100 || data.checklist.some((item) => !item || typeof item.text !== "string" || item.text.length > 1000 || typeof item.done !== "boolean" || Object.keys(item).some((key) => !["text", "done"].includes(key))))) throw Error("清单应包含文字与完成状态");
  for (const key of ["dueAt", "startAt"]) if (Object.hasOwn(data, key)) {
    if (key === "dueAt" && typeof data[key] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data[key])) {
      instant(data[key] + "T00:00:00Z", false);
      continue;
    }
    const stamp = instant(data[key]); data[key] = stamp === null ? null : new Date(stamp).toISOString();
  }
  if (kind === "agenda") {
    const old = before && readEvent(before);
    if (before && !old) throw Error("原日程格式无效");
    let event = { ...old, ...data, ...projectChange, projectId: projectID, workspace };
    const missing = ['title', 'start', 'end'].filter(key => event[key] == null || key === 'title' && !String(event[key]).trim());
    if (missing.length) throw Error(`日程缺少 ${missing.join('、')}；请补充标题、开始日期时间、结束时间或时长。不确定时调用 request_clarification`);
    event.start = instant(event.start, false); event.end = instant(event.end, false);
    if (event.end <= event.start) throw Error("日程结束时间必须晚于开始时间");
    event = editAgendaEvent(old, event, { scope: data.editScope });
    event.timeZone ||= Intl.DateTimeFormat().resolvedOptions().timeZone;
    try { new Intl.DateTimeFormat("en", { timeZone: event.timeZone }); } catch { throw Error("日程时区无效"); }
    if (Object.hasOwn(event, "allDay") && typeof event.allDay !== "boolean") throw Error("全天状态无效");
    if (!String(event.title || "").trim()) throw Error("请提供日程标题");
    const output = agendaNote(event, before || { id: targetId, createdAt: now });
    Object.assign(output, projectChange, { workspace });
    output.updatedAt = now;
    output.sourceConversationId ||= scope.conversationID;
    return output;
  }
  const defaults = kind === "tasks" ? {} : kind === "notes" ? { kind: "note", content: "" } : { status: "active" };
  const output = { ...defaults, ...before, ...data, ...projectChange, id: targetId, workspace, createdAt: before?.createdAt || now,
    updatedAt: now, sourceConversationId: before?.sourceConversationId || scope.conversationID };
  if (!String((kind === "projects" ? output.name : output.title) || "").trim()) throw Error("请提供名称或标题");
  if (kind === "tasks") Object.assign(output, taskStatePatch(before, data, { now }));
  if (kind === "projects" && !["active", "paused", "done"].includes(output.status)) throw Error("项目状态无效");
  if (kind === "notes" && before && before.content !== output.content) output.revisionHistory = [
    ...(before.revisionHistory || []).slice(-19), { title: before.title, content: before.content, savedAt: now, reason: "手机确认 AI 修改" },
  ];
  return output;
}

function storedPlan(state, expected) {
  if (!expected || expected.status !== "pending" || !validID(expected.id) || !Array.isArray(expected.actions)) throw Error("待审阅修改格式无效");
  const matches = Object.entries(state.records).filter(([key, record]) => key.startsWith("messages:") && !record.deleted && record.data?.role === "assistant" && record.data?.pendingPlan?.id === expected.id);
  if (matches.length !== 1) throw Error("待审阅修改已不存在或重复，请重新打开对话");
  const [key, record] = matches[0], current = record.data.pendingPlan;
  if (record.conflict || !live(record.data) || ["cancelled", "failed"].includes(record.data.status)) throw Error("审阅消息已变化或有同步冲突，请重新生成方案");
  const comparable = { ...current, status: "pending" };
  delete comparable.receipts; delete comparable.appliedAt; delete comparable.rejectedAt; delete comparable.syncGroupId;
  if (!equal(comparable, expected) || record.data.conversationId !== expected.conversationID) throw Error("待审阅修改已经变化，请重新审阅");
  return { key, record, plan: current };
}
function validateActions(state, plan, { requireConversation = true } = {}) {
  const conversation = state.records["conversations:" + plan.conversationID];
  if ((requireConversation || conversation) && (!conversation || conversation.deleted || conversation.conflict || !live(conversation.data) ||
      (conversation.data.projectId || null) !== plan.projectID)) throw Error("原对话或项目归属已变化，请重新生成修改方案");
  if (!Array.isArray(plan.actions) || !plan.actions.length || plan.actions.length > 10 ||
      plan.actions.some((action) => !action || typeof action !== "object" || Array.isArray(action)) ||
      plan.actions.reduce((sum, action) => sum + actionSize(action), 0) > 10)
    throw Error("修改方案条数无效，最多涉及 10 条内容");
  const references = new Map();
  for (const action of plan.actions) if (action.ref !== undefined) {
    if (action.operation !== "create" || action.kind !== "projects" || !validRef(action.ref) || references.has(action.ref)) throw Error("方案项目引用无效或重复");
    references.set(action.ref, { kind: "projects", id: action.targetId });
  }
  if (!equal(plan.refMap || {}, Object.fromEntries(references))) throw Error("方案项目引用映射已变化，请重新生成");
  const overlay = clone(state), seen = new Set(), availableRefs = new Map(), receipts = [], timestamps = [];
  for (const action of plan.actions) {
    const lifecycle = ["remove", "restore"].includes(action.operation);
    if (!(lifecycle ? lifecycleKinds : writable).has(action.kind) || !["create", "update", "remove", "restore"].includes(action.operation) || !validID(action.targetId))
      throw Error("修改方案格式无效");
    if (action.operation === "remove" && action.kind === "trash") throw Error("不能永久删除回收记录");
    const key = `${physicalKind(action.kind)}:${action.targetId}`, current = overlay.records[key];
    for (const target of actionKeys(action)) {
      if (seen.has(target)) throw Error("修改方案包含重复目标");
      seen.add(target);
    }
    if (action.operation === "create" && action.before !== null) throw Error("新建方案不得携带旧记录");
    if (action.operation === "create" ? !!current : !current || current.deleted || current.conflict || !equal(current.data, action.before))
      throw Error("目标资料已在其他位置修改或存在同步冲突，请重新审阅最新版本");
    if (current && !accessible(overlay, action.kind, current.data, plan, { forWrite: true, includeArchived: action.operation === "restore" }))
      throw Error("目标资料已离开当前项目或变为不可访问，请重新审阅");
    if (action.kind === "agenda" && current && !readEvent(current.data) || action.kind === "notes" && current?.data.kind === "日程")
      throw Error("请使用正确的笔记或日程类型");
    if (lifecycle) {
      if (!Number.isSafeInteger(action.timestamp) || action.timestamp < 0 || !equal(action.changes, {}) ||
          !action.lifecycleReview || action.lifecycleReview.key !== key || action.lifecycleOperation !== action.lifecycleReview.operation ||
          action.title !== action.lifecycleReview.title || !equal(action.warnings, action.lifecycleReview.warnings) ||
          action.lifecycleOperation === "trash" && !validID(action.trashId) ||
          action.lifecycleOperation !== "trash" && Object.hasOwn(action, "trashId")) throw Error("生命周期方案内容与审阅不一致");
      const result = action.operation === "remove"
        ? applyRemovalReview(overlay, action.lifecycleReview, { now: action.timestamp, trashId: action.trashId })
        : applyRestoreReview(overlay, action.lifecycleReview, { now: action.timestamp });
      if (!equal(action.after, overlay.records[key]?.data || null)) throw Error("生命周期方案结果与审阅不一致");
      if (["archive", "unarchive"].includes(action.lifecycleOperation)) timestamps.push({ key, field: "updatedAt" });
      if (action.lifecycleOperation === "trash") timestamps.push({ key: result.recoveryKey, field: "deletedAt" });
      const restored = (result.restored || []).map((restoredKey) => {
        const data = overlay.records[restoredKey].data;
        return recoveryTarget({ key: restoredKey, kind: restoredKey.split(":")[0], data });
      });
      receipts.push({ operation: action.operation, kind: action.kind, id: action.targetId, title: action.title,
        lifecycleOperation: action.lifecycleOperation, ...(result.recoveryKey ? { recoveryKey: result.recoveryKey } : {}),
        ...(restored.length ? { restored } : {}), warnings: clone(action.warnings) });
      continue;
    }
    if (action.after?.id !== action.targetId || !Number.isSafeInteger(action.after.updatedAt) || action.after.updatedAt < 0 ||
        action.title !== titleOf(action.after) || !equal(action.after,
          buildRecord(overlay, action.kind, action.targetId, action.before, resolveReferences(action.changes, availableRefs),
            { conversationID: plan.conversationID, projectID: plan.projectID, timestamp: action.after.updatedAt })))
      throw Error("修改方案内容与可审阅字段不一致，请重新生成");
    putRecord(overlay, physicalKind(action.kind), clone(action.after), action.before ?? undefined);
    timestamps.push({ key, field: "updatedAt" });
    if (action.ref) availableRefs.set(action.ref, { kind: "projects", id: action.targetId });
    const event = action.kind === "agenda" ? readEvent(action.after) : null;
    receipts.push({ operation: action.operation, kind: action.kind, id: action.targetId, title: action.title,
      ...(action.ref ? { ref: action.ref } : {}), ...(event ? { start: event.start, end: event.end, timeZone: event.timeZone } : {}) });
  }
  return { overlay, receipts, timestamps };
}
export function validatePlan(store, plan) {
  const current = storedPlan(store.state, plan).plan;
  if (current.status !== "pending") throw Error(current.status === "applied" ? "这份修改已经采纳" : "这份修改已经拒绝");
  validateActions(store.state, current);
  return clone(current);
}
export async function applyPlan(store, expected) {
  const review = clone(expected);
  return store.tx((state) => {
    const { key: messageKey, plan } = storedPlan(state, review);
    if (plan.status === "applied") return clone(plan);
    if (plan.status !== "pending") throw Error("这份修改已经拒绝");
    const beforeRecords = clone(state.records);
    const { overlay, receipts, timestamps } = validateActions(state, plan);
    const now = Date.now();
    for (const { key, field } of timestamps) overlay.records[key].data[field] = now;
    // All targets, dependencies and immutable review payloads have passed before
    // any record can reach the durable adapter. A failed write discards everything.
    state.records = overlay.records;
    const response = state.records[messageKey];
    const applied = { ...plan, status: "applied", appliedAt: Date.now(), receipts };
    response.data.pendingPlan = applied;
    response.data.content += `\n\n${receipts.some((item) => item.lifecycleOperation) ? "已确认并完成" : "已确认并保存"} ${receipts.length} 项修改：${receipts.map((receipt) => receipt.title).join("、")}。`;
    for (const receipt of receipts.filter((item) => item.kind === "agenda" && ["create", "update"].includes(item.operation)))
      response.data.content += `\n日程「${receipt.title}」已保存到本机：${agendaTimeSummary(receipt)}。`;
    for (const receipt of receipts.filter((item) => item.lifecycleOperation))
      response.data.content += `\n${receipt.lifecycleOperation === "archive" ? `已归档${receipt.kind === "projects" ? "项目" : "资料"}「${receipt.title}」，关联内容保留` : receipt.lifecycleOperation === "trash" ? `已将「${receipt.title}」移入回收站` : `已恢复「${receipt.title}」`}。`;
    response.dirty = true;
    freezeDecisionGroup(state, beforeRecords, { messageKey, plan, decision: "applied" });
    return clone(applied);
  });
}
export async function rejectPlan(store, expected) {
  const review = clone(expected);
  return store.tx((state) => {
    const { key: messageKey, record, plan } = storedPlan(state, review);
    if (plan.status === "rejected") return clone(plan);
    if (plan.status !== "pending") throw Error("这份修改已经采纳，不能再次拒绝");
    const beforeRecords = clone(state.records);
    const rejected = { ...plan, status: "rejected", rejectedAt: Date.now() };
    record.data.pendingPlan = rejected;
    record.data.content += "\n\n已拒绝本次修改，原资料保留。";
    record.dirty = true;
    freezeDecisionGroup(state, beforeRecords, { messageKey, plan, decision: "rejected" });
    return clone(rejected);
  });
}

// Non-strict, portable JSON Schema: optional update fields stay optional. Actual
// per-kind/create validation remains authoritative in buildRecord, before review.
const timestampSchema = { anyOf: [{ type: 'integer' }, { type: 'string' }],
  description: 'UTC 毫秒整数，或带明确时区偏移的 ISO 日期时间，例如 2030-02-04T15:00:00+08:00。不是秒，不使用无偏移的本地时间。' };
const nullableTimestamp = { anyOf: [...timestampSchema.anyOf, { type: 'null' }], description: timestampSchema.description + ' null 清除。' };
const changeProperties = {
  title: { type: 'string', description: '新建任务/笔记/日程必须有标题；最多 12000 字符。' },
  name: { type: 'string', description: '新建项目必须有名称。' },
  description: { type: 'string' }, content: { type: 'string', description: '笔记正文，最多 100000 字符。' },
  start: { ...timestampSchema, description: '新建日程必填开始时间。' + timestampSchema.description },
  end: { ...timestampSchema, description: '新建日程必填结束时间，必须晚于 start。' + timestampSchema.description },
  timeZone: { type: 'string', description: 'IANA 时区，例如 Asia/Shanghai；它不能替代 start/end 中的 +08:00 等偏移。' },
  location: { type: 'string' }, details: { type: 'string' }, allDay: { type: 'boolean' },
  reminderMinutes: { anyOf: [{ type: 'integer', minimum: 0, maximum: 10080 }, { type: 'null' }], description: '提前提醒分钟数，null 不提醒。' },
  recurrence: { type: 'object', properties: {
    frequency: { type: 'string', enum: ['none', 'daily', 'weekly', 'monthly'] },
    interval: { type: 'integer', minimum: 1, maximum: 52 },
    weekdays: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, description: '周一=1，周日=7；非每周重复也提供空数组。' },
    count: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
    until: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: '重复结束 UTC 毫秒，不早于 start。' },
  }, required: ['frequency', 'interval', 'weekdays'], additionalProperties: false },
  editScope: { type: 'string', enum: ['series'], description: '仅用户明确改整个重复系列时提供。' },
  projectId: { anyOf: [{ type: 'string' }, { type: 'null' }], description: '真实项目 ID；null 明确独立保存。' },
  projectRef: { type: 'string', description: '同方案先创建项目的 ref，不与 projectId 同时提供。' },
  workspace: { type: 'string', enum: ['日常', '课程', '科研'] },
  status: { type: 'string', description: '任务 todo/in_progress/done/blocked；项目 active/paused/done。已有未知状态仅可原样保留。' },
  priority: { type: 'string', description: 'low/medium/high；已有未知优先级仅可原样保留。' },
  dueAt: { ...nullableTimestamp, description: nullableTimestamp.description + ' 截止日期也可 YYYY-MM-DD，例如 2030-02-04。' },
  startAt: nullableTimestamp,
  tags: { type: 'array', items: { type: 'string' } },
  checklist: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, done: { type: 'boolean' } }, required: ['text', 'done'], additionalProperties: false } },
};

export const agentToolDefinitions = [
  { type: 'function', function: { name: 'request_clarification', description: '用户要求修改工作区，但日期、时间、目标等信息不够时调用。只选择缺少的字段，客户端生成安全问题；不创建方案、不执行写入。不要用普通回复假称已保存，也不要猜日期。', parameters: {
    type: 'object', properties: {
      kind: { type: 'string', enum: Object.keys(clarificationFields) },
      operation: { type: 'string', enum: ['create', 'update', 'remove', 'restore'] },
      fields: { type: 'array', items: { type: 'string', enum: Object.keys(clarificationLabels) }, description: '仅选择该类型实际缺少的信息；agenda 的起始日期和时刻都用 start，结束时间或时长用 end。' },
    }, required: ['kind', 'operation', 'fields'], additionalProperties: false,
  } } },
  { type: "function", function: { name: "knowledge_search", description: "在当前项目或明确引用范围内检索本机资料的匹配段落，可找到长文后部。结果有引用编号；不代表读取原件。结构化目录及恢复目标请用 workspace_list。", parameters: {
    type: "object", properties: { query: { type: "string", description: "关键词；* 仅返回有限的资料样例，完整目录请分页调用 workspace_list" }, kind: { type: "string", enum: [...kinds] }, limit: { type: "integer", minimum: 1, maximum: 20 } }, required: ["query"], additionalProperties: false,
  } } },
  { type: "function", function: { name: "knowledge_read", description: "按类型和 ID 分段读取资料及可编辑字段。更新、移除、恢复前必须读取目标；nextOffset 非空可继续读取。优先原样使用目录 entry.read.arguments；普通归档记录必须 archived:true，kind:trash 已显式选择回收包，省略 archived 也可读，显式 false 会拒绝。回收包 content 是包内白名单字段与正文的真实存储快照，可用 nextRead 分页；recovery.targets 的原 ID 恢复前不可当活动记录读取。recovery.restoreAction 是恢复提议的精确 action，不表示已执行。originalRead 只指来源原文件，和是否读到存储快照无关。", parameters: {
    type: "object", properties: { kind: { type: "string", enum: [...readable] }, id: { type: "string" }, archived: { type: "boolean" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 12000 } }, required: ["kind", "id"], additionalProperties: false,
  } } },
  { type: "function", function: { name: "workspace_list", description: "分页列出当前范围的真实记录与 ID。state 默认 active；recoverable 包含归档及回收站，canRestore=false 表示当前无法在手机恢复。每项 read.arguments 是下一次 knowledge_read 的完整参数，直接使用，不改成 recoveryTargets 里的原 ID。恢复目录 kind 可按原内容种类筛选，回收包仍返回 kind:trash；recoveryTargets 列出整包恢复后的目标及真实存储归属，不能只恢复其中一项。目录不代替修改前 knowledge_read。任务可按 status 和 dueAt 日期筛选；日程日期窗口展开实际发生项，同一日程各 occurrenceID 不同，修改 ID 仍是记录 id。dateFrom 含起点、dateTo 不含终点，YYYY-MM-DD 按设备本地零点，或用带时区 ISO/毫秒；日程须同时提供两端，最长 366 天。", parameters: {
    type: "object", properties: {
      kind: { type: "string", enum: [...readable] }, state: { type: "string", enum: ["active", "archived", "trash", "recoverable"] },
      query: { type: "string", description: "标题或描述关键词" }, projectId: { type: "string" },
      status: { type: "string", enum: [...taskStatuses, "active", "paused"], description: "仅 tasks/projects 支持；任务 in_progress 与旧 doing 筛选匹配同一进行中状态，返回保留记录的原始值" },
      dateFrom: { anyOf: [{ type: "string" }, { type: "number" }] }, dateTo: { anyOf: [{ type: "string" }, { type: "number" }] },
      offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 50 },
    }, additionalProperties: false,
  } } },
  { type: "function", function: { name: "propose_changes", description: "生成待用户审阅方案，不执行写入，最多涉及 10 条内容。create/update 支持 tasks/notes/projects/agenda；remove 将任务/笔记/日程移入回收站，将项目/资料归档且保留全部子项和原件，并非删除项目。restore 支持归档记录或 trash 回收记录；先 workspace_list 定位，按 entry.read.arguments 调用 knowledge_read，再采用 recovery.restoreAction。所有 update/remove/restore 必须先读取。remove/restore 不夹带 changes。新建项目设置唯一 ref，后续同方案子项通过 changes.projectRef 引用，必须项目在前，不可同时填 projectId。日程请求使用 agenda；start/end 毫秒或带时区 ISO，timeZone 为 IANA。重复日程可创建 canonical recurrence；修改已有重复日程时间必须 editScope:series 且用户明确改整组，单次改期不能当整组。确认前不得声称已执行。", parameters: {
    type: "object", properties: { actions: { type: "array", minItems: 1, maxItems: 10, items: {
      type: "object", properties: { operation: { type: "string", enum: ["create", "update", "remove", "restore"] }, kind: { type: "string", enum: [...lifecycleKinds] }, id: { type: "string" }, ref: { type: "string", description: "仅新建项目：字母开头、字母数字下划线短横线，最多 64 字符" }, changes: {
        type: "object", description: "create/update 必填，只提供用户要改的字段。agenda 新建必须 title/start/end，推荐 timeZone。例如 {title:'讨论',start:'2030-02-04T15:00:00+08:00',end:'2030-02-04T16:00:00+08:00',timeZone:'Asia/Shanghai'}。不确定时 request_clarification。tasks 新建需 title；projects 需 name；notes 需 title。字段按目标种类使用，已有未知任务状态可原样保留但不能新造。", properties: changeProperties, additionalProperties: false,
      } }, required: ["operation", "kind"], additionalProperties: false,
    } } }, required: ["actions"], additionalProperties: false,
  } } },
];
