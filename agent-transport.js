(function (root) {
  'use strict';
  const Core = root.WorkstationCore;
  const messageText = item => (Array.isArray(item?.content) ? item.content : []).filter(part => ['output_text', 'text'].includes(part?.type) && typeof part.text === 'string').map(part => part.text).join('');
  const jsonText = data => data?.output_text || data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || (Array.isArray(data?.output) ? data.output : []).filter(item => item?.type === 'message' && item.phase !== 'commentary').map(messageText).join('') || '';
  const toolLabels = Object.freeze({ web_search_call: '网页搜索', file_search_call: '资料检索', code_interpreter_call: '代码执行', mcp_call: 'MCP 工具', function_call: '函数调用', custom_tool_call: '自定义工具', computer_call: '计算机操作', shell_call: '命令执行', local_shell_call: '命令执行', image_generation_call: '图像生成', apply_patch_call: '文件修改' });
  const toolName = (value, fallback) => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_.:-]{0,79}$/.test(value) ? value : fallback;
  const generationError = (data, type = '') => {
    const value = data?.response || data || {}, failure = value.error || data?.error;
    const status = value.status || data?.status;
    if (!failure && !['error','response.failed','response.incomplete'].includes(type) && !['failed','incomplete','cancelled','canceled','in_progress','queued'].includes(status)) return null;
    // A progress event is expected during SSE; only terminal/error envelopes
    // and non-stream responses use the incomplete-status check.
    if (type && !['error','response.failed','response.incomplete','response.completed','response.done'].includes(type) && !failure) return null;
    const detail = typeof failure === 'string' ? failure : failure?.message || data?.message;
    const error = new Error(typeof detail === 'string' && detail ? detail : '模型响应未完成或已失败，本次未执行操作。请重试。');
    error.code = 'STREAM_ERROR'; return error;
  };
  const errorFrom = (response, body) => {
    let message = '';
    try { const data = JSON.parse(body); message = data.error?.message || data.message || ''; } catch (_) {}
  if (!message && response.status === 404) message = '接口不存在（404）。请确认 API 地址指向服务的 /v1，且该服务支持 Responses API。';
  if (!message && response.status === 400) message = '请求格式被服务拒绝（400）。请确认模型名称和 Responses API 兼容性。';
  const error = new Error(message || body.slice(0, 400) || `HTTP ${response.status}`); error.code = 'HTTP'; error.status = response.status; return error;
  };
  async function requestPlan({ provider = 'api', base, model, effort = '', token, input, webSearch = false, onDelta, onPhase, onActivity, onSources, signal }) {
    const controller = new AbortController();
    let reader, readerDone = false, rejectOnAbort;
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
      if (changed) onSources?.([...sources.values()].map(source => ({ ...source })));
    };
    const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 160 ? value : '_legacy';
    const activity = (kind, id, text, status, name, append = false) => {
      const key = `${kind}:${typeof id === 'string' && id.length > 0 && id.length <= 200 ? id : '_legacy'}`;
      const previous = activities.get(key);
      if (!previous && activities.size >= 100) return;
      if (previous && ['completed', 'failed', 'cancelled'].includes(previous.status) && ['pending', 'running'].includes(status)) return;
      if (typeof text !== 'string') return;
      text = ((append ? previous?.text || '' : '') + text).slice(0, kind === 'tool' ? 240 : 4000);
      if (!text && kind !== 'tool') return;
      const value = { id: key, kind, status, name, text };
      if (previous && previous.text === text && previous.status === status && previous.name === name) return;
      activities.set(key, value); onActivity?.({ ...value });
      if (kind !== 'tool') onPhase?.('reasoning', [...activities.values()].filter(item => item.kind !== 'tool').map(item => item.text).join('\n\n').slice(0, 16000));
    };
    const publicText = (event, text, append = false, status = 'running') => {
      const kind = event.source === 'commentary' ? 'commentary' : 'summary';
      const index = Number.isSafeInteger(event.summary_index) && event.summary_index >= 0 && event.summary_index < 100 ? event.summary_index : 0;
      activity(kind, `${identifier(event.item_id)}:${index}`, text, status, kind === 'commentary' ? '进度说明' : '公开摘要', append);
    };
    const observeItem = (item, completed = false) => {
      if (!item || typeof item !== 'object') return;
      if (item.type === 'reasoning') {
        (Array.isArray(item.summary) ? item.summary : []).slice(0, 100).forEach((part, index) => {
          if (part?.type === 'summary_text') publicText({ item_id: item.id, summary_index: index }, part.text, false, completed ? 'completed' : 'running');
        });
      } else if (item.type === 'message') {
        if (item.phase === 'commentary' || item.phase === 'final_answer') messagePhases.set(identifier(item.id), item.phase);
        if (item.phase === 'commentary') publicText({ source: 'commentary', item_id: item.id }, messageText(item), false, completed ? 'completed' : 'running');
        for (const part of Array.isArray(item.content) ? item.content : []) if (part?.type === 'output_text') observeSources((Array.isArray(part.annotations) ? part.annotations : []).filter(annotation => annotation?.type === 'url_citation'));
      } else if (Object.hasOwn(toolLabels, item.type)) {
        const pending = item.type === 'function_call' || item.type === 'custom_tool_call';
        const status = ['failed', 'error'].includes(item.status) || item.error ? 'failed' : ['cancelled', 'canceled', 'incomplete'].includes(item.status) ? 'cancelled' : pending ? 'pending' : completed || item.status === 'completed' ? 'completed' : 'running';
        const id = item.id || item.call_id;
        const previous = activities.get(`tool:${identifier(id)}`);
        activity('tool', id, pending ? '工具调用已提出，等待宿主执行' : toolLabels[item.type], status, toolName(item.name, previous?.name || toolLabels[item.type]));
        if (item.type === 'web_search_call') observeSources(item.action?.sources);
      }
    };
    let response;
    try {
      if (controller.signal.aborted) { await wait(Promise.resolve()); throw interruptionError(); }
      const url = provider === 'openai-auth' ? '/__codex/respond' : `/__proxy?url=${encodeURIComponent(Core.endpoint(base, 'responses'))}`;
      const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
      if (provider !== 'openai-auth' && token) headers.Authorization = `Bearer ${token}`;
      const body = { model, input, stream: true };
      if (webSearch !== false && webSearch !== true) { const error = new Error('网页搜索选项必须为布尔值。'); error.code = 'INVALID_WEB_SEARCH'; throw error; }
      if (webSearch) {
        if (provider === 'openai-auth') body.webSearch = true;
        else {
          const endpoint = new URL(Core.endpoint(base, 'responses'));
          if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'api.openai.com' || endpoint.port || endpoint.username || endpoint.password) { const error = new Error('此 API 服务尚未确认支持网页搜索，请使用 OpenAI 账号或官方 OpenAI API。'); error.code = 'WEB_SEARCH_UNSUPPORTED'; throw error; }
          body.tools = [{ type: 'web_search', external_web_access: true }];
          body.include = ['web_search_call.action.sources'];
        }
      }
      if (effort && effort !== 'auto') {
        if (provider === 'openai-auth') body.effort = effort;
        else body.reasoning = { effort };
      }
      response = await wait(fetch(url, { method: 'POST', signal: controller.signal, headers, body: JSON.stringify(body) }));
      if (!response.ok) {
        let errorBody = '';
        try { errorBody = await readText(response); }
        catch (error) { if (controller.signal.aborted) throw error; }
        throw errorFrom(response, errorBody);
      }
      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (!contentType.includes('text/event-stream')) {
        const body = await readText(response); let data; try { data = JSON.parse(body); } catch (_) {
          if (contentType.includes('json')) { const error = new Error('API 返回的 JSON 响应不完整或格式无效，本次未执行操作。'); error.code = 'INVALID_RESPONSE'; throw error; }
          data = { output_text: body };
        }
        const failure = generationError(data) || generationError(data,data?.type || ''); if (failure) throw failure;
        data = data?.response || data;
        if (['length','content_filter','error'].includes(data?.choices?.[0]?.finish_reason)) { const error = new Error('模型生成被截断或未完成，本次未执行操作。请检查服务返回的完成状态后重试。'); error.code = 'STREAM_ERROR'; throw error; }
        (Array.isArray(data?.output) ? data.output : []).forEach(item => observeItem(item, true));
        const output = jsonText(data); if (typeof output !== 'string' || !output.trim()) { const error = new Error('模型未返回可用内容，本次未执行操作。请检查账号和模型后重试。'); error.code = 'EMPTY_RESPONSE'; throw error; }
        onDelta?.(output); if (controller.signal.aborted) throw interruptionError(); return output;
      }
      if (!response.body) { const error = new Error('API 没有提供可读取的事件流，本次未执行操作。'); error.code = 'STREAM_INCOMPLETE'; throw error; }
      onPhase?.('reasoning');
      reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let output = '';
      let streamFormat = null, completed = false;
      const outputParts = new Map();
      const publishOutput = (event, text, append = false) => {
        if (typeof text !== 'string' || !text) return;
        if (event.phase === 'commentary' || messagePhases.get(identifier(event.item_id)) === 'commentary') { publicText({ ...event, source: 'commentary' }, text, append, append ? 'running' : 'completed'); return; }
        const key = identifier(event.item_id);
        outputParts.set(key, (append ? outputParts.get(key) || '' : '') + text);
        const value = [...outputParts.values()].join('');
        if (value !== output) { const delta = value.startsWith(output) ? value.slice(output.length) : undefined; output = value; onPhase?.('output'); onDelta?.(output, delta); }
      };
      const dispatch = raw => {
        const lines = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()); if (!lines.length) return;
        const dataText = lines.join('\n'); if (!dataText) return;
        if (dataText === '[DONE]') { if (streamFormat === 'chat') completed = true; return; }
        let event; try { event = JSON.parse(dataText); } catch (_) { return; }
        if (!event || typeof event !== 'object' || Array.isArray(event)) return;
        const type = event.type || raw.split(/\r?\n/).find(line=>line.startsWith('event:'))?.slice(6).trim() || '';
        const failure = generationError(event,type); if (failure) throw failure;
        const format = type.startsWith('response.') ? 'responses' : Array.isArray(event.choices) ? 'chat' : null;
        if (format) {
          if (streamFormat && streamFormat !== format) { const error = new Error('API 混合返回了不同流协议，无法确认完整结果，本次未执行操作。'); error.code = 'STREAM_ERROR'; throw error; }
          streamFormat = format;
        }
        if (format === 'chat') {
          const choice = event.choices.find(item=>item?.index===0) || event.choices[0];
          if (choice && ['length','content_filter','error'].includes(choice.finish_reason)) { const error = new Error('模型生成被截断或未完成，本次未执行操作。请检查服务返回的完成状态后重试。'); error.code = 'STREAM_ERROR'; throw error; }
          const delta = choice?.delta?.content ?? choice?.text;
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
          const complete = jsonText(data); if (complete && output !== complete) { output = complete; onDelta?.(output); }
          completed = true;
        }
        // Raw reasoning, encrypted content, tool arguments/results and unknown
        // deltas are deliberately excluded from both progress and final text.
      };
      while (true) {
        const result = await readChunk();
        if (result.done) { buffer += decoder.decode(); break; } buffer += decoder.decode(result.value, { stream: true });
        const events = buffer.split(/\n\n|\r\n\r\n/); buffer = events.pop() || ''; events.forEach(dispatch);
        if (completed) break;
      }
      if (!completed && buffer.trim()) dispatch(buffer);
      if (controller.signal.aborted) throw interruptionError();
      if (!completed) { const error = new Error('连接已结束，但未收到模型的明确完成事件。本次结果可能不完整，未执行任何操作。请重试或检查 API 的流协议兼容性。'); error.code = 'STREAM_INCOMPLETE'; throw error; }
      if (!output.trim()) throw new Error('模型未返回内容，请检查账号和模型后重试。'); return output;
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') throw interruptionError();
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel); controller.signal.removeEventListener('abort', rejectOnAbort);
      controller.abort();
      if (reader) {
        if (!readerDone) { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch (_) {} }
        try { reader.releaseLock(); } catch (_) {}
      }
    }
  }
  root.AgentTransport = { requestPlan };
})(typeof globalThis !== 'undefined' ? globalThis : this);
