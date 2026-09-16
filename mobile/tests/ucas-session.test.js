import test from "node:test";
import assert from "node:assert/strict";
import { UCAS } from "../src/ucas.js";
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const vault = () => {
  const data = new Map();
  return {
    get: async (k) => data.get(k),
    set: async (k, v) => data.set(k, v),
    remove: async (k) => data.delete(k),
  };
};
const loginResponse = (sessionId = "old", id = "1") => ({
  STATUS: 0,
  result: { id, sessionId, studentNo: "student-" + id },
});
const daily = {
  STATUS: 0,
  result: [
    {
      id: "1234567",
      courseName: "数学",
      classBeginTime: "08:30",
      classEndTime: "09:20",
    },
  ],
};
test("opt-in credentials survive reopening, coalesce expired queries, and are erased on logout", async () => {
  const v = vault(),
    gate = deferred();
  let logins = 0;
  const http = async (url, options) => {
    if (url.includes("login.action")) {
      logins++;
      const body = new URLSearchParams(options.body);
      assert.equal(body.get("verificationType"), "1");
      assert.equal(body.get("phone"), "sep@example.test");
      assert.equal(body.get("password"), "synthetic-password");
      if (logins === 2) await gate.promise;
      return loginResponse(logins === 1 ? "old" : "fresh");
    }
    if (options.headers.sessionId === "old")
      return { STATUS: 1, ERRMSG: "会话已过期，请重新登录" };
    assert.equal(options.headers.sessionId, "fresh");
    return daily;
  };
  await new UCAS(http, v).login(" sep@example.test ", "synthetic-password", {
    remember: true,
  });
  const reopened = new UCAS(http, v);
  const a = reopened.courses("20260916"),
    b = reopened.courses("20260916");
  await new Promise((r) => setImmediate(r));
  assert.equal(logins, 2);
  gate.resolve();
  const results = await Promise.all([a, b]);
  assert.equal(results[0][0].owner, "1");
  assert.equal(logins, 2);
  await reopened.logout();
  assert.equal(await v.get("ucas"), undefined);
  await assert.rejects(reopened.session(), /先连接/);
});
test("non-opt-in expiry, network failure, and malformed success do not silently authenticate", async () => {
  const v = vault();
  let calls = 0;
  const u = new UCAS(async () => {
    calls++;
    return loginResponse();
  }, v);
  await u.login("student", "password");
  u.http = async () => {
    calls++;
    throw Object.assign(Error("unauthorized"), { status: 401 });
  };
  await assert.rejects(u.courses("20260916"), /过期/);
  assert.equal(calls, 2);
  await assert.rejects(u.login("student", "password"));
  assert.equal(JSON.parse(await v.get("ucas")).credentials, undefined);
  u.http = async () => {
    throw Error("offline");
  };
  await assert.rejects(u.courses("20260916"), /offline/);
  u.http = async () => ({ STATUS: 0, result: {} });
  await assert.rejects(u.courses("20260916"), /有效课表/);
});
test("logout cancels delayed login and reauthentication without resurrecting a session", async () => {
  const v = vault(),
    first = deferred();
  const u = new UCAS(async () => {
    await first.promise;
    return loginResponse();
  }, v);
  const login = assert.rejects(
    u.login("student", "password", { remember: true }),
    /已切换/,
  );
  await u.logout();
  first.resolve();
  await login;
  assert.equal(await v.get("ucas"), undefined);
  u.http = async () => loginResponse();
  await u.login("student", "password", { remember: true });
  const recovery = deferred();
  let reached = false;
  u.http = async (url) => {
    if (url.includes("login.action")) {
      reached = true;
      await recovery.promise;
      return loginResponse("new");
    }
    return { STATUS: 1, ERRMSG: "请重新登录" };
  };
  const query = assert.rejects(u.courses("20260916"), /已切换/);
  await new Promise((r) => setImmediate(r));
  assert.equal(reached, true);
  await u.logout();
  recovery.resolve();
  await query;
  assert.equal(await v.get("ucas"), undefined);
});
test("account switch rejects stale courses and prevents attendance after a delayed school clock", async () => {
  const v = vault(),
    gate = deferred();
  const u = new UCAS(async () => loginResponse(), v);
  await u.login("first", "password");
  u.http = async () => {
    await gate.promise;
    return daily;
  };
  const stale = assert.rejects(u.courses("20260916"), /已切换/);
  await new Promise((r) => setImmediate(r));
  u.http = async () => loginResponse("second", "2");
  await u.login("second", "password");
  gate.resolve();
  await stale;
  await assert.rejects(u.sign({ id: "1234567", owner: "1" }), /之前的学校账号/);
  const clock = deferred();
  let signs = 0;
  u.http = async (url) => {
    if (url.includes("get_timestamp")) {
      await clock.promise;
      return { STATUS: 0, timestamp: Date.now() };
    }
    signs++;
    return { STATUS: 0, result: { stuSignStatus: 1 } };
  };
  const signing = assert.rejects(
    u.sign({ id: "1234567", owner: "2" }),
    /已切换/,
  );
  await new Promise((r) => setImmediate(r));
  await u.logout();
  clock.resolve();
  await signing;
  assert.equal(signs, 0);
});
test("reauthentication retries the read only once and rejects identity mismatch", async () => {
  const v = vault();
  let logins = 0,
    reads = 0;
  const u = new UCAS(async () => loginResponse(), v);
  await u.login("student", "password", { remember: true });
  u.http = async (url) => {
    if (url.includes("login.action")) {
      logins++;
      return loginResponse("new");
    }
    reads++;
    throw Object.assign(Error("unauthorized"), { status: 403 });
  };
  await assert.rejects(u.courses("20260916"));
  assert.equal(logins, 1);
  assert.equal(reads, 2);
  u.http = async (url) =>
    url.includes("login.action")
      ? loginResponse("other", "2")
      : { STATUS: 1, ERRMSG: "未登录" };
  await assert.rejects(u.courses("20260916"), /账号与原会话不一致/);
  assert.equal((await u.session()).userId, "1");
});
