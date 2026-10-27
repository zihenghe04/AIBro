/* Provider preset library: categories, search, vendor families and address recognition. Pure functions over the static preset table. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProviderLibrary = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const data = () => root.ProviderPresetData || (typeof require === 'function' ? require('./provider-presets-data.js') : { presets: [] });
  const CATEGORIES = [
    { id: 'all', zh: '全部', en: 'All' },
    { id: 'account', zh: '账号登录', en: 'Sign in' },
    { id: 'vendor', zh: '模型厂商', en: 'Model makers' },
    { id: 'platform', zh: '第三方平台', en: 'Platforms' },
    { id: 'cloud', zh: '云服务商', en: 'Cloud' },
    { id: 'local', zh: '本地', en: 'Local' }
  ];
  const PLAN = { payg: ['按量', 'Pay as you go'], coding: ['编程套餐', 'Coding plan'], codingPlan: ['编程套餐', 'Coding plan'], agentPlan: ['Agent 套餐', 'Agent plan'], tokenPlan: ['Token 套餐', 'Token plan'], enterpriseLite: ['企业轻量', 'Enterprise Lite'], enterprisePro: ['企业专业', 'Enterprise Pro'], stepPlan: ['Step 套餐', 'Step plan'], aksk: ['AK/SK', 'AK/SK'], apiKey: ['API Key', 'API key'] };
  const REGION = { cn: ['国内', 'Mainland'], intl: ['海外', 'Global'] };
  // 账号登录类不是 API Key 供应商：只有 ChatGPT（经官方 Codex）。Grok 在批 6 才加。
  const ACCOUNTS = [{ id: 'chatgpt', zh: 'ChatGPT 账号', en: 'ChatGPT account', descZh: '用 ChatGPT 订阅登录（经官方 Codex）', descEn: 'Sign in with your ChatGPT plan (through the official Codex)', providerId: 'codex-cli' }];

  const text = value => String(value == null ? '' : value);
  const hostOf = url => { try { return new URL(text(url)).hostname.toLowerCase(); } catch (_) { return ''; } };
  const presets = () => data().presets || [];
  const get = id => presets().find(preset => preset.id === id) || null;

  function versionLabel(preset, english) {
    const i = english ? 1 : 0, parts = [];
    if (preset.region && REGION[preset.region]) parts.push(REGION[preset.region][i]);
    if (preset.plan && PLAN[preset.plan]) parts.push(PLAN[preset.plan][i]);
    return parts.length ? parts.join(' · ') : (hostOf(preset.baseUrl) || preset.name);
  }

  // 同一家的多个版本合成一行；其余一预设一行。名称按字母序，没有任何加权或置顶。
  function rows({ query = '', category = 'all', english = false } = {}) {
    const tokens = text(query).toLowerCase().split(/\s+/).filter(Boolean);
    const matches = preset => {
      if (category !== 'all' && preset.category !== category) return false;
      if (!tokens.length) return true;
      const hay = [preset.name, preset.familyName, hostOf(preset.baseUrl), hostOf(preset.websiteUrl), preset.aliases].map(text).join(' ').toLowerCase();
      return tokens.every(token => hay.includes(token));
    };
    const out = [], families = new Map();
    for (const preset of presets()) {
      if (!matches(preset)) continue;
      if (preset.family) {
        let row = families.get(preset.family);
        if (!row) { row = { key: `family:${preset.family}`, name: preset.familyName || preset.name, category: preset.category, versions: [] }; families.set(preset.family, row); out.push(row); }
        row.versions.push({ id: preset.id, label: versionLabel(preset, english) });
      } else out.push({ key: preset.id, name: preset.name, category: preset.category, versions: [{ id: preset.id, label: versionLabel(preset, english) }] });
    }
    for (const row of out) {
      row.id = row.versions[0].id;
      const first = get(row.id);
      row.host = hostOf(first && (first.websiteUrl || first.baseUrl));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  }
  function counts() {
    const all = rows(), out = { all: all.length, account: ACCOUNTS.length };
    for (const category of ['vendor', 'platform', 'cloud', 'local']) out[category] = rows({ category }).length;
    return out;
  }

  // 同一家的其他版本（含自己）。
  function versions(id, english = false) {
    const preset = get(id);
    if (!preset) return [];
    const group = preset.family ? presets().filter(item => item.family === preset.family) : [preset];
    return group.map(item => ({ id: item.id, label: versionLabel(item, english) }));
  }

  // 按主机名找预设（迁移 / 导入时补图标、模型和能力标签）。只认主机，不看路径。
  function matchHost(host) {
    const wanted = text(host).toLowerCase();
    // 本机地址（localhost、回环、IP 字面量）对应很多不同的本地服务，不能按主机认。
    if (!wanted || wanted === 'localhost' || /^[\d.]+$/.test(wanted) || wanted.includes(':')) return null;
    const found = presets().find(preset => hostOf(preset.baseUrl) === wanted);
    if (!found) return null;
    const caps = {};
    for (const model of found.models) if (model.caps) caps[model.model] = { ...model.caps };
    return { preset: found.id, name: found.name, protocol: found.protocol, caps };
  }

  // ---- 地址识别 ----
  // 输入可以带 /chat/completions、/responses、/messages、/models 这类末段：整理成基础地址并据此判断协议。
  const ENDPOINT_TAILS = [
    [/\/v1\/chat\/completions$/i, '/v1', 'chat'], [/\/chat\/completions$/i, '', 'chat'],
    [/\/v1\/responses$/i, '/v1', 'responses'], [/\/responses$/i, '', 'responses'],
    [/\/v1\/messages$/i, '/v1', 'anthropic'], [/\/messages$/i, '', 'anthropic'],
    [/\/v1\/completions$/i, '/v1', 'chat'], [/\/models$/i, '', '']
  ];
  function normalizeAddress(input) {
    let value = text(input).trim();
    if (!value) return { ok: false, reason: 'empty' };
    if (/[\u0000- \u007f]/.test(value)) return { ok: false, reason: 'invalid' };
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
    let url;
    try { url = new URL(value); } catch (_) { return { ok: false, reason: 'invalid' }; }
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname) return { ok: false, reason: 'scheme' };
    if (url.username || url.password) return { ok: false, reason: 'credentials' };
    let path = url.pathname.replace(/\/+$/, ''), protocol = '', source = '';
    for (const [pattern, keep, wire] of ENDPOINT_TAILS) {
      if (pattern.test(path)) { path = path.replace(pattern, keep); protocol = wire; source = wire ? 'path' : ''; break; }
    }
    if (!protocol) {
      if (url.hostname.toLowerCase() === 'api.anthropic.com') { protocol = 'anthropic'; source = 'host'; }
      else if (/(^|\/)anthropic(\/|$)/i.test(path)) { protocol = 'anthropic'; source = 'path'; }
    }
    // 常见的忘写 /v1：官方 OpenAI 风格主机只给了域名时补上。
    const bare = path === '';
    const host = url.hostname.toLowerCase();
    const known = matchHost(host);
    if (!protocol && known && bare === false) { protocol = known.protocol; source = 'preset'; }
    const base = `${url.protocol}//${url.host.toLowerCase()}${path}`;
    const insecure = url.protocol === 'http:' && !/^(localhost|127\.|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(host);
    return { ok: true, base, host, protocol: protocol || 'auto', source, changed: base !== text(input).trim().replace(/\/+$/, ''), insecure, preset: known ? known.preset : '' };
  }

  return Object.freeze({ CATEGORIES, ACCOUNTS, presets, get, rows, counts, versions, versionLabel, matchHost, normalizeAddress, hostOf });
}));
