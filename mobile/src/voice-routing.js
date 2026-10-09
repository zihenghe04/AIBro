import { id, putRecord } from './store.js';

function conversation(state, conversationID, projectID) {
  const record = state.records['conversations:' + conversationID], data = record?.data;
  if (!data || record.deleted || data.archived || data.deletedAt)
    throw Error('原会话已不可用，转写文字仍保留，未新建或发送');
  if ((data.projectId || null) !== projectID)
    throw Error('原会话的项目已改变，转写文字仍保留，请重新选择会话后录制');
  if (projectID) {
    const project = state.records['projects:' + projectID];
    if (!project?.data || project.deleted || project.data.archived || project.data.deletedAt)
      throw Error('原项目已不可用，转写文字仍保留');
  }
  return data;
}

// Capture the destination before requesting microphone permission. Navigation,
// later reference selection and delayed transcription cannot redirect this run.
export function voiceDestination(store, conversationID = null, contextKeys = []) {
  if (!conversationID) return Object.freeze({ mode: 'new', conversationID: null, projectID: null,
    contextKeys: Object.freeze([]), title: '新的 AI 会话', projectTitle: '' });
  const projectID = store.get('conversations', conversationID)?.projectId || null;
  const data = conversation(store.state, conversationID, projectID);
  return Object.freeze({ mode: 'conversation', conversationID, projectID,
    contextKeys: Object.freeze([...new Set(contextKeys)]), title: data.title || '当前对话',
    projectTitle: projectID ? store.get('projects', projectID)?.name || '当前项目' : '' });
}

export function voiceDestinationLabel(destination) {
  if (!destination || destination.mode === 'new') return '新的 AI 会话';
  return `当前对话「${destination.title}」${destination.projectTitle ? ' · ' + destination.projectTitle : ''}${destination.contextKeys.length ? ' · ' + destination.contextKeys.length + ' 项引用' : ''}`;
}

// Preparing a new chat and remembering its request ID share one durable write.
// Failed saves and retrying an unsent transcript cannot create duplicate chats.
export async function prepareVoiceConversation(store, { requestId, destination, text, edit = false }) {
  if (!requestId || !text?.trim() || !destination) throw Error('语音文字或发送位置不可用');
  return store.tx(state => {
    const mapped = state.settings.voiceSubmissions?.[requestId];
    if (mapped && destination.mode === 'conversation' && mapped !== destination.conversationID)
      throw Error('这条语音的会话已改变，请重新录制');
    const conversationID = mapped || destination.conversationID || id();
    let created = false;
    if (mapped || destination.mode === 'conversation') conversation(state, conversationID, destination.projectID);
    else {
      const now = Date.now();
      putRecord(state, 'conversations', { id: conversationID, title: '新对话', projectId: null,
        workspace: '日常', createdAt: now, updatedAt: now });
      created = true;
    }
    const draftKey = 'chat:' + conversationID;
    if (edit) {
      const current = state.drafts[draftKey] || '';
      state.drafts[draftKey] = current.trim() && current.trim() !== text.trim() ? current + '\n' + text : text;
    } else if (created) state.drafts[draftKey] = text;
    state.settings.voiceSubmissions = Object.fromEntries(Object.entries({ ...state.settings.voiceSubmissions,
      [requestId]: conversationID }).slice(-30));
    return { conversationID, projectID: destination.projectID, contextKeys: [...destination.contextKeys],
      draft: state.drafts[draftKey] || '' };
  });
}
