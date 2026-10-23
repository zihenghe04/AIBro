/* Per-service model list: display name, request model, context window and reasoning levels. Public metadata only; keys never enter it. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ModelCatalog = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 数据格式（state.settings.modelCatalog，version 1）：
  // { version:1, services:{ "<服务地址>": { models:[{model,label,contextWindow,efforts}], updatedAt } } }
  // 按服务地址分组：同一地址的不同方案共享一份列表，换设备同步后也能对上。
  // 旧版只认 profile.model / workstation-api-model，这里不改动它们，降级后旧版照常工作。
  const VERSION = 1, MAX_MODELS = 200, MIN_WINDOW = 1024, MAX_WINDOW = 10000000;
  const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  // 只列出该协议请求体能表达的档位；“自动”按服务实际协议决定，列全部。
  const PROTOCOL_EFFORTS = {
    responses: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
    chat: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    auto: EFFORTS
  };
  // 现有内核的固定预算按 128K 窗口标定；填写窗口后等比例缩放并设上下限。
  const REFERENCE_WINDOW = 128000;
  const DEFAULT_BUDGETS = Object.freeze({ historyTokens: 3500, compactThreshold: 12000, keepRecentTokens: 4000, batchTokens: 8000 });
  const LIMITS = { historyTokens: [1200, 14000], compactThreshold: [3000, 48000], keepRecentTokens: [1000, 16000], batchTokens: [2000, 16000] };
  // 内核循环的截断/压缩：主窗口证据输入预算（24000）、run 内压缩阈值与保留量（32000/8000，见 kernel-compaction.js）。
  // 同样按 128K 标定；没填窗口时沿用这些固定值。
  const KERNEL_DEFAULTS = Object.freeze({ evidenceInputTokens: 24000, runCompactTokens: 32000, runRetainTokens: 8000 });
  const KERNEL_LIMITS = { evidenceInputTokens: [6000, 96000], runCompactTokens: [6000, 160000], runRetainTokens: [1500, 40000] };

  const text = (value, max) => String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

  function serviceKey(base) {
    try {
      const url = new URL(String(base || '').trim());
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
      return url.origin.toLowerCase() + url.pathname.replace(/\/+$/, '');
    } catch (_) { return ''; }
  }

  function protocolEfforts(protocol) { return (PROTOCOL_EFFORTS[protocol] || PROTOCOL_EFFORTS.auto).slice(); }

  function contextWindow(value) {
    if (value === '' || value == null) return null;
    const number = typeof value === 'number' ? value : Number(String(value).replace(/[,_\s]/g, ''));
    return Number.isSafeInteger(number) && number >= MIN_WINDOW && number <= MAX_WINDOW ? number : null;
  }

  function normalizeEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const model = text(raw.model, 200);
    if (!model) return null;
    const efforts = Array.isArray(raw.efforts) ? EFFORTS.filter(level => raw.efforts.includes(level)) : [];
    return { model, label: text(raw.label, 80) || model, contextWindow: contextWindow(raw.contextWindow), efforts };
  }

  function normalizeList(list) {
    const seen = new Set(), out = [];
    for (const raw of Array.isArray(list) ? list : []) {
      const entry = normalizeEntry(raw);
      if (!entry || seen.has(entry.model)) continue;
      seen.add(entry.model); out.push(entry);
      if (out.length >= MAX_MODELS) break;
    }
    return out;
  }

  function catalogOf(settings) {
    const value = settings && settings.modelCatalog;
    return value && typeof value === 'object' && value.version === VERSION && value.services && typeof value.services === 'object' ? value : null;
  }

  function has(settings, base) {
    const key = serviceKey(base), catalog = catalogOf(settings);
    return !!(key && catalog && Object.prototype.hasOwnProperty.call(catalog.services, key));
  }

  function read(settings, base) {
    const key = serviceKey(base), catalog = catalogOf(settings);
    return key && catalog ? normalizeList(catalog.services[key]?.models) : [];
  }

  function write(settings, base, list, now = Date.now()) {
    const key = serviceKey(base);
    if (!settings || !key) return false;
    // 未来版本或损坏的目录不覆盖，避免降级写回丢数据。
    if (settings.modelCatalog && !catalogOf(settings)) {
      if (Number(settings.modelCatalog.version) > VERSION) return false;
      settings.modelCatalogBackup = settings.modelCatalog;
    }
    const catalog = catalogOf(settings) || (settings.modelCatalog = { version: VERSION, services: {} });
    catalog.services[key] = { models: normalizeList(list), updatedAt: now };
    return true;
  }

  // 旧设置只有一个默认模型：把它变成列表里的一项。只填补空缺，从不覆盖已有列表。
  function migrate(settings, sources = []) {
    if (!settings) return 0;
    if (settings.modelCatalog && !catalogOf(settings) && Number(settings.modelCatalog.version) > VERSION) return 0;
    let seeded = 0;
    for (const source of Array.isArray(sources) ? sources : []) {
      const model = text(source?.model, 200);
      if (!model || !serviceKey(source?.base) || has(settings, source.base)) continue;
      if (write(settings, source.base, [{ model, label: model }])) seeded += 1;
    }
    return seeded;
  }

  function find(list, model) {
    const id = text(model, 200);
    return id ? (Array.isArray(list) ? list : []).find(entry => entry && entry.model === id) || null : null;
  }

  function label(list, model) { const entry = find(list, model); return entry ? entry.label : text(model, 200); }

  function ensureModel(list, model) {
    const entries = normalizeList(list), id = text(model, 200);
    return !id || find(entries, id) ? entries : normalizeList([...entries, { model: id, label: id }]);
  }

  function addModels(list, ids) {
    return normalizeList([...(Array.isArray(list) ? list : []), ...(Array.isArray(ids) ? ids : []).map(model => ({ model, label: model }))]);
  }

  function effortsFor(entry, protocol) {
    const allowed = protocolEfforts(protocol);
    const chosen = entry && Array.isArray(entry.efforts) && entry.efforts.length ? entry.efforts.filter(level => allowed.includes(level)) : [];
    return chosen.length ? chosen : allowed;
  }

  function budgets(windowTokens) {
    const size = contextWindow(windowTokens);
    if (!size) return { ...DEFAULT_BUDGETS, configured: false };
    const scale = size / REFERENCE_WINDOW, out = { configured: true, contextWindow: size };
    for (const [key, base] of Object.entries(DEFAULT_BUDGETS)) {
      const [min, max] = LIMITS[key];
      out[key] = Math.round(Math.min(max, Math.max(min, base * scale)));
    }
    // 压缩前保留的原文不能多于触发阈值本身。
    out.keepRecentTokens = Math.min(out.keepRecentTokens, Math.floor(out.compactThreshold / 2));
    return out;
  }

  function kernelBudgets(windowTokens) {
    const size = contextWindow(windowTokens);
    if (!size) return { ...KERNEL_DEFAULTS, configured: false };
    const scale = size / REFERENCE_WINDOW, out = { configured: true, contextWindow: size };
    for (const [key, base] of Object.entries(KERNEL_DEFAULTS)) {
      const [min, max] = KERNEL_LIMITS[key];
      out[key] = Math.round(Math.min(max, Math.max(min, base * scale)));
    }
    out.runRetainTokens = Math.min(out.runRetainTokens, Math.floor(out.runCompactTokens / 2));
    return out;
  }

  function officialOpenAI(base) { const key = serviceKey(base); return key.startsWith('https://api.openai.com'); }

  // 针对具体填写给出提示，不做泛泛的提醒。返回中英文两份文案。
  function hints(entry, { base = '', available = null, protocol = 'auto' } = {}) {
    const out = [];
    if (!entry) return out;
    const size = entry.contextWindow;
    if (/(^|[\/:])gpt-/i.test(entry.model) && !officialOpenAI(base) && size && size > 272000) {
      out.push({ code: 'relay-gpt-window', zh: '中转站的 GPT 多来自 ChatGPT 订阅，窗口通常只有 272K。窗口写大了 AI Bro 不会提前压缩，等上游拒收时这一轮会失败；确认这家支持更大窗口再这样填。', en: 'GPT models on relay services usually come from ChatGPT plans with a 272K window. A larger value delays compaction and the turn fails when the provider rejects it; only use it if this provider supports more.' });
    }
    if (size && size < 16000) {
      out.push({ code: 'small-window', zh: '窗口较小：AI Bro 会更早压缩旧对话，长资料要分页读取，复杂任务可能放不下工具说明。', en: 'Small window: older turns are compacted sooner, long sources are read in pages, and complex tasks may not fit tool instructions.' });
    }
    if (Array.isArray(available) && available.length && !available.includes(entry.model)) {
      out.push({ code: 'not-listed', zh: '服务返回的模型列表里没有这个名称；发送前请确认拼写或大小写。', en: 'This name is not in the provider’s model list. Check its spelling and case before sending.' });
    }
    const allowed = protocolEfforts(protocol), unsupported = (entry.efforts || []).filter(level => !allowed.includes(level));
    if (unsupported.length) {
      out.push({ code: 'effort-protocol', zh: `当前协议不支持 ${unsupported.join(', ')}，这些档位不会出现在对话的推理选项里。`, en: `The current protocol does not support ${unsupported.join(', ')}; those levels are hidden in the chat picker.` });
    }
    return out;
  }

  function summarizeEfforts(efforts) {
    const list = EFFORTS.filter(level => (efforts || []).includes(level));
    if (!list.length) return '';
    const first = EFFORTS.indexOf(list[0]), last = EFFORTS.indexOf(list[list.length - 1]);
    return list.length > 2 && last - first + 1 === list.length ? `${list[0]} → ${list[list.length - 1]}` : list.join(', ');
  }

  return Object.freeze({ VERSION, EFFORTS, DEFAULT_BUDGETS, KERNEL_DEFAULTS, serviceKey, protocolEfforts, contextWindow, normalizeEntry, normalizeList, has, read, write, migrate, find, label, ensureModel, addModels, effortsFor, budgets, kernelBudgets, hints, summarizeEfforts });
}));
