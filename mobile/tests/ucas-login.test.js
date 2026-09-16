import test from "node:test";
import assert from "node:assert/strict";
import { UCAS, parseLoginResponse } from "../src/ucas.js";

test("school rejection, incomplete identity and malformed responses stay distinct and never save sessions", async () => {
  const cases = [
    [{ STATUS: 1, ERRCODE: 401, ERRMSG: "密码验证失败" }, /LOGIN_REJECTED.*401/],
    [{ STATUS: 0, result: { id: "u", sessionId: "secret-session" } }, /studentNo.*LOGIN_INCOMPLETE/],
    [{ STATUS: 0, result: { id: "u", sessionId: "   ", studentNo: "student" } }, /sessionId.*LOGIN_INCOMPLETE/],
    [null, /LOGIN_BAD_RESPONSE/],
    [{}, /LOGIN_BAD_RESPONSE/],
    [{ STATUS: 0, success: false, result: { id: "u", sessionId: "s", studentNo: "n" } }, /LOGIN_REJECTED/],
    [{ STATUS: 0, ERRCODE: 9, result: { id: "u", sessionId: "s", studentNo: "n" } }, /LOGIN_REJECTED/],
  ];
  for (const [response, expected] of cases) {
    let writes = 0;
    const ucas = new UCAS(async () => response, { set: async () => writes++ });
    await assert.rejects(ucas.login("test@example.test", "test-password"), expected);
    assert.equal(writes, 0);
    assert.equal(ucas.loginPending, false);
  }
});

test("login diagnostics omit raw school error and identity values", () => {
  const secret = "private-token-email-password";
  for (const response of [
    { STATUS: secret, ERRCODE: secret, ERRMSG: secret, result: { msg: secret } },
    { STATUS: 0, result: { id: secret, sessionId: secret } },
  ]) {
    assert.throws(() => parseLoginResponse(response), (error) => !error.message.includes(secret));
  }
  assert.deepEqual(parseLoginResponse({ STATUS: "0", result: { id: 12, sessionId: " s ", studentNo: " n " } }),
    { userId: "12", sessionId: "s", studentNo: "n" });
});
