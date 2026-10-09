// Resolve saved desktop/mobile source identities against current records.
// Never guess a record collection from a colliding ID or reuse a cached title
// after the source or its owner becomes unavailable.
import { readEvent } from './agenda.js';

const types = { note:'notes', import:'imports', task:'tasks', project:'projects', paper:'papers', agenda:'agenda' };
const kinds = new Set(Object.values(types));
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const live = data => data && !['private','ephemeral','incognito','hidden','archived','archivedAt','deleted','deletedAt']
  .some(field => data[field]) && !['deleted','archived'].includes(data.status);
function available(state, kind, recordID, seen = new Set()) {
  const key = `${kind}:${recordID}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const record = state.records[key], data = record?.data;
  if (!record || record.deleted || record.conflict || !live(data) || data.id !== recordID) return null;
  for (const [field, parentKind] of [['projectId','projects'],['sourceConversationId','conversations']]) {
    if (data[field] == null || data[field] === '') continue;
    if (!id(data[field])) return null;
    if (state.records[`${parentKind}:${data[field]}`] && !available(state,parentKind,data[field],new Set(seen))) return null;
  }
  return data;
}

export function messageSources(store, message) {
  const state = store.state || store;
  return (Array.isArray(message?.retrievedSources) ? message.retrievedSources : []).map((source,index) => {
    const label = Number.isSafeInteger(source?.citation) && source.citation > 0 ? source.citation : index + 1;
    const blocked = {index,label,title:'来源不可用',target:null};
    if (!source || !id(source.id) || !live(source)) return blocked;
    const kind = source.kind || types[source.type];
    if (!kinds.has(kind) || source.type && types[source.type] !== kind) return blocked;
    const identity = {kind,id:source.id};
    const data = available(state,kind === 'agenda' ? 'notes' : kind,source.id);
    if (!data) return blocked;
    const title = String(data.title || data.name || data.originalName || '未命名来源');
    if (kind === 'papers') {
      // The mobile editor owns notes, not desktop structured-paper records.
      // Open an explicit linked note when available; never guess by paper ID.
      const linked = id(data.noteId) && available(state,'notes',data.noteId);
      return linked && !readEvent(linked) ? {index,label,title,identity,target:{kind:'notes',id:linked.id}}
        : {index,label,title:`${title} · 请在 Mac 查看`,target:null};
    }
    const event = kind === 'notes' || kind === 'agenda' ? readEvent(data) : null;
    if (kind === 'agenda' && !event) return blocked;
    return {index,label,title,identity,target:{kind:event?'agenda':kind,id:source.id}};
  });
}
