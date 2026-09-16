import { clone, equal, keyOf, id } from "./store.js";
export function serverURL(raw) {
  const u = new URL(raw);
  if (
    u.protocol !== "https:" &&
    !(
      u.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)
    )
  )
    throw Error("同步服务必须使用 HTTPS");
  if (u.username || u.password || u.search || u.hash)
    throw Error("服务器地址不能包含凭据或参数");
  return u.href.replace(/\/$/, "");
}
export class Sync {
  constructor(store, http, vault, files) {
    Object.assign(this, { store, http, vault, files });
    this.busy = null;
    this.status = "尚未连接";
  }
  async login(raw, username, password) {
    const base = serverURL(raw),
      old = this.store.state.binding;
    if (
      old &&
      (old.base !== base || old.username !== username.trim().toLowerCase())
    )
      throw Error("当前工作区已绑定其他账号或服务，请勿混合资料");
    const session = await this.http(base + "/v1/auth/login", {
      method: "POST",
      body: { username, password, deviceName: "AI Bro iPhone" },
    });
    if (!session.accessToken || !session.account?.id)
      throw Error("登录响应不完整");
    if (old && old.accountID !== session.account.id)
      throw Error("账号标识变化，已停止合并");
    await this.vault.set(
      "sync",
      JSON.stringify({ base, token: session.accessToken }),
    );
    await this.store.tx((s) => {
      s.binding = {
        base,
        username: session.account.username,
        accountID: session.account.id,
        deviceID: session.device.id,
      };
    });
    return this.run();
  }
  async logout() {
    const saved = await this.vault.get("sync");
    try {
      if (saved) {
        const v = JSON.parse(saved);
        await this.http(v.base + "/v1/auth/logout", {
          method: "POST",
          headers: { Authorization: "Bearer " + v.token },
          body: {},
        });
      }
    } finally {
      await this.vault.remove("sync");
      this.status = "已断开，内容保留";
    }
  }
  run() {
    if (!this.busy)
      this.busy = this.perform().finally(() => {
        this.busy = null;
      });
    return this.busy;
  }
  async perform() {
    const saved = await this.vault.get("sync");
    if (!saved) {
      this.status = "尚未连接";
      return;
    }
    const { base, token } = JSON.parse(saved);
    if (base !== this.store.state.binding?.base) throw Error("同步账号不匹配");
    const call = (path, opt = {}) =>
      this.http(base + path, {
        ...opt,
        headers: { ...opt.headers, Authorization: "Bearer " + token },
      });
    this.status = "同步中";
    try {
      // Store exact immutable operations BEFORE sending, so a dropped response can be replayed after restart.
      for (let round = 0; round < 20; round++) {
        const ops = await this.store.tx((s) => {
          const result = [];
          for (const [key, r] of Object.entries(s.records)) {
            if (!r.dirty || r.conflict) continue;
            if (!r.flight) {
              const split = key.indexOf(":");
              r.flight = {
                opId: id(),
                entityType: key.slice(0, split),
                entityId: key.slice(split + 1),
                baseVersion: r.version,
                deleted: r.deleted,
                data: r.deleted ? null : clone(r.data),
              };
            }
            result.push(clone(r.flight));
            if (result.length === 100) break;
          }
          return result;
        });
        if (!ops.length) break;
        for (const op of ops) {
          if (op.entityType === "imports" && op.data?.blobHash) {
            const hash = op.data.blobHash;
            const blob = this.store.state.blobs[hash];
            if (blob && !blob.uploaded) {
              const data = await this.files.read(hash);
              await call("/v1/blobs/" + hash, { method: "PUT", bytes: data });
              await this.store.tx((s) => {
                if (s.blobs[hash]) s.blobs[hash].uploaded = true;
              });
            }
          }
        }
        const result = await call("/v1/sync/push", {
          method: "POST",
          body: { operations: ops },
        });
        if (!Array.isArray(result.accepted) || !Array.isArray(result.conflicts))
          throw Error("同步响应格式错误");
        const handled = new Set(
          [...result.accepted, ...result.conflicts].map((x) => x.opId),
        );
        if (ops.some((x) => !handled.has(x.opId)))
          throw Error("服务器未确认全部操作，保留重试队列");
        await this.store.tx((s) => {
          for (const ack of result.accepted) {
            const r = s.records[keyOf(ack.entityType, ack.entityId)];
            if (!r?.flight || r.flight.opId !== ack.opId) continue;
            const sent = r.flight;
            r.version = ack.version;
            r.remote = clone(sent.data);
            r.remoteDeleted = sent.deleted;
            r.flight = null;
            r.conflict = null;
            r.dirty = r.deleted !== sent.deleted || !equal(r.data, sent.data);
          }
          for (const c of result.conflicts) {
            const r = s.records[keyOf(c.entityType, c.entityId)];
            if (r?.flight?.opId === c.opId) {
              r.flight = null;
              r.conflict = clone(c.remote);
            }
          }
        });
      }
      for (let page = 0; page < 1000; page++) {
        const result = await call(
          "/v1/sync/pull?cursor=" + this.store.state.cursor + "&limit=100",
        );
        if (
          !Array.isArray(result.changes) ||
          !Number.isSafeInteger(result.cursor) ||
          result.cursor < this.store.state.cursor
        )
          throw Error("同步游标异常");
        if (result.hasMore && result.cursor === this.store.state.cursor)
          throw Error("同步分页未前进");
        await this.store.tx((s) => {
          for (const c of result.changes) {
            const key = keyOf(c.entityType, c.entityId),
              r = s.records[key];
            if (r && c.version <= r.version) continue;
            if (r?.dirty || r?.flight) {
              r.conflict = {
                version: c.version,
                deleted: !!c.deleted,
                data: clone(c.data),
              };
            } else
              s.records[key] = {
                data: clone(c.data),
                deleted: !!c.deleted,
                version: c.version,
                remote: clone(c.data),
                remoteDeleted: !!c.deleted,
                dirty: false,
              };
          }
          s.cursor = result.cursor;
        });
        if (!result.hasMore) break;
        if (page === 999) throw Error("资料较多，请继续同步");
      }
      const conflicts = Object.values(this.store.state.records).filter(
        (r) => r.conflict,
      ).length;
      const pending = Object.values(this.store.state.records).filter(
        (r) => r.dirty && !r.conflict,
      ).length;
      this.status = conflicts
        ? `${conflicts} 项内容需要合并`
        : pending
          ? `${pending} 项待同步`
          : "已同步";
      await this.store.tx((s) => (s.settings.lastSync = Date.now()));
    } catch (e) {
      this.status =
        e.status === 401
          ? "登录已失效，请重新连接"
          : "同步未完成，离线内容已保留";
      throw e;
    }
  }
}
