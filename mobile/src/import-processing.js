import { clone, equal, putRecord } from "./store.js";

const queues = new WeakMap();
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
export const MAX_IMPORT_TEXT = 200000;
const digest = /^[a-f0-9]{64}$/;
const textExtensions = /\.(txt|md|markdown|mdown|csv|tsv|json|jsonl|ndjson|yaml|yml|toml|ini|log|tex|xml|html?|css|[cm]?js|jsx|tsx?|py|r|sql|sh|bash|zsh|swift|java|kt|c|h|cpp|hpp|go|rs|ipynb)$/i;
const textMimes = new Set(["application/json", "application/ld+json", "application/x-ndjson", "application/xml", "application/javascript", "application/yaml", "application/x-yaml", "application/toml"]);
const imageExtension = /\.(png|jpe?g|gif|webp|bmp|heic|heif|tiff?)$/i;
const active = (record) => record && !record.deleted && !record.conflict && record.data &&
  !record.data.archived && !record.data.archivedAt && !record.data.deletedAt && !record.data.deleted;
const hasText = (data) => typeof data.content === "string" && !!data.content.trim();
const untouched = (data) => !hasText(data) && !data.parser && !data.textStatus && !data.warning && !data.error &&
  (data.content == null || typeof data.content === "string");
const resultSummary = () => ({ processed: 0, ready: 0, empty: 0, failed: 0, pending: 0, skipped: 0, changed: 0, results: [] });

function enqueue(store, work) {
  const previous = queues.get(store) || Promise.resolve();
  const queued = previous.catch(() => {}).then(work);
  queues.set(store, queued);
  queued.finally(() => { if (queues.get(store) === queued) queues.delete(store); }).catch(() => {});
  return queued;
}

function formatOf(data, native, platformName) {
  const name = String(data.originalName || data.name || data.title || "附件");
  const mime = String(data.mimeType || "").split(";")[0].trim().toLowerCase();
  const deviceParser = `${platformName === "android" ? "android" : "ios"}-device`;
  if (/\.pdf$/i.test(name) || mime === "application/pdf")
    return { kind: "pdf", name: /\.pdf$/i.test(name) ? name : name + ".pdf", parser: native ? deviceParser : "browser-pdf" };
  if (mime.startsWith("image/") || imageExtension.test(name))
    return { kind: native ? "image" : "unsupported-image", name, parser: native ? deviceParser : "mobile-extraction" };
  if (textExtensions.test(name) || mime.startsWith("text/") || textMimes.has(mime))
    return { kind: "text", name, parser: "text-utf8" };
  return { kind: "unsupported", name, parser: "mobile-extraction" };
}

function trimText(text) {
  if (text.length <= MAX_IMPORT_TEXT) return { text, truncated: false };
  let value = text.slice(0, MAX_IMPORT_TEXT);
  const last = value.charCodeAt(value.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) value = value.slice(0, -1);
  return { text: value, truncated: true };
}

function decodeText(bytes) {
  let encoding = "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
  let text;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw Error("文本编码无法识别，请转为 UTF-8 后重新导入；原件仍保留。"); }
  if (text.includes("\0")) throw Error("文件包含二进制内容，未将其当作可引用正文；原件仍保留。");
  return { text, parser: "text-" + encoding.replaceAll("-", "") };
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw Error("本机原件格式无效，未覆盖正文；原件仍保留。");
}

