/* Safe, versioned failure receipts. Never persist provider bodies, URLs, request
 * headers, exception text, credentials or model inputs in a diagnostic record. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RunFailureDiagnostics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // category, title, English title, guidance, English guidance, destination
  const kinds = Object.freeze({
    HTTP_UNAUTHORIZED: ['credentials', '连接认证未通过', 'Authentication failed', '服务拒绝了当前凭据。请在模型设置中检查连接凭据或重新登录。', 'The service rejected the credentials. Check the connection credentials or sign in again in model settings.', 'settings'],
    HTTP_FORBIDDEN: ['permission', '服务拒绝访问', 'Access denied', '当前账号或请求没有访问权限。请核对服务、模型权限及账号状态。', 'The account or request lacks permission. Check the service, model permissions and account status.', 'settings'],
    QUOTA_EXHAUSTED: ['quota', '服务额度不足', 'Service quota exhausted', '服务明确报告额度不足。请在服务商处检查额度，或选择另一个可用连接。', 'The service explicitly reported exhausted quota. Check the provider account or choose another connection.', 'settings'],
    RATE_LIMITED: ['rate_limit', '请求受到限流', 'Request rate limited', '服务限制了当前请求频率。请稍后再试；这条状态本身不能证明账号余额不足。', 'The service rate limited this request. Try again later; this status alone does not establish an exhausted balance.', null],
    UPSTREAM_DNS_ERROR: ['network', '无法解析服务地址', 'Service address could not be resolved', '域名解析失败。请检查 API 地址和当前网络连接。', 'DNS resolution failed. Check the API address and network connection.', 'settings'],
    UPSTREAM_TLS_ERROR: ['tls', '安全连接未建立', 'Secure connection failed', 'TLS 握手或证书校验失败。请检查服务证书、地址和网络代理配置。', 'TLS negotiation or certificate validation failed. Check the service certificate, address and network proxy.', 'settings'],
    UPSTREAM_CONNECT_TIMEOUT: ['timeout', '连接服务超时', 'Service connection timed out', '建立连接时超过等待限制。请检查网络或服务状态后重试；这不是模型生成时限。', 'Connection setup timed out. Check the network or service before retrying; this is not a generation deadline.', null],
    UPSTREAM_CONNECTION_REFUSED: ['network', '服务拒绝连接', 'Connection refused', '目标端口拒绝了连接。请确认服务正在运行，且地址和端口正确。', 'The destination port refused the connection. Verify that the service is running at the configured address and port.', 'settings'],
    UPSTREAM_CONNECTION_ERROR: ['network', '连接没有完成', 'Connection failed', '连接发生中断或网络错误。请检查本机服务、网络及 API 服务状态。', 'A network or connection error occurred. Check the local service, network and API service.', null],
    UPSTREAM_REDIRECT_REJECTED: ['configuration', '服务重定向被拒绝', 'Service redirect rejected', '请求被重定向到另一来源，凭据没有继续转发。请在设置中填写正确的 API 地址。', 'The request redirected to another origin and credentials were not forwarded. Configure the correct API address.', 'settings'],
    UPSTREAM_STREAM_INTERRUPTED: ['network', '响应传输中断', 'Response transfer interrupted', '读取服务响应时连接中断。已接收的公开内容仍保留，请核对本轮记录后重试。', 'The connection failed while reading the response. Received public content is retained; review this run before retrying.', null],
    ENDPOINT_UNAVAILABLE: ['protocol', '接口路径不可用', 'Endpoint unavailable', '服务拒绝了当前接口路径。请检查 API 地址，以及 Responses / Chat Completions 协议设置。', 'The service rejected this endpoint. Check the API address and Responses / Chat Completions protocol setting.', 'settings'],
    MODEL_NOT_AVAILABLE: ['configuration', '模型不可用', 'Model unavailable', '服务报告指定模型不存在或无法访问。请检查当前对话使用的模型及其权限。', 'The service reported that the requested model is missing or inaccessible. Check the conversation model and its permissions.', 'settings'],
    INVALID_REQUEST: ['configuration', '服务拒绝了请求', 'Request rejected', '服务认为请求参数无效。请检查模型、接口协议和附件是否受支持。', 'The service rejected the request parameters. Check the model, protocol and supported attachments.', 'settings'],
    UPSTREAM_SERVICE_ERROR: ['service', 'API 服务暂时出错', 'API service error', '服务返回了服务端错误。请稍后重试或检查服务状态；不会因此自动切换接口协议。', 'The service returned a server error. Retry later or check service status; this alone does not switch protocols.', null],
    UPSTREAM_HTTP_ERROR: ['unknown', '请求未被服务接受', 'Request was not accepted', '服务返回了 HTTP 错误，现有信息不足以确定更具体的原因。请检查服务状态或连接设置。', 'The service returned an HTTP error without enough information for a more specific cause. Check service status or connection settings.', 'settings'],
    CONTEXT_LENGTH_EXCEEDED: ['context', '输入超过上下文容量', 'Context capacity exceeded', '服务报告输入过长。请查看本轮上下文，调整附件或较早对话后再试。', 'The service reported excessive input. Review this run’s context and adjust attachments or earlier conversation before retrying.', 'context'],
    MODEL_PROTOCOL_ERROR: ['protocol', '模型响应协议不兼容', 'Incompatible model response', '模型返回了当前连接无法处理的工具或响应协议。请检查模型及接口协议；这些未接入的调用没有被执行。', 'The model returned an unsupported tool or response protocol. Check the model and endpoint protocol; unsupported calls were not executed.', 'settings'],
    INVALID_RESPONSE: ['protocol', '服务响应格式无效', 'Invalid service response', '服务返回的 JSON 响应不完整或无效。请检查服务的协议兼容性。', 'The service returned incomplete or invalid JSON. Check its protocol compatibility.', 'settings'],
    STREAM_INCOMPLETE: ['protocol', '未收到明确完成信号', 'Completion was not confirmed', '连接已结束，但没有收到明确完成事件。已生成的公开内容保留，不能将本轮视为成功。', 'The connection ended without an explicit completion event. Received public content remains, but this run cannot be treated as successful.', 'settings'],
    MODEL_STREAM_ERROR: ['service', '服务报告生成失败', 'Generation failed at the service', '服务报告本次生成失败或未完成，没有足够信息确定更具体原因。请核对本轮记录后重试。', 'The service reported failed or incomplete generation without a more specific cause. Review this run before retrying.', null],
    OUTPUT_LIMIT: ['output_limit', '本次生成达到输出上限', 'Output limit reached', '服务报告本次输出达到长度上限，已生成内容保留。这不等同于账号额度不足。', 'The service reported an output length limit. Generated content is retained; this is distinct from account quota.', null],
    CONTENT_FILTER: ['content_filter', '服务停止了本次生成', 'Generation stopped by the service', '服务报告内容过滤终止了生成。请调整请求后再试。', 'The service reported that content filtering stopped generation. Revise the request before trying again.', null],
    CREDENTIAL_REENTRY_REQUIRED: ['credentials', '需要重新保存 API Key', 'Save the API key again', '旧凭据当前不可用。请在设置中重新粘贴并保存 Key，随后再重试。', 'The previous credential is unavailable. Paste and save the key again in settings before retrying.', 'settings'],
    MODEL_NOT_CONFIGURED: ['configuration', '尚未配置可用模型', 'No model configured', '请在设置中完成模型连接配置，然后继续当前对话。', 'Configure a model connection in settings, then return to this conversation.', 'settings'],
    PROTOCOL_UNSUPPORTED: ['protocol', '当前接口不支持此能力', 'Capability unsupported by this protocol', '当前接口协议不支持请求中的附件或工具能力。请调整附件或接口设置。', 'The endpoint protocol does not support the requested attachment or tool capability. Adjust attachments or protocol settings.', 'settings'],
    INVALID_KNOWLEDGE_REQUESTS: ['tool_plan', '工具计划包含无效请求', 'Tool plan contains invalid requests', '模型生成的工具请求格式或参数无效，这一批请求尚未执行。请查看本轮记录，将需要读取的资料或执行的步骤说明得更具体后重新发起。系统不会自动重试。', 'The model generated invalid tool request structure or parameters. This batch was not executed. Review the run and clarify the sources to read or steps to perform before starting again. The app will not retry automatically.', null],
    KNOWLEDGE_BATCH_REQUIRES_SPLIT: ['tool_plan', '工具计划需要分批执行', 'Tool plan must be split into batches', '这一批工具请求超过 32 项，且包含不能自动拆批的操作，因此尚未执行。请把任务拆为每批最多 32 项的较小步骤，再由你确认并重新发起；系统不会自动重试。', 'This batch exceeds 32 tool requests and includes operations that cannot be split automatically, so it was not executed. Split the task into smaller steps of at most 32 requests per batch, then review and start them yourself. The app will not retry automatically.', null],
  });
  const knowledgeCodes = new Set(['INVALID_KNOWLEDGE_REQUESTS', 'KNOWLEDGE_BATCH_REQUIRES_SPLIT']);
  const knowledgeBatchLimit = 32;
  const phases = new Set(['configuration', 'connection', 'response', 'stream']);
  const protocols = new Set(['responses', 'chat', 'anthropic']);
  const providerCodes = Object.freeze({ insufficient_quota: 'QUOTA_EXHAUSTED', quota_exceeded: 'QUOTA_EXHAUSTED', credit_balance_too_low: 'QUOTA_EXHAUSTED', billing_hard_limit_reached: 'QUOTA_EXHAUSTED', rate_limit_exceeded: 'RATE_LIMITED', rate_limit_error: 'RATE_LIMITED', model_not_found: 'MODEL_NOT_AVAILABLE', invalid_api_key: 'HTTP_UNAUTHORIZED', authentication_error: 'HTTP_UNAUTHORIZED', context_length_exceeded: 'CONTEXT_LENGTH_EXCEEDED', context_window_exceeded: 'CONTEXT_LENGTH_EXCEEDED', prompt_too_long: 'CONTEXT_LENGTH_EXCEEDED', input_too_long: 'CONTEXT_LENGTH_EXCEEDED', max_output_tokens: 'OUTPUT_LIMIT', content_filter: 'CONTENT_FILTER', chatgpt_modelNotSupported: 'MODEL_NOT_AVAILABLE', chatgpt_quota: 'QUOTA_EXHAUSTED', chatgpt_auth: 'HTTP_UNAUTHORIZED', needs_reauth: 'HTTP_UNAUTHORIZED', authentication_required: 'HTTP_UNAUTHORIZED', chatgpt_stream_error: 'UPSTREAM_STREAM_INTERRUPTED' });
  function normalize(value) {
    if (!value || value.version !== 1 || typeof value.code !== 'string' || !Object.hasOwn(kinds, value.code)) return null;
    const result = { version: 1, code: value.code, category: kinds[value.code][0] };
    if (Number.isInteger(value.httpStatus) && value.httpStatus >= 400 && value.httpStatus <= 599) result.httpStatus = value.httpStatus;
    if (phases.has(value.phase)) result.phase = value.phase;
    if (protocols.has(value.protocol)) result.protocol = value.protocol;
    if (value.fallbackAttempted === true) result.fallbackAttempted = true;
    if (value.contextRecoveryAttempted === true) result.contextRecoveryAttempted = true;
    if (Number.isSafeInteger(value.retryAttempts) && value.retryAttempts > 0 && value.retryAttempts <= 10) result.retryAttempts = value.retryAttempts;
    return result;
  }
  const receipt = (code, options = {}) => normalize({ ...options, version: 1, code });
  function providerCode(failure) {
    if (!failure || typeof failure !== 'object') return null;
    return [failure.code, failure.type].filter(value => typeof value === 'string' && Object.hasOwn(providerCodes, value)).map(value => providerCodes[value])[0] || null;
  }
  function fromHttp(status, failure, { context = false, protocolMismatch = false } = {}) {
    const local = status === 502 && typeof failure?.code === 'string' && /^UPSTREAM_(DNS|TLS|CONNECT_TIMEOUT|CONNECTION|REDIRECT)/.test(failure.code) && Object.hasOwn(kinds, failure.code);
    const code = local ? failure.code : context ? 'CONTEXT_LENGTH_EXCEEDED' : providerCode(failure)
      || (status === 401 ? 'HTTP_UNAUTHORIZED' : status === 403 ? 'HTTP_FORBIDDEN' : status === 429 ? 'RATE_LIMITED'
        : protocolMismatch || [404, 405, 501].includes(status) ? 'ENDPOINT_UNAVAILABLE'
        : [400, 413, 422].includes(status) ? 'INVALID_REQUEST' : status >= 500 ? 'UPSTREAM_SERVICE_ERROR' : 'UPSTREAM_HTTP_ERROR');
    return receipt(code, { httpStatus: status, phase: local && phases.has(failure.phase) ? failure.phase : 'response' });
  }
  function fromStream(failure, reason) {
    return receipt(failure?.code === 'UPSTREAM_STREAM_INTERRUPTED' ? failure.code : providerCode(failure) || (typeof reason === 'string' && Object.hasOwn(providerCodes, reason) ? providerCodes[reason] : null) || 'MODEL_STREAM_ERROR', { phase: 'stream' });
  }
  function capture(error) {
    if (!error || ['CANCELLED', 'REPEATED_TOOL'].includes(error.code)) return null;
    const existing = normalize(error.diagnostic); if (existing) return existing;
    const aliases = { WEB_SEARCH_UNSUPPORTED: 'PROTOCOL_UNSUPPORTED', STREAM_ERROR: 'MODEL_STREAM_ERROR' };
    const code = aliases[error.code] || error.code;
    if (Object.hasOwn(kinds, code)) return receipt(code, { phase: ['CREDENTIAL_REENTRY_REQUIRED', 'MODEL_NOT_CONFIGURED', 'PROTOCOL_UNSUPPORTED'].includes(code) ? 'configuration' : undefined });
    if (code === 'HTTP' && Number.isInteger(error.status)) return fromHttp(error.status);
    return null;
  }
  function captureKnowledge(error) {
    const value = error?.knowledgeDiagnostic;
    if (!value || value.version !== 1 || !knowledgeCodes.has(value.code) || error.code != null && error.code !== value.code) return null;
    // An invalid container has no countable requests. Keep that unknown rather
    // than inventing zero, while actual batches must have safe integer counts.
    const unknown = value.requestCount === null && value.code === 'INVALID_KNOWLEDGE_REQUESTS';
    if (!unknown && (!Number.isSafeInteger(value.requestCount) || value.requestCount < 0)) return null;
    if (value.code === 'KNOWLEDGE_BATCH_REQUIRES_SPLIT' && value.requestCount <= knowledgeBatchLimit) return null;
    const result = { version: 1, code: value.code, requestCount: value.requestCount, batchLimit: knowledgeBatchLimit };
    for (const prefix of ['invalid', 'nonReadOnly']) {
      const count = value[prefix + 'Count'];
      if (Number.isSafeInteger(count) && count >= 0 && (unknown || count <= value.requestCount)) result[prefix + 'Count'] = count;
      if (Array.isArray(value[prefix + 'Indices'])) {
        const indices = unknown ? [] : [...new Set(value[prefix + 'Indices'].slice(0, knowledgeBatchLimit).filter(index => Number.isSafeInteger(index) && index >= 0 && index < value.requestCount))];
        // Contradictory partial indices cannot describe the retained count.
        if (result[prefix + 'Count'] === undefined || indices.length <= result[prefix + 'Count']) result[prefix + 'Indices'] = indices;
      }
    }
    return result;
  }
  function present(value, { language = 'zh' } = {}) {
    const d = normalize(value); if (!d) return null;
    const en = language === 'en', item = kinds[d.code], t = (zh, english) => en ? english : zh;
    const details = [{ label: t('错误代码', 'Error code'), value: d.code }];
    if (d.httpStatus) details.push({ label: 'HTTP', value: String(d.httpStatus) });
    const phaseNames = { configuration: ['配置', 'Configuration'], connection: ['建立连接', 'Connection setup'], response: ['等待或读取响应', 'Response'], stream: ['响应流', 'Response stream'] };
    if (d.phase) details.push({ label: t('发生阶段', 'Stage'), value: phaseNames[d.phase][en ? 1 : 0] });
    if (d.protocol) details.push({ label: t('本次接口', 'Request protocol'), value: d.protocol === 'chat' ? 'Chat Completions' : 'Responses API' });
    if (d.fallbackAttempted) details.push({ label: t('接口切换', 'Protocol fallback'), value: t('Responses 失败后已尝试 Chat Completions', 'Chat Completions was tried after Responses failed') });
    if (d.retryAttempts) details.push({ label: t('自动重试', 'Automatic retries'), value: t(`已重试 ${d.retryAttempts} 次`, `${d.retryAttempts} ${d.retryAttempts === 1 ? 'retry' : 'retries'}`) });
    let description = item[en ? 4 : 3];
    if (d.contextRecoveryAttempted) description += t(' 已缩减较早对话并重试一次，仍然超出容量。', ' Earlier conversation was reduced and retried once, but still exceeded capacity.');
    if (d.retryAttempts) description += t(` 尚未收到任何内容，已自动重试 ${d.retryAttempts} 次，仍然失败。`, ` Nothing had been received, so it was retried automatically ${d.retryAttempts} ${d.retryAttempts === 1 ? 'time' : 'times'} and still failed.`);
    return { title: item[en ? 2 : 1], description, action: item[5], actionLabel: item[5] === 'context' ? t('查看上下文', 'Review context') : item[5] === 'settings' ? t('检查模型设置', 'Check model settings') : '', details };
  }
  // Older runs sometimes have a reliable machine code but no receipt. Use
  // that code without interpreting the stored prose or inventing HTTP status.
  function forRun(run) {
    if (run?.status !== 'failed') return null;
    return normalize(run.errorDiagnostic) || normalize(captureKnowledge({ code: run.errorCode, knowledgeDiagnostic: run.knowledgeDiagnostic })) || capture({ code: run.errorCode });
  }
  return { normalize, receipt, fromHttp, fromStream, capture, captureKnowledge, forRun, present };
});
