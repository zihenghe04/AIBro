import test from "node:test";
import assert from "node:assert/strict";
import { Store, MemoryAdapter, addMessage } from "../src/store.js";
import { ask } from "../src/ai.js";
import { parseAgendaIntent } from "../src/agenda-intent.js";
import { applyPlan, createAgentTools } from "../src/agent-tools.js";
import { eventsFor, readEvent } from "../src/agenda.js";

const prompt = "明天下午三点打篮球，帮我新建日程";
const now = Date.parse("2030-01-31T21:00:00+08:00");
const parse = (text, options = {}) => parseAgendaIntent(text, { now, timeZone: "Asia/Shanghai", ...options });
const noNetwork = () => { throw Error("local agenda must not use model/network/credentials"); };
const finalReply = (content) => ({ choices: [{ message: { content }, finish_reason: "stop" }] });
const proposalReply = (changes) => ({ choices: [{ message: { tool_calls: [{ id: "plan", type: "function", function: {
  name: "propose_changes", arguments: JSON.stringify({ actions: [{ operation: "create", kind: "agenda", changes }] }),
} }] }, finish_reason: "tool_calls" }] });

test("explicit local calendar intent resolves tomorrow in the selected timezone with a visible one-hour default", () => {
  const intent = parse(prompt);
  assert.deepEqual(intent, {
    event: { title: "打篮球", start: Date.parse("2030-02-01T15:00:00+08:00"), end: Date.parse("2030-02-01T16:00:00+08:00"),
      timeZone: "Asia/Shanghai", allDay: false, reminderMinutes: null }, durationMinutes: 60, defaultDuration: true,
  });
  const explicit = parse("请帮我创建一个日程：2030年2月3日下午三点半打篮球，持续两小时");
  assert.equal(explicit.event.title, "打篮球");
  assert.equal(explicit.event.start, Date.parse("2030-02-03T15:30:00+08:00"));
  assert.equal(explicit.durationMinutes, 120);
  assert.equal(explicit.defaultDuration, false);
  assert.equal(parse("2030-02-03 15:00 打篮球，添加日程").event.start, Date.parse("2030-02-03T15:00:00+08:00"));
});

test("local parser refuses ambiguous clocks, invalid dates, DST gaps/folds and unsupported calendar instructions", () => {
  for (const text of ["明天三点打篮球，帮我新建日程", "明天下午二十五点打篮球，帮我新建日程", "2030-02-30下午三点打篮球，帮我新建日程", "今天下午三点打篮球，帮我新建日程"])
    assert.ok(parse(text).error, text);
  for (const [text, timestamp] of [["2030-03-10凌晨两点半训练，帮我新建日程", "2030-03-09T12:00:00Z"], ["2030-11-03凌晨一点半训练，帮我新建日程", "2030-11-02T12:00:00Z"]])
    assert.ok(parse(text, { now: Date.parse(timestamp), timeZone: "America/New_York" }).error, text);
  for (const text of ["明天下午三点打篮球", "不要明天下午三点打篮球，帮我新建日程", "明天下午三点到四点打篮球，帮我新建日程", "明天下午三点打篮球，每周重复，帮我新建日程", "明天下午三点打篮球，后天下午四点游泳，帮我新建日程", "明天北京时间下午三点打篮球，帮我新建日程"])
    assert.equal(parse(text), null, text);
});

