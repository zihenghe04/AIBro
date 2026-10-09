import test from "node:test";
import assert from "node:assert/strict";
import { Store, MemoryAdapter, conflictReview } from "../src/store.js";
import { Sync } from "../src/sync.js";
import { SyncScheduler } from "../src/sync-scheduler.js";

const flush = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

class Clock {
  time = 0;
  sequence = 0;
  timers = new Map();
  now = () => this.time;
  setTimeout = (fn, ms) => {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.time + ms, fn });
    return id;
  };
  clearTimeout = (id) => this.timers.delete(id);
  async advance(ms) {
    const target = this.time + ms;
    await flush();
    let fired = 0;
    while (true) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      assert.ok(++fired < 1000, "timer loop must remain bounded");
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].fn();
      await flush();
    }
    this.time = target;
    await flush();
  }
}

async function fixture(options = {}) {
  const clock = new Clock();
  const store = await new Store(new MemoryAdapter()).load();
  const times = [];
  const sync = {
    busy: null,
    async perform() {
      await store.tx((s) => {
        for (const r of Object.values(s.records))
          if (!r.conflict) r.dirty = false;
        s.settings.lastSync = clock.now();
      });
    },
    run() {
      if (!this.busy) {
        times.push(clock.now());
        this.busy = Promise.resolve()
          .then(() => this.perform())
          .finally(() => (this.busy = null));
      }
      return this.busy;
    },
  };
  const scheduler = new SyncScheduler({
    store,
    sync,
    clock,
    authenticated: true,
    ...options,
  });
  await clock.advance(0);
  return { store, sync, clock, times, scheduler };
}

const put = (store, content, id = "note") =>
  store.put("notes", { id, content });

test("debounces real pending content, ignoring flight/cursor/draft/lastSync writes", async () => {
  const { store, clock, times, scheduler } = await fixture();
  assert.deepEqual(times, [0]);
  await put(store, "first");
  await clock.advance(1000);
  await store.tx((s) => {
    s.records["notes:note"].flight = { opId: "synthetic-flight" };
    s.records["notes:note"].version = 1;
    s.cursor = 4;
    s.drafts.chat = "unsent draft";
    s.settings.lastSync = 1000;
  });
  assert.equal(scheduler.snapshot.nextRunAt, 1500);
  await clock.advance(499);
  assert.equal(times.length, 1);
  await clock.advance(1);
  assert.deepEqual(times, [0, 1500]);
  await clock.advance(10000);
  assert.equal(
    times.length,
    2,
    "sync's own change events must not create a follow-up loop",
  );
  scheduler.dispose();
});

test("continuous edits cannot postpone upload beyond maxWait", async () => {
  const { store, clock, times, scheduler } = await fixture();
  for (let i = 0; i < 8; i++) {
    await put(store, `edit-${i}`);
    await clock.advance(1000);
  }
  assert.deepEqual(times, [0, 8000]);
  assert.equal(scheduler.snapshot.pendingCount, 0);
  scheduler.dispose();
});

test("pending deletion is debounced but acknowledged/conflicted records do not retrigger", async () => {
  const { store, clock, times, scheduler } = await fixture();
  await put(store, "first");
  await clock.advance(1500);
  await store.tx((s) => {
    const r = s.records["notes:note"];
    r.deleted = true;
    r.dirty = true;
  });
  assert.equal(scheduler.snapshot.pendingCount, 1);
  await clock.advance(1500);
  assert.equal(times.length, 3);
  await put(store, "conflicting");
  await store.tx((s) => {
    s.records["notes:note"].conflict = {
      version: 2,
      deleted: false,
      data: { id: "note", content: "remote" },
    };
  });
  assert.equal(scheduler.snapshot.pendingCount, 0);
  assert.equal(scheduler.snapshot.conflictCount, 1);
  await clock.advance(10000);
  assert.equal(times.length, 3);
  await store.resolve(
    "notes:note",
    "local",
    conflictReview(store.state.records["notes:note"]),
  );
  await clock.advance(1500);
  assert.equal(
    times.length,
    4,
    "a reviewed local conflict resolution becomes real pending work",
  );
  scheduler.dispose();
});

