import test from "node:test";
import assert from "node:assert/strict";
import { Store, MemoryAdapter, addMessage } from "../src/store.js";
import { ask } from "../src/ai.js";
import { applyPlan } from "../src/agent-tools.js";
import { readEvent } from "../src/agenda.js";

async function fixture(format = "chat") {
  const store = await new Store(new MemoryAdapter()).load();
  await store.tx((state) => {
    state.settings.model = { base: "https://synthetic.invalid/v1", model: "fixture", format };
    state.drafts["chat:other"] = "另一条完整草稿";
  });
  await store.put("conversations", { id: "chat", title: "Synthetic operations", projectId: null });
  return { store, vault: { get: async (key) => { assert.equal(key, "model"); return "synthetic-not-a-real-key"; } } };
}
const reply = (content) => ({ choices: [{ message: { content }, finish_reason: "stop" }] });
const tool = (name, args) => ({ choices: [{ message: { content: "已经全部保存并同步。", tool_calls: [
  { id: name, type: "function", function: { name, arguments: JSON.stringify(args) } },
] }, finish_reason: "tool_calls" }] });

test("CRUD prose with no actual plan cannot stream or persist a false success for any supported record", async () => {
  for (const prompt of ["  帮我创建任务：合成任务  ", "创建项目合成研究", "把这段话保存为新笔记", "为下周一新建日程",
    "修改任务状态", "把项目改名为合成项目", "更新笔记标题", "把日程改到下周五",
    "删除任务", "归档项目", "移除笔记", "取消日程", "恢复任务", "恢复项目", "恢复笔记", "恢复日程", "把刚才那个删掉",
    "帮我保存这篇笔记", "把这段内容记到笔记里", "记下这个任务：明天交报告", "能否帮我删除这个任务"]) {
    const { store, vault } = await fixture(), progress = [];
    await assert.rejects(ask({ store, vault, conversationID: "chat", prompt,
      stream: async (_, { onEvent }) => {
        onEvent({ choices: [{ delta: { reasoning_content: "合成思考" } }] });
        onEvent({ choices: [{ delta: { content: "已经保存、删除并同步到 Mac。" }, finish_reason: "stop" }] });
      }, onProgress: (event) => progress.push(event) }), /没有保存或执行/, prompt);
    assert.equal(progress.filter((event) => event.type === "text").length, 0, prompt);
    assert.ok(progress.some((event) => event.type === "reasoning"));
    const messages = store.list("messages");
    assert.equal(messages[0].content, prompt, "the original user message is not rewritten");
    assert.equal(messages[1].content, "");
    assert.equal(messages[1].status, "failed");
    for (const kind of ["projects", "tasks", "notes"]) assert.equal(store.list(kind).length, 0);
    assert.equal(store.state.drafts["chat:other"], "另一条完整草稿");
  }
});

test("real create plans produce concrete pending summaries and never relay a fabricated write receipt", async () => {
  for (const [kind, prompt, changes, label] of [
    ["tasks", "帮我创建任务", { title: "合成任务" }, "任务"],
    ["projects", "帮我创建项目", { name: "合成项目" }, "项目"],
    ["notes", "帮我创建笔记", { title: "合成笔记", content: "正文" }, "笔记"],
    ["agenda", "为下周一新建日程", { title: "合成日程", start: "2030-01-02T15:00:00+08:00", end: "2030-01-02T16:00:00+08:00", timeZone: "Asia/Shanghai" }, "日程"],
  ]) {
    const { store, vault } = await fixture(), replies = [tool("propose_changes", { actions: [{ operation: "create", kind, changes }] }), reply("已经创建并同步 Mac。")];
    const result = await ask({ store, vault, conversationID: "chat", prompt, http: async () => replies.shift() });
    assert.match(result.text, new RegExp(`拟新建${label}「合成${label}」`));
    assert.match(result.text, /审阅并确认后才会保存/);
    assert.doesNotMatch(result.text, /已经创建|全部保存|同步 Mac/);
    assert.equal(result.pendingPlan.status, "pending");
    assert.equal(store.list(kind === "agenda" ? "notes" : kind).length, 0);
  }
});

test("rejected tool arguments or a different kind/action cannot satisfy the requested operation", async () => {
  for (const actions of [
    [{ operation: "create", kind: "projects", changes: { description: "missing name" } }],
    [{ operation: "create", kind: "tasks", changes: { title: "wrong kind" } }],
  ]) {
    const { store, vault } = await fixture(), replies = [tool("propose_changes", { actions }), reply("已建项目。")];
    await assert.rejects(ask({ store, vault, conversationID: "chat", prompt: "创建项目", http: async () => replies.shift() }), /项目没有保存或执行/);
    assert.equal(store.list("projects").length, 0);
    assert.doesNotMatch(store.list("messages").at(-1).content, /已建项目/);
  }
});