async function processOne(options, importID, before, summary) {
  const { store, files, extractText, native = false, platformName = "web" } = options;
  const key = "imports:" + importID;
  const format = formatOf(before, native, platformName);
  // Persist an attempt before reading/decoding so interruption does not become a
  // foreground retry loop. parser is already part of the desktop sync contract.
  const claimed = await store.tx((state) => {
    const record = state.records[key];
    if (!active(record) || !equal(record.data, before)) return null;
    const value = { ...before, parser: format.parser + ":processing", textStatus: "processing",
      warning: "正在提取文字；如果提取中断，可手动重试。", updatedAt: Date.now() };
    putRecord(state, "imports", value, before);
    return clone(value);
  });
  if (!claimed) { summary.changed++; return; }

  let status, warning = "", content, parser = format.parser;
  if (Number(before.size) > MAX_IMPORT_BYTES) {
    status = "too-large";
    warning = "原件超过 64 MB，未自动提取；原件和已有正文仍保留。";
  } else if (format.kind.startsWith("unsupported")) {
    status = "unsupported";
    warning = format.kind === "unsupported-image"
      ? "图片文字识别可在手机或 Mac 上完成；当前保留图片原件。"
      : "此文件格式暂不自动提取文字，可预览或导出原件。";
  } else {
    let raw;
    try { raw = await files.read(before.blobHash); }
    catch {
      status = "pending-download";
      warning = "原件尚未在本机可用。请先打开或下载原件，再手动提取文字。";
    }
    if (!status) {
      try {
        const bytes = asBytes(raw);
        if (bytes.byteLength > MAX_IMPORT_BYTES) {
          status = "too-large";
          warning = "原件超过 64 MB，未自动提取；原件和已有正文仍保留。";
        } else {
          if (format.kind !== "text" && typeof extractText !== "function")
            throw Error("当前设备暂未提供此文件的文字提取能力");
          const extracted = format.kind === "text" ? decodeText(bytes) : await extractText(format.name, bytes);
          if (!extracted || typeof extracted.text !== "string") throw Error("文字提取未返回有效正文；原件仍保留。");
          const limited = trimText(extracted.text);
          content = limited.text;
          parser = typeof extracted.parser === "string" ? extracted.parser.slice(0, 160) : format.parser;
          warning = typeof extracted.warning === "string" ? extracted.warning.slice(0, 2000) : "";
          if (limited.truncated) warning = [warning, "正文较长，已提取前 200,000 字符；完整原件已保留。"].filter(Boolean).join(" ");
          status = content.trim() ? "ready" : "empty";
          if (status === "empty") {
            if (hasText(before)) content = before.content;
            warning = [warning, hasText(before) ? "未提取到新的文字，已保留已有正文和原件。" : "没有可提取文字，仍可预览原件或手动重试。"].filter(Boolean).join(" ");
          }
        }
      } catch (error) {
        status = "failed";
        warning = String(error?.message || "文字提取未完成").slice(0, 400) + " 可手动重试；原件仍保留。";
      }
    }
  }
  const patch = { parser: status === "ready" || status === "empty" ? parser : parser + ":" + status,
    textStatus: status, warning, updatedAt: Date.now(), ...(content === undefined ? {} : { content }) };
  const saved = await store.tx((state) => {
    const record = state.records[key];
    if (!active(record) || !equal(record.data, claimed)) return false;
    putRecord(state, "imports", { ...claimed, ...patch }, claimed);
    return true;
  });
  if (!saved) { summary.changed++; return; }
  summary.processed++;
  if (status === "ready") summary.ready++;
  else if (status === "empty") summary.empty++;
  else if (status === "pending-download") summary.pending++;
  else summary.failed++;
  summary.results.push({ id: importID, key, status, warning });
}

/** Reads only local originals. Already attempted/imported text is never retried automatically. */
export function extractPendingImports(options) {
  const { store } = options;
  return enqueue(store, async () => {
    const summary = resultSummary();
    for (const [key, record] of Object.entries(store.state.records)) {
      if (!key.startsWith("imports:")) continue;
      if (!active(record) || !digest.test(record.data.blobHash || "") || !untouched(record.data)) { summary.skipped++; continue; }
      await processOne(options, record.data.id, clone(record.data), summary);
    }
    return summary;
  });
}

/** Explicit one-file retry after download or user request; still checks the reviewed version. */
export function retryImportText(options, importID, expected) {
  const record = options.store.state.records["imports:" + importID];
  if (!active(record) || !digest.test(record.data.blobHash || "")) throw Error("资料不存在、已归档或有同步冲突，请重新打开后重试");
  if (expected !== undefined && !equal(record.data, expected)) throw Error("资料已变化，请重新打开后再提取，未覆盖新内容");
  const before = clone(record.data);
  return enqueue(options.store, async () => {
    const summary = resultSummary();
    await processOne(options, importID, before, summary);
    return summary;
  });
}