test("a real Sync edit during pull is pushed in a follow-up and cursor housekeeping does not loop", async () => {
  const clock = new Clock();
  const store = await new Store(new MemoryAdapter()).load();
  await store.tx((s) => (s.binding = { base: "https://sync.example" }));
  await put(store, "initial");
  const pull = deferred(),
    pushed = [];
  let pulls = 0;
  const sync = new Sync(
    store,
    async (url, options) => {
      if (url.endsWith("/capabilities")) throw Object.assign(Error("legacy fixture"), { status: 404 });
      if (url.endsWith("/push")) {
        pushed.push(...options.body.operations.map((op) => op.data.content));
        return {
          accepted: options.body.operations.map((op) => ({
            ...op,
            version: pushed.length,
          })),
          conflicts: [],
        };
      }
      if (++pulls === 1) await pull.promise;
      return { changes: [], cursor: 0, hasMore: false };
    },
    {
      get: async () =>
        JSON.stringify({
          base: "https://sync.example",
          token: "synthetic-fixture",
        }),
    },
    {},
  );
  const scheduler = new SyncScheduler({
    store,
    sync,
    clock,
    authenticated: true,
  });
  await clock.advance(0);
  assert.deepEqual(pushed, ["initial"]);
  assert.equal(pulls, 1);
  assert.equal(scheduler.snapshot.running, true);
  await clock.advance(400);
  await put(store, "written-during-pull");
  pull.resolve();
  await flush();
  assert.equal(scheduler.snapshot.pendingCount, 1);
  assert.equal(scheduler.snapshot.nextRunAt, 1900);
  await clock.advance(1500);
  assert.deepEqual(pushed, ["initial", "written-during-pull"]);
  assert.equal(scheduler.snapshot.pendingCount, 0);
  await clock.advance(10000);
  assert.equal(pulls, 2);
  scheduler.dispose();
});

test("adopts an already-running login sync and does not lose edits when it finishes", async () => {
  const { store, sync, clock, times, scheduler } = await fixture();
  const gate = deferred();
  sync.perform = () => gate.promise;
  const external = sync.run();
  await put(store, "late edit");
  assert.equal(scheduler.snapshot.running, true);
  assert.equal(times.length, 2, "adoption does not call run again");
  gate.resolve();
  await external;
  await flush();
  sync.perform = async () =>
    store.tx((s) => (s.records["notes:note"].dirty = false));
  await clock.advance(1500);
  assert.equal(times.length, 3);
  assert.equal(scheduler.snapshot.pendingCount, 0);
  scheduler.dispose();
});

test("a successful no-op with unchanged pending data waits for polling instead of looping", async () => {
  const { store, sync, clock, times, scheduler } = await fixture();
  sync.perform = async () =>
    store.tx((s) => (s.settings.lastSync = clock.now()));
  await put(store, "still pending");
  await clock.advance(1500);
  assert.equal(times.length, 2);
  assert.equal(scheduler.snapshot.pendingCount, 1);
  assert.equal(scheduler.snapshot.nextRunAt, 61500);
  await clock.advance(59999);
  assert.equal(times.length, 2);
  await clock.advance(1);
  assert.equal(times.length, 3);
  await put(store, "new content");
  await clock.advance(1500);
  assert.equal(times.length, 4);
  scheduler.dispose();
});

test("foreground idle polling pulls without local writes and pauses while hidden/offline", async () => {
  const { clock, times, scheduler } = await fixture();
  await clock.advance(120000);
  assert.deepEqual(times, [0, 60000, 120000]);
  scheduler.setForeground(false);
  assert.equal(clock.timers.size, 0);
  await clock.advance(300000);
  assert.equal(times.length, 3);
  scheduler.setOnline(false);
  scheduler.setForeground(true);
  await clock.advance(300000);
  assert.equal(times.length, 3);
  scheduler.setOnline(true);
  await clock.advance(0);
  assert.equal(
    times.length,
    4,
    "foreground reconnection catches up immediately",
  );
  assert.equal(clock.timers.size, 1);
  scheduler.setOnline(true);
  scheduler.setForeground(true);
  assert.equal(clock.timers.size, 1);
  scheduler.dispose();
});

