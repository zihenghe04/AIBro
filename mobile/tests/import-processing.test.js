import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Store, MemoryAdapter, clone } from "../src/store.js";
import { receiveShared } from "../src/inbox.js";
import { createAgentTools } from "../src/agent-tools.js";
import { extractPendingImports, retryImportText, MAX_IMPORT_BYTES, MAX_IMPORT_TEXT } from "../src/import-processing.js";

const fresh = () => new Store(new MemoryAdapter()).load();
const hash = async (bytes) => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (text) => new TextEncoder().encode(text);
async function source(store, files, identifier, name, text, extra = {}) {
  const bytes = typeof text === "string" ? bytesOf(text) : text;
  const blobHash = await hash(bytes);
  files.set(blobHash, bytes);
  await store.put("imports", { id: identifier, name, originalName: name, title: name,
    mimeType: "application/octet-stream", size: bytes.length, blobHash, workspace: "日常", ...extra });
  return blobHash;
}
function options(store, local, extra = {}) {
  return { store, native: true, platformName: "ios", files: { read: async (hash) => {
    if (!local.has(hash)) throw Error("fixture file absent");
    return local.get(hash);
  } }, ...extra };
}
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test("actual share-inbox import fields produce PDF/image/text content usable from the capture citation", async () => {
  const store = await fresh(), local = new Map();
  const shareID = "01234567-1234-4123-8123-012345678901";
  let acknowledged = false;
  const input = [{ name: "Shared PDF without suffix", mimeType: "application/pdf", text: "%PDF fixture" },
    { name: "课堂图.png", mimeType: "image/png", text: "image fixture" },
    { name: "研究记录.md", mimeType: "text/markdown", text: "# 附件结论\n检索的真实内容" }];
  const bridge = { shared: async () => ({ items: acknowledged ? [] : [{ id: shareID, text: "今天的分享", files: input.map(({ text, ...file }) => ({ ...file, data: Buffer.from(text).toString("base64") })) }] }),
    sharedAck: async () => { acknowledged = true; } };
  await receiveShared(store, bridge, { write: async (digest, bytes) => local.set(digest, bytes) }, hash);
  assert.equal(acknowledged, true);
  const calls = [];
  const result = await extractPendingImports(options(store, local, { extractText: async (name, bytes) => {
    calls.push({ name, bytes });
    return { text: name.endsWith(".pdf") ? "共享 PDF 的可引用正文" : "课堂图中的 OCR 正文", warning: "" };
  } }));
  assert.equal(result.ready, 3);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, "Shared PDF without suffix.pdf");
  const sharedFile = store.get("imports", "sharefile_" + shareID + "_0");
  assert.equal(sharedFile.originalName, "Shared PDF without suffix");
  assert.equal(sharedFile.parser, "ios-device");
  assert.equal(sharedFile.textStatus, "ready");
  const context = createAgentTools({ store, contextKeys: ["notes:share_" + shareID] }).initial("正文");
  assert.ok(context.some((entry) => entry.content.includes("共享 PDF 的可引用正文")));
  assert.ok(context.some((entry) => entry.content.includes("课堂图中的 OCR 正文")));
  assert.ok(context.some((entry) => entry.content.includes("检索的真实内容")));
  assert.equal((await extractPendingImports(options(store, local))).processed, 0);
});

test("one Store serializes overlapping scans and processes each original only once", async () => {
  const store = await fresh(), local = new Map(), gate = deferred(), entered = deferred();
  await source(store, local, "a", "a.pdf", "first");
  await source(store, local, "b", "b.pdf", "second");
  let active = 0, maximum = 0, calls = 0;
  const settings = options(store, local, { extractText: async () => {
    active++; maximum = Math.max(maximum, active); calls++;
    if (calls === 1) { entered.resolve(); await gate.promise; }
    active--;
    return { text: "finished", warning: "" };
  } });
  const first = extractPendingImports(settings);
  await entered.promise;
  const second = extractPendingImports(settings);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(maximum, 1);
  assert.equal(calls, 2);
});

test("missing local original records pending download once, never downloads, explicit retry works", async () => {
  const store = await fresh(), local = new Map();
  const digest = await source(store, local, "f", "资料.txt", "下载后正文");
  const original = local.get(digest); local.clear();
  let reads = 0;
  const settings = options(store, local);
  const read = settings.files.read;
  settings.files.read = async (hash) => { reads++; return read(hash); };
  assert.equal((await extractPendingImports(settings)).pending, 1);
  assert.equal(store.get("imports", "f").textStatus, "pending-download");
  await extractPendingImports(settings);
  assert.equal(reads, 1);
  // Desktop projection keeps parser/warning even if it omits textStatus.
  await store.tx((state) => { delete state.records["imports:f"].data.textStatus; });
  await extractPendingImports(settings);
  assert.equal(reads, 1);
  local.set(digest, original);
  assert.equal((await retryImportText(settings, "f")).ready, 1);
  assert.equal(store.get("imports", "f").content, "下载后正文");
});

test("failed OCR preserves original and existing text; foreground scans never retry the failure", async () => {
  const store = await fresh(), local = new Map();
  const digest = await source(store, local, "f", "photo.jpg", "original", { content: "人工保存的正文" });
  let calls = 0;
  const settings = options(store, local, { extractText: async () => { calls++; throw Error("识别失败"); } });
  assert.equal((await extractPendingImports(settings)).processed, 0);
  assert.equal((await retryImportText(settings, "f")).failed, 1);
  assert.equal(store.get("imports", "f").content, "人工保存的正文");
  assert.equal(store.get("imports", "f").textStatus, "failed");
  assert.equal(local.get(digest).length, 8);
  await extractPendingImports(settings);
  assert.equal(calls, 1);
});