test("no-model calendar proposal survives reload, writes one agenda note only after approval and yields a durable receipt", async (t) => {
  t.mock.method(Date, "now", () => now);
  const adapter = new MemoryAdapter(), store = await new Store(adapter).load();
  const progress = [];
  const result = await ask({ store, prompt, http: noNetwork, stream: noNetwork, vault: { get: noNetwork }, onProgress: (event) => progress.push(event) });
  assert.equal(store.list("notes").length, 0);
  assert.equal(store.list("tasks").length, 0);
  assert.equal(result.pendingPlan.actions[0].kind, "agenda");
  assert.match(result.text, /时长.*1 小时/);
  assert.match(result.text, /确认后才会保存/);
  assert.match(result.text, new RegExp(parseAgendaIntent(prompt).event.timeZone));
  assert.equal(progress.find((event) => event.type === "tool-result").output.executed, false);
  const reopened = await new Store(adapter).load();
  const persisted = reopened.list("messages").find((message) => message.id === result.messageID);
  assert.deepEqual(persisted.pendingPlan, result.pendingPlan);
  const applied = await applyPlan(reopened, persisted.pendingPlan);
  const event = readEvent(reopened.list("notes")[0]);
  assert.equal(event.title, "打篮球");
  assert.equal(event.end - event.start, 3600000);
  assert.equal(event.format, "aibro.agenda.v1");
  assert.equal(applied.receipts[0].id, event.id);
  assert.equal(applied.receipts[0].start, event.start);
  assert.equal(applied.receipts[0].timeZone, event.timeZone);
  assert.equal(eventsFor(reopened, event.start, event.end)[0].title, "打篮球");
  assert.match(reopened.list("messages").find((message) => message.id === result.messageID).content, /日程「打篮球」已保存到本机/);
  await applyPlan(reopened, result.pendingPlan);
  const afterRetry = await new Store(adapter).load();
  assert.equal(afterRetry.list("notes").length, 1);
  assert.equal(afterRetry.list("tasks").length, 0);
  assert.equal(afterRetry.list("messages").find((message) => message.id === result.messageID).content.match(/已保存到本机/g).length, 1);
});

test("created calendar can be searched, read and updated through the same tool contract without changing identity", async (t) => {
  t.mock.method(Date, "now", () => now);
  const store = await new Store(new MemoryAdapter()).load();
  await store.put("projects", { id: "sports", name: "运动", workspace: "日常" });
  const result = await ask({ store, projectID: "sports", prompt, vault: { get: noNetwork } });
  await applyPlan(store, result.pendingPlan);
  const tools = createAgentTools({ store, conversationID: result.conversationID, projectID: "sports" });
  const search = await tools.execute("knowledge_search", { query: "篮球", kind: "agenda" });
  assert.equal(search.entries.length, 1);
  const recordID = search.entries[0].id;
  const original = await tools.execute("knowledge_read", { kind: "agenda", id: recordID });
  assert.equal(original.projectId, "sports");
  assert.equal(original.start, result.pendingPlan.actions[0].changes.start);
  assert.equal((await tools.execute("propose_changes", { actions: [{ operation: "update", kind: "agenda", id: recordID, changes: {
    start: original.start + 3600000, end: original.end + 3600000, location: "体育馆",
  } }] })).error, undefined);
  const update = tools.pendingPlan();
  await addMessage(store, result.conversationID, "assistant", "请审阅改期", { pendingPlan: update });
  await applyPlan(store, update);
  assert.equal(store.list("notes").length, 1);
  assert.equal(readEvent(store.get("notes", recordID)).location, "体育馆");
  assert.equal(readEvent(store.get("notes", recordID)).start, original.start + 3600000);
});

test("local staging and approval never claim a save after storage failure", async (t) => {
  t.mock.method(Date, "now", () => now);
  const store = await new Store(new MemoryAdapter()).load();
  const write = store.adapter.write.bind(store.adapter);
  store.adapter.write = async () => { throw Error("synthetic disk failure"); };
  await assert.rejects(ask({ store, prompt }), /synthetic disk failure/);
  assert.equal(store.list("messages").length, 0);
  assert.equal(store.list("notes").length, 0);
  store.adapter.write = write;
  const result = await ask({ store, prompt });
  store.adapter.write = async () => { throw Error("synthetic disk failure"); };
  await assert.rejects(applyPlan(store, result.pendingPlan), /synthetic disk failure/);
  assert.equal(store.list("notes").length, 0);
  assert.doesNotMatch(store.list("messages").at(-1).content, /已保存到本机/);
});