test("binding alone never authorizes sync; login starts catch-up and logout stops timers", async () => {
  const { store, clock, times, scheduler } = await fixture({
    authenticated: false,
  });
  await store.tx(
    (s) => (s.binding = { base: "https://sync.example", username: "fixture" }),
  );
  await put(store, "offline work");
  await clock.advance(100000);
  assert.equal(times.length, 0);
  await assert.rejects(scheduler.runNow(), { code: "SYNC_NOT_CONNECTED" });
  scheduler.setAuthenticated(true);
  await clock.advance(0);
  assert.equal(times.length, 1);
  scheduler.setAuthenticated(false);
  assert.equal(clock.timers.size, 0);
  await clock.advance(100000);
  assert.equal(times.length, 1);
  scheduler.dispose();
});

test("exponential retries are capped, finite, and cannot be bypassed by edits or reconnect", async () => {
  const errors = [];
  const { store, sync, clock, times, scheduler } = await fixture({
    maxRetries: 3,
    retryMaxMs: 10000,
    onError: (e) => errors.push(e),
  });
  sync.perform = async () => {
    throw Error("synthetic outage");
  };
  await assert.rejects(scheduler.runNow(), /synthetic outage/);
  assert.equal(scheduler.snapshot.retryAt, 5000);
  await clock.advance(1000);
  await put(store, "new edit");
  scheduler.setOnline(false);
  scheduler.setOnline(true);
  scheduler.setForeground(false);
  scheduler.setForeground(true);
  assert.equal(scheduler.snapshot.nextRunAt, 5000);
  await clock.advance(4000);
  assert.equal(scheduler.snapshot.retryAt, 15000);
  await clock.advance(10000);
  assert.equal(scheduler.snapshot.retryAt, 25000);
  await clock.advance(10000);
  assert.equal(scheduler.snapshot.retryPaused, true);
  assert.equal(scheduler.snapshot.failures, 4);
  assert.equal(clock.timers.size, 0);
  await put(store, "another edit");
  scheduler.setOnline(false);
  scheduler.setOnline(true);
  await clock.advance(600000);
  assert.deepEqual(times, [0, 0, 5000, 15000, 25000]);
  assert.equal(errors.length, 4);
  sync.perform = async () =>
    store.tx((s) => (s.records["notes:note"].dirty = false));
  await scheduler.runNow();
  assert.equal(scheduler.snapshot.failures, 0);
  assert.equal(scheduler.snapshot.retryPaused, false);
  assert.equal(scheduler.snapshot.pendingCount, 0);
  assert.equal(scheduler.snapshot.nextRunAt, clock.now() + 60000);
  scheduler.dispose();
});

test("401 pauses all automatic work until manual retry or a new authenticated session", async () => {
  const { store, sync, clock, times, scheduler } = await fixture();
  sync.perform = async () => {
    throw Object.assign(Error("expired"), { status: 401 });
  };
  await assert.rejects(scheduler.runNow(), { status: 401 });
  assert.equal(scheduler.snapshot.authBlocked, true);
  assert.equal(scheduler.snapshot.retryAt, null);
  await put(store, "retained edit");
  scheduler.setForeground(false);
  scheduler.setOnline(false);
  scheduler.setForeground(true);
  scheduler.setOnline(true);
  await clock.advance(600000);
  assert.equal(times.length, 2);
  await assert.rejects(scheduler.runNow(), { status: 401 });
  assert.equal(
    times.length,
    3,
    "explicit retry allows exactly one more attempt before pausing",
  );
  assert.equal(scheduler.snapshot.authBlocked, true);
  sync.perform = async () =>
    store.tx((s) => (s.records["notes:note"].dirty = false));
  scheduler.setAuthenticated(true);
  await clock.advance(0);
  assert.equal(times.length, 4);
  assert.equal(scheduler.snapshot.authBlocked, false);
  scheduler.dispose();
});

test("an old session's late 401 cannot poison a replacement login", async () => {
  const failures = [];
  const { sync, clock, times, scheduler } = await fixture({
    onError: (error) => failures.push(error),
  });
  const gate = deferred();
  sync.perform = () => gate.promise;
  const old = scheduler.runNow();
  await flush();
  scheduler.setAuthenticated(false);
  scheduler.setAuthenticated(true);
  sync.perform = async () => {};
  gate.reject(Object.assign(Error("old expired token"), { status: 401 }));
  await assert.rejects(old, { status: 401 });
  assert.equal(scheduler.snapshot.authBlocked, false);
  assert.equal(failures.length, 0);
  await clock.advance(0);
  assert.equal(
    times.length,
    3,
    "replacement session is synchronized after the old run settles",
  );
  scheduler.dispose();
});