test("CAS preserves an edit, archive, deletion or conflict arriving during extraction", async () => {
  for (const mutation of [
    (store) => store.put("imports", { ...store.get("imports", "f"), content: "人工新编辑" }),
    (store) => store.put("imports", { ...store.get("imports", "f"), archived: true }),
    (store) => store.remove("imports", "f"),
    (store) => store.tx((state) => { state.records["imports:f"].conflict = { version: 4, data: { id: "f", content: "远端" }, deleted: false }; }),
  ]) {
    const store = await fresh(), local = new Map(), entered = deferred(), gate = deferred();
    await source(store, local, "f", "file.pdf", "pdf");
    const settings = options(store, local, { extractText: async () => { entered.resolve(); await gate.promise; return { text: "过期提取结果", warning: "" }; } });
    const pending = extractPendingImports(settings);
    await entered.promise;
    await mutation(store);
    const edited = clone(store.state.records["imports:f"]);
    gate.resolve();
    assert.equal((await pending).changed, 1);
    assert.deepEqual(store.state.records["imports:f"], edited);
  }
});

test("strict text decoding handles UTF-8, BOM UTF-16 and rejects binary or corrupt text", async () => {
  const store = await fresh(), local = new Map();
  await source(store, local, "utf8", "文件.toml", '标题 = "内容"');
  await source(store, local, "utf16", "table.csv", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("列1,列2", "utf16le")]));
  await source(store, local, "binary", "broken.json", new Uint8Array([0x61, 0, 0x62]));
  await source(store, local, "bad", "broken.md", new Uint8Array([0xff, 0xff, 0xff]));
  const result = await extractPendingImports(options(store, local));
  assert.equal(result.ready, 2);
  assert.equal(result.failed, 2);
  assert.equal(store.get("imports", "utf16").content, "列1,列2");
  assert.equal(store.get("imports", "utf16").parser, "text-utf16le");
  assert.equal(store.get("imports", "binary").content, undefined);
});

test("text length limit retains Unicode boundary and a clear warning", async () => {
  const store = await fresh(), local = new Map();
  await source(store, local, "f", "long.txt", "a".repeat(MAX_IMPORT_TEXT - 1) + "🙂tail");
  await extractPendingImports(options(store, local));
  const item = store.get("imports", "f");
  assert.equal(item.content.length, MAX_IMPORT_TEXT - 1);
  assert.match(item.warning, /200,000/);
  assert.equal(item.textStatus, "ready");
});

test("64 MB cap checks both metadata and actual bytes before decoding or native extraction", async () => {
  const store = await fresh(), local = new Map();
  await source(store, local, "declared", "big.pdf", "small", { size: MAX_IMPORT_BYTES + 1 });
  const digest = await source(store, local, "actual", "also-big.pdf", "declared small");
  local.set(digest, new Uint8Array(MAX_IMPORT_BYTES + 1));
  let reads = 0;
  const settings = options(store, local, { extractText: async () => assert.fail("too large must not enter native bridge") });
  const read = settings.files.read;
  settings.files.read = async (hash) => { reads++; return read(hash); };
  const result = await extractPendingImports(settings);
  assert.equal(result.failed, 2);
  assert.equal(reads, 1);
  assert.equal(store.get("imports", "actual").textStatus, "too-large");
});

test("unsupported formats and browser images remain originals without repeat attempts", async () => {
  const store = await fresh(), local = new Map();
  await source(store, local, "doc", "source.docx", "office binary");
  await source(store, local, "image", "image.png", "image binary");
  const settings = options(store, local, { native: false, platformName: "web", files: { read: async () => assert.fail("unsupported originals need no read") } });
  const result = await extractPendingImports(settings);
  assert.equal(result.failed, 2);
  assert.equal(store.get("imports", "doc").textStatus, "unsupported");
  assert.equal((await extractPendingImports(settings)).processed, 0);
});

test("empty extraction is durable and an explicit empty retry never erases previous text", async () => {
  const store = await fresh(), local = new Map();
  await source(store, local, "f", "scan.pdf", "pdf");
  let calls = 0;
  const settings = options(store, local, { extractText: async () => { calls++; return { text: "", warning: "扫描 PDF" }; } });
  assert.equal((await extractPendingImports(settings)).empty, 1);
  await extractPendingImports(settings);
  assert.equal(calls, 1);
  await store.put("imports", { ...store.get("imports", "f"), content: "手工补入正文" });
  await retryImportText(settings, "f");
  assert.equal(store.get("imports", "f").content, "手工补入正文");
});

test("interrupted extraction marker survives restart and requires explicit retry", async () => {
  const store = await fresh(), local = new Map();
  await source(store, local, "f", "file.pdf", "pdf", { parser: "ios-device:processing", textStatus: "processing", warning: "可手动重试" });
  const reopened = await new Store(store.adapter).load();
  const result = await extractPendingImports(options(reopened, local, { extractText: async () => assert.fail("no automatic restart loop") }));
  assert.equal(result.processed, 0);
  assert.equal(reopened.get("imports", "f").textStatus, "processing");
});

test("manual retry can require exactly the import version shown in the file sheet", async () => {
  const store = await fresh(), local = new Map();
  await source(store, local, "f", "file.txt", "原件正文");
  const reviewed = store.get("imports", "f");
  await store.put("imports", { ...reviewed, content: "随后保存的新正文" });
  assert.throws(() => retryImportText(options(store, local), "f", reviewed), /未覆盖/);
  assert.equal(store.get("imports", "f").content, "随后保存的新正文");
});
