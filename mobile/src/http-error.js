// Only known protocol codes are exposed; never display arbitrary server bodies.
export function httpError(status, data) {
  let code;
  try {
    const payload = typeof data === "string" ? JSON.parse(data) : data;
    if (["invalid_credentials", "unauthorized", "rate_limited", "origin_denied", "model_origin_denied", "upstream_unavailable", "upstream_http_error", "upstream_auth_expired", "relay_denied", "school_unavailable", "school_origin_denied", "school_request_invalid", "school_rate_limited"].includes(payload?.code))
      code = payload.code;
  } catch {}
  const messages = {
    school_unavailable: "暂时无法连接学校服务，请稍后重试；无需配置云同步。",
    school_origin_denied: "请从正式 AI Bro 网页打开课程助手。",
    school_request_invalid: "课程请求信息不完整，请刷新课程或重新连接学校账号。",
    school_rate_limited: "课程请求较频繁，请一分钟后再试。",
    invalid_credentials: "云同步账号或密码不匹配。请使用 AI Bro 云同步密码，不是 SSH 或学校账号密码。",
    unauthorized: "云同步登录已失效，请重新连接。已保存的本地资料会保留。",
    origin_denied: "当前网页地址尚未获得服务器授权，请将它加入 CLOUD_WEB_ORIGINS。",
    model_origin_denied: "请在同步服务器的 CLOUD_MODEL_ORIGINS 中允许你配置的模型域名。",
    upstream_unavailable: "同步服务已连接，但学校或模型服务暂时无法访问，请稍后重试。",
    upstream_http_error: "学校或模型服务拒绝了请求，请核对对应账号或 API Key。",
    upstream_auth_expired: "学校会话已失效，请重新连接学校账号。",
    relay_denied: "服务器不允许转接这个接口，请检查服务地址。",
    rate_limited: "登录尝试过于频繁，请稍后重试。",
  };
  const error = Error(messages[code] || `请求未完成（${status}），请检查连接或重新登录`);
  error.status = status;
  if (code) error.code = code;
  return error;
}

// Model failures must not send the user to cloud/account login. Keep known relay
// diagnostics, but never expose the provider's arbitrary response or credentials.
export function modelHttpError(status, data) {
  const error = httpError(status, data);
  if (error.code) return error;
  const messages = {
    400: "模型服务不接受本次请求，请检查模型名称、接口格式及工具调用支持。",
    401: "模型 API Key 未通过验证，请在设置 → 模型连接中重新填写。",
    403: "模型服务拒绝访问，请检查 API Key 的模型权限或服务额度。",
    404: "模型接口或模型不存在，请检查 API 基址、模型名称及接口格式。",
    429: "模型服务请求过多或额度不足，请稍后重试或检查服务额度。",
  };
  error.message = messages[status] || (status >= 500 ? `模型服务暂时不可用（${status}），请稍后重试。` : `模型请求未完成（${status}），请检查模型连接设置。`);
  return error;
}

export function modelTransportError(message) {
  // Exact native strings only. Native NSError suffixes contain numeric codes;
  // strip them for matching, never interpolate arbitrary bridge diagnostics.
  const safe = typeof message === "string" ? message.replace(/（网络错误 -?\d{1,6}）$/, "") : "";
  const hints = new Map([
    ["服务未返回 SSE 流式内容，请检查模型接口", "模型服务未返回流式响应，请检查接口类型与模型配置"],
    ["HTTPS 安全连接失败，请检查证书或代理配置。", "模型 HTTPS 连接失败，请检查证书或代理配置。"],
    ["流式连接超时；已接收的内容已保留", "模型响应超时，已接收的内容已保留，请稍后重试。"],
    ["连接超时；提交结果请刷新核对。", "模型响应超时，已接收的内容已保留，请稍后重试。"],
    ["无法解析服务器地址，请检查地址与 Tailscale 连接。", "无法解析模型服务器地址，请检查 API 地址与网络。"],
    ["无法连接服务器，请检查网络与 Tailscale 是否在线。", "无法连接模型服务器，请检查网络或代理配置。"],
    ["服务器返回了无效的 UTF-8 内容", "模型服务返回的文字编码无效，请检查接口配置。"],
    ["服务器返回的 UTF-8 内容不完整", "模型流式文字不完整，请重试。"],
    ["返回内容过大", "模型返回内容超过大小限制，已接收的内容已保留。"],
  ]);
  return Error(hints.get(safe) || "模型连接中断，请检查网络后重试");
}
