/* Balance / credit lookup for the few providers that publish a balance endpoint (DeepSeek, OpenRouter, SiliconFlow, StepFun, Novita).
   Logic ported from CC Switch (https://github.com/farion1231/cc-switch, MIT). Copyright (c) 2025 Jason Young; licence text in docs/THIRD_PARTY.md.
   Runs only when the user presses Refresh. The key comes from the keychain through the host and is sent to that provider only. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProviderBalance = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const TIMEOUT_MS = 15000;
  const ADAPTERS = {
    deepseek: { url: 'https://api.deepseek.com/user/balance', name: 'DeepSeek' },
    stepfun: { url: 'https://api.stepfun.com/v1/accounts', name: 'StepFun' },
    'siliconflow-cn': { url: 'https://api.siliconflow.cn/v1/user/info', name: 'SiliconFlow' },
    'siliconflow-en': { url: 'https://api.siliconflow.com/v1/user/info', name: 'SiliconFlow' },
    openrouter: { url: 'https://openrouter.ai/api/v1/credits', name: 'OpenRouter' },
    novita: { url: 'https://api.novita.ai/v3/user/balance', name: 'Novita AI' }
  };

  function detect(base) {
    const url = String(base || '').toLowerCase();
    if (url.includes('api.deepseek.com')) return 'deepseek';
    if (url.includes('api.stepfun.ai') || url.includes('api.stepfun.com')) return 'stepfun';
    if (url.includes('api.siliconflow.cn')) return 'siliconflow-cn';
    if (url.includes('api.siliconflow.com')) return 'siliconflow-en';
    if (url.includes('openrouter.ai')) return 'openrouter';
    if (url.includes('api.novita.ai')) return 'novita';
    return '';
  }

  const field = (object, key) => {
    const value = object && typeof object === 'object' ? object[key] : undefined;
    const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
    return Number.isFinite(number) ? number : null;
  };
  const bad = message => ({ ok: false, state: 'error', items: [], message });

  // 解析各家返回的余额。余额为 0 不代表密钥失效（失效是 401/403），所以只照实显示数字。
  function parse(adapter, body) {
    if (!body || typeof body !== 'object') return bad('服务没有返回有效内容。');
    if (adapter === 'deepseek') {
      let items = (Array.isArray(body.balance_infos) ? body.balance_infos : []).map(info => ({ label: String(info && info.currency || 'CNY'), remaining: field(info, 'total_balance'), unit: String(info && info.currency || 'CNY') }));
      // 同一账号会列出 CNY / USD 两个钱包：只要有钱包有余额，就不列空钱包。
      if (items.some(item => item.remaining > 0)) items = items.filter(item => item.remaining === null || item.remaining > 0);
      return items.length ? { ok: true, state: 'ok', items, message: '' } : bad('没有读到余额。');
    }
    if (adapter === 'stepfun') return { ok: true, state: 'ok', items: [{ label: 'StepFun', remaining: field(body, 'balance') ?? 0, unit: 'CNY' }], message: '' };
    if (adapter === 'siliconflow-cn' || adapter === 'siliconflow-en') {
      if (!body.data || typeof body.data !== 'object') return bad('服务没有返回 data 字段。');
      return { ok: true, state: 'ok', items: [{ label: ADAPTERS[adapter].name + (adapter === 'siliconflow-en' ? ' (EN)' : ''), remaining: field(body.data, 'totalBalance') ?? 0, unit: adapter === 'siliconflow-cn' ? 'CNY' : 'USD' }], message: '' };
    }
    if (adapter === 'openrouter') {
      const data = body.data && typeof body.data === 'object' ? body.data : body;
      const total = field(data, 'total_credits'), used = field(data, 'total_usage');
      if (total === null || used === null) return bad('没有读到有效的额度数字。');
      return { ok: true, state: 'ok', items: [{ label: 'OpenRouter', remaining: total - used, total, used, unit: 'USD' }], message: '' };
    }
    if (adapter === 'novita') {
      const raw = field(body, 'availableBalance');
      if (raw === null) return bad('没有读到有效的余额数字。');
      // Novita 金额单位为 0.0001 美元。
      return { ok: true, state: 'ok', items: [{ label: 'Novita AI', remaining: raw / 10000, unit: 'USD' }], message: '' };
    }
    return bad('不支持的余额接口。');
  }

  // request(url, headers, signal) → fetch-like Response（宿主经本地代理转发）。结果不含密钥和原始返回内容。
  async function run({ base, token, request, timeoutMs = TIMEOUT_MS } = {}) {
    const adapter = detect(base);
    if (!adapter) return { ok: false, state: 'unsupported', items: [], message: '这个供应商没有公开的余额接口。' };
    if (!token) return { ok: false, state: 'auth', items: [], message: '还没有保存这个供应商的密钥。' };
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await request(ADAPTERS[adapter].url, { Authorization: `Bearer ${token}`, Accept: 'application/json' }, controller.signal);
      if (response.status === 401 || response.status === 403) return { ok: false, state: 'auth', items: [], message: '密钥被拒绝，请检查密钥。' };
      if (!response.ok) return bad(`服务返回 HTTP ${response.status}。`);
      const body = await response.json().catch(() => null);
      return { ...parse(adapter, body), adapter };
    } catch (error) {
      return { ok: false, state: error && error.name === 'AbortError' ? 'timeout' : 'unreachable', items: [], message: error && error.name === 'AbortError' ? '查询超时（15 秒）。' : '无法连接到余额接口。' };
    } finally { clearTimeout(timer); }
  }

  const format = item => {
    const value = Number(item.remaining);
    const symbol = item.unit === 'CNY' ? '¥' : item.unit === 'USD' ? '$' : '';
    return `${symbol}${Number.isFinite(value) ? value.toFixed(Math.abs(value) >= 100 ? 0 : 2) : '—'}${symbol ? '' : ' ' + (item.unit || '')}`.trim();
  };

  return Object.freeze({ ADAPTERS, detect, parse, run, format, TIMEOUT_MS });
}));
