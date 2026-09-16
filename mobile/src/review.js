import { equal } from "./store.js";
export async function stageDraft(store, noteID, content, base) {
  const current = store.get("notes", noteID);
  if (!current) throw Error("原笔记已删除，生成内容仍保留在对话里");
  if (current.aiDraft)
    throw Error("已有一份待审阅草稿。新内容保留在对话里，请先处理旧草稿");
  await store.put(
    "notes",
    {
      ...current,
      aiDraft: {
        title: base.title,
        content,
        baseContent: base.content,
        baseTitle: base.title,
        createdAt: Date.now(),
        origin: "mobile",
      },
      updatedAt: Date.now(),
    },
    current,
  );
}
export async function applyDraft(store, noteID, expectedDraft) {
  const n = store.get("notes", noteID);
  if (!n?.aiDraft || !equal(n.aiDraft, expectedDraft))
    throw Error("草稿已经变化，请重新审阅");
  const d = n.aiDraft;
  if (
    d.baseContent !== undefined &&
    (n.content !== d.baseContent || n.title !== d.baseTitle)
  )
    throw Error("原文已被修改。请先对照最新原文，复制需要的内容手动合并");
  const next = {
    ...n,
    title: d.title || n.title,
    content: d.content,
    aiDraft: null,
    userEdited: true,
    userEditedAt: Date.now(),
    updatedAt: Date.now(),
    revisionHistory: [
      ...(n.revisionHistory || []).slice(-19),
      {
        title: n.title,
        content: n.content,
        savedAt: Date.now(),
        reason: "手机采纳 AI 草稿",
      },
    ],
  };
  await store.put("notes", next, n);
  return next;
}
