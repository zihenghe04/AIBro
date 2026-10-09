// Persist identities only. Restore against current records before displaying a
// return link or sending references to the model; never reconstruct empty data.
export const MAX_CONVERSATION_CONTEXT_KEYS = 50;
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const reference = value => typeof value === 'string' && /^(notes|imports):[A-Za-z0-9_-]{1,200}$/.test(value);
const invalid = () => Object.assign(Error('会话引用或返回来源格式无效，请重新选择资料'), { code: 'CONVERSATION_CONTEXT_INVALID' });

function sourceValue(source) {
  if (source === null) return null;
  if (!object(source) || source.kind !== 'notes' || !identifier(source.id)
      || Object.keys(source).some(key => !['kind', 'id', 'conversationId'].includes(key))
      || own(source, 'conversationId') && !identifier(source.conversationId)) throw invalid();
  return { kind: 'notes', id: source.id,
    ...(own(source, 'conversationId') ? { conversationId: source.conversationId } : {}) };
}

export function createConversationContext(refs, source = null) {
  if (!Array.isArray(refs) || refs.length > MAX_CONVERSATION_CONTEXT_KEYS || !refs.every(reference)) throw invalid();
  return { version: 1, keys: [...new Set(refs)], source: sourceValue(source) };
}

const live = data => object(data) && !['private', 'ephemeral', 'incognito', 'hidden', 'archived', 'archivedAt', 'deleted', 'deletedAt']
  .some(field => data[field]) && !['archived', 'deleted'].includes(data.status);
function present(state, key) {
  const record = state.records[key];
  return !!record && !record.deleted && !record.conflict && live(record.data)
    && record.data.id === key.slice(key.indexOf(':') + 1);
}
function available(state, key) {
  if (!present(state, key)) return false;
  const data = state.records[key].data;
  // Match explicit-reference semantics: a surviving orphan remains readable;
  // an existing private/inactive/conflicted owner cannot expose its children.
  for (const [field, kind] of [['projectId', 'projects'], ['sourceConversationId', 'conversations']]) {
    if (data[field] == null || data[field] === '') continue;
    if (!identifier(data[field])) return false;
    const parent = `${kind}:${data[field]}`;
    if (own(state.records, parent) && !present(state, parent)) return false;
  }
  return true;
}

/**
 * unavailableCount counts filtered unique references. Invalid persisted
 * envelopes report at least one unavailable reference instead of silently
 * becoming an unrestricted conversation. Callers must surface this before send.
 * A null source disables returning to a missing/changed note; if only its old
 * conversation is unavailable, the note remains a valid return destination.
 */
export function restoreConversationContext(store, conversation) {
  const state = store?.state || store;
  if (!object(state?.records)) throw invalid();
  const raw = conversation?.mobileContext;
  if (raw === undefined) return { keys: [], source: null, unavailableCount: 0 };
  let context;
  try {
    context = parsedContext(raw);
  } catch {
    return { keys: [], source: null,
      unavailableCount: Array.isArray(raw?.keys) ? Math.max(1, Math.min(MAX_CONVERSATION_CONTEXT_KEYS, new Set(raw.keys).size)) : 1 };
  }
  if (!object(conversation) || !identifier(conversation.id) || !live(conversation)
      || own(state.records, 'conversations:' + conversation.id) && !available(state, 'conversations:' + conversation.id))
    return { keys: [], source: null, unavailableCount: context.keys.length };
  // Project membership never adds/removes an otherwise explicitly selected
  // cross-project record. The Agent already grants that explicit read scope.
  const keys = context.keys.filter(key => available(state, key));
  let source = context.source;
  if (source) {
    const key = 'notes:' + source.id;
    if (!available(state, key) || state.records[key].data.kind === '日程') source = null;
    else if (source.conversationId && !available(state, 'conversations:' + source.conversationId))
      source = { kind: source.kind, id: source.id };
  }
  return { keys, source, unavailableCount: context.keys.length - keys.length };
}

function parsedContext(raw) {
  if (!object(raw) || raw.version !== 1 || !own(raw, 'keys') || !own(raw, 'source')
      || Object.keys(raw).some(key => !['version', 'keys', 'source'].includes(key))) throw invalid();
  return createConversationContext(raw.keys, raw.source);
}

