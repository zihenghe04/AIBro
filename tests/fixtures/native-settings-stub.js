/* Test-only stand-in for the native settings bridge. Mirrors the reply shape of window.workstationDesktop.nativeSettings
   ({status, values, meta, id?, reason?}); it does NOT enforce the trusted-gesture gate, which only native/Resources/desktop.js can. */
(function () {
  const sections = ['home', 'tasks', 'agenda', 'capture', 'links', 'recordings', 'voice', 'vault', 'clipboard', 'shelf', 'runs', 'settings'];
  const titles = { home: '主页', tasks: '待办', agenda: '日程', capture: '速记', links: '链接', recordings: '录音', voice: '语音', vault: '资料库', clipboard: '剪贴板', shelf: '暂存架', runs: '运行', settings: '设置' };
  const modules = [['clock', '时钟'], ['tasks', '待办'], ['agenda', '日程'], ['weather', '天气']];
  const v = {
    'login.enabled': false, 'login.background': false,
    'quickEntry.enabled': true, 'quickEntry.mode': 'island', 'quickEntry.shortcut': '2048:49',
    'quickPanel.default': 'home', 'clipboard.retention.preview': '30:50',
    'dictate.enabled': true, 'dictate.trigger': 'rightOption', 'dictate.combo': '4096:49', 'dictate.access': true,
    'speech.shortcut': '4096:49', 'speech.mode': 'hold', 'speech.autoSubmit': false, 'speech.silence': 1.5,
  };
  Object.assign(v, { 'perm.accessibility': 'granted', 'perm.inputMonitoring': 'denied', 'perm.microphone': 'notDetermined', 'perm.camera': 'unknown', 'perm.notifications': 'granted', 'perm.loginItem': 'notRegistered' });
  Object.assign(v, { 'agenda.notifications': true, 'agenda.taskReminder': '15', 'agenda.briefing': false, 'agenda.briefingHour': 8, 'agenda.briefingMinute': 30, 'agenda.showTitles': true, 'notify.external': false, 'notify.island': true });
  let history = 2;
  for (const s of sections) if (s !== 'home' && s !== 'settings') v['quickPanel.section.' + s] = true;
  for (const [id] of modules) { v['quickPanel.home.' + id] = true; v['quickPanel.size.' + id] = 'small'; }
  let order = modules.map(m => m[0]);
  let preview = null;
  const log = [];
  const snap = (extra) => ({
    status: 'ok', values: { ...v }, ...extra,
    meta: {
      login: { changing: false, issue: null, status: v['login.enabled'] ? 'enabled' : 'notRegistered' },
      quickEntry: { label: '⌥ Space', issue: null, preferredMode: 'island' },
      quickPanel: {
        sections: sections.map(id => ({ id, title: titles[id] || id, canHide: id !== 'home' && id !== 'settings' })),
        modules: order.map(id => ({ id, title: modules.find(m => m[0] === id)[1], visible: v['quickPanel.home.' + id], lastVisible: order.filter(x => v['quickPanel.home.' + x]).length === 1 && v['quickPanel.home.' + id] })),
        automatic: false, issue: null },
      clipboard: { available: true, open: !!preview, loading: false, busy: false, error: null, preview },
      dictate: { label: '右 Option', comboLabel: '⌃ Space', issue: null, active: true, registered: true, needsAccess: false },
      speech: { label: '⌃ Space', issue: null, active: true, registered: true },
      agenda: { status: v['perm.notifications'], error: null },
      externalNotify: { present: true, loaded: true, ready: true, changing: false, receiving: !!v['notify.external'], issue: null, needsRestart: false, historyCount: history },
      islandNotify: { present: true, loaded: true, available: true, changing: false, blocked: false, error: null },
      entryOff: false,
      permissions: { bundlePath: '/Applications/AI Bro Stub.app', bundleID: 'app.example.stub' },
    },
  });
  const nativeSettings = Object.freeze({
    async state() { return snap(); },
    async set(id, value, event) {
      log.push([id, value]);
      if (id.startsWith('perm.open.') || id === 'agenda.test' || id.startsWith('notify.hook.')) return snap({ id });
      if (id === 'notify.history.clear') { history = 0; return snap({ id }); }
      if (id in v && typeof v[id] === typeof value) {
        if (id === 'speech.silence') value = Math.min(10, Math.max(0, value));
        if (id === 'quickEntry.shortcut' && value === '256:12') return snap({ id, reason: 'rejected' });
        v[id] = value;
      } else if (id === 'clipboard.retention.preview') {
        v[id] = value; preview = { count: 12, bytes: 40960, totalBytes: 204800, favorites: 3, stamp: 's1', policy: value };
      } else if (id === 'clipboard.retention.apply') preview = null;
      else if (id === 'clipboard.retention.cancel') preview = null;
      else if (id.startsWith('quickPanel.move.')) {
        const m = id.slice(16), i = order.indexOf(m), j = i + (value === 'up' ? -1 : 1);
        if (i >= 0 && j >= 0 && j < order.length) [order[i], order[j]] = [order[j], order[i]];
      }
      return snap({ id });
    },
  });
  window.__nativeSettingsLog = log;
  window.workstationDesktop = Object.assign(window.workstationDesktop || {}, { nativeSettings });
})();
