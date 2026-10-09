import { clone, equal, keyOf, id } from "./store.js";
import { groupLocks, queuedGroupIds, prepareGroupSend, acknowledgeGroup, applyPullPage, refreshGroupHeads, syncGroupSummaries } from "./sync-groups.js";
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
  constructor(store, http, vault, files, deviceName = "AI Bro iPhone") {
    Object.assign(this, { store, http, vault, files, deviceName });
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
      body: { username, password, deviceName: this.deviceName },
    });
    const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
    if (typeof session.accessToken !== 'string' || !session.accessToken || /[\s\u0000-\u001f\u007f]/.test(session.accessToken)
      || !validId(session.account?.id) || !validId(session.device?.id)
      || typeof session.account?.username !== 'string' || !session.account.username
      || /[\s\u0000-\u001f\u007f/\\:]/.test(session.account.username))
      throw Error("登录响应不完整");
    if (old && old.accountID !== session.account.id)
      throw Error("账号标识变化，已停止合并");
    await this.vault.set(
      "sync",
      JSON.stringify({ base, token: session.accessToken, accountId: session.account.id, sessionId: session.device.id }),
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
    // Invalidate the native session fence before any network wait. A delayed
    // logout response must never remove a newer login's credentials.
    await this.vault.remove("sync");
    this.status = "已断开，内容保留";
    if (saved) {
      const v = JSON.parse(saved);
      await this.http(v.base + "/v1/auth/logout", {
        method: "POST",
        headers: { Authorization: "Bearer " + v.token },
        body: {},
      });
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
      let grouped = false;
      try {
        const capabilities = await call("/v1/sync/capabilities");
        grouped = capabilities?.atomicOperationGroups?.version === 1 && capabilities?.atomicGroupPull?.version === 1;
      } catch (error) {
        if (![404, 405, 501].includes(error.status)) throw error;
      }
      // Groups are frozen at approval, not assembled from the current dirty
      // records. They run first so unrelated local writes cannot invalidate a
      // lifecycle group's frozen account cursor.
      if (grouped) for (const groupId of queuedGroupIds(this.store.state)) {
        const payload = await this.store.tx(state => prepareGroupSend(state, groupId));
        if (!payload) continue;
        await this.uploadOriginals(payload.operations, call);
        const result = await call("/v1/sync/push-group", { method: "POST", body: payload });
        await this.store.tx(state => acknowledgeGroup(state, groupId, result));
      }
      // Store exact immutable operations BEFORE sending, so a dropped response can be replayed after restart.
      for (let round = 0; round < 20; round++) {
        const ops = await this.store.tx((s) => {
          const result = [];
          const locked = groupLocks(s);
          for (const [key, r] of Object.entries(s.records)) {
            if (!r.dirty || r.conflict || locked.has(key)) continue;
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
        await this.uploadOriginals(ops, call);
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
          if (result.accepted.length) { s.settings.syncNeedsPull = true; s.settings.syncLegacyPushAhead = true; }
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
          `/v1/sync/${grouped ? "pull-group" : "pull"}?cursor=${this.store.state.cursor}&limit=100`,
        );
        await this.store.tx(state => applyPullPage(state, result, { grouped }));
        if (!result.hasMore) break;
        if (page === 999) throw Error("资料较多，请继续同步");
      }
      if (Object.values(this.store.state.syncGroups || {}).some(group => group.status === "blocked" && !group.remoteReady)) {
        // The conflict response deliberately carries no remote content. Replay
        // cloud history into comparison heads only, so even an old collision
        // below our normal cursor gets an accurate whole-group review.
        let cursor = Math.min(...Object.values(this.store.state.syncGroups).filter(group => group.status === "blocked" && !group.remoteReady)
          .map(group => group.remoteCursor || 0));
        for (let page = 0; page < 1000; page++) {
          const result = await call(`/v1/sync/${grouped ? "pull-group" : "pull"}?cursor=${cursor}&limit=100`);
          if (!Number.isSafeInteger(result.cursor) || result.cursor < cursor || result.hasMore && result.cursor === cursor)
            throw Error("整组云端比较分页未前进");
          await this.store.tx(state => refreshGroupHeads(state, result, { grouped, fromCursor: cursor }));
          cursor = result.cursor;
          if (!result.hasMore) break;
          if (page === 999) throw Error("整组云端比较尚未读取完整，请继续同步");
        }
      }
      const conflicts = Object.values(this.store.state.records).filter(
        (r) => r.conflict,
      ).length;
      const pending = Object.values(this.store.state.records).filter(
        (r) => r.dirty && !r.conflict,
      ).length;
      const groups = syncGroupSummaries(this.store.state), blocked = groups.filter(group => group.status === "blocked").length;
      this.status = blocked ? `${blocked} 个操作组需要整组比较`
        : groups.length && !grouped ? `服务器尚不支持整组同步，${groups.length} 个操作组保留在本机`
        : conflicts
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
  async uploadOriginals(operations, call) {
    for (const op of operations) if (op.entityType === "imports" && op.data?.blobHash) {
      const hash = op.data.blobHash, blob = this.store.state.blobs[hash];
      if (!blob?.uploaded && (blob || op.baseVersion === 0)) {
        let data;
        try { data = await this.files.read(hash); }
        catch {
          try { await call("/v1/blobs/" + hash, { method: "HEAD", raw: true }); }
          catch (remoteError) {
            if (remoteError.status === 404) throw Error("附件原件不在本机或当前同步账号中，请恢复完整备份后重试");
            throw remoteError;
          }
        }
        if (data) await call("/v1/blobs/" + hash, { method: "PUT", bytes: data });
        await this.store.tx(state => { state.blobs[hash] = { name: op.data.originalName || op.data.name || op.data.title || hash,
          size: data?.length ?? op.data.size ?? null, ...state.blobs[hash], uploaded: true }; });
      }
    }
  }
}