/** A current, content-free projection for composer text and recovery controls. */
export function conversationContextStatus(store, conversation) {
  const state = store?.state || store;
  if (!object(state?.records)) throw invalid();
  const currentKey = 'conversations:' + conversation?.id;
  if (state.records[currentKey]) conversation = state.records[currentKey].data;
  const restored = restoreConversationContext(store, conversation);
  let malformed = false;
  if (conversation?.mobileContext !== undefined) {
    try { parsedContext(conversation.mobileContext); } catch { malformed = true; }
  }
  const hasProject = !!conversation?.projectId;
  const scopeLabel = hasProject ? '项目知识' : '全部知识';
  const resetLabel = `改用${scopeLabel}`;
  const unavailable = restored.unavailableCount;
  const inaccessible = !object(conversation) || !identifier(conversation.id) || !live(conversation)
    || !available(state, currentKey);
  const blocked = malformed || inaccessible || unavailable > 0;
  const status = malformed || inaccessible ? 'invalid' : unavailable ? restored.keys.length ? 'partial' : 'unavailable'
    : restored.keys.length ? 'ready' : 'scope';
  return { ...restored, state: status, canSend: !blocked, scopeLabel, resetLabel,
    label: blocked ? unavailable ? `${unavailable} 项引用待处理` : '引用范围待处理'
      : restored.keys.length ? `${restored.keys.length} 项引用` : scopeLabel,
    message: inaccessible ? '当前对话暂不可用，请先处理同步冲突或重新打开对话。'
      : malformed ? '这份对话的引用信息无法读取。请重新选择，或明确改用知识检索。'
      : unavailable ? `${unavailable} 项引用已不可用。你的输入仍保留，发送前请调整引用。` : '',
  };
}

function candidate(state, key) {
  if (!reference(key) || !available(state, key)) return false;
  const data = state.records[key].data;
  return key.startsWith('notes:') ? data.kind !== '日程'
    : typeof data.content === 'string' && !!data.content.trim();
}

/** Use the same current availability policy for listing and accepting choices. */
export function conversationContextOptions(store) {
  const state = store?.state || store;
  if (!object(state?.records)) throw invalid();
  return Object.keys(state.records).filter(key => candidate(state, key))
    .sort((a, b) => (Number(state.records[b].data.updatedAt || state.records[b].data.createdAt) || 0)
      - (Number(state.records[a].data.updatedAt || state.records[a].data.createdAt) || 0) || a.localeCompare(b))
    .map(key => {
      const data = state.records[key].data;
      return { key, kind: key.split(':')[0], id: data.id,
        title: String(data.title || data.name || '未命名资料'), projectId: data.projectId || null };
    });
}

/**
 * Pure selection validation; call inside the owner's transaction with fresh
 * state, then persist the returned context using the conversation's CAS base.
 * An empty selection is a scope change and always needs the explicit action.
 */
export function selectConversationContext(store, conversation, keys, { useKnowledgeScope = false } = {}) {
  const state = store?.state || store;
  if (!object(state?.records) || !object(conversation) || !identifier(conversation.id)
      || !available(state, 'conversations:' + conversation.id)) throw invalid();
  if (typeof useKnowledgeScope !== 'boolean') throw invalid();
  const current = state.records['conversations:' + conversation.id].data;
  const context = createConversationContext(keys);
  if (!context.keys.length && !useKnowledgeScope)
    throw Object.assign(Error('请选择至少一项资料，或明确改用项目知识／全部知识'), { code: 'CONVERSATION_CONTEXT_SCOPE_CONFIRMATION_REQUIRED' });
  if (useKnowledgeScope && context.keys.length) throw invalid();
  if (context.keys.some(key => !candidate(state, key)))
    throw Object.assign(Error('所选资料已不可用，请刷新引用列表；未改变检索范围'), { code: 'CONVERSATION_CONTEXT_UNAVAILABLE' });
  return createConversationContext(context.keys, restoreConversationContext(state, current).source);
}