test("Responses operation prose without a real plan remains unexecuted while ordinary questions stream", async () => {
  for (const prompt of ["创建任务", "修改项目名称", "删除笔记", "恢复日程"]) {
    const { store, vault } = await fixture("responses"), progress = [];
    await assert.rejects(ask({ store, vault, conversationID: "chat", prompt, onProgress: (event) => progress.push(event),
      stream: async (_, { body, onEvent }) => {
        assert.ok(body.tools.some(tool => tool.name === "propose_changes"));
        onEvent({ type: "response.output_text.delta", delta: "已完成修改。" });
        onEvent({ type: "response.completed", response: { status: "completed" } });
      } }), /本次未生成可审阅/);
    assert.equal(progress.filter((event) => event.type === "text").length, 0);
    assert.match(store.list("messages").at(-1).error, /没有保存或执行/);
  }
  for (const prompt of ["怎么创建项目？", "帮我写一份项目计划草稿", "Create a project plan", "不要删除任务，只解释步骤", "刚才那个任务删除了吗？"]) {
    const { store, vault } = await fixture(), progress = [];
    const result = await ask({ store, vault, conversationID: "chat", prompt, onProgress: (event) => progress.push(event),
      stream: async (_, { onEvent }) => {
        onEvent({ choices: [{ delta: { content: "真实段落一" } }] });
        assert.ok(progress.some((event) => event.type === "text" && event.text === "真实段落一"));
        onEvent({ choices: [{ delta: { content: "真实段落二" }, finish_reason: "stop" }] });
      } });
    assert.equal(result.text, "真实段落一真实段落二", prompt);
  }
});

test("mutation cancellation persists original input and genuine reasoning but ignores false or late body claims", async () => {
  const { store, vault } = await fixture(), controller = new AbortController();
  let late;
  await assert.rejects(ask({ store, vault, conversationID: "chat", prompt: "请创建合成任务", signal: controller.signal,
    stream: async (_, { onEvent }) => {
      late = onEvent;
      onEvent({ choices: [{ delta: { content: "已创建任务。", reasoning_content: "先分析" } }] });
      controller.abort();
      return new Promise(() => {});
    } }), (error) => error.name === "AbortError" && error.partialText === "");
  late({ choices: [{ delta: { content: "迟到成功消息" }, finish_reason: "stop" }] });
  await store.tail;
  const saved = store.list("messages").at(-1);
  assert.equal(saved.status, "cancelled"); assert.equal(saved.content, ""); assert.equal(saved.reasoning, "先分析");
  assert.equal(store.list("tasks").length, 0);
});

test("subsequent model context contains actual applied IDs even outside text history, excluding pending plans and other chats", async () => {
  const { store, vault } = await fixture();
  const created = await ask({ store, vault, conversationID: "chat", prompt: "创建任务", http: (() => {
    const replies = [tool("propose_changes", { actions: [{ operation: "create", kind: "tasks", changes: { title: "合成任务" } }] }), reply("请审阅")];
    return async () => replies.shift();
  })() });
  const actual = await applyPlan(store, created.pendingPlan), tid = actual.receipts[0].id;
  for (let index = 0; index < 13; index++) await addMessage(store, "chat", "user", "普通后续问答 " + index);
  await addMessage(store, "chat", "assistant", "没有执行", { pendingPlan: { id: "pending", status: "pending", receipts: [{ operation: "create", kind: "notes", id: "never-created" }] } });
  await store.put("conversations", { id: "other", title: "Other", projectId: null });
  await addMessage(store, "other", "assistant", "别的对话", { pendingPlan: { id: "other-plan", status: "applied", receipts: [{ operation: "create", kind: "tasks", id: "other-secret" }] } });
  const replies = [tool("knowledge_read", { kind: "tasks", id: tid }),
    tool("propose_changes", { actions: [{ operation: "update", kind: "tasks", id: tid, changes: { status: "done" } }] }), reply("已完成了")];
  const result = await ask({ store, vault, conversationID: "chat", prompt: "把刚才那个标为完成", http: async (_, { body }) => {
    assert.match(body.messages[0].content, new RegExp(`"id":"${tid}"`));
    assert.match(body.messages[0].content, /仅供定位.*再次操作先读取最新记录/);
    assert.doesNotMatch(body.messages[0].content, /never-created|other-secret|synthetic-not-a-real-key/);
    return replies.shift();
  } });
  assert.equal(result.pendingPlan.actions[0].targetId, tid);
  assert.equal(store.get("tasks", tid).status, "todo");
  await applyPlan(store, result.pendingPlan);
  assert.equal(store.get("tasks", tid).status, "done");
});