test("model prose cannot fabricate a calendar receipt when no plan exists or its tool arguments were rejected", async () => {
  for (const invalidTool of [false, true]) {
    const store = await new Store(new MemoryAdapter()).load();
    await store.tx((state) => state.settings.model = { base: "https://fixture.example/v1", model: "fixture", format: "chat" });
    const replies = [...(invalidTool ? [proposalReply({ title: "篮球", start: "2030-02-01T15:00:00+08:00" })] : []), finalReply("已帮你创建并同步 Mac。")];
    const progress = [];
    await assert.rejects(ask({ store, prompt: "下周一下午三点打篮球，帮我新建日程", vault: { get: async () => "synthetic" },
      http: async () => replies.shift(), onProgress: (event) => progress.push(event) }), /日程没有保存/);
    assert.equal(store.list("notes").length, 0);
    assert.equal(progress.filter((event) => event.type === "text").length, 0);
    const response = store.list("messages").at(-1);
    assert.equal(response.status, "failed");
    assert.doesNotMatch(response.content, /已帮你创建|同步 Mac/);
  }
});

test("model calendar proposals expose actual proposed times and review status instead of fabricated completion", async () => {
  const store = await new Store(new MemoryAdapter()).load();
  await store.tx((state) => state.settings.model = { base: "https://fixture.example/v1", model: "fixture", format: "chat" });
  const changes = { title: "模型合成日程", start: "2030-02-04T15:00:00+08:00", end: "2030-02-04T16:00:00+08:00", timeZone: "Asia/Shanghai" };
  const replies = [proposalReply(changes), finalReply("已帮你创建并同步 Mac。")];
  const result = await ask({ store, prompt: "下周一下午三点打篮球，帮我新建日程", vault: { get: async () => "synthetic" }, http: async () => replies.shift() });
  assert.equal(store.list("notes").length, 0);
  assert.match(result.text, /拟新建日程「模型合成日程」/);
  assert.match(result.text, /Asia\/Shanghai/);
  assert.match(result.text, /确认后才会保存/);
  assert.doesNotMatch(result.text, /已帮你创建|同步 Mac/);
});

test("unsupported no-model requests explain the local range and preserve existing reminder behavior", async (t) => {
  t.mock.method(Date, "now", () => now);
  const store = await new Store(new MemoryAdapter()).load();
  await assert.rejects(ask({ store, prompt: "下周每天下午三点打篮球，帮我新建日程" }), /无需模型可新建明确的单次日程/);
  const result = await ask({ store, prompt: "明天下午三点提醒我打篮球", vault: { get: noNetwork } });
  assert.equal(result.pendingPlan, null);
  assert.equal(store.list("tasks").length, 1);
  assert.equal(store.list("notes").length, 0);
});

test("acceptance acknowledges a persisted user message for local agenda and model runs", async () => {
  for (const local of [true, false]) {
    const store = await new Store(new MemoryAdapter()).load();
    if (!local) await store.tx(state => state.settings.model = { base: "https://model.example/v1", model: "fixture", format: "chat" });
    let accepted = 0;
    await ask({ store, prompt: local ? prompt : "你好", vault: { get: async () => "synthetic-key" },
      http: async () => { assert.equal(accepted, 1); return finalReply("你好"); },
      onAccepted: ({ conversationID, messageID }) => {
        accepted++;
        const message = store.list("messages").find(m => m.id === messageID);
        assert.equal(message.role, "user"); assert.equal(message.conversationId, conversationID);
      },
    });
    assert.equal(accepted, 1);
  }
  const store = await new Store(new MemoryAdapter()).load();
  store.adapter.write = async () => { throw Error("write failed"); };
  await assert.rejects(ask({ store, prompt, onAccepted: () => assert.fail("not durable") }), /write failed/);
});
