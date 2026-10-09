import test from "node:test";
import assert from "node:assert/strict";
import { httpError } from "../src/http-error.js";

test("login rejection and expired session have distinct actionable messages", () => {
  const login = httpError(401, JSON.stringify({ code: "invalid_credentials" }));
  const session = httpError(401, JSON.stringify({ code: "unauthorized" }));
  assert.match(login.message, /不是 SSH/);
  assert.match(session.message, /登录已失效/);
  assert.equal(login.status, 401);
  assert.equal(login.code, "invalid_credentials");
  assert.notEqual(login.message, session.message);
});

test("unknown, malformed and sensitive response bodies are not surfaced", () => {
  for (const data of ["secret-token", {code:"secret-token",error:"secret-token"}, new Uint8Array([1]), null]) {
    const error = httpError(502, data);
    assert.equal(error.message, "请求未完成（502），请检查连接或重新登录");
    assert.equal(error.code, undefined);
  }
});

test("model HTTP errors point to model settings, not cloud login, without leaking bodies", async () => {
  const { modelHttpError, modelTransportError } = await import("../src/http-error.js");
  for (const [status, hint] of [[400, /工具调用/], [401, /模型 API Key/], [403, /模型权限/], [404, /接口或模型不存在/], [429, /额度/], [503, /暂时不可用/]]) {
    const error = modelHttpError(status, '{"error":"private-token-fixture"}');
    assert.equal(error.status, status); assert.match(error.message, hint);
    assert.doesNotMatch(error.message, /private-token|重新登录/);
  }
  assert.equal(modelHttpError(403, { code: "model_origin_denied" }).code, "model_origin_denied");
  assert.match(modelTransportError("服务未返回 SSE 流式内容，请检查模型接口").message, /未返回流式响应/);
  assert.match(modelTransportError("连接超时；提交结果请刷新核对。（网络错误 -1001）").message, /模型响应超时/);
  assert.match(modelTransportError("HTTPS 安全连接失败，请检查证书或代理配置。").message, /HTTPS/);
  for (const unsafe of ["secret-token", "服务未返回 SSE 流式内容，请检查模型接口 secret-token", null, {error:"private"}])
    assert.equal(modelTransportError(unsafe).message, "模型连接中断，请检查网络后重试");
});
