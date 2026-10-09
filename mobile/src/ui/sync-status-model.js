const states = new Set(["offline", "pending", "syncing", "synced", "conflict", "auth-expired", "error"]);
const count = value => Number.isSafeInteger(value) && value > 0 ? value : 0;
const shortCount = value => value > 99 ? "99+" : String(value);

// Presentation only. The scheduler owns completion, retries, connectivity and auth.
export function syncStatusModel(props = {}) {
  const pending = count(props.pendingCount ?? props.pending), conflicts = count(props.conflictCount ?? props.conflicts);
  let state = states.has(props.state) ? props.state : "offline";
  if (state !== "auth-expired" && state !== "syncing") {
    if (props.connected === false || props.online === false) state = "offline";
    else if (conflicts) state = "conflict";
    else if (state === "synced" && pending) state = "pending";
  }
  let title, detail;
  if (state === "offline") {
    title = "离线 · 本机已保留";
    detail = props.connected === true ? "连接恢复后可继续同步。" : "连接同步，与电脑共用资料。";
    if (pending) detail = `${pending} 项本机修改等待同步。`;
  } else if (state === "pending") {
    title = pending ? `${pending} 项待推送` : "等待同步";
    detail = "本机修改已保存，等待上传。";
  } else if (state === "syncing") {
    title = "正在同步";
    detail = pending ? `正在处理 ${pending} 项本机修改。` : "正在检查云端更新。";
  } else if (state === "conflict") {
    title = conflicts ? `${conflicts} 项需要合并` : "有内容需要合并";
    detail = "比较两个版本后，选择要保留的内容。";
  } else if (state === "auth-expired") {
    title = "登录已失效";
    detail = "本机内容已保留，请重新连接。";
  } else if (state === "error") {
    title = "同步未完成";
    detail = pending ? `${pending} 项修改仍保留在本机。` : "本机内容已保留，可以重试。";
  } else {
    title = "已同步";
    const stamp = props.lastSyncedAt ?? props.lastSync;
    detail = Number.isFinite(stamp) && stamp > 0
      ? `上次同步 ${new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(stamp)}`
      : "当前设备已与同步服务完成同步。";
  }
  const shortTitle = state === "offline" ? "本机" : state === "pending" ? `待同步 ${shortCount(pending)}` : state === "syncing" ? "同步中"
    : state === "synced" ? "已同步" : state === "conflict" ? `需合并 ${shortCount(conflicts)}` : "同步异常";
  return Object.freeze({ state, title, shortTitle, detail, pendingCount: pending, conflictCount: conflicts,
    syncing: state === "syncing", showConflicts: conflicts > 0 || state === "conflict",
    canSync: props.connected !== false && props.online !== false && !["syncing", "auth-expired"].includes(state),
    settingsPrimary: state === "auth-expired" || props.connected === false,
  });
}
