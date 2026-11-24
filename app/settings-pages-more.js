/* Settings shell pages, second set: Privacy and security, Plugins.
   System permission status is read-only (status APIs only, never a prompt); the only actions open System Settings.
   Automation permissions save immediately through window.AIBroSettingsAccess. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.SettingsPagesMore = api; if (root.SettingsShell?.pages) Object.assign(root.SettingsShell.pages, api.pages); }
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  const controller = (ui, t) => root.SettingsPages.controller(ui, t);
  const access = () => root.AIBroSettingsAccess || null;

  const PERMS = [
    ['perm.accessibility', 'accessibility', ['辅助功能', 'Accessibility'], ['听写监听触发键并输入文字。', 'Dictation watches the trigger key and types text.']],
    ['perm.inputMonitoring', 'inputMonitoring', ['输入监控', 'Input monitoring'], ['全局快捷键需要。', 'Needed for global shortcuts.']],
    ['perm.microphone', 'microphone', ['麦克风', 'Microphone'], ['语音输入和听写。', 'Voice input and dictation.']],
    ['perm.camera', 'camera', ['摄像头', 'Camera'], ['拍照和扫描。', 'Photos and scanning.']],
    ['perm.notifications', 'notifications', ['通知', 'Notifications'], ['日程提醒和外部通知。', 'Agenda reminders and external notifications.']],
  ];

  function badgeFor(ui, t, state) {
    const label = { granted: t('已授权', 'Allowed'), denied: t('已拒绝', 'Denied'), notDetermined: t('尚未请求', 'Not asked yet'), unknown: t('未知', 'Unknown') }[state] || t('未知', 'Unknown');
    return ui.badge(label, state === 'granted' ? 'ok' : state === 'denied' ? 'bad' : undefined);
  }

  function openButton(c, t, pane) {
    const { el } = c;
    const b = el('button', { type: 'button', class: 'secondary', text: t('打开系统设置', 'Open System Settings') });
    const st = c.stamp();
    b.addEventListener('click', async e => { const r = await c.write(`perm.open.${pane}`, 'run', e); if (r.error) st.bad(r.error); });
    return [st.node, b];
  }

  function privacy(ui, t) {
    const c = controller(ui, t), { el } = c;
    const rows = PERMS.map(([id, pane, title, desc]) => {
      const slot = el('span');
      c.syncs.push(s => slot.replaceChildren(badgeFor(ui, t, s.values[id])));
      return ui.row({ title: t(...title), description: t(...desc), control: [slot, ...openButton(c, t, pane)] });
    });
    const loginSlot = el('span');
    c.syncs.push(s => {
      const v = s.values['perm.loginItem'];
      const text = { enabled: t('已开启', 'On'), notRegistered: t('未开启', 'Off'), requiresApproval: t('待在系统设置中批准', 'Needs approval in System Settings'), notFound: t('未找到', 'Not found') }[v] || t('未知', 'Unknown');
      loginSlot.replaceChildren(ui.badge(text, v === 'enabled' ? 'ok' : v === 'requiresApproval' ? 'bad' : undefined));
    });
    rows.push(ui.row({ title: t('登录时启动', 'Open at login'), description: t('开关在“通用”页；这里只显示系统是否放行。', 'The switch is on General; this only shows whether the system allows it.'), control: [loginSlot, ...openButton(c, t, 'loginItems')] }));
    const path = el('code', { class: 'st-code' });
    c.syncs.push(s => { path.textContent = s.meta?.permissions?.bundlePath || ''; });
    rows.push(ui.row({ title: t('应用位置', 'App location'), description: t('系统授权记录在这个应用上；换位置或重装后可能需要重新授权。', 'Permissions are recorded for this app; moving or reinstalling it may require granting again.'), control: path }));
    const system = ui.group(t('系统权限', 'System permissions'), rows);
    const note = el('div', { class: 'st-sub', text: t('这里只读取状态，不会弹出系统授权窗口。', 'This page only reads status and never opens a system prompt.') });

    const groupRows = [];
    const a = access();
    if (a) {
      const spaces = [['日常', t('日常空间', 'Daily space'), t('整理资料、创建任务', 'Organize notes, create tasks')], ['课程', t('课程空间', 'Course space'), t('生成卡片、关联概念', 'Make cards, link concepts')], ['科研', t('科研空间', 'Research space'), t('修改研究笔记、批量整理', 'Edit research notes, batch organize')]];
      const select = (options, current, onPick) => {
        const st = c.stamp();
        const sel = el('select', { class: 'st-select' });
        sel.append(...options.map(([v, text]) => el('option', { value: v, text })));
        sel.value = current;
        sel.addEventListener('change', async () => {
          try { sel.value = await onPick(sel.value); st.ok(); } catch (_) { st.bad(t('没有保存', 'Not saved')); sel.value = current; }
        });
        return [st.node, sel];
      };
      const cur = a.permissions();
      const modes = [['auto', t('自动执行', 'Run automatically')], ['approval', t('审批确认', 'Ask for approval')]];
      for (const [key, title, desc] of spaces) {
        groupRows.push(ui.row({ title, description: desc, control: select(modes, cur.spaces[key], v => a.setPermission(key, v)) }));
      }
      groupRows.push(ui.row({
        title: t('后台运行权限', 'Background runs'), description: t('关闭主窗口后继续的运行；删除等风险步骤始终要你批准。', 'Runs that continue after the main window closes; risky steps like deletion always need your approval.'),
        control: select([['follow', t('跟随主窗口权限', 'Follow main window')], ['request', t('每个写入都审批', 'Approve every write')], ['readonly', t('只读，不写入', 'Read-only')]], cur.headless, v => a.setHeadless(v)),
      }));
      groupRows.push(ui.row({ title: t('默认风险保护', 'Default risk protection'), description: t('未覆盖对话权限时，删除始终审批。', 'Deletion always needs approval unless a conversation overrides it.'), control: ui.badge(t('始终审批', 'Always approve')) }));
    }
    const auto = groupRows.length ? ui.group(t('自动化权限', 'Automation permissions'), groupRows) : null;
    return c.mountQuiet(...[auto, system, note].filter(Boolean));
  }

  function plugins(ui, t) {
    const c = controller(ui, t), { el } = c;
    const status = el('div', { class: 'st-sub', role: 'status', hidden: true });
    const body = el('div', { class: 'settings-plugins-body' });
    const M = root.AIBroPluginSettings;
    if (M?.mount) {
      const handle = M.mount(body, { toast: m => { status.textContent = m || ''; status.hidden = !m; } });
      handle?.reload?.();
    } else {
      body.append(ui.group(null, [ui.row({ title: t('插件不可用', 'Plugins unavailable'), description: t('当前环境没有加载插件模块。', 'The plugin module is not loaded here.'), control: [] })]));
    }
    return c.mountQuiet(status, body);
  }

  function notifications(ui, t) {
    const c = controller(ui, t), { el } = c;
    const pad = n => String(Math.max(0, Math.floor(n))).padStart(2, '0');
    const statusText = s => ({ granted: t('系统已允许通知。', 'Notifications are allowed.'), denied: t('系统已拒绝通知，请在系统设置中打开。', 'Notifications are denied; allow them in System Settings.'), notDetermined: t('尚未请求系统通知权限；打开开关时会请求。', 'Permission not asked yet; turning this on will ask.') }[s.values['perm.notifications']] || '');
    const reminderOptions = [['off', t('不提醒', 'Off')], ['0', t('开始时', 'At start')], ['15', t('提前 15 分钟', '15 minutes before')], ['60', t('提前 1 小时', '1 hour before')], ['1440', t('提前 1 天', '1 day before')]];
    const agendaStatus = el('div', { class: 'st-sub' });
    c.syncs.push(s => { agendaStatus.textContent = statusText(s); agendaStatus.hidden = !agendaStatus.textContent; });
    const agendaError = el('div', { class: 'st-sub', hidden: true });
    c.syncs.push(s => { const v = s.meta?.agenda?.error; agendaError.hidden = !v; agendaError.textContent = v || ''; agendaError.dataset.tone = 'bad'; });
    const time = el('input', { type: 'time', class: 'st-input', step: '60' });
    const timeStamp = c.stamp();
    c.syncs.push(s => { if (document.activeElement !== time) time.value = `${pad(s.values['agenda.briefingHour'])}:${pad(s.values['agenda.briefingMinute'])}`; time.disabled = s.values['agenda.briefing'] !== true; });
    time.addEventListener('change', async e => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(time.value);
      if (!m) return;
      const a = await c.write('agenda.briefingHour', Number(m[1]), e);
      const b = a.error ? a : await c.write('agenda.briefingMinute', Number(m[2]), e);
      if (b.error) timeStamp.bad(b.error); else timeStamp.ok();
    });
    const testBtn = el('button', { type: 'button', class: 'secondary', text: t('发送测试通知', 'Send test notification') });
    const testStamp = c.stamp();
    testBtn.addEventListener('click', async e => { const r = await c.write('agenda.test', 'run', e); if (r.error) testStamp.bad(r.error); else testStamp.ok(); });
    c.syncs.push(s => { testBtn.disabled = s.values['perm.notifications'] !== 'granted'; });
    const openBtn = openButton(c, t, 'notifications');
    const agenda = ui.group(t('日程与待办提醒', 'Agenda and task reminders'), [
      c.toggleRow({ id: 'agenda.notifications', title: t('日程通知', 'Agenda notifications'), description: t('到点时用系统通知提醒。', 'Remind you with system notifications.') }),
      ui.row({ title: t('通知权限', 'Notification permission'), description: t('只读状态，不会弹出系统授权窗口。', 'Read-only status; never opens a system prompt.'), control: openBtn }),
      c.selectRow({ id: 'agenda.taskReminder', title: t('待办提醒', 'Task reminders'), description: t('有截止时间的待办何时提醒。', 'When tasks with a due time remind you.'), options: reminderOptions }),
      c.toggleRow({ id: 'agenda.briefing', title: t('每日简报', 'Daily briefing'), description: t('每天固定时间汇总今天的安排。', 'A daily summary of today at a fixed time.') }),
      ui.row({ title: t('简报时间', 'Briefing time'), control: [timeStamp.node, time] }),
      c.toggleRow({ id: 'agenda.showTitles', title: t('通知显示标题', 'Show titles in notifications'), description: t('关闭后通知只显示“你有一项安排”。', 'When off, notifications do not reveal titles.') }),
      ui.row({ title: t('测试', 'Test'), control: [testStamp.node, testBtn] }),
    ]);
    // Today page brief: a timed plugin action (switch + time of day) and the notification sounds.
    const plugins = () => window.AIBroPlugins?.default;
    const briefKey = 'today.daily-brief', briefInfo = () => plugins()?.triggers?.().find(x => x.key === briefKey);
    const briefStamp = c.stamp(), briefTimeStamp = c.stamp();
    const briefSwitch = ui.toggle({
      label: t('今日简报', 'Today brief'),
      onChange: async next => {
        try { await plugins().setTrigger(briefKey, next); briefStamp.ok(); } catch (err) { briefStamp.bad(String(err?.message || err)); }
        refreshBrief();
      },
    });
    const briefTime = el('input', { type: 'time', class: 'st-input', step: '60', 'aria-label': t('今日简报时间', 'Today brief time') });
    briefTime.addEventListener('change', async () => {
      if (!/^\d{2}:\d{2}$/.test(briefTime.value)) return;
      try { await plugins().setTriggerTime(briefKey, briefTime.value); briefTimeStamp.ok(); } catch (err) { briefTimeStamp.bad(String(err?.message || err)); }
    });
    function refreshBrief() {
      const info = briefInfo();
      briefSwitch.setAttribute('aria-checked', String(info?.enabled === true));
      if (!info) briefSwitch.setAttribute('aria-disabled', 'true'); else briefSwitch.removeAttribute('aria-disabled');
      if (document.activeElement !== briefTime) briefTime.value = info?.at || '08:30';
      briefTime.disabled = !info || info.enabled !== true;
    }
    refreshBrief();
    plugins()?.load?.().then(refreshBrief, () => {});
    const todayGroup = ui.group(t('今日页', 'Today page'), [
      ui.row({ title: t('每日简报', 'Daily brief'), description: t('每天固定时间为今日页准备一段简报。', 'Prepare the Today page brief at a fixed time each day.'), control: [briefStamp.node, briefSwitch] }),
      ui.row({ title: t('简报时间', 'Brief time'), description: t('默认 08:30。', 'Defaults to 08:30.'), control: [briefTimeStamp.node, briefTime] }),
      c.toggleRow({ id: 'notify.sounds', title: t('提醒声音', 'Reminder sounds'), description: t('提醒、审批和完成通知使用 AI Bro 的提示音。', 'Use AI Bro sounds for reminders, approvals and completions.') }),
    ]);
    const entryNote = el('div', { class: 'st-sub', hidden: true, text: t('快捷入口已关闭，灵动岛通知暂不可用。', 'Quick entry is off, so island notifications are unavailable.') });
    c.syncs.push(s => { entryNote.hidden = !s.meta?.entryOff; });
    const extIssue = el('div', { class: 'st-sub', hidden: true });
    c.syncs.push(s => { const m = s.meta?.externalNotify || {}; const v = m.issue || (m.needsRestart ? t('需要重启 AI Bro 后生效。', 'Restart AI Bro to apply.') : ''); extIssue.hidden = !v; extIssue.textContent = v || ''; extIssue.dataset.tone = 'bad'; });
    const islIssue = el('div', { class: 'st-sub', hidden: true });
    c.syncs.push(s => { const v = s.meta?.islandNotify?.error; islIssue.hidden = !v; islIssue.textContent = v || ''; islIssue.dataset.tone = 'bad'; });
    const count = el('span', { class: 'st-sub' });
    c.syncs.push(s => { const n = s.meta?.externalNotify?.historyCount || 0; count.textContent = t(`${n} 条记录`, `${n} entries`); });
    const clear = el('button', { type: 'button', class: 'secondary', text: t('清空记录', 'Clear history') });
    const clearStamp = c.stamp();
    clear.addEventListener('click', async e => { const r = await c.write('notify.history.clear', 'run', e); if (r.error) clearStamp.bad(r.error); else clearStamp.ok(); });
    c.syncs.push(s => { clear.disabled = !(s.meta?.externalNotify?.historyCount > 0); });
    const copyRow = (source, title) => {
      const b = el('button', { type: 'button', class: 'secondary', text: t('复制命令', 'Copy command') });
      const st = c.stamp();
      b.addEventListener('click', async e => { const r = await c.write(`notify.hook.${source}`, 'run', e); if (r.error) st.bad(r.error); else st.ok(); });
      c.syncs.push(s => { b.disabled = s.meta?.externalNotify?.receiving !== true; });
      return ui.row({ title, description: t('把命令放进该工具的 hook 配置；命令只含文件路径。', 'Put the command in that tool\u2019s hook config; it holds file paths only.'), control: [st.node, b] });
    };
    const island = ui.group(t('灵动岛与外部通知', 'Island and external notifications'), [
      c.toggleRow({ id: 'notify.island', title: t('任务提醒显示在灵动岛', 'Show task reminders in the island'), description: t('到点时在快捷入口的灵动岛里提醒。', 'Reminders appear in the quick-entry island.'), disabled: s => s.meta?.entryOff === true || s.meta?.islandNotify?.present === false || s.meta?.islandNotify?.loaded === false || s.meta?.islandNotify?.changing === true }),
      c.toggleRow({ id: 'notify.external', title: t('接收 Codex / Claude 完成通知', 'Receive Codex / Claude completion notices'), description: t('本机的 AI 编程工具完成任务时在灵动岛提示。', 'Local AI coding tools notify you in the island when they finish.'), disabled: s => s.meta?.entryOff === true || s.meta?.externalNotify?.present === false || s.meta?.externalNotify?.loaded === false || s.meta?.externalNotify?.changing === true || s.meta?.externalNotify?.needsRestart === true }),
      ui.row({ title: t('通知记录', 'Notice history'), control: [clearStamp.node, count, clear] }),
      copyRow('codex', 'Codex hook'),
      copyRow('claude', 'Claude hook'),
    ]);
    return c.mountQuiet(agenda, agendaStatus, agendaError, todayGroup, island, entryNote, extIssue, islIssue);
  }

  // Borrow a classic card (kept alive by its owning module) into a group; ui.onLeave gives it back.
  function adopted(ui, t, c, { title, mount, release, after, emptyText }) {
    const { el } = c;
    const host = el('div', { class: 'settings-adopted-host' });
    const group = ui.group(title, []);
    group.append(host);
    const ok = access()?.[mount]?.(host);
    if (!ok) host.append(ui.badge(emptyText, 'unknown'));
    else ui.onLeave(() => { access()?.[release]?.(); setTimeout(() => after?.(), 0); });
    return group;
  }

  function models(ui, t) {
    const c = controller(ui, t), { el } = c;
    const conn = adopted(ui, t, c, {
      title: t('文本模型与连接', 'Models and connections'), mount: 'mountConnections', release: 'releaseConnections',
      after: () => access()?.refreshConnections?.(), emptyText: t('当前环境没有连接模块。', 'The connections module is not available here.'),
    });
    access()?.refreshConnections?.();
    ui.onLeave(() => access()?.parkRoles?.());

    const st = c.stamp();
    const cur = el('input', { class: 'st-input', type: 'text', maxlength: '4', autocomplete: 'off', placeholder: '¥ / $', 'aria-label': t('币种符号', 'Currency symbol') });
    const inp = el('input', { class: 'st-input', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: t('例如 2', 'e.g. 2'), 'aria-label': t('输入单价（每百万 tokens）', 'Input price per million tokens') });
    const out = el('input', { class: 'st-input', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: t('例如 8', 'e.g. 8'), 'aria-label': t('输出单价（每百万 tokens）', 'Output price per million tokens') });
    const fill = () => { const p = access()?.usagePrice?.() || { currency: '', input: 0, output: 0 }; cur.value = p.currency || ''; inp.value = p.input || ''; out.value = p.output || ''; };
    fill();
    const save = async () => {
      try {
        const p = await access().setUsagePrice({ currency: cur.value, input: inp.value, output: out.value });
        fill(); st.ok(p);
      } catch (_) { st.bad(t('保存失败', 'Could not save')); }
    };
    for (const i of [cur, inp, out]) i.addEventListener('change', save);
    const usage = ui.group(t('用量估算', 'Usage estimate'), [
      ui.row({ title: t('币种符号', 'Currency symbol'), description: t('留空则不显示金额。这只是估算，不是服务商账单。', 'Leave empty to hide amounts. This is an estimate, not a provider bill.'), control: [st.node, cur] }),
      ui.row({ title: t('输入单价', 'Input price'), description: t('每百万 tokens。', 'Per million tokens.'), control: [inp] }),
      ui.row({ title: t('输出单价', 'Output price'), description: t('每百万 tokens。', 'Per million tokens.'), control: [out] }),
    ]);
    return c.mountQuiet(conn, usage);
  }

  function sync(ui, t) {
    const c = controller(ui, t);
    const cloud = adopted(ui, t, c, {
      title: t('云同步', 'Cloud sync'), mount: 'mountCloudSync', release: 'releaseCloudSync',
      emptyText: t('云同步仅在桌面版可用。', 'Cloud sync is available in the desktop app.'),
    });
    const phone = adopted(ui, t, c, {
      title: t('手机与设备', 'Phone and devices'), mount: 'mountConnectionSync', release: 'releaseConnectionSync',
      emptyText: t('设备接入仅在桌面版可用。', 'Device access is available in the desktop app.'),
    });
    const embHost = c.el('div', { class: 'settings-adopted-host' });
    const emb = ui.group(t('知识库与向量检索', 'Knowledge and embeddings'), []);
    emb.append(embHost);
    access()?.mountRoles?.(embHost, 'embedding');
    ui.onLeave(() => access()?.parkRoles?.());
    return c.mountQuiet(cloud, phone, emb);
  }

  const pages = { privacy, plugins, notifications, models, sync };
  return { pages, PERMS };
});