test("built-in reminder persists its real task receipt in the same transaction for later references", async () => {
  const { store, vault } = await fixture();
  const created = await ask({ store, conversationID: "chat", prompt: "明天晚上8点提醒我整理合成材料" });
  assert.equal(created.pendingPlan, null, "built-in direct reminder remains compatible");
  assert.equal(created.receipts[0].id, store.list("tasks")[0].id);
  assert.deepEqual(store.list("messages").at(-1).pendingPlan.receipts, created.receipts);
  await ask({ store, vault, conversationID: "chat", prompt: "刚才的提醒是什么", http: async (_, { body }) => {
    assert.match(body.messages[0].content, new RegExp(created.receipts[0].id));
    return reply("合成说明");
  } });
});

test("cancel at the final safe proposal event cannot finalize the request as completed", async () => {
  const { store, vault } = await fixture(), controller = new AbortController();
  const replies = [tool("propose_changes", { actions: [{ operation: "create", kind: "tasks", changes: { title: "合成取消" } }] }), reply("已保存")];
  await assert.rejects(ask({ store, vault, conversationID: "chat", prompt: "创建任务", signal: controller.signal,
    http: async () => replies.shift(), onProgress: (event) => { if (event.type === "text") controller.abort(); } }),
  (error) => error.name === "AbortError");
  assert.equal(store.list("messages").at(-1).status, "cancelled");
  assert.equal(store.list("tasks").length, 0);
});

test("hidden or private message bodies are excluded alongside operation receipt metadata", async () => {
  const { store, vault } = await fixture();
  for (const flag of ["hidden", "private", "ephemeral", "incognito"]) {
    await addMessage(store, "chat", "assistant", flag + "-message-body-secret", { [flag]: true,
      pendingPlan: { id: flag, status: "applied", conversationID: "chat", receipts: [{ operation: "create", kind: "notes", id: flag + "-receipt-secret" }] } });
  }
  await ask({ store, vault, conversationID: "chat", prompt: "你好", http: async (_, { body }) => {
    assert.doesNotMatch(JSON.stringify(body), /message-body-secret|receipt-secret/);
    return reply("你好");
  } });
});

test("explicit content-draft mode keeps the returned prose without requiring a workspace plan", async () => {
  const { store, vault } = await fixture();
  const draft = "精简后的合成正文。\n这只是待审阅草稿。";
  const result = await ask({ store, vault, conversationID: "chat", prompt: "把笔记正文改成更简短的版本", allowWritePlans: false,
    http: async (_, { body }) => {
      assert.ok(body.tools.every((entry) => entry.function.name !== "propose_changes"));
      return reply(draft);
    } });
  assert.equal(result.text, draft);
  assert.equal(result.pendingPlan, null);
  assert.equal(store.list("notes").length, 0);
});

