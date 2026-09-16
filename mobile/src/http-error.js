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
