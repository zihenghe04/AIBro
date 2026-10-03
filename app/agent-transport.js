(function (root) {
  'use strict';
  const Core = root.WorkstationCore;
  const SSEFrames = root.SSEFrameScanner || (typeof require === 'function' ? require('./sse-frame-scanner.js') : null);
  const Reception = root.StreamReception || (typeof require === 'function' ? require('./stream-reception.js') : null);
  const activitySession = typeof root.crypto?.randomUUID === 'function' ? root.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  let activityRequestSequence = 0;
  const nextActivityNamespace = () => `${activitySession}:${(++activityRequestSequence).toString(36)}`;
  const messageText = item => (Array.isArray(item?.content) ? item.content : []).filter(part => ['output_text', 'text'].includes(part?.type) && typeof part.text === 'string').map(part => part.text).join('');
  const jsonText = data => data?.output_text || data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || (Array.isArray(data?.output) ? data.output : []).filter(item => item?.type === 'message' && item.phase !== 'commentary').map(messageText).join('') || '';
  const toolLabels = Object.freeze({ web_search_call: '网页搜索', file_search_call: '资料检索', code_interpreter_call: '代码执行', mcp_call: 'MCP 工具', function_call: '函数调用', custom_tool_call: '自定义工具', computer_call: '计算机操作', shell_call: '命令执行', local_shell_call: '命令执行', image_generation_call: '图像生成', apply_patch_call: '文件修改' });
  // These output items are requests to the host, not receipts of side effects.
  // AI Bro executes its own reviewed JSON protocol; no CUA or raw patch host is wired here.
  const hostCalls = new Set(['function_call', 'custom_tool_call', 'computer_call', 'local_shell_call', 'apply_patch_call']);
  // This host accepts reviewed knowledgeRequests/actions JSON. DSML emitted in
  // content is a provider protocol leak, never an instruction to execute. Keep
  // examples inside JSON strings, Markdown code and quotations as ordinary data.
  // Match the doubled full-width separators seen from compatible gateways too.
  const inspectProtocolOutput = (value, { final = true } = {}) => {
    if (typeof value !== 'string' || !/<\s*\/?\s*[|｜]/.test(value)) return null;
    let fence = null, quoted = false, escaped = false;
    const lines = value.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const marker = !quoted && /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
        continue;
      }
      if (fence || (!quoted && /^\s*>/.test(line))) continue;
      if (!quoted && /^\s*<\s*\/?\s*[|｜]+\s*DSML(?:\s*[|｜]|\s*$)/i.test(line)) return { kind: 'dsml', incomplete: !/>/.test(line) };
      // Hold a split opening token until it is distinguishable from normal
      // text. A truncated bare prefix cannot become a successful final reply.
      if (!quoted && index === lines.length - 1 && /^\s*<\s*\/?\s*[|｜]+\s*(?:D(?:S(?:M(?:L)?)?)?)?\s*$/i.test(line)) {
        return { kind: final ? 'dsml' : 'pending', incomplete: true };
      }
      // Track JSON strings across chunks. A marker in a valid message value is
      // source text, not a second wire protocol. Escapes must not end strings.
      for (let offset = 0; offset < line.length; offset += 1) {
        const char = line[offset];
        if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
        else if (char === '"' && /^\s*[\[{]/.test(value)) quoted = true;
      }
    }
    return null;
  };
  const protocolError = (value, options) => {
    const issue = inspectProtocolOutput(value, options);
    if (!issue || issue.kind === 'pending') return null;
    const error = new Error('模型返回了未接入的 DSML 工具协议，尚未执行这些调用，也没有得到最终答复。请按 AI Bro 的 knowledgeRequests JSON 协议重试。');
    error.code = 'MODEL_PROTOCOL_ERROR'; error.protocolKind = issue.kind; error.recoverable = true;
    return error;
  };
  const nativeProtocolError = () => Object.assign(new Error('模型返回了当前连接未接入的原生工具调用，尚未执行这些调用。请按 AI Bro 的 knowledgeRequests JSON 协议重试。'), { code: 'MODEL_PROTOCOL_ERROR', protocolKind: 'native_tool_call', recoverable: true });
  // PKU MaaS documents thinking.type as its canonical DeepSeek switch. Keep
  // automatic effort upstream-owned and do not guess other gateways' contracts.
  const isPkuDeepSeek = (base, model) => {
    if (typeof model !== 'string' || !/^deepseek(?:-|$)/i.test(model)) return false;
    let url; try { url = new URL(base); } catch (_) { return false; }
    return url.protocol === 'https:' && url.hostname === 'chat.pku.edu.cn' && !url.port && !url.username && !url.password;
  };
  const pkuDeepSeekThinking = (base, model, effort) => {
    if (!isPkuDeepSeek(base, model) || typeof effort !== 'string' || !effort || effort === 'auto') return null;
    return { type: effort === 'none' || effort === 'off' ? 'disabled' : 'enabled' };
  };
  // The Auto preference must not pass originals or unknown fields through a
  // converter that cannot represent them. Validate against its exact vocabulary.
  const chatCompatibleInput = input => typeof input === 'string' || Array.isArray(input) && input.length > 0 && Array.from(input).every(item =>
    item && typeof item === 'object' && !Array.isArray(item) && ['developer', 'system', 'assistant', 'user'].includes(item.role)
    && Object.keys(item).every(key => ['role', 'content'].includes(key)) && Array.isArray(item.content) && item.content.length > 0
    && Array.from(item.content).every(part => part && typeof part === 'object' && !Array.isArray(part) && (
      part.type === 'input_text' && typeof part.text === 'string' && Object.keys(part).every(key => ['type', 'text'].includes(key))
      || part.type === 'input_image' && typeof part.image_url === 'string' && part.image_url.length > 0
        && (part.detail === undefined || ['auto', 'low', 'high'].includes(part.detail))
        && Object.keys(part).every(key => ['type', 'image_url', 'detail'].includes(key))
    )));
  const toolName = (value, fallback) => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_.:-]{0,79}$/.test(value) ? value : fallback;
  const contextOverflow = (failure, message = '') => {
    const code = typeof failure === 'object' ? failure?.code || failure?.type : '';
    return ['context_length_exceeded', 'context_window_exceeded', 'prompt_too_long', 'input_too_long'].includes(code)
      || /maximum context length|(?:context (?:window|length|size)|max(?:imum)? input tokens)[\s\S]{0,100}(?:exceed|too (?:long|large)|limit)|(?:exceed|too (?:long|large))[\s\S]{0,80}(?:context (?:window|length|size))|prompt is too long/i.test(message);
  };
  const containsGeneration = data => {
    const value = data?.response || data;
    return !!value?.output_text || (Array.isArray(value?.output) && value.output.some(item => item?.type === 'message' ? !!messageText(item) : item?.type === 'reasoning' ? Array.isArray(item.summary) && item.summary.some(part => !!part.text) : true))
      || (Array.isArray(value?.choices) && value.choices.some(choice => !!(choice.text || choice.message?.content || choice.message?.tool_calls || choice.delta?.content || choice.delta?.reasoning_content || choice.delta?.reasoning || choice.delta?.tool_calls || choice.delta?.function_call)));
  };
  const generationError = (data, type = '', phase = 'stream') => {
    const value = data?.response || data || {}, failure = value.error || data?.error;
    const status = value.status || data?.status;
    if (!failure && !['error','response.failed','response.incomplete'].includes(type) && !['failed','incomplete','cancelled','canceled','in_progress','queued'].includes(status)) return null;
    // A progress event is expected during SSE; only terminal/error envelopes
    // and non-stream responses use the incomplete-status check.
    if (type && !['error','response.failed','response.incomplete','response.completed','response.done'].includes(type) && !failure) return null;
    const detail = typeof failure === 'string' ? failure : failure?.message || data?.message;
    const error = new Error(typeof detail === 'string' && detail ? detail : '模型响应未完成或已失败，本次未执行操作。请重试。');
    error.code = contextOverflow(failure, detail) ? 'CONTEXT_LENGTH_EXCEEDED' : 'STREAM_ERROR';
    error.diagnostic = error.code === 'CONTEXT_LENGTH_EXCEEDED'
      ? root.RunFailureDiagnostics?.receipt(error.code, { phase })
      : root.RunFailureDiagnostics?.fromStream(failure, value.incomplete_details?.reason);
    if (error.diagnostic) { error.diagnostic.phase = phase; error.message = root.RunFailureDiagnostics.present(error.diagnostic).description; }
    return error;
  };
  const errorFrom = (response, body) => {
    let message = '', failure, hasGeneration = false;
    try { const data = JSON.parse(body); failure = data.error || data; message = data.error?.message || data.message || ''; hasGeneration = containsGeneration(data); } catch (_) {}
  if (!message && response.status === 404) message = '接口不存在（404）。请确认 API 地址（例如 https://api.deepseek.com 或 .../v1）；若地址正确，可在连接设置中切换接口协议（Responses API / Chat Completions）后重试。';
  if (!message && response.status === 400) message = '请求格式被服务拒绝（400）。请确认模型名称，并在连接设置中检查接口协议是否与该服务匹配。';
  const error = new Error(message || body.slice(0, 400) || `HTTP ${response.status}`); error.code = [400, 413, 422].includes(response.status) && contextOverflow(failure, message) ? 'CONTEXT_LENGTH_EXCEEDED' : 'HTTP'; error.status = response.status; error.contextHasGeneration = hasGeneration;
  error.protocolMismatch = looksLikeProtocolMismatch(response.status, message) && !hasGeneration
    && !['model_not_found', 'insufficient_quota', 'rate_limit_exceeded'].includes(failure?.code)
    && !/(?:model[^.]{0,80}(?:does not exist|not found|not available))/i.test(message);
  error.diagnostic = root.RunFailureDiagnostics?.fromHttp(response.status, failure, { context: error.code === 'CONTEXT_LENGTH_EXCEEDED', protocolMismatch: error.protocolMismatch });
  // Provider error bodies can echo credentials or input. Only fixed guidance
  // and whitelisted evidence are allowed into persisted conversation errors.
  if (error.diagnostic) error.message = root.RunFailureDiagnostics.present(error.diagnostic).description;
  return error;
  };
  // 接口协议：Responses API 与 Chat Completions。默认保持 Responses（不因地址陌生
  // 就改写既有网关用户的行为——他们可能正依赖 Responses 的附件与网页搜索）；只有
  // 已知只提供 /chat/completions 的服务（DeepSeek、Moonshot、本地推理等）才自动
  // 切到 Chat，从而开箱可用。用户在连接设置中的显式选择优先于一切自动判定；设置页
  // 的“测试连接”会探测端点并把结果写回选择框。
  const CHAT_FIRST_HOSTS = ['deepseek.com', 'moonshot.cn', 'siliconflow.cn', 'dashscope.aliyuncs.com', 'open.bigmodel.cn', 'api.groq.com', 'api.together.xyz', 'openrouter.ai', 'api.perplexity.ai', 'api.mistral.ai', 'api.stepfun.com', 'api.minimax.chat', 'api.minimaxi.com'];
  const localHost = host => host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' || host === '[::1]' || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  // 某些服务只实现了一种协议：请求打到另一种时以 404/405/501，或以 503/400 附带
  // “没有可服务该请求的端点/路由”说明的方式拒绝（例如企业 MaaS 网关只配置了
  // Chat Completions 的端点）。这类失败与请求内容无关，可据此改用另一协议重试一次。
  const PROTOCOL_MISMATCH_HINT = /(no enabled endpoints|routing filters|no available (endpoint|route|upstream)|endpoint[^.]{0,24}(not|un)available|unknown (endpoint|route|protocol)|unsupported (endpoint|protocol|path)|no such (endpoint|route)|not implemented)/i;
  const looksLikeProtocolMismatch = (status, message) => {
    if (status === 404 || status === 405 || status === 501) return true;
    return [400, 503].includes(status) && typeof message === 'string' && PROTOCOL_MISMATCH_HINT.test(message);
  };
  // 回退成功后记住该来源，后续请求直接使用正确协议（避免每次先失败一轮）。
  // 键为来源 hostname，仅在同一次运行内有效；宿主可通过 configure 注入持久化记录。
  const learnedProtocols = new Map();
  let protocolLearned = null;
  const sourceOf = base => { try { return new URL(String(base || '').trim()).hostname.toLowerCase(); } catch (_) { return ''; } };
  const protocolOf = (provider, base, preferred) => {
    if (provider === 'openai-auth') return 'responses';
    if (preferred === 'responses' || preferred === 'chat') return preferred;
    const learned = learnedProtocols.get(sourceOf(base));
    if (learned === 'responses' || learned === 'chat') return learned;
    try {
      const host = new URL(String(base || '').trim()).hostname.toLowerCase();
      if (CHAT_FIRST_HOSTS.some(domain => host === domain || host.endsWith('.' + domain))) return 'chat';
      if (localHost(host)) return 'chat';
      return 'responses';
    } catch (_) { return 'responses'; }
  };
  // 宿主（设置页）注入的协议偏好。保持模块本身无环境依赖：读不到配置时按域名自动判定。
  let protocolPreference = '';
  const configure = options => {
    if (options && (typeof options.protocol === 'string' || typeof options.protocol === 'function')) protocolPreference = options.protocol;
    if (options && typeof options.onProtocolLearned === 'function') protocolLearned = options.onProtocolLearned;
    if (options && options.learnedProtocols && typeof options.learnedProtocols === 'object') for (const [origin, value] of Object.entries(options.learnedProtocols)) {
      if ((value === 'chat' || value === 'responses') && typeof origin === 'string' && origin) learnedProtocols.set(origin.toLowerCase(), value);
    }
  };
  const preferredProtocol = explicit => {
    if (explicit !== undefined) return explicit;
    return typeof protocolPreference === 'function' ? protocolPreference() : protocolPreference;
  };
  // Responses 风格的 input → Chat Completions 的 messages。附件块里无法无损转换的
  // 类型必须显式失败，不能静默丢弃用户附件。
  function chatMessages(input) {
    const list = typeof input === 'string' ? [{ role: 'user', content: [{ type: 'input_text', text: input }] }] : Array.isArray(input) ? input : [];
    return list.map(item => {
      const role = item?.role === 'developer' || item?.role === 'system' ? 'system' : item?.role === 'assistant' ? 'assistant' : 'user';
      const parts = Array.isArray(item?.content) ? item.content : [];
      const converted = [];
      for (const part of parts) {
        if (part?.type === 'input_text' && typeof part.text === 'string') converted.push({ type: 'text', text: part.text });
        else if (part?.type === 'input_image' && typeof part.image_url === 'string') converted.push({ type: 'image_url', image_url: { url: part.image_url, ...(part.detail ? { detail: part.detail } : {}) } });
        else if (part?.type === 'input_file') { const error = new Error('当前接口协议（Chat Completions）不支持以文件形式发送附件。请改用支持 Responses API 的服务，或移除该附件后重试。'); error.code = 'PROTOCOL_UNSUPPORTED'; throw error; }
      }
      const textOnly = converted.length > 0 && converted.every(part => part.type === 'text');
      return { role, content: textOnly ? converted.map(part => part.text).join('\n') : converted };
    });
  }
  async function requestPlan(options) {
    try { return await requestOnce(options); }
    catch (error) {
      if (error?.code !== 'CONTEXT_LENGTH_EXCEEDED' || !error.contextRecoveryAllowed || typeof options.recoverInput !== 'function' || options.signal?.aborted) throw error;
      // The owner knows which derived history can be reduced. Never guess by
      // slicing a prompt: instructions, current corrections, attachments and
      // host-operation receipts may all share the same text block.
      let cancelRecovery;
      const cancelled = new Promise((_, reject) => {
        cancelRecovery = () => reject(Object.assign(new Error('已停止本次执行'), { code: 'CANCELLED' }));
        options.signal?.addEventListener('abort', cancelRecovery, { once: true });
      });
      let input;
      try { input = await Promise.race([Promise.resolve(options.recoverInput({ input: options.input, error, signal: options.signal })), cancelled]); }
      finally { options.signal?.removeEventListener('abort', cancelRecovery); }
      if (options.signal?.aborted) throw Object.assign(new Error('已停止本次执行'), { code: 'CANCELLED' });
      if (!input || JSON.stringify(input).length >= JSON.stringify(options.input).length) throw error;
      options.onActivity?.({ id: `commentary:${nextActivityNamespace()}:context-recovery`, source: 'transport', ...(error.attemptId ? { attemptId: error.attemptId } : {}), kind: 'commentary', status: 'completed', name: '上下文恢复', text: '服务报告上下文过长，已缩减较早对话并重试一次；近期用户要求与已执行记录保留。' });
      // This is one model request, not a replay of the host tool loop. Do not
      // recurse: another overflow terminates, as does any other provider error.
      try { return await requestOnce({ ...options, input, protocol: error.requestProtocol || options.protocol }); }
      catch (retryError) {
        if (retryError?.code === 'CONTEXT_LENGTH_EXCEEDED') {
          retryError.message += '\n已缩减较早对话并重试一次，服务仍报告上下文过长；当前目标、附件和已执行记录未被静默删减。';
          if (retryError.diagnostic) retryError.diagnostic.contextRecoveryAttempted = true;
        }
        throw retryError;
      }
    }
  }
  async function requestOnce({ provider = 'api', base, model, effort = '', token, input, webSearch = false, protocol, requirePlanProtocol = false, onDelta, onPhase, onActivity, onAttempt, onSources, onUsage, onReception, signal }) {
    const controller = new AbortController();
    const reception = typeof onReception === 'function' ? Reception?.createEmitter(onReception) : null;
    let receptionOutcome = 'failed';
    let attemptId = null, attemptSettled = true;
    const finishAttempt = status => {
      if (!attemptId || attemptSettled) return;
      attemptSettled = true;
      onAttempt?.({ id: attemptId, status });
    };
    const publishDelta = (output, delta) => onDelta?.(output, delta, { attemptId });
    let reader, readerDone = false, rejectOnAbort, receivedContent = false, usedProtocol, pendingNativeToolCall = false;
    const interruptionError = () => { const error = new Error('已停止本次执行'); error.code = 'CANCELLED'; return error; };
    const cancel = () => controller.abort();
    const interrupted = new Promise((_, reject) => {
      rejectOnAbort = () => reject(interruptionError());
      controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
    });
    // Generation has no automatic deadline. Race network awaits with the user
    // signal so a buffered/custom reader cannot keep the stop button waiting.
    const wait = promise => Promise.race([promise, interrupted]);
    const readChunk = async () => {
      const chunk = await wait(reader.read());
      if (chunk.done) readerDone = true;
      return chunk;
    };
    const readText = async response => {
      if (!response.body) return wait(response.text());
      reader = response.body.getReader(); const decoder = new TextDecoder(); let value = '';
      while (true) { const chunk = await readChunk(); if (chunk.done) break; value += decoder.decode(chunk.value, { stream: true }); }
      return value + decoder.decode();
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const activities = new Map(), messagePhases = new Map();
    // A run can call the provider repeatedly after tools. Provider-local IDs
    // (especially Chat's synthetic thinking IDs) must not overwrite prior rounds.
    let activityNamespace;
    const activityKeys = new Map();
    const activityKey = (kind, id) => {
      const local = typeof id === 'string' && id.length > 0 && id.length <= 200 ? id : '_legacy', key = `${kind}:${local}`;
      // Keep the full local identity in the map. The stable ordinal prevents
      // long provider IDs or summary indexes colliding at the UI's 180-char cap.
      if (!activityKeys.has(key)) activityKeys.set(key, `${kind}:${activityNamespace}:${activityKeys.size.toString(36)}:${local.slice(0,64)}`);
      return activityKeys.get(key);
    };
    const sources = new Map();
    const observeSources = values => {
      let changed = false;
      for (const value of (Array.isArray(values) ? values : []).slice(0, 64)) {
        if (!value || typeof value.url !== 'string' || value.url.length > 2048 || /[\u0000-\u001f]/.test(value.url)) continue;
        let url; try { url = new URL(value.url); } catch (_) { continue; }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || sources.size >= 64 && !sources.has(url.href)) continue;
        const source = { url: url.href, title: typeof value.title === 'string' && value.title ? value.title.slice(0, 240) : url.hostname, type: value.type === 'url_citation' ? 'url_citation' : 'web_source' };
        if (source.type === 'url_citation' && Number.isSafeInteger(value.start_index) && Number.isSafeInteger(value.end_index) && value.start_index >= 0 && value.end_index >= value.start_index) { source.start_index = value.start_index; source.end_index = value.end_index; }
        const previous = sources.get(source.url);
        if (previous?.type === 'url_citation' && source.type !== 'url_citation') continue;
        if (JSON.stringify(previous) !== JSON.stringify(source)) { sources.set(source.url, source); changed = true; }
      }
      if (changed) { receivedContent = true; reception?.content('source'); onSources?.([...sources.values()].map(source => ({ ...source }))); }
    };
    const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 160 ? value : '_legacy';
    // 用量只在服务端明确返回时记录（responses 与 chat 两种字段名），缺失就保持为空：
    // 不用本地估算值冒充实测用量。
    const observeUsage = usage => {
      if (!usage || typeof usage !== 'object') return;
      const pick = value => { const number = typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN; return Number.isSafeInteger(number) && number >= 0 ? number : null; };
      const input = pick(usage.input_tokens ?? usage.prompt_tokens), output = pick(usage.output_tokens ?? usage.completion_tokens);
      let total = pick(usage.total_tokens), totalSource = total === null ? null : 'reported';
      // Both APIs define total as input + output. Adding reported components
      // is exact accounting, not a tokenizer estimate; missing remains null.
      if (usage.total_tokens == null && input !== null && output !== null && Number.isSafeInteger(input + output)) { total = input + output; totalSource = 'components'; }
      if (input === null && output === null && total === null) return;
      onUsage?.({ input, output, total }, { attemptId, totalSource });
      if (controller.signal.aborted) throw interruptionError();
    };
    const observeErrorUsage = body => { let data; try { data = JSON.parse(body); } catch (_) { return; } observeUsage((data?.response || data)?.usage); };
    const activity = (kind, id, text, status, name, append = false) => {
      const key = activityKey(kind, id);
      const previous = activities.get(key);
      if (previous && ['completed', 'failed', 'cancelled'].includes(previous.status) && ['pending', 'running'].includes(status)) return;
      if (typeof text !== 'string') return;
      text = (append ? previous?.text || '' : '') + text;
      if (!text && kind !== 'tool') return;
      if (id !== 'protocol-fallback') receivedContent = true;
      const value = { id: key, kind, status, name, text, attemptId, ...(id === 'protocol-fallback' ? { source: 'transport' } : {}) };
      if (previous && previous.text === text && previous.status === status && previous.name === name) return;
      if (id !== 'protocol-fallback') reception?.content(kind);
      activities.set(key, value); onActivity?.({ ...value });
      if (kind !== 'tool') onPhase?.('reasoning', [...activities.values()].filter(item => item.kind !== 'tool').map(item => item.text).join('\n\n').slice(0, 16000));
    };
    // 段级呼吸的“完成”信号：把仍处 running 的段收束为 completed（内容不改写）。
    // chat 协议的明文思考没有 done 事件，由调用方在正文/工具开始时触发收束。
    const settle = (kind, id, status = 'completed') => {
      const key = activityKey(kind, id);
      const previous = activities.get(key);
      if (!previous || previous.status === status) return;
      const value = { ...previous, status };
      reception?.content(kind);
      activities.set(key, value); onActivity?.({ ...value });
    };
    const publicText = (event, text, append = false, status = 'running') => {
      const kind = event.source === 'commentary' ? 'commentary' : 'summary';
      const index = Number.isSafeInteger(event.summary_index) && event.summary_index >= 0 ? event.summary_index : 0;
      activity(kind, `${identifier(event.item_id)}:${index}`, text, status, kind === 'commentary' ? '进度说明' : '公开摘要', append);
    };
    const observeItem = (item, completed = false) => {
      if (!item || typeof item !== 'object') return;
      if (item.type === 'reasoning') {
        (Array.isArray(item.summary) ? item.summary : []).forEach((part, index) => {
          if (part?.type === 'summary_text') publicText({ item_id: item.id, summary_index: index }, part.text, false, completed ? 'completed' : 'running');
        });
      } else if (item.type === 'message') {
        if (item.phase === 'commentary' || item.phase === 'final_answer') messagePhases.set(identifier(item.id), item.phase);
        if (item.phase === 'commentary') publicText({ source: 'commentary', item_id: item.id }, messageText(item), false, completed ? 'completed' : 'running');
        for (const part of Array.isArray(item.content) ? item.content : []) if (part?.type === 'output_text') observeSources((Array.isArray(part.annotations) ? part.annotations : []).filter(annotation => annotation?.type === 'url_citation'));
      } else if (Object.hasOwn(toolLabels, item.type)) {
        const pending = hostCalls.has(item.type);
        if (pending && requirePlanProtocol) pendingNativeToolCall = true;
        const status = ['failed', 'error'].includes(item.status) || item.error ? 'failed' : ['cancelled', 'canceled', 'incomplete'].includes(item.status) ? 'cancelled' : pending ? 'pending' : completed || item.status === 'completed' ? 'completed' : 'running';
        const id = item.id || item.call_id;
        const previous = activities.get(activityKey('tool', identifier(id)));
        activity('tool', id, pending ? '工具调用已提出；当前连接未执行此宿主操作' : toolLabels[item.type], status, toolName(item.name, previous?.name || toolLabels[item.type]));
        if (item.type === 'web_search_call') observeSources(item.action?.sources);
      }
    };
    let response;
    try {
      if (controller.signal.aborted) { await wait(Promise.resolve()); throw interruptionError(); }
      const explicitProtocol = preferredProtocol(protocol);
      const autoProtocol = provider !== 'openai-auth' && explicitProtocol !== 'responses' && explicitProtocol !== 'chat';
      const pkuAuto = autoProtocol && !webSearch && isPkuDeepSeek(base, model);
      const compatibleChat = pkuAuto && chatCompatibleInput(input);
      // A host-level learned protocol cannot override this request's originals.
      const requestProtocol = pkuAuto ? compatibleChat ? 'chat' : 'responses' : protocolOf(provider, base, explicitProtocol);
      // 按指定协议构造并发送一次请求；自动回退需要用另一种协议重建请求体。
      const send = async chosen => {
        if (controller.signal.aborted) { await wait(Promise.resolve()); throw interruptionError(); }
        usedProtocol = chosen;
        const url = provider === 'openai-auth' ? '/__codex/respond' : `/__proxy?url=${encodeURIComponent(Core.endpoint(base, chosen === 'chat' ? 'chat/completions' : 'responses'))}`;
        const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
        if (provider !== 'openai-auth' && token) headers.Authorization = `Bearer ${token}`;
        const body = chosen === 'chat' ? { model, messages: chatMessages(input), stream: true } : { model, input, stream: true };
        if (webSearch !== false && webSearch !== true) { const error = new Error('网页搜索选项必须为布尔值。'); error.code = 'INVALID_WEB_SEARCH'; throw error; }
        if (webSearch) {
          if (provider === 'openai-auth') body.webSearch = true;
          else if (chosen === 'chat') { const error = new Error('当前接口协议（Chat Completions）不支持内置网页搜索。请关闭网页搜索，或在连接设置中改用 Responses API。'); error.code = 'WEB_SEARCH_UNSUPPORTED'; throw error; }
          else {
            const endpoint = new URL(Core.endpoint(base, 'responses'));
            if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'api.openai.com' || endpoint.port || endpoint.username || endpoint.password) { const error = new Error('此 API 服务尚未确认支持网页搜索，请使用 OpenAI 账号或官方 OpenAI API。'); error.code = 'WEB_SEARCH_UNSUPPORTED'; throw error; }
            body.tools = [{ type: 'web_search', external_web_access: true }];
            body.include = ['web_search_call.action.sources'];
          }
        }
        const thinking = chosen === 'chat' ? pkuDeepSeekThinking(base, model, effort) : null;
        if (thinking) body.thinking = thinking;
        if (effort && effort !== 'auto') {
          if (provider === 'openai-auth') body.effort = effort;
          else if (chosen === 'chat') {
            if (!(thinking && effort === 'off')) body.reasoning_effort = effort;
          } else body.reasoning = { effort };
        }
        attemptId = nextActivityNamespace();
        activityNamespace = attemptId;
        attemptSettled = false;
        onAttempt?.({ id: attemptId, status: 'running' });
        if (controller.signal.aborted) { await wait(Promise.resolve()); throw interruptionError(); }
        reception?.start();
        onPhase?.('waiting');
        try { return await wait(fetch(url, { method: 'POST', signal: controller.signal, headers, body: JSON.stringify(body) })); }
        catch (error) {
          if (!controller.signal.aborted && error?.name !== 'AbortError') {
            error.diagnostic = root.RunFailureDiagnostics?.receipt('UPSTREAM_CONNECTION_ERROR', { phase: 'connection' });
            if (error.diagnostic) error.message = root.RunFailureDiagnostics.present(error.diagnostic).description;
          }
          throw error;
        }
      };
      response = await send(requestProtocol);
      if (!response.ok) {
        let errorBody = '';
        try { errorBody = await readText(response); }
        catch (error) { if (controller.signal.aborted) throw error; }
        observeErrorUsage(errorBody);
        const failure = errorFrom(response, errorBody);
        // 自动判定模式下，若失败特征指向“该服务不提供这条协议路径”，改用另一协议重试
        // 一次：成功即记住该来源，并把这次切换如实展示给用户（不静默改写协议）。
        // 用户显式选定的协议、以及开启网页搜索（仅 Responses 支持）时不做回退。
        const mismatched = provider !== 'openai-auth' && requestProtocol === 'responses' && failure.protocolMismatch && !failure.contextHasGeneration;
        if (mismatched && autoProtocol && !webSearch && !controller.signal.aborted && (!pkuAuto || compatibleChat)) {
          finishAttempt('failed');
          const retry = await send('chat');
          if (retry.ok) {
            const source = sourceOf(base);
            if (source) learnedProtocols.set(source, 'chat');
            try { protocolLearned?.(source, 'chat'); } catch (_) {}
            activity('commentary', 'protocol-fallback', `该服务未提供 Responses API（${failure.message}），已自动改用 Chat Completions 重试。`);
            response = retry;
          } else {
            let retryBody = '';
            try { retryBody = await readText(retry); }
            catch (error) { if (controller.signal.aborted) throw error; }
            observeErrorUsage(retryBody);
            const retryFailure = errorFrom(retry, retryBody);
            if (retryFailure.diagnostic) retryFailure.diagnostic.fallbackAttempted = true;
            if (retryFailure.code === 'CONTEXT_LENGTH_EXCEEDED') throw retryFailure;
            retryFailure.message = `${failure.message}\n\n已按 Chat Completions 重试，同样失败：${retryFailure.message}`;
            if (retryFailure.diagnostic) retryFailure.diagnostic.fallbackAttempted = true;
            throw retryFailure;
          }
        } else {
          if (controller.signal.aborted) throw interruptionError();
          if (mismatched && pkuAuto && !compatibleChat) failure.message += '\n\n当前输入需要保留 Responses 格式；请选择支持此格式和附件的服务。';
          else if (mismatched) failure.message += webSearch
            ? '\n\n该服务可能只提供 Chat Completions（它不支持内置网页搜索）。可在连接设置中切换接口协议并关闭网页搜索后重试。'
            : '\n\n该服务可能只提供 Chat Completions。可在连接设置中将接口协议改为“Chat Completions”后重试。';
          throw failure;
        }
      }
      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (!contentType.includes('text/event-stream')) {
        const body = await readText(response); let data; try { data = JSON.parse(body); } catch (_) {
          if (contentType.includes('json')) { const error = new Error('API 返回的 JSON 响应不完整或格式无效，本次未执行操作。'); error.code = 'INVALID_RESPONSE'; throw error; }
          data = { output_text: body };
        }
        observeUsage((data?.response || data)?.usage);
        receivedContent ||= containsGeneration(data);
        const failure = generationError(data, '', 'response') || generationError(data, data?.type || '', 'response'); if (failure) throw failure;
        data = data?.response || data;
        if (['length','content_filter','error'].includes(data?.choices?.[0]?.finish_reason)) { const error = new Error('模型生成被截断或未完成，本次未执行操作。请检查服务返回的完成状态后重试。'); error.code = 'STREAM_ERROR'; error.diagnostic = root.RunFailureDiagnostics?.fromStream(null, data.choices[0].finish_reason === 'length' ? 'max_output_tokens' : data.choices[0].finish_reason); throw error; }
        if (data?.choices?.some(choice => choice?.message?.tool_calls?.length || choice?.message?.function_call || ['tool_calls', 'function_call'].includes(choice?.finish_reason))) throw nativeProtocolError();
        (Array.isArray(data?.output) ? data.output : []).forEach(item => observeItem(item, true));
        if (pendingNativeToolCall) throw nativeProtocolError();
        const output = jsonText(data); if (typeof output !== 'string' || !output.trim()) { const error = new Error('模型未返回可用内容，本次未执行操作。请检查账号和模型后重试。'); error.code = 'EMPTY_RESPONSE'; throw error; }
        const protocolFailure = protocolError(output); if (protocolFailure) throw protocolFailure;
        const thinking = [data?.choices?.[0]?.message?.reasoning_content, data?.choices?.[0]?.message?.reasoning].find(value => typeof value === 'string' && value);
        if (thinking) publicText({ item_id: '_chat_thinking', summary_index: 0 }, thinking, false, 'completed');
        if (controller.signal.aborted) throw interruptionError();
        receivedContent = true; reception?.content('output'); publishDelta(output); if (controller.signal.aborted) throw interruptionError(); receptionOutcome = 'completed'; return output;
      }
      if (!response.body) { const error = new Error('API 没有提供可读取的事件流，本次未执行操作。'); error.code = 'STREAM_INCOMPLETE'; throw error; }
      reader = response.body.getReader(); const decoder = new TextDecoder(); let output = '';
      let streamFormat = null, completed = false;
      // chat 协议的明文思考流：段号递增——收束后再次出现的思考另开一段，不并进旧段。
      let chatThinkingOpen = false, chatThinkingIndex = -1;
      const outputParts = new Map();
      const publishOutput = (event, text, append = false) => {
        if (typeof text !== 'string' || !text) return;
        receivedContent = true;
        if (pendingNativeToolCall) return;
        if (event.phase === 'commentary' || messagePhases.get(identifier(event.item_id)) === 'commentary') { publicText({ ...event, source: 'commentary' }, text, append, append ? 'running' : 'completed'); return; }
        const key = identifier(event.item_id);
        outputParts.set(key, (append ? outputParts.get(key) || '' : '') + text);
        const value = [...outputParts.values()].join('');
        const protocolFailure = protocolError(value, { final: false }); if (protocolFailure) throw protocolFailure;
        if (inspectProtocolOutput(value, { final: false })?.kind === 'pending') return;
        if (value !== output) { const delta = value.startsWith(output) ? value.slice(output.length) : undefined; output = value; reception?.content('output'); onPhase?.('output'); publishDelta(output, delta); }
      };
      const dispatch = raw => {
        if (controller.signal.aborted) throw interruptionError();
        const lines = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()); if (!lines.length) return;
        const dataText = lines.join('\n'); if (!dataText) return;
        if (dataText === '[DONE]') { if (streamFormat === 'chat') completed = true; return; }
        let event; try { event = JSON.parse(dataText); } catch (_) { return; }
        if (!event || typeof event !== 'object' || Array.isArray(event)) return;
        const type = event.type || raw.split(/\r?\n/).find(line=>line.startsWith('event:'))?.slice(6).trim() || '';
        receivedContent ||= containsGeneration(event);
        if (type === 'response.output_item.added' && event.item && !['message','reasoning'].includes(event.item.type)) receivedContent = true;
        if (Array.isArray(event.choices) || type.startsWith('response.')) observeUsage((event.response || event).usage);
        const failure = generationError(event,type); if (failure) throw failure;
        if (requirePlanProtocol && /^response\.(?:function_call_arguments|custom_tool_call_input)\./.test(type)) pendingNativeToolCall = true;
        const format = type.startsWith('response.') ? 'responses' : Array.isArray(event.choices) ? 'chat' : null;
        if (format) {
          if (streamFormat && streamFormat !== format) { const error = new Error('API 混合返回了不同流协议，无法确认完整结果。'); error.code = 'STREAM_ERROR'; error.diagnostic = root.RunFailureDiagnostics?.receipt('INVALID_RESPONSE', { phase: 'stream' }); throw error; }
          streamFormat = format;
        }
        if (format === 'chat') {
          const choice = event.choices.find(item=>item?.index===0) || event.choices[0];
          if (choice && ['length','content_filter','error'].includes(choice.finish_reason)) { const error = new Error('模型生成被截断或未完成，本次未执行操作。请检查服务返回的完成状态后重试。'); error.code = 'STREAM_ERROR'; error.diagnostic = root.RunFailureDiagnostics?.fromStream(null, choice.finish_reason === 'length' ? 'max_output_tokens' : choice.finish_reason); throw error; }
          if (choice?.delta?.tool_calls?.length || choice?.message?.tool_calls?.length || choice?.delta?.function_call || choice?.message?.function_call || ['tool_calls', 'function_call'].includes(choice?.finish_reason)) pendingNativeToolCall = true;
          const delta = choice?.delta?.content ?? choice?.text;
          // 明文思考（DeepSeek 等经 reasoning_content 返回）：独立成“深度思考”段进入
          // 进度流，与工具、正文分层；正文或工具一开始就收束该段——段级呼吸据此在
          // 思考完成后自动折叠，并保留随时点开回看。思考内容不进正文（不混流）。
          const thinking = [choice?.delta?.reasoning_content, choice?.delta?.reasoning, choice?.message?.reasoning_content].find(value => typeof value === 'string' && value) || '';
          if (thinking) {
            if (!chatThinkingOpen) { chatThinkingOpen = true; chatThinkingIndex += 1; }
            publicText({ item_id: '_chat_thinking', summary_index: chatThinkingIndex }, thinking, true, 'running');
          } else if (chatThinkingOpen && (typeof delta === 'string' || choice?.delta?.tool_calls !== undefined || choice?.finish_reason)) {
            chatThinkingOpen = false;
            settle('summary', `_chat_thinking:${chatThinkingIndex}`);
          }
          if (typeof delta === 'string') publishOutput({item_id:'_chat'},delta,true);
          else if (typeof choice?.message?.content === 'string') publishOutput({item_id:'_chat'},choice.message.content);
          return;
        }
        if (type === 'response.reasoning_summary_text.delta') { publicText(event, event.delta, true); return; }
        if (type === 'response.reasoning_summary_text.done') { publicText(event, event.text, false, event.status === 'running' ? 'running' : 'completed'); return; }
        if (type === 'response.reasoning_summary_part.added' || type === 'response.reasoning_summary_part.done') { if (event.part?.type === 'summary_text') publicText(event, event.part.text, false, type.endsWith('.done') ? 'completed' : 'running'); return; }
        if (type === 'response.output_item.added' || type === 'response.output_item.done') { observeItem(event.item, type.endsWith('.done')); return; }
        if (type === 'response.web_sources') { observeSources(event.sources); return; }
        if (type === 'response.output_text.annotation.added') { if (event.annotation?.type === 'url_citation') observeSources([event.annotation]); return; }
        if (type === 'response.tool_activity') {
          if (['pending', 'running', 'completed', 'failed', 'cancelled'].includes(event.status)) {
            const label = ['命令执行', '文件修改', 'MCP 工具', '动态工具', '协作工具', '网页搜索', '图片查看'].includes(event.text) ? event.text : '工具调用';
            activity('tool', event.id, label, event.status, toolName(event.name, label));
          }
          return;
        }
        const toolEvent = /^response\.(web_search_call|file_search_call|code_interpreter_call|mcp_call|image_generation_call)\.(in_progress|searching|interpreting|completed|failed)$/.exec(type);
        if (toolEvent) { observeItem({ type: toolEvent[1], id: event.item_id, status: toolEvent[2] }, toolEvent[2] === 'completed'); return; }
        if (type === 'response.output_text.delta' || type === 'response.refusal.delta') { publishOutput(event, event.delta, true); return; }
        if (type === 'response.output_text.done' || type === 'response.refusal.done') { publishOutput(event, event.text || event.refusal); return; }
        if (type === 'response.completed' || type === 'response.done') {
          const data = event.response || event;
          (Array.isArray(data.output) ? data.output : []).forEach(item => observeItem(item, true));
          if (pendingNativeToolCall) throw nativeProtocolError();
          const complete = jsonText(data); if (complete && output !== complete) { const protocolFailure = protocolError(complete); if (protocolFailure) throw protocolFailure; receivedContent = true; output = complete; reception?.content('output'); publishDelta(output); }
          completed = true;
        }
        // Raw reasoning, encrypted content, tool arguments/results and unknown
        // deltas are deliberately excluded from both progress and final text.
      };
      if (!SSEFrames?.create) throw Object.assign(new Error('本机流式响应组件未加载，请重新打开应用。'), { code: 'INVALID_RESPONSE' });
      const frames = SSEFrames.create({ onFrame: dispatch });
      while (true) {
        const result = await readChunk();
        if (result.done) { frames.push(decoder.decode()); break; }
        frames.push(decoder.decode(result.value, { stream: true }));
        if (completed) break;
      }
      if (!completed) frames.finish();
      if (controller.signal.aborted) throw interruptionError();
      if (!completed) { const error = new Error('连接已结束，但未收到模型的明确完成事件。本次结果可能不完整，未执行任何操作。请重试或检查 API 的流协议兼容性。'); error.code = 'STREAM_INCOMPLETE'; throw error; }
      if (pendingNativeToolCall) throw nativeProtocolError();
      const protocolFailure = protocolError([...outputParts.values()].join('') || output); if (protocolFailure) throw protocolFailure;
      if (!output.trim()) throw new Error('模型未返回内容，请检查账号和模型后重试。'); receptionOutcome = 'completed'; return output;
    } catch (error) {
      receptionOutcome = controller.signal.aborted || error?.name === 'AbortError' || error?.code === 'CANCELLED' ? 'cancelled' : 'failed';
      if (controller.signal.aborted || error?.name === 'AbortError') throw Object.assign(interruptionError(), attemptId ? { attemptId } : {});
      if (attemptId) error.attemptId = attemptId;
      if (error?.code === 'CONTEXT_LENGTH_EXCEEDED') { error.contextRecoveryAllowed = !receivedContent && !error.contextHasGeneration; error.requestProtocol = usedProtocol; }
      const diagnostic = root.RunFailureDiagnostics?.capture(error)
        || (error?.name === 'TypeError' && response ? root.RunFailureDiagnostics?.receipt('UPSTREAM_STREAM_INTERRUPTED', { phase: 'stream' }) : null);
      if (diagnostic) {
        error.diagnostic = root.RunFailureDiagnostics.normalize({ ...diagnostic, protocol: usedProtocol });
        // Fixed provider-facing guidance only; existing host validation messages
        // remain unchanged when their structured category is unavailable.
        error.message = root.RunFailureDiagnostics.present(error.diagnostic).description;
      }
      throw error;
    } finally {
      reception?.finish(receptionOutcome);
      signal?.removeEventListener('abort', cancel); controller.signal.removeEventListener('abort', rejectOnAbort);
      controller.abort();
      if (reader) {
        if (!readerDone) { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch (_) {} }
        try { reader.releaseLock(); } catch (_) {}
      }
      finishAttempt(receptionOutcome);
    }
  }
  root.AgentTransport = { requestPlan, configure, protocolOf, chatMessages, inspectProtocolOutput, protocolError };
})(typeof globalThis !== 'undefined' ? globalThis : this);
