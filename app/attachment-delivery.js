/* Prepare one representation per attachment. Reads only through caller-provided
   adapters; never calls a model, changes the store, or falls back after failure. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AttachmentDelivery = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const MiB = 1024 * 1024;
  const LIMITS = Object.freeze({ apiFileBytes: 40 * MiB, apiBatchBytes: 40 * MiB, authImageBytes: 16 * MiB });
  const mimeByExtension = Object.freeze({
    pdf: 'application/pdf', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml', heic: 'image/heic', avif: 'image/avif'
  });
  const officeTypes = new Set(Object.entries(mimeByExtension).filter(([key]) => ['ppt','pptx','doc','docx','xls','xlsx'].includes(key)).map(([,value]) => value));
  const string = value => typeof value === 'string' ? value : '';
  const mime = value => string(value).split(';')[0].trim().toLowerCase();
  const nameOf = (item, index) => string(item.name || item.originalName) || `附件 ${index + 1}`;
  const mimeOf = (item, name) => {
    const declared = mime(item.mimeType || item.type), extension = name.split('.').pop().toLowerCase();
    return declared && declared.includes('/') && declared !== 'application/octet-stream' ? declared : (Object.hasOwn(mimeByExtension, extension) ? mimeByExtension[extension] : '') || declared || 'application/octet-stream';
  };
  class AttachmentDeliveryError extends Error {
    constructor(message, code, item, details = {}) {
      super(message); this.name = 'AttachmentDeliveryError'; this.code = code;
      if (item) { this.attachmentId = string(item.id); this.attachmentName = string(item.name || item.originalName); }
      Object.assign(this, details);
    }
  }
  const cancelled = () => new AttachmentDeliveryError('已停止准备附件。', 'CANCELLED');
  function check(signal) { if (signal?.aborted) throw cancelled(); }
  function abortable(signal, operation) {
    check(signal);
    return new Promise((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener('abort', stop);
      const stop = () => { cleanup(); reject(cancelled()); };
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) { stop(); return; }
      Promise.resolve().then(() => { check(signal); return operation(); }).then(value => { cleanup(); check(signal); return value; }).then(resolve, error => { cleanup(); reject(error); });
    });
  }
  async function adapted(callback, args, signal, item, code, label) {
    if (typeof callback !== 'function') throw new AttachmentDeliveryError(`${label}不可用，请检查附件服务配置。`, code, item);
    try { return await abortable(signal, () => callback(...args)); }
    catch (error) { if (signal?.aborted || error?.code === 'CANCELLED' || error?.name === 'AbortError') throw cancelled(); throw new AttachmentDeliveryError(`${label}失败。${string(error?.message).slice(0, 240)} 可以重试，或调整本轮附件后继续。`, code, item); }
  }
  function validateBlob(value, item, label, jpeg = false) {
    const blob = value?.blob || value;
    if (!blob || typeof blob.arrayBuffer !== 'function' || !Number.isSafeInteger(blob.size) || blob.size <= 0) throw new AttachmentDeliveryError(`${label}缺失或为空，未发送不完整附件。`, 'MISSING_ORIGINAL', item);
    if (jpeg && mime(blob.type) !== 'image/jpeg') throw new AttachmentDeliveryError(`${label}没有返回 JPEG 图像，未省略该页。`, 'INVALID_PDF_IMAGE', item);
    return blob;
  }
  async function dataUrl(blob, type, signal, item) {
    let buffer;
    try { buffer = await abortable(signal, () => blob.arrayBuffer()); }
    catch (error) { if (error?.code === 'CANCELLED') throw error; throw new AttachmentDeliveryError('附件原件读取失败，未自动改为文字模式。', 'ORIGINAL_READ_FAILED', item); }
    check(signal);
    if (Object.prototype.toString.call(buffer) !== '[object ArrayBuffer]' || buffer.byteLength !== blob.size) throw new AttachmentDeliveryError('附件实际字节数与原件不一致，请重新导入。', 'INVALID_ORIGINAL', item);
    const bytes = new Uint8Array(buffer); let encoded;
    if (root.Buffer?.from) encoded = root.Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
    else if (typeof root.btoa === 'function') {
      let binary = ''; for (let at = 0; at < bytes.length; at += 0x8000) { check(signal); binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000)); }
      encoded = root.btoa(binary);
    } else throw new AttachmentDeliveryError('当前环境无法编码附件原件。', 'ENCODING_UNAVAILABLE', item);
    check(signal); return `data:${type};base64,${encoded}`;
  }
  const identityBlock = value => ({ type: 'input_text', text: JSON.stringify({ attachment: value }) });
  const textAvailable = item => [item.content, item.text, item.extractedText, ...(Array.isArray(item.pages) ? item.pages.flatMap(page => [page?.text, page?.content]) : [])].some(value => string(value).trim());
  async function prepare(attachments, options = {}) {
    const { provider = 'api', getBlob, getPdfInfo, getPdfPage, signal, onProgress, forceText = false } = options;
    check(signal);
    if (!Array.isArray(attachments) || attachments.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new AttachmentDeliveryError('附件清单无效，请重新选择附件。', 'INVALID_ATTACHMENTS');
    const seen = new Set();
    for (const item of attachments) { const id = string(item.id); if (id && seen.has(id)) throw new AttachmentDeliveryError('同一附件在本次请求中重复出现，请重新选择。', 'DUPLICATE_ATTACHMENT', item); if (id) seen.add(id); }
    const auth = provider === 'openai-auth', blocks = [], metadata = [], textAttachments = [];
    let nativeBytes = 0, imageBytes = 0, renderedImageBytes = 0, pdfPageCount = 0;
    const progress = message => { check(signal); onProgress?.(message); check(signal); };
    for (const [index, item] of attachments.entries()) {
      check(signal); const name = nameOf(item, index), type = mimeOf(item, name), id = string(item.id);
      const image = type.startsWith('image/'), pdf = type === 'application/pdf', office = officeTypes.has(type);
      const storedSize = Number.isSafeInteger(item.size) && item.size > 0 ? item.size : null;
      const record = { attachmentId: id, name, originalName: string(item.originalName) || name, mimeType: type, originalBytes: storedSize, originalBytesSource: storedSize === null ? 'unavailable' : 'stored_original_metadata' };
      if (forceText === true || !(image || pdf || (!auth && office))) {
        const reason = forceText === true ? 'user_selected_text' : auth && office ? 'auth_office_requires_text' : 'text_or_unsupported_file';
        metadata.push({ ...record, readMode: 'text', reason, textAvailable: !!textAvailable(item) }); textAttachments.push(item); continue;
      }
      if (auth && pdf) {
        progress(`正在读取 ${name}…`);
        const info = await adapted(getPdfInfo, [item], signal, item, 'PDF_INFO_FAILED', `《${name}》页数读取`);
        const count = info?.pageCount;
        if (!Number.isSafeInteger(count) || count < 1) throw new AttachmentDeliveryError(`《${name}》页数无效，无法确认全部页面。`, 'INVALID_PAGE_COUNT', item);
        for (let page = 1; page <= count; page++) {
          const blob = validateBlob(await adapted(getPdfPage, [item, page], signal, item, 'PDF_PAGE_FAILED', `《${name}》第 ${page} 页图像准备`), item, `《${name}》第 ${page} 页`, true);
          if (imageBytes + blob.size > LIMITS.authImageBytes) throw new AttachmentDeliveryError('本次图片与 PDF 页面图像的实际体积超过此连接的 16 MiB 发送预算，未发送不完整附件。此限制按图片字节量计算，与 PDF 页数无关。请减少本次附件，或明确选择文字模式。', 'IMAGE_BATCH_LIMIT', item, { page, bytes: imageBytes + blob.size, limit: LIMITS.authImageBytes });
          const url = await dataUrl(blob, 'image/jpeg', signal, item); imageBytes += blob.size; renderedImageBytes += blob.size; pdfPageCount++;
          blocks.push(identityBlock({ attachmentId: id, name, originalName: record.originalName, readMode: 'pdf_page_images', page, pageCount: count }), { type: 'input_image', image_url: url, detail: 'auto' });
          progress(`正在读取 ${name} · ${page}/${count} 页`);
        }
        // The model sees saved-original metadata only. Rendered JPEG sizes are
        // transport diagnostics, not facts about the user's PDF.
        metadata.push({ ...record, readMode: 'pdf_page_images', pageCount: count, includedPages: Array.from({ length: count }, (_, at) => at + 1) });
        progress(`已读取 ${name} · ${count} 页`);
        continue;
      }
      progress(`正在读取 ${name}…`);
      const blob = validateBlob(await adapted(getBlob, [item], signal, item, 'ORIGINAL_READ_FAILED', `《${name}》原件读取`), item, `《${name}》原件`);
      if (!auth && (blob.size >= LIMITS.apiFileBytes || nativeBytes + blob.size > LIMITS.apiBatchBytes)) throw new AttachmentDeliveryError('单份原件须小于 40 MiB，本批原件总大小不能超过 40 MiB。请拆分附件后发送，或明确选择文字模式。', 'ORIGINAL_SIZE_LIMIT', item, { bytes: blob.size, limit: LIMITS.apiBatchBytes });
      if (auth && imageBytes + blob.size > LIMITS.authImageBytes) throw new AttachmentDeliveryError('本次图片与 PDF 页面图像的实际体积超过此连接的 16 MiB 发送预算，未发送不完整附件。此限制按图片字节量计算，与 PDF 页数无关。请减少本次附件，或明确选择文字模式。', 'IMAGE_BATCH_LIMIT', item, { bytes: imageBytes + blob.size, limit: LIMITS.authImageBytes });
      const readMode = image ? 'original_image' : 'original_file';
      const originalType = mime(blob.type) && mime(blob.type) !== 'application/octet-stream' ? mime(blob.type) : type;
      const url = await dataUrl(blob, originalType, signal, item);
      nativeBytes += blob.size; if (image) imageBytes += blob.size;
      blocks.push(identityBlock({ attachmentId: id, name, originalName: record.originalName, readMode }), image ? { type: 'input_image', image_url: url, detail: 'auto' } : { type: 'input_file', filename: name, file_data: url });
      metadata.push({ ...record, mimeType: originalType, readMode, originalBytes: blob.size, originalBytesSource: 'actual_original_blob' });
      progress(`已读取 ${name}`);
    }
    check(signal);
    const originalFiles = metadata.filter(item => item.readMode === 'original_file').length, originalImages = metadata.filter(item => item.readMode === 'original_image').length;
    const unavailable = metadata.filter(item => item.readMode === 'text' && !item.textAvailable).map(({ attachmentId, name }) => ({ attachmentId, name }));
    const first = metadata[0];
    let stageLabel = !first ? '本次没有附件' : metadata.length === 1
      ? `已读取 ${first.name}${first.pageCount ? ` · ${first.pageCount} 页` : ''}`
      : `已读取 ${metadata.length} 份资料${pdfPageCount ? ` · ${pdfPageCount} 页` : ''}`;
    if (unavailable.length) stageLabel = `${metadata.length === unavailable.length ? '资料待补充' : stageLabel} · ${unavailable.length} 份暂无可用文字`;
    const knownOriginalBytes = metadata.reduce((sum, item) => sum + (item.originalBytes || 0), 0);
    const originalBytesComplete = metadata.every(item => item.originalBytes !== null);
    return { blocks, metadata, textAttachments, coverage: { scope: 'prepared_representations', totalAttachments: attachments.length, nativeAttachments: metadata.length - textAttachments.length, textAttachments: textAttachments.length, originalFiles, originalImages, pdfPageImages: pdfPageCount, originalBytes: originalBytesComplete ? knownOriginalBytes : null, knownOriginalBytes, originalBytesComplete, transmittedOriginalBytes: nativeBytes, renderedImageBytes, imageBytes, textUnavailable: unavailable }, stageLabel };
  }
  return { prepare, LIMITS, AttachmentDeliveryError };
}));
