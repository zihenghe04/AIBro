import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  Store,
  MemoryAdapter,
  messageWireID,
  addMessage,
  clone,
} from "../src/store.js";
import { Sync, serverURL } from "../src/sync.js";
import { parseICS, eventsFor, agendaNote } from "../src/agenda.js";
import { UCAS, signOutcome } from "../src/ucas.js";
import { ask } from "../src/ai.js";
const newStore = () => new Store(new MemoryAdapter()).load();
const note = (title = "Before") => ({
  id: "n1",
  title,
  content: "hello",
  kind: "note",
});
const vault = () => {
  const m = new Map();
  return {
    get: async (k) => m.get(k),
    set: async (k, v) => m.set(k, v),
    remove: async (k) => m.delete(k),
  };
};
async function bound() {
  const store = await newStore(),
    v = vault();
  await store.tx(
    (s) => (s.binding = { base: "https://sync.example", accountID: "acct" }),
  );
  await v.set(
    "sync",
    JSON.stringify({ base: "https://sync.example", token: "token" }),
  );
  return { store, v };
}
const ack = (op) => ({
  opId: op.opId,
  entityType: op.entityType,
  entityId: op.entityId,
  version: op.baseVersion + 1,
});
test("durable transaction rollback, serialization and restart", async () => {
  const s = await newStore();
  await s.put("notes", note());
  const adapter = s.adapter,
    save = adapter.write;
  adapter.write = async () => {
    throw Error("disk full");
  };
  await assert.rejects(s.put("notes", note("Lost")));
  assert.equal(s.get("notes", "n1").title, "Before");
  adapter.write = save;
  await Promise.all([
    s.tx((x) => (x.settings.counter = 1)),
    s.tx((x) => x.settings.counter++),
  ]);
  const reopened = await new Store(adapter).load();
  assert.equal(reopened.state.settings.counter, 2);
  await assert.rejects(s.put("notes", note("overwrite"), note("stale")));
});
test("message IDs match desktop Python UUID5 and survive restart", async () => {
  const expected = execFileSync(
    "python3",
    [
      "-c",
      "import json,uuid; print(uuid.uuid5(uuid.NAMESPACE_URL,json.dumps(['conv','msg'],separators=(',',':'))).hex)",
    ],
    { encoding: "utf8" },
  ).trim();
  assert.equal(await messageWireID("conv", "msg"), expected);
  const s = await newStore();
  await addMessage(s, "conv", "user", "Hi");
  await addMessage(s, "conv", "assistant", "Hello");
  assert.deepEqual(
    s.list("messages").map((m) => m.position),
    [0, 1],
  );
});
test("dropped push response replays exactly the same operation after restart", async () => {
  const { store, v } = await bound();
  await store.put("notes", note());
  let sent;
  const http = async (path, opt) => {
    if (path.endsWith("/push")) {
      sent = clone(opt.body.operations[0]);
      throw Error("disconnected");
    }
    return { changes: [], cursor: 0, hasMore: false };
  };
  await assert.rejects(new Sync(store, http, v, {}).run());
  const s = await new Store(store.adapter).load();
  await s.put("notes", note("Edited while offline"));
  const ops = [];
  await new Sync(
    s,
    async (path, opt) => {
      if (path.endsWith("/push")) {
        ops.push(clone(opt.body.operations[0]));
        return { accepted: opt.body.operations.map(ack), conflicts: [] };
      }
      return { changes: [], cursor: 0, hasMore: false };
    },
    v,
    {},
  ).run();
  assert.deepEqual(ops[0], sent);
  assert.equal(ops[1].data.title, "Edited while offline");
  assert.equal(ops[1].baseVersion, 1);
  assert.equal(s.state.records["notes:n1"].dirty, false);
});
test("edit during network request is sent as a second operation", async () => {
  const { store, v } = await bound();
  await store.put("notes", note());
  let count = 0;
  await new Sync(
    store,
    async (path, opt) => {
      if (path.endsWith("/push")) {
        if (count++ === 0) await store.put("notes", note("Changed"));
        return { accepted: opt.body.operations.map(ack), conflicts: [] };
      }
      return { changes: [], cursor: 0, hasMore: false };
    },
    v,
    {},
  ).run();
  assert.equal(count, 2);
  assert.equal(store.get("notes", "n1").title, "Changed");
});
test("remote deletion conflicts with local edits, explicit remote choice deletes", async () => {
  const { store, v } = await bound();
  await store.put("notes", note());
  const remote = { version: 4, deleted: true, data: null };
  await new Sync(
    store,
    async (path, opt) =>
      path.endsWith("/push")
        ? {
            accepted: [],
            conflicts: opt.body.operations.map((op) => ({
              ...ack(op),
              remote,
            })),
          }
        : {
            changes: [
              { seq: 4, entityType: "notes", entityId: "n1", ...remote },
            ],
            cursor: 4,
            hasMore: false,
          },
    v,
    {},
  ).run();
  assert.equal(store.get("notes", "n1").title, "Before");
  await store.resolve("notes:n1", "remote");
  assert.equal(store.get("notes", "n1"), null);
  assert.equal(store.state.cursor, 4);
});
test("server URL rejects credential leaks and unsafe transports", () => {
  assert.throws(() => serverURL("http://example.org"));
  assert.throws(() => serverURL("https://user:pass@example.org"));
  assert.throws(() => serverURL("https://example.org?token=x"));
  assert.equal(serverURL("https://example.org/"), "https://example.org");
});
const ics = (extra) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:course1\r\nSUMMARY:机器学习\r\nDTSTART;TZID=Asia/Shanghai:20260914T083000\r\nDTEND;TZID=Asia/Shanghai:20260914T100000\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\n${extra || ""}END:VEVENT\r\nEND:VCALENDAR`;
test("Chinese recurring timetable preserves 08:30 and exclusions across re-load", async () => {
  const parsed = parseICS(ics("EXDATE;TZID=Asia/Shanghai:20260921T083000\r\n"));
  assert.equal(parsed.warnings.length, 0);
  assert.equal(parsed.events[0].start, Date.parse("2026-09-14T08:30:00+08:00"));
  const store = await newStore();
  await store.put("notes", agendaNote(parsed.events[0]));
  const rows = eventsFor(
    await new Store(store.adapter).load(),
    Date.parse("2026-09-01"),
    Date.parse("2026-10-01"),
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[1].start, Date.parse("2026-09-28T08:30:00+08:00"));
  assert.equal(rows[0].reminderAt, rows[0].start - 900000);
});
test("invalid ICS timezone and broken duration are reported, not guessed", () => {
  assert.equal(
    parseICS(ics().replaceAll("Asia/Shanghai", "Mars/Base")).events.length,
    0,
  );
  assert.equal(parseICS(ics().replace("T100000", "T070000")).events.length, 0);
});
test("UCAS success requires explicit school confirmation", () => {
  assert.equal(
    signOutcome({ STATUS: 0, result: { stuSignStatus: 1 } }).status,
    "signed",
  );
  for (const j of [
    { STATUS: 0 },
    { STATUS: 1, result: { stuSignStatus: 1 } },
    { STATUS: 0, success: false, result: { stuSignStatus: 1 } },
    { STATUS: 0, ERRCODE: 2, result: { stuSignStatus: 1 } },
  ])
    assert.equal(signOutcome(j).status, "unknown");
});
test("school password is not persisted by default; failed login does not save session", async () => {
  const v = vault();
  let seen;
  const u = new UCAS(async (path, opt) => {
    seen = opt.body;
    return {
      STATUS: 0,
      result: { id: 1, sessionId: "s", studentNo: "student" },
    };
  }, v);
  await u.login("user", "private-password");
  assert.match(seen, /verificationType=1/);
  assert.doesNotMatch(await v.get("ucas"), /private-password/);
  const bad = new UCAS(async () => ({ STATUS: 1 }), v);
  await assert.rejects(bad.login("u", "p"));
});
test("model receives selected sources and project memory, never credentials", async () => {
  const store = await newStore(),
    v = vault();
  await store.tx(
    (s) =>
      (s.settings.model = {
        base: "https://model.example/v1",
        model: "test",
        format: "chat",
      }),
  );
  await v.set("model", "key");
  await v.set("ucas", "school-secret");
  await store.put("notes", note());
  await store.put("notes", {
    id: "notselected",
    title: "PRIVATE",
    content: "unselected-secret",
  });
  let body;
  const result = await ask({
    store,
    vault: v,
    http: async (url, opt) => {
      body = opt.body;
      return { choices: [{ message: { content: "Grounded [1]" } }] };
    },
    prompt: "Summarize",
    contextKeys: ["notes:n1"],
  });
  assert.match(JSON.stringify(body), /hello/);
  assert.doesNotMatch(JSON.stringify(body), /school-secret|unselected-secret/);
  assert.equal(store.list("messages").length, 2);
  assert.equal(result.sources.length, 1);
});
test("AI rewrite waits for review and does not overwrite concurrent human edits", async () => {
  const { stageDraft, applyDraft } = await import("../src/review.js");
  const s = await newStore();
  await s.put("notes", note());
  await stageDraft(s, "n1", "AI version", s.get("notes", "n1"));
  assert.equal(s.get("notes", "n1").content, "hello");
  let n = s.get("notes", "n1");
  await s.put("notes", { ...n, content: "human edit" });
  await assert.rejects(applyDraft(s, "n1", n.aiDraft));
  assert.equal(s.get("notes", "n1").content, "human edit");
  await s.put("notes", { ...s.get("notes", "n1"), content: "hello" });
  await applyDraft(s, "n1", n.aiDraft);
  assert.equal(s.get("notes", "n1").content, "AI version");
  assert.equal(s.get("notes", "n1").revisionHistory[0].content, "hello");
});
test("desktop SyncStore assembles mobile messages and preserves mobile notes/drafts", async () => {
  const s = await newStore();
  await s.put("notes", {
    ...note(),
    kind: "随记",
    aiDraft: { content: "draft" },
    wikiCategory: "methods",
  });
  await s.put("conversations", {
    id: "conversation",
    title: "Project conversation",
  });
  await addMessage(s, "conversation", "user", "mobile question");
  await addMessage(s, "conversation", "assistant", "mobile answer");
  const output = JSON.parse(
    execFileSync("python3", ["tests/desktop-roundtrip.py"], {
      input: JSON.stringify(s.state.records),
      encoding: "utf8",
    }),
  );
  assert.equal(output.notes[0].aiDraft.content, "draft");
  assert.deepEqual(
    output.conversations[0].messages.map((m) => m.content),
    ["mobile question", "mobile answer"],
  );
  assert.deepEqual(
    output.wireIDs.sort(),
    Object.keys(s.state.records)
      .filter((k) => k.startsWith("messages:"))
      .map((k) => k.split(":")[1])
      .sort(),
  );
});
test("share inbox commits attachments and note together, retries failed acknowledgement without duplicates", async () => {
  const { receiveShared } = await import("../src/inbox.js");
  const s = await newStore();
  const item = {
    id: "12345678-1234-1234-1234-123456789012",
    text: "分享链接",
    files: [{ name: "a.txt", data: btoa("content") }],
    createdAt: 1,
  };
  let remaining = [item],
    fail = true;
  const bridge = {
    shared: async () => ({ items: remaining }),
    sharedAck: async () => {
      if (fail) throw Error("ack lost");
      remaining = [];
    },
  };
  const files = { write: async () => {} };
  await assert.rejects(
    receiveShared(s, bridge, files, async () => "a".repeat(64)),
  );
  assert.equal(s.list("notes").length, 1);
  assert.equal(s.list("imports").length, 1);
  fail = false;
  await receiveShared(s, bridge, files, async () => "a".repeat(64));
  assert.equal(s.list("notes").length, 1);
  assert.equal(remaining.length, 0);
});
