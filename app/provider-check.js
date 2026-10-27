/* Connection check: asks a provider for its model list. It never sends a chat request, so it cannot spend quota. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProviderCheck = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const TIMEOUT_MS = 15000;
  const text = value => String(value == null ? '' : value);

  function modelsRequest(base, protocol, token) {
    const wire = protocol === 'anthropic' ? 'anthropic' : 'openai';
    const url = new URL(text(base).trim());
    if (wire === 'anthropic') {
      let path = url.pathname.replace(/\/+$/, '').replace(/\/messages$/, '');
      if (!/\/v1$/.test(path)) path += '/v1';
      url.pathname = `${path}/models`; url.search = '?limit=1000';
      return { url: url.toString(), headers: token ? { 'x-api-key': token, 'anthropic-version': '2023-06-01' } : {} };
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`; url.search = '';
    return { url: url.toString(), headers: token ? { Authorization: `Bearer ${token}` } : {} };
  }

  // request(url, headers, signal) → fetch-like Response。结果里没有 Key，也不带服务返回的原文。
  async function run({ base, protocol = 'auto', token = '', request, timeoutMs = TIMEOUT_MS } = {}) {
    if (!text(base).trim()) return { ok: false, state: 'invalid', message: '请填写 API 地址。' };
    let req;
    try { req = modelsRequest(base, protocol, text(token).trim()); } catch (_) { return { ok: false, state: 'invalid', message: 'API 地址无效。' }; }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await request(req.url, req.headers, controller.signal);
      const data = await response.json().catch(() => null);
      if (response.status === 401 || response.status === 403) return { ok: false, state: 'auth', status: response.status, message: '鉴权失败，请检查 API Key。' };
      if (response.status === 404 || response.status === 405) return { ok: true, state: 'reachable', status: response.status, models: [], message: '地址可达，服务没有提供模型列表；请手动填写模型名。' };
      if (!response.ok) return { ok: false, state: 'error', status: response.status, message: `服务返回 HTTP ${response.status}。` };
      const rows = Array.isArray(data && data.data) ? data.data : Array.isArray(data && data.models) ? data.models : null;
      if (!rows) return { ok: false, state: 'error', status: response.status, message: '服务没有返回有效的模型列表。' };
      const models = [...new Set(rows.map(item => typeof item === 'string' ? item : (item && (item.id || item.name)) || '').map(id => text(id).trim().replace(/^models\//, '')).filter(Boolean))];
      return { ok: true, state: 'ok', status: response.status, models, message: models.length ? `已读取模型列表，共 ${models.length} 个。` : '连接成功，服务没有返回模型。' };
    } catch (error) {
      return { ok: false, state: error && error.name === 'AbortError' ? 'timeout' : 'unreachable', message: error && error.name === 'AbortError' ? '连接超时（15 秒），请检查地址和网络。' : '无法连接到这个地址。' };
    } finally { clearTimeout(timer); }
  }

  // 协议探测：往两条端点各发一个故意无效的请求（空模型名、不生成任何内容），只看服务认不认这条路径。
  // 404/405/501，或 400/503 并带“没有可用端点/路由”说明，才算不支持；其余（400/401/403/422/429 等）说明端点存在。
  const NO_ROUTE = /(no enabled endpoints|routing filters|no available (endpoint|route|upstream)|endpoint[^.]{0,24}(not|un)available|unknown (endpoint|route|protocol)|unsupported (endpoint|protocol|path)|no such (endpoint|route)|not implemented)/i;
  const WIRES = { responses: { path: 'responses', body: { model: '', input: '', stream: false } }, chat: { path: 'chat/completions', body: { model: '', messages: [], stream: false } } };
  async function probeWire(base, wire, token, request, timeoutMs) {
    const url = new URL(text(base).trim());
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${WIRES[wire].path}`; url.search = '';
    const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await request(url.toString(), headers, controller.signal, { method: 'POST', body: JSON.stringify(WIRES[wire].body) });
      const status = response.status, body = status === 400 || status === 503 ? text(await response.text().catch(() => '')).slice(0, 600) : '';
      if (status === 404 || status === 405 || status === 501) return false;
      if ((status === 400 || status === 503) && NO_ROUTE.test(body)) return false;
      return status >= 500 ? null : true;
    } catch (_) { return null; } finally { clearTimeout(timer); }
  }
  // 返回 { responses, chat }：true 支持，false 不支持，null 无法判断。
  async function probeProtocols({ base, token = '', request, timeoutMs = TIMEOUT_MS } = {}) {
    const [responses, chat] = await Promise.all(['responses', 'chat'].map(wire => probeWire(base, wire, text(token).trim(), request, timeoutMs).catch(() => null)));
    return { responses, chat };
  }
  // 配置的协议不被支持、另一种被支持时，返回建议的协议；否则 ''。
  function suggestProtocol(configured, support) {
    if (!support) return '';
    if (configured === 'responses' && support.responses === false && support.chat === true) return 'chat';
    if (configured === 'chat' && support.chat === false && support.responses === true) return 'responses';
    return '';
  }

  return Object.freeze({ run, modelsRequest, probeProtocols, suggestProtocol, TIMEOUT_MS });
}));