test("manual sync coalesces with in-flight work; offline/background calls do not start a request", async () => {
  const { sync, clock, times, scheduler } = await fixture();
  const gate = deferred();
  sync.perform = () => gate.promise;
  const first = scheduler.runNow(),
    second = scheduler.runNow();
  assert.equal(first, second);
  await flush();
  assert.equal(times.length, 2);
  scheduler.setOnline(false);
  await assert.rejects(scheduler.runNow(), { code: "SYNC_OFFLINE" });
  gate.resolve();
  await first;
  assert.equal(clock.timers.size, 0);
  scheduler.setForeground(false);
  scheduler.setOnline(true);
  await assert.rejects(scheduler.runNow(), { code: "SYNC_BACKGROUND" });
  await clock.advance(600000);
  assert.equal(times.length, 2);
  scheduler.dispose();
});

test("a late local edit follows an in-flight run immediately after its max wait has elapsed", async () => {
  const { store, sync, clock, times, scheduler } = await fixture();
  const gate = deferred();
  sync.perform = () => gate.promise;
  const running = scheduler.runNow();
  await flush();
  await put(store, "written during slow pull");
  await clock.advance(10000);
  assert.equal(times.length, 2);
  sync.perform = async () =>
    store.tx((s) => (s.records["notes:note"].dirty = false));
  gate.resolve();
  await running;
  await clock.advance(0);
  assert.deepEqual(times, [0, 0, 10000]);
  scheduler.dispose();
});

test("dispose cancels timers/subscriptions and suppresses late success/error callbacks", async () => {
  let successes = 0,
    errors = 0,
    states = 0;
  const { store, sync, clock, times, scheduler } = await fixture({
    onSuccess: () => successes++,
    onError: () => errors++,
    onStateChange: () => states++,
  });
  const gate = deferred();
  sync.perform = () => gate.promise;
  const running = scheduler.runNow();
  await flush();
  scheduler.dispose();
  const stateCount = states;
  gate.reject(Error("late failure"));
  await assert.rejects(running, /late failure/);
  await put(store, "after disposal");
  await clock.advance(600000);
  assert.equal(successes, 1);
  assert.equal(errors, 0);
  assert.equal(states, stateCount);
  assert.equal(times.length, 2);
  assert.equal(clock.timers.size, 0);
  await assert.rejects(scheduler.runNow(), { code: "SYNC_DISPOSED" });
});

test("UI callback failures do not become network retries", async () => {
  const { clock, times, scheduler } = await fixture({
    onSuccess: () => {
      throw Error("render failed");
    },
    onStateChange: async () => {
      throw Error("render failed asynchronously");
    },
  });
  assert.equal(scheduler.snapshot.failures, 0);
  assert.equal(scheduler.snapshot.nextRunAt, 60000);
  await clock.advance(60000);
  assert.equal(times.length, 2);
  assert.equal(scheduler.snapshot.retryPaused, false);
  scheduler.dispose();
});

test("an exhausted idle-pull retry budget requires explicit recovery even without pending writes", async () => {
  const { sync, clock, times, scheduler } = await fixture({ maxRetries: 0 });
  sync.perform = async () => {
    throw Error("pull unavailable");
  };
  await clock.advance(60000);
  assert.equal(scheduler.snapshot.pendingCount, 0);
  assert.equal(scheduler.snapshot.retryPaused, true);
  scheduler.setForeground(false);
  scheduler.setOnline(false);
  await clock.advance(300000);
  scheduler.setForeground(true);
  scheduler.setOnline(true);
  await clock.advance(600000);
  assert.deepEqual(times, [0, 60000]);
  sync.perform = async () => {};
  await scheduler.runNow();
  await clock.advance(60000);
  assert.deepEqual(times, [0, 60000, 960000, 1020000]);
  scheduler.dispose();
});
