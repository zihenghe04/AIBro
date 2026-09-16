import test from "node:test";
import assert from "node:assert/strict";
import { UCAS, qrURL } from "../src/ucas.js";
import {
  schoolDay,
  courseInstant,
  currentAndNext,
  autoAttend,
} from "../src/course-time.js";
import { Store, MemoryAdapter } from "../src/store.js";
const course = (id, start, end, title = "课程") => ({
  id,
  title,
  day: "20260916",
  start,
  end,
  signed: false,
});
const now = Date.parse("2026-09-16T08:30:00+08:00");
test("school day, current and next remain correct overseas and skip contiguous same-name sessions", () => {
  assert.equal(schoolDay(Date.parse("2026-09-15T18:00:00Z")), "20260916");
  assert.equal(courseInstant("20260916", "8：30"), now);
  assert.equal(courseInstant("20260916", "0830"), now);
  assert.equal(courseInstant("20260916", "2026-09-16 08:30:00"), now);
  assert.ok(Number.isNaN(courseInstant("20260916", "25:70")));
  const list = [
    course("1", "08:30", "09:20", "数学"),
    course("2", "09:30", "10:20", "数学"),
    course("3", "10:30", "12:00", "论文讨论"),
  ];
  assert.equal(currentAndNext(list, now - 10 * 60000).current.id, "1");
  assert.equal(currentAndNext(list, now).next.id, "3");
  assert.equal(currentAndNext(list, now + 86400000).current, undefined);
});
test("QR content follows verified identifier rules and contains no account session", () => {
  const url = new URL(qrURL("a1b2c3d4-1234-5678-9012-abcdef123456", now));
  assert.equal(
    url.searchParams.get("timeTableId"),
    "A1B2C3D4123456789012ABCDEF123456",
  );
  assert.equal(
    new URL(qrURL("1234567", now)).searchParams.get("courseSchedId"),
    "1234567",
  );
  assert.equal(url.searchParams.get("sessionId"), null);
  assert.throws(() => qrURL("bad", now));
});
test("school clock caches for thirty seconds and refuses stale or failed samples", async () => {
  const original = Date.now;
  let clock = now,
    calls = 0;
  Date.now = () => clock;
  try {
    const u = new UCAS(async () => {
      calls++;
      clock += 100;
      return { STATUS: 0, timestamp: clock };
    }, {});
    const q = await u.qr("1234567");
    assert.equal(q.expiresAt, clock + 5000);
    clock += 2000;
    await u.qr("1234567");
    assert.equal(calls, 1);
    clock += 30000;
    await u.qr("1234567");
    assert.equal(calls, 2);
    u.http = async () => ({ STATUS: 1, timestamp: clock });
    clock += 30000;
    await assert.rejects(u.qr("1234567"));
    assert.equal(u.clock, null);
  } finally {
    Date.now = original;
  }
});
test("automatic attendance is explicit, foreground-only, once-per-course and durable after uncertain outcome", async () => {
  const adapter = new MemoryAdapter(),
    store = await new Store(adapter).load();
  let calls = 0;
  const ucas = {
    sign: async () => {
      calls++;
      throw Error("lost response");
    },
  };
  const courses = [course("1", "08:30", "09:20")];
  await autoAttend({ ucas, store, courses, now });
  assert.equal(calls, 0);
  await store.tx(
    (s) =>
      (s.settings.ucasAuto = { day: "20260916", enabled: true, attempts: {} }),
  );
  await autoAttend({ ucas, store, courses, now, visible: false });
  assert.equal(calls, 0);
  await Promise.all([
    autoAttend({ ucas, store, courses, now }),
    autoAttend({ ucas, store, courses, now }),
  ]);
  assert.equal(calls, 1);
  const reopened = await new Store(adapter).load();
  await autoAttend({ ucas, store: reopened, courses, now });
  assert.equal(calls, 1);
  assert.equal(
    reopened.state.settings.ucasAuto.attempts["20260916:1"].status,
    "unknown",
  );
  await autoAttend({ ucas, store: reopened, courses, now: now + 86400000 });
  assert.equal(calls, 1);
});
test("malformed weekly fallback cannot masquerade as an empty successful course query", async () => {
  const u = new UCAS(
    async () => ({ STATUS: 1, result: { message: "expired" } }),
    {
      get: async () =>
        JSON.stringify({ userId: "1", sessionId: "s", studentNo: "student" }),
    },
  );
  await assert.rejects(u.courses("20260916"));
});
