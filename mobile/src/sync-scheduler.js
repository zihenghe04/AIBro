import { canonical } from "./store.js";

export const SYNC_SCHEDULE_DEFAULTS = Object.freeze({
  debounceMs: 1500,
  maxWaitMs: 8000,
  pollIntervalMs: 60000,
  retryBaseMs: 5000,
  retryMaxMs: 60000,
  maxRetries: 5,
});

const systemClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};
const skipped = Symbol("sync skipped");

// Sync's own acknowledgements/cursor/lastSync transactions emit change too.
// Compare only the content that can actually be pushed, not flight metadata.
function pendingContent(store) {
  const pending = new Map();
  let conflicts = 0;
  for (const [key, record] of Object.entries(store.state.records)) {
    if (record.conflict) conflicts++;
    else if (record.dirty)
      pending.set(
        key,
        canonical([!!record.deleted, record.deleted ? null : record.data]),
      );
  }
  return { pending, conflicts };
}

function samePending(a, b) {
  return (
    a.size === b.size && [...a].every(([key, value]) => b.get(key) === value)
  );
}

/**
 * Owns automatic scheduling, not the sync protocol or credentials.
 * `authenticated` must come from the saved session, never workspace binding.
 * Call setAuthenticated(true) after a new login, including recovery from 401.
 * runNow() is the explicit retry action; it resets both retry/auth pauses.
 * Clock methods use milliseconds and may be injected for deterministic tests.
 */
export class SyncScheduler {
  constructor({
    store,
    sync,
    authenticated = false,
    foreground = true,
    online = true,
    clock = systemClock,
    onSuccess,
    onError,
    onStateChange,
    ...options
  }) {
    this.store = store;
    this.sync = sync;
    this.clock = clock;
    this.options = { ...SYNC_SCHEDULE_DEFAULTS, ...options };
    for (const [key, value] of Object.entries(this.options)) {
      if (
        !Number.isSafeInteger(value) ||
        value < (key === "maxRetries" ? 0 : 1)
      )
        throw TypeError(`Invalid sync scheduler option: ${key}`);
    }
    this.onSuccess = onSuccess;
    this.onError = onError;
    this.onStateChange = onStateChange;
    this.authenticated = !!authenticated;
    this.foreground = !!foreground;
    this.online = !!online;
    this.disposed = false;
    this.authBlocked = false;
    this.retryPaused = false;
    this.failures = 0;
    this.retryAt = null;
    this.nextRunAt = null;
    this._epoch = 0;
    this._revision = 0;
    this._running = null;
    this._timer = null;
    this._dirtySince = null;
    this._dirtyTouchedAt = null;
    this._pollAt = clock.now();
    this._pending = new Map();
    this._refreshPending();
    this._onChange = () => {
      if (this.disposed) return;
      this._refreshPending();
      this._schedule();
    };
    store.addEventListener("change", this._onChange);
    this._schedule();
  }

  get snapshot() {
    return {
      running: !!this._running,
      authenticated: this.authenticated,
      foreground: this.foreground,
      online: this.online,
      pendingCount: this._pending.size,
      conflictCount: this._conflicts,
      authBlocked: this.authBlocked,
      retryPaused: this.retryPaused,
      failures: this.failures,
      retryAt: this.retryAt,
      nextRunAt: this.nextRunAt,
      disposed: this.disposed,
    };
  }

  setAuthenticated(authenticated) {
    if (this.disposed) return;
    // An explicit true also represents a replacement/repaired login session.
    this._epoch++;
    this.authenticated = !!authenticated;
    this._resetRetry();
    this._pollAt = this.clock.now();
    this._schedule();
  }

  setForeground(foreground) {
    if (this.disposed || this.foreground === !!foreground) return;
    this.foreground = !!foreground;
    if (this.foreground) this._pollAt = this.clock.now();
    this._schedule();
  }

  setOnline(online) {
    if (this.disposed || this.online === !!online) return;
    this.online = !!online;
    if (this.online) this._pollAt = this.clock.now();
    this._schedule();
  }

  runNow() {
    const code = this.disposed
      ? "SYNC_DISPOSED"
      : !this.authenticated
        ? "SYNC_NOT_CONNECTED"
        : !this.foreground
          ? "SYNC_BACKGROUND"
          : !this.online
            ? "SYNC_OFFLINE"
            : null;
    if (code) {
      const messages = {
        SYNC_DISPOSED: "同步调度已关闭",
        SYNC_NOT_CONNECTED: "请先连接同步账号",
        SYNC_BACKGROUND: "请回到前台后同步",
        SYNC_OFFLINE: "当前离线，联网后可重试同步",
      };
      return Promise.reject(Object.assign(Error(messages[code]), { code }));
    }
    this._resetRetry();
    this._clearTimer();
    if (this._running) {
      this._emit();
      return this._running.promise;
    }
    this._refreshPending();
    return this._start(this.sync.busy);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.store.removeEventListener("change", this._onChange);
    this._clearTimer();
    this._emit();
    // Sync has no cancellation API. Its in-flight durable transaction may finish;
    // completion callbacks and all subsequent network scheduling are suppressed.
  }

