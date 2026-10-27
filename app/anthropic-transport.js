/* Anthropic Messages API transport: request building, SSE projection, cancel and thinking effort. Keys are passed per request and never stored here. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AnthropicTransport = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';
  const Frames = root.SSEFrameScanner || (typeof require === 'function' ? require('./sse-frame-scanner.js') : null);
  const Reception = root.StreamReception || (typeof require === 'function' ? require('./stream-reception.js') : null);
  const Connections = () => root.Connections || (typeof require === 'function' ? require('./connections.js') : null);
  const VERSION = '2023-06-01', DEFAULT_MAX_TOKENS = 16384, MAX_STREAM = 16 * 1024 * 1024, MIN_BUDGET = 1024;
  const fail = (code, message) => Object.assign(new Error(message), { code });
  const cancelled = () => fail('CANCELLED', '已停止本次执行');
  const invalid = () => fail('INVALID_RESPONSE', 'Anthropic 返回了无法识别的事件，本次未确认完成。');

  // base 可以是 https://api.anthropic.com、…/v1 或已带 /messages；统一补成 …/v1/messages。
  function endpoint(base) {
    const url = new URL(String(base || '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fail('INVALID_BASE', 'API 地址必须是不含账号密码的 http(s) 地址。');
    let path = url.pathname.replace(/\/+$/, '').replace(/\/messages$/, '');
    if (!/\/v1$/.test(path)) path += '/v1';
    url.pathname = path + '/messages'; url.hash = ''; url.search = '';
    return url.toString();
  }

  const textOf = part => (['input_text', 'output_text', 'text'].includes(part?.type) && typeof part.text === 'string') ? part.text : null;
  function imageBlock(part) {
    const value = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
    if (typeof value !== 'string') throw fail('PROTOCOL_UNSUPPORTED', '图片内容无法转换为 Anthropic 格式。');
    const data = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
    if (data) return { type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } };
    if (/^https:\/\//.test(value)) return { type: 'image', source: { type: 'url', url: value } };
    throw fail('PROTOCOL_UNSUPPORTED', '图片只支持 PNG/JPEG/GIF/WebP 内嵌数据或 https 地址。');
  }

  // Responses 风格的 input → { system, messages }。无法无损转换的内容显式失败，不静默丢弃附件。
  function convertInput(input) {
    const list = typeof input === 'string' ? [{ role: 'user', content: [{ type: 'input_text', text: input }] }] : Array.isArray(input) ? input : [];
    const system = [], messages = [];
    for (const item of list) {
      const parts = typeof item?.content === 'string' ? [{ type: 'input_text', text: item.content }] : Array.isArray(item?.content) ? item.content : [];
      if (item?.role === 'system' || item?.role === 'developer') {
        for (const part of parts) { const text = textOf(part); if (text && text.trim()) system.push(text); }
        continue;
      }
      const role = item?.role === 'assistant' ? 'assistant' : 'user', blocks = [];
      for (const part of parts) {
        const text = textOf(part);
        if (text !== null) { if (text.trim()) blocks.push({ type: 'text', text }); }
        else if (part?.type === 'input_image' && role === 'user') blocks.push(imageBlock(part));
        else if (part?.type === 'input_file') throw fail('PROTOCOL_UNSUPPORTED', '当前接口协议（Anthropic Messages）不支持以文件形式发送附件。请改用支持 Responses API 的服务，或移除该附件后重试。');
        else throw fail('PROTOCOL_UNSUPPORTED', 'Anthropic 连接只支持文本和图片消息，不能忽略未识别的内容。');
      }
      if (!blocks.length) continue;
      const last = messages[messages.length - 1];
      if (last && last.role === role) last.content.push(...blocks); else messages.push({ role, content: blocks });
    }
    if (!messages.length) throw fail('INPUT_EMPTY', '没有可发送的内容。');
    if (messages[0].role !== 'user') messages.unshift({ role: 'user', content: [{ type: 'text', text: '（以下为此前的对话）' }] });
    return { system: system.join('\n\n'), messages };
  }

  // 强度 → thinking。none/空/auto 不发 thinking 字段（由服务默认决定）；档位按预算映射，预算须小于 max_tokens。
  function thinkingFor(effort, maxTokens) {
    if (!effort || effort === 'auto' || effort === 'none') return { thinking: null, maxTokens };
    const budget = Connections()?.anthropicBudget(effort);
    if (!budget) throw fail('EFFORT_UNSUPPORTED', `Anthropic 连接不支持思考强度“${effort}”。`);
    return { thinking: { type: 'enabled', budget_tokens: Math.max(MIN_BUDGET, budget) }, maxTokens: Math.max(maxTokens, budget + 4096) };
  }

  function buildRequest({ model, input, effort = '', maxTokens = DEFAULT_MAX_TOKENS, nativeTools = null, webSearch = false }) {
    if (typeof model !== 'string' || !model.trim()) throw fail('MODEL_REQUIRED', '请先选择模型。');
    if (webSearch !== false) throw fail('WEB_SEARCH_UNSUPPORTED', '当前接口协议（Anthropic Messages）不支持内置网页搜索。请关闭网页搜索；AI Bro 自身的资料与网页读取工具仍可使用。');
    if (Array.isArray(nativeTools) && nativeTools.length) throw fail('PROTOCOL_UNSUPPORTED', 'Anthropic Messages 连接暂不支持原生工具调用，请在连接设置里把工具协议改回“文本”。');
    const { system, messages } = convertInput(input), plan = thinkingFor(effort, maxTokens);
    const body = { model: model.trim(), max_tokens: plan.maxTokens, stream: true, messages };
    if (system) body.system = system;
    if (plan.thinking) body.thinking = plan.thinking;
    return body;
  }

  // GET /v1/models，用于“测试连接”读取模型列表。
  function modelsEndpoint(base) { return endpoint(base).replace(/\/messages$/, '/models') + '?limit=1000'; }
  function headers(token) {
    return { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Anthropic-Version': VERSION, ...(token ? { 'X-Api-Key': token } : {}) };
  }

  const count = value => (typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value)) && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;

  async function request(options, { protocolError, inspectProtocolOutput, errorFrom } = {}) {
    const { base, model, effort = '', token, input, webSearch = false, nativeTools = null, maxTokens, signal, onDelta, onPhase, onActivity, onAttempt, onUsage, onReception } = options;
    if (signal?.aborted) throw cancelled();
    const body = buildRequest({ model, input, effort, maxTokens, nativeTools, webSearch });
    const url = `/__proxy?url=${encodeURIComponent(endpoint(base))}`;
    if (!Frames?.create) throw fail('INVALID_RESPONSE', '本机流式响应组件未加载，请重新打开应用。');
    const attemptId = `anthropic:${root.crypto?.randomUUID ? root.crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)}`;
    const controller = new AbortController(), reception = typeof onReception === 'function' ? Reception?.createEmitter(onReception) : null;
    let reader, readerDone = false, outcome = 'failed', rejectAbort, output = '', completed = false, streamBytes = 0, thinking = null, activityIndex = 0;
    let inputTokens = null, outputTokens = null, cacheRead = null, stopReason = '', httpStatus = null;
    const interrupted = new Promise((_, reject) => { rejectAbort = reject; }); interrupted.catch(() => {});
    const check = () => { if (controller.signal.aborted) throw cancelled(); };
    const abort = () => { controller.abort(); rejectAbort(cancelled()); };
    const wait = value => Promise.race([value, interrupted]);
    const settleThinking = status => { if (!thinking) return; const item = { ...thinking, status }; thinking = null; onActivity?.(item); check(); };
    const observeUsage = () => {
      if (inputTokens === null && outputTokens === null) return;
      const total = inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;
      onUsage?.({ input: inputTokens, output: outputTokens, total }, { attemptId, totalSource: total === null ? null : 'components', cacheRead });
    };
    const readInputUsage = usage => {
      if (!usage || typeof usage !== 'object') return;
      const cached = count(usage.cache_read_input_tokens); if (cached !== null) cacheRead = cached;
      const parts = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens].map(count).filter(value => value !== null);
      if (parts.length) inputTokens = parts.reduce((sum, value) => sum + value, 0);
      const out = count(usage.output_tokens); if (out !== null) outputTokens = out;
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) abort(); check();
      onAttempt?.({ id: attemptId, status: 'running' }); reception?.start(); onPhase?.('waiting'); check();
      const response = await wait(root.fetch(url, { method: 'POST', signal: controller.signal, headers: headers(token), body: JSON.stringify(body) })); httpStatus = response.status; check();
      if (!response.ok) {
        let text = '';
        try { text = await wait(response.text()); } catch (error) { if (controller.signal.aborted) throw error; }
        throw errorFrom ? errorFrom(response, text) : fail('HTTP', `Anthropic 请求未成功（HTTP ${response.status}）。`);
      }
      if (!response.body) throw invalid();
      reader = response.body.getReader(); const decoder = new TextDecoder();
      const dispatch = raw => {
        check();
        const lines = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, ''));
        if (!lines.length) return;
        let event; try { event = JSON.parse(lines.join('\n')); } catch (_) { return; }
        if (!event || typeof event !== 'object' || Array.isArray(event)) return;
        switch (event.type) {
          case 'message_start': readInputUsage(event.message?.usage); observeUsage(); break;
          case 'content_block_start':
            if (event.content_block?.type === 'thinking' || event.content_block?.type === 'redacted_thinking') {
              if (!thinking) {
                thinking = { id: `commentary:${attemptId}:${++activityIndex}`, attemptId, kind: 'commentary', source: 'transport', name: '模型状态', text: '正在思考', status: 'running' };
                onActivity?.({ ...thinking }); reception?.content('commentary'); onPhase?.('reasoning', '正在思考'); check();
              }
            } else if (event.content_block && !['text', 'thinking', 'redacted_thinking'].includes(event.content_block.type)) {
              // 请求里没有声明任何工具；服务端自行产生的工具块不在本连接的能力内。
              throw fail('MODEL_PROTOCOL_ERROR', '模型返回了当前连接未接入的工具调用，尚未执行，也没有得到最终答复。');
            }
            break;
          case 'content_block_delta': {
            const delta = event.delta || {};
            if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
              output += delta.text;
              const error = protocolError?.(output, { final: false }); if (error) throw error;
              if (inspectProtocolOutput?.(output, { final: false })?.kind === 'pending') break;
              settleThinking('completed'); reception?.content('output'); onPhase?.('output'); check();
              onDelta?.(output, delta.text, { attemptId }); check();
            }
            break;
          }
          case 'content_block_stop': settleThinking('completed'); break;
          case 'message_delta': readInputUsage(event.usage); if (typeof event.delta?.stop_reason === 'string') stopReason = event.delta.stop_reason; observeUsage(); break;
          case 'message_stop': completed = true; break;
          case 'error': {
            const kind = event.error?.type;
            throw errorFrom ? errorFrom({ status: kind === 'overloaded_error' ? 529 : kind === 'rate_limit_error' ? 429 : kind === 'invalid_request_error' ? 400 : 500, headers: { get: () => '' } }, JSON.stringify(event))
              : fail('HTTP', 'Anthropic 流式响应返回错误。');
          }
          default: break; // ping 等事件
        }
      };
      const frames = Frames.create({ onFrame: dispatch });
      while (true) {
        const chunk = await wait(reader.read()); check();
        if (chunk.done) { readerDone = true; frames.push(decoder.decode()); break; }
        streamBytes += chunk.value.byteLength; if (streamBytes > MAX_STREAM) throw fail('STREAM_ERROR', 'Anthropic 输出超过本地限制，本次未确认完成。');
        frames.push(decoder.decode(chunk.value, { stream: true }));
        if (completed) break;
      }
      if (!completed) frames.finish();
      check();
      if (!completed) throw fail('STREAM_INCOMPLETE', '连接已结束，但未收到 Anthropic 的明确完成事件。本次结果可能不完整，未执行任何操作。');
      if (stopReason === 'max_tokens') throw fail('OUTPUT_LIMIT', '模型输出达到长度上限被截断，本次未确认完成。请缩小任务范围后重试。');
      if (stopReason === 'refusal') throw fail('MODEL_REFUSED', '模型拒绝了这次请求，本次未得到答复。');
      const error = protocolError?.(output); if (error) throw error;
      if (!output.trim()) throw fail('EMPTY_RESPONSE', '模型未返回内容，请检查账号和模型后重试。');
      settleThinking('completed'); outcome = 'completed'; return output;
    } catch (error) {
      outcome = controller.signal.aborted || error?.code === 'CANCELLED' || error?.name === 'AbortError' ? 'cancelled' : 'failed';
      try { settleThinking(outcome); } catch (_) {}
      const failure = outcome === 'cancelled' ? cancelled() : error;
      failure.attemptId = attemptId; failure.receivedContent = output.length > 0; failure.requestProtocol = 'anthropic';
      throw failure;
    } finally {
      signal?.removeEventListener('abort', abort); controller.abort();
      if (reader) {
        if (!readerDone) { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch (_) {} }
        try { reader.releaseLock(); } catch (_) {}
      }
      reception?.finish(outcome); onAttempt?.({ id: attemptId, status: outcome, ...(httpStatus ? { httpStatus } : {}) });
    }
  }
  return Object.freeze({ VERSION, endpoint, modelsEndpoint, convertInput, thinkingFor, buildRequest, headers, request });
});
