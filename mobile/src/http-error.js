// Only known protocol codes are exposed; never display arbitrary server bodies.
export function httpError(status, data) {
  let code;
  try {
    const payload = typeof data === "string" ? JSON.parse(data) : data;
    if (["invalid_credentials", "unauthorized", "rate_limited"].includes(payload?.code))
      code = payload.code;
  } catch {}
  const messages = {
    invalid_credentials: "云同步账号或密码不匹配。请使用 AI Bro 云同步密码，不是 SSH 或学校账号密码。",
    unauthorized: "云同步登录已失效，请重新连接。已保存的本地资料会保留。",
    rate_limited: "登录尝试过于频繁，请稍后重试。",
  };
  const error = Error(messages[code] || `请求未完成（${status}），请检查连接或重新登录`);
  error.status = status;
  if (code) error.code = code;
  return error;
}