  _refreshPending() {
    const { pending, conflicts } = pendingContent(this.store);
    const changed = [...pending].some(
      ([key, value]) => this._pending.get(key) !== value,
    );
    this._pending = pending;
    this._conflicts = conflicts;
    if (!pending.size) {
      this._dirtySince = this._dirtyTouchedAt = null;
    } else if (changed) {
      const now = this.clock.now();
      this._dirtySince ??= now;
      this._dirtyTouchedAt = now;
      this._revision++;
    }
  }

  _eligible() {
    return (
      !this.disposed &&
      this.authenticated &&
      this.foreground &&
      this.online &&
      !this.authBlocked &&
      !this.retryPaused
    );
  }

  _resetRetry() {
    this.authBlocked = this.retryPaused = false;
    this.failures = 0;
    this.retryAt = null;
  }

  _clearTimer() {
    if (this._timer !== null) this.clock.clearTimeout(this._timer);
    this._timer = null;
    this.nextRunAt = null;
  }

  _schedule() {
    this._clearTimer();
    if (this.disposed) return;
    // login() and legacy callers may already be running Sync. Observe that
    // promise so a local write during its pull phase is not stranded.
    if (!this._running && this.sync.busy) {
      this._start(this.sync.busy);
      return;
    }
    if (!this._running && this._eligible()) {
      let due = this._pollAt;
      if (this._dirtySince !== null) {
        due = Math.min(
          due,
          this._dirtyTouchedAt + this.options.debounceMs,
          this._dirtySince + this.options.maxWaitMs,
        );
      }
      // Neither more edits nor reconnect/resume may bypass failure backoff.
      if (this.retryAt !== null) due = this.retryAt;
      this.nextRunAt = Math.max(this.clock.now(), due);
      this._timer = this.clock.setTimeout(() => {
        this._clearTimer();
        if (this._eligible()) this._start(this.sync.busy);
      }, this.nextRunAt - this.clock.now());
    }
    this._emit();
  }

  _start(external) {
    const cycle = {
      epoch: this._epoch,
      pending: this._pending,
      revision: this._revision,
      external: !!external,
      promise: null,
    };
    this._clearTimer();
    this._running = cycle;
    cycle.promise = Promise.resolve()
      .then(() => external || (this._eligible() ? this.sync.run() : skipped))
      .then(
        (value) => {
          this._finish(cycle, null, value);
          return value === skipped ? undefined : value;
        },
        (error) => {
          this._finish(cycle, error);
          throw error;
        },
      );
    // Automatic/adopted calls have no awaiting UI. Manual callers still receive
    // the original rejecting promise and can display the actual failure.
    cycle.promise.catch(() => {});
    this._emit();
    return cycle.promise;
  }

  _finish(cycle, error, value) {
    this._running = null;
    if (this.disposed) return;
    this._refreshPending();
    if (
      cycle.epoch === this._epoch &&
      this.authenticated &&
      value !== skipped
    ) {
      if (error) {
        this.failures++;
        this.authBlocked = Number(error.status) === 401;
        // maxRetries counts retries AFTER the initial failed attempt.
        this.retryPaused =
          !this.authBlocked && this.failures > this.options.maxRetries;
        this.retryAt =
          this.authBlocked || this.retryPaused
            ? null
            : this.clock.now() +
              Math.min(
                this.options.retryMaxMs,
                this.options.retryBaseMs * 2 ** (this.failures - 1),
              );
        this._call(this.onError, error);
      } else {
        this._resetRetry();
        this._pollAt = this.clock.now() + this.options.pollIntervalMs;
        if (this._pending.size) {
          const noProgress =
            !cycle.external &&
            cycle.revision === this._revision &&
            samePending(cycle.pending, this._pending);
          if (noProgress) {
            // A stale session flag or a successful no-op must not continuously
            // rerun the same queue. Keep idle polling and wait for a real edit.
            this._dirtySince = this._dirtyTouchedAt = null;
          } else {
            this._dirtySince ??= this.clock.now();
            this._dirtyTouchedAt ??= this.clock.now();
          }
        }
        this._call(this.onSuccess, value);
      }
    }
    this._schedule();
  }

  _call(callback, value) {
    // Rendering/notification failures are not network failures and must never
    // consume retries or cause a second sync operation.
    try {
      Promise.resolve(callback?.(value)).catch(() => {});
    } catch {
      /* UI callback */
    }
  }

  _emit() {
    this._call(this.onStateChange, this.snapshot);
  }
}
