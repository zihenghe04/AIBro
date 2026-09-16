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
