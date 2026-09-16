import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { Store, MemoryAdapter, addMessage } from "../src/store.js";
import { Sync } from "../src/sync.js";
import { agendaNote } from "../src/agenda.js";
const vault = () => {
  const m = new Map();
  return {
    get: async (k) => m.get(k),
    set: async (k, v) => m.set(k, v),
    remove: async (k) => m.delete(k),
  };
};
const http = async (url, opt = {}) => {
  const r = await fetch(url, {
    method: opt.method || "GET",
    headers: { "Content-Type": "application/json", ...opt.headers },
    body: opt.bytes || (opt.body ? JSON.stringify(opt.body) : undefined),
  });
  const j = await r.json();
  if (!r.ok) throw Object.assign(Error(j.error), { status: r.status });
  return j;
};
test("real protocol: two mobile devices exchange records, messages, blobs, conflict and deletion", async () => {
  const python = [
    process.env.PYTHON,
    "python3.13",
    "python3.12",
    "python3.11",
    "python3",
  ]
    .filter(Boolean)
    .find(
      (p) =>
        spawnSync(p, ["-c", 'import hashlib; assert hasattr(hashlib,"scrypt")'])
          .status === 0,
    );
  assert.ok(python, "Python with hashlib.scrypt is required");
  const child = spawn(python, ["tests/cloud-fixture.py"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const stop = new Promise((_, reject) =>
    child.on("exit", (code) =>
      reject(Error("fixture exited " + code + " " + stderr)),
    ),
  );
  try {
    const [chunk] = await Promise.race([once(child.stdout, "data"), stop]);
    const base = "http://127.0.0.1:" + String(chunk).trim();
    const a = await new Store(new MemoryAdapter()).load(),
      b = await new Store(new MemoryAdapter()).load();
    const va = vault(),
      vb = vault();
    const bytes = new TextEncoder().encode("hello file");
    const hash = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    ]
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    const sa = new Sync(a, http, va, { read: async () => bytes }),
      sb = new Sync(b, http, vb, {});
    await a.put("projects", {
      id: "project1",
      name: "科研",
      workspace: "科研",
    });
    await a.put("notes", {
      id: "note1",
      title: "研究随记",
      content: "灵感",
      kind: "随记",
      projectId: "project1",
    });
    await a.put(
      "notes",
      agendaNote({
        title: "组会",
        start: 1800000000000,
        end: 1800003600000,
        reminderMinutes: 15,
      }),
    );
    await a.put("conversations", {
      id: "conv1",
      title: "继续实验",
      projectId: "project1",
    });
    await addMessage(a, "conv1", "user", "分析证据");
    await a.put("imports", {
      id: "file1",
      title: "sample.txt",
      blobHash: hash,
      size: bytes.length,
      mimeType: "text/plain",
    });
    await a.tx((s) => (s.blobs[hash] = { uploaded: false }));
    await sa.login(base, "mobile-test", "fixture-password-42!");
    await sb.login(base, "mobile-test", "fixture-password-42!");
    assert.equal(b.get("notes", "note1").content, "灵感");
    assert.equal(b.list("messages")[0].content, "分析证据");
    assert.equal(b.list("notes").filter((n) => n.kind === "日程").length, 1);
    const token = JSON.parse(await vb.get("sync")).token;
    const downloaded = await fetch(base + "/v1/blobs/" + hash, {
      headers: { Authorization: "Bearer " + token },
    });
    assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), bytes);
    await a.put("notes", { ...a.get("notes", "note1"), content: "A 修改" });
    await b.put("notes", { ...b.get("notes", "note1"), content: "B 修改" });
    await sa.run();
    await sb.run();
    assert.ok(b.state.records["notes:note1"].conflict);
    assert.equal(b.get("notes", "note1").content, "B 修改");
    await b.resolve("notes:note1", "remote");
    assert.equal(b.get("notes", "note1").content, "A 修改");
    await a.remove("notes", "note1");
    await sa.run();
    await sb.run();
    assert.equal(b.get("notes", "note1"), null);
    await sa.logout();
  } finally {
    child.kill("SIGTERM");
  }
});