test("model create/remove/restore roundtrips report real recoverable targets and retain restored IDs in context", async () => {
  for (const [kind, label, changes] of [["tasks", "任务", { title: "合成任务" }], ["notes", "笔记", { title: "合成笔记", content: "原内容" }],
    ["agenda", "日程", { title: "合成日程", start: "2030-01-02T15:00:00+08:00", end: "2030-01-02T16:00:00+08:00", timeZone: "Asia/Shanghai" }]]) {
    const { store, vault } = await fixture(), physicalKind = kind === "agenda" ? "notes" : kind;
    const run = (prompt, calls) => {
      const replies = [...calls, reply("已经成功修改并同步到 Mac。")];
      return ask({ store, vault, conversationID: "chat", prompt, http: async () => replies.shift() });
    };
    const creation = await run(`创建${label}`, [tool("propose_changes", { actions: [{ operation: "create", kind, changes }] })]);
    const receipt = (await applyPlan(store, creation.pendingPlan)).receipts[0], recordID = receipt.id;
    const field = kind === "tasks" ? "description" : kind === "notes" ? "content" : "details";
    const updated = await run(`修改${label}`, [tool("knowledge_read", { kind, id: recordID }),
      tool("propose_changes", { actions: [{ operation: "update", kind, id: recordID, changes: { [field]: "合成更新内容" } }] })]);
    assert.match(updated.text, new RegExp(`拟修改${label}`));
    assert.doesNotMatch(updated.text, /已经成功|同步到 Mac/);
    assert.equal((await applyPlan(store, updated.pendingPlan)).receipts[0].id, recordID);
    const current = kind === "agenda" ? readEvent(store.get(physicalKind, recordID)) : store.get(physicalKind, recordID);
    assert.equal(current[field], "合成更新内容");
    const removal = await run(`删除${label}`, [tool("knowledge_read", { kind, id: recordID }),
      tool("propose_changes", { actions: [{ operation: "remove", kind, id: recordID }] })]);
    assert.match(removal.text, new RegExp(`拟移入回收站${label}`));
    assert.doesNotMatch(removal.text, /已经成功|同步到 Mac/);
    assert.ok(store.get(physicalKind, recordID), "proposal alone does not remove the record");
    const removed = await applyPlan(store, removal.pendingPlan), recoveryKey = removed.receipts[0].recoveryKey;
    assert.equal(store.get(physicalKind, recordID), null);
    const trashID = recoveryKey.split(":")[1];
    const restoration = await run(`恢复刚才删除的${label}`, [tool("workspace_list", { state: "recoverable" }),
      tool("knowledge_read", { kind: "trash", id: trashID, archived: true }),
      tool("propose_changes", { actions: [{ operation: "restore", kind: "trash", id: trashID }] })]);
    assert.match(restoration.text, new RegExp(`拟恢复${label}「合成${label}」`));
    assert.doesNotMatch(restoration.text, /已经成功|同步到 Mac/);
    assert.equal(store.get(physicalKind, recordID), null);
    const restored = await applyPlan(store, restoration.pendingPlan);
    assert.equal(restored.receipts[0].restored[0].id, recordID);
    assert.equal(store.list(physicalKind).length, 1);
    await ask({ store, vault, conversationID: "chat", prompt: "刚才恢复的是哪条", http: async (_, { body }) => {
      const context = body.messages[0].content.split("近期已确认的操作记录")[1];
      assert.match(context, new RegExp(`"kind":"${kind}","id":"${recordID}"`));
      assert.match(context, /"lifecycleOperation":"restore-trash"/);
      return reply("合成说明");
    } });
  }
});

test("same-plan project references and project archival summaries do not pretend to cascade-delete children", async () => {
  const { store, vault } = await fixture();
  const run = (prompt, calls) => {
    const replies = [...calls, reply("已经全部创建或删除。")];
    return ask({ store, vault, conversationID: "chat", prompt, http: async () => replies.shift() });
  };
  const created = await run("创建项目并创建任务", [tool("propose_changes", { actions: [
    { operation: "create", kind: "projects", ref: "synthetic_project", changes: { name: "合成项目" } },
    { operation: "create", kind: "tasks", changes: { title: "合成子任务", projectRef: "synthetic_project" } },
  ] })]);
  const applied = await applyPlan(store, created.pendingPlan), projectID = applied.receipts[0].id, taskID = applied.receipts[1].id;
  assert.equal(store.get("tasks", taskID).projectId, projectID);
  const updated = await run("修改项目", [tool("knowledge_read", { kind: "projects", id: projectID }),
    tool("propose_changes", { actions: [{ operation: "update", kind: "projects", id: projectID, changes: { description: "合成更新目标" } }] })]);
  assert.match(updated.text, /拟修改项目「合成项目」/);
  await applyPlan(store, updated.pendingPlan);
  assert.equal(store.get("projects", projectID).description, "合成更新目标");
  const removed = await run("删除项目", [tool("knowledge_read", { kind: "projects", id: projectID }),
    tool("propose_changes", { actions: [{ operation: "remove", kind: "projects", id: projectID }] })]);
  assert.match(removed.text, /拟归档项目「合成项目」/);
  assert.match(removed.text, /项目内任务、笔记、资料和对话全部保留/);
  assert.doesNotMatch(removed.text, /已经全部|拟移入回收站项目/);
  await applyPlan(store, removed.pendingPlan);
  assert.equal(store.get("projects", projectID).archived, true);
  assert.equal(store.get("tasks", taskID).projectId, projectID);
  const restored = await run("恢复项目", [tool("knowledge_read", { kind: "projects", id: projectID, archived: true }),
    tool("propose_changes", { actions: [{ operation: "restore", kind: "projects", id: projectID }] })]);
  assert.match(restored.text, /拟恢复项目「合成项目」/);
  await applyPlan(store, restored.pendingPlan);
  assert.equal(store.get("projects", projectID).archived, false);
  assert.equal(store.get("tasks", taskID).projectId, projectID);
});
