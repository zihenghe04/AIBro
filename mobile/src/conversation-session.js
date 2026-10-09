// In-flight UI state belongs to a conversation, never to the selected route.
export class ConversationSessions {
  constructor() { this.runs = new Map(); }
  get(id) { return this.runs.get(id); }
  start({ conversationID, projectID, contextKeys = [], prompt, messageIDs = [] }) {
    if (this.runs.has(conversationID)) throw Error("此对话正在回复，请先停止或等待完成");
    if (this.runs.size >= 2) throw Error("已有两条对话正在执行，请先等待其中一条完成");
    const run = { conversationID, projectID, contextKeys: [...contextKeys], prompt,
      controller: new AbortController(), messageIDs: new Set(messageIDs),
      text: "", reasoning: "", events: [], phase: "正在连接模型", follow: true };
    this.runs.set(conversationID, run);
    return run;
  }
  progress(run, event) {
    if (this.runs.get(run.conversationID) !== run || run.controller.signal.aborted) return false;
    if (event.type === "text") run.text += event.text || "";
    else if (event.type === "reasoning") run.reasoning += event.text || "";
    else if (event.type === "phase") run.phase = event.title || "";
    else if (event.type === "tool-start" || event.type === "tool-result") run.events.push(structuredClone(event));
    return true;
  }
  cancel(id) { this.runs.get(id)?.controller.abort(); }
  finish(run) {
    if (this.runs.get(run.conversationID) === run) this.runs.delete(run.conversationID);
  }
}
