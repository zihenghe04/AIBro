/* OpenAI account connection. Tokens stay inside the official local runtime. */
(function(root) {
  'use strict';
  const $ = id => document.getElementById(id);
  let hooks = {}, status = null, busy = false, timer = null, loading = null, modelsLoaded = false, lifecycleVersion = 0;
  const provider = () => ['openai-auth','claude-auth'].includes($('provider')?.value) ? $('provider').value : 'api';
  const model = () => modelsLoaded && $('openaiModel') ? $('openaiModel').value : (localStorage.getItem('workstation-openai-model') || '');
  // oauth：AI Bro 自己走 ChatGPT OAuth 登录（默认）；private：经 Codex CLI 在 AI Bro 内单独登录；shared：复用本机已有的 Codex 登录（高级）。
  const mode = () => { const value = hooks.codexMode?.(); return value === 'shared' || value === 'oauth' ? value : 'private'; };
  const withMode = path => mode() === 'private' ? path : path + (path.includes('?') ? '&' : '?') + 'mode=' + mode();
  const OAUTH_ERRORS = { needs_reauth: 'ChatGPT 登录已失效，请重新登录。' };
  let detected = null, testing = false, testMessage = '';
  async function request(path, body) {
    path = withMode(path);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || data.message || (typeof data.error === 'string' ? data.error : '') || `连接失败 (${response.status})`);
      return data;
    } catch (error) { if (error.name === 'AbortError') throw new Error('连接超时，请检查本地 Codex 运行环境后重试。'); throw error; }
    finally { clearTimeout(timeout); }
  }
  function writeStatus(message, error = false) {
    if (!$('openaiAuthStatus')) return;
    $('openaiAuthStatus').textContent = message;
    $('openaiAuthStatus').classList.toggle('auth-error', error);
  }
  function paintMode() {
    const shared = mode() === 'shared';
    if ($('codexLoginMode')) $('codexLoginMode').value = mode();
    if ($('codexTest')) { $('codexTest').disabled = busy || testing; }
    if ($('codexDetect')) {
      const text = testMessage || (mode() === 'oauth' ? '' : detected ? (detected.installed ? `Codex ${detected.version || ''} · ${detected.loggedIn ? (shared ? '平时的账号已登录' : '已登录') : '未登录'}` : '未找到官方 Codex CLI') : '');
      $('codexDetect').textContent = text;
    }
  }
  function paint() {
    const enabled = provider() === 'openai-auth';
    paintMode();
    if ($('apiCredentials')) $('apiCredentials').hidden = provider() !== 'api';
    if ($('openaiAuthPanel')) $('openaiAuthPanel').hidden = !enabled;
    root.ClaudeAuth?.render();
    if (!$('openaiSignIn')) return;
    const authenticated = !!status?.authenticated;
    const pending = !!(status?.login?.pending || status?.pending);
    // 复用模式下登录和退出都在终端里做，AI Bro 不代办。
    $('openaiSignIn').hidden = authenticated || pending || mode() === 'shared';
    $('openaiSignIn').disabled = busy || status?.available === false;
    $('openaiSignOut').hidden = !authenticated || mode() === 'shared';
    $('openaiSignOut').disabled = busy;
    $('openaiCancelLogin').hidden = !pending;
    $('openaiCancelLogin').disabled = busy;
    $('openaiRefreshStatus').disabled = busy;
    $('openaiModel').disabled = !authenticated || busy;
    if (!pending) $('openaiLoginLink').hidden = true;
    const account = status?.account;
    $('openaiAccountDetails').textContent = status?.needsReauth ? 'ChatGPT 登录已失效，请重新登录。' : authenticated ? [account?.email || 'OpenAI 账号已连接', account?.planType].filter(Boolean).join(' · ') : '使用自己的 OpenAI 账号，登录后选择可用模型。';
  }
  async function loadModels(version) {
    // 复用模式只读按 CLI 版本缓存的列表；刷新由“测试可用性”触发，设置页打开时不启动运行时。
    const result = await request(mode() === 'shared' ? '/__auth/models?cache=1&cacheonly=1' : '/__auth/models');
    if (version !== lifecycleVersion) return;
    const entries = (result.data || result.models || []).filter(item => item.id || item.model);
    const select = $('openaiModel'); if (!select) return;
    const selected = select.value || localStorage.getItem('workstation-openai-model');
    select.replaceChildren(new Option('账号默认模型', ''));
    for (const entry of entries) select.add(new Option(entry.displayName || entry.name || entry.model || entry.id, entry.model || entry.id));
    select.value = entries.some(x => (x.model || x.id) === selected) ? selected : '';
    modelsLoaded = true;
    hooks.onChange?.();
  }
  function schedule() {
    clearTimeout(timer);
    if ((provider() === 'openai-auth' || mode() === 'oauth') && (status?.login?.pending || status?.pending)) timer = setTimeout(() => refresh().catch(() => {}), 1800);
  }
  function invalidateRefresh() {
    // A status response that started before login/cancel/logout must not
    // restore the previous account state after the mutation completes.
    lifecycleVersion += 1;
    loading = null;
    clearTimeout(timer);
  }
  async function refresh() {
    if (loading) return loading;
    const version = lifecycleVersion;
    loading = (async () => {
      const wasAuthenticated = status?.authenticated;
      try {
        if (mode() === 'shared') {
          // 只跑官方状态命令（--version / login status），只看退出码；不启动运行时、不碰账号信息。
          detected = await request('/__codex/detect');
          if (version !== lifecycleVersion) return status;
          status = { available: !!detected.installed, authenticated: !!detected.loggedIn, account: null, login: { pending: false } };
          writeStatus(!detected.installed ? '未找到官方 Codex CLI。安装后重新检测。' : detected.loggedIn ? '已连接 · 复用你平时已登录的 Codex 账号' : '平时使用的 Codex 尚未登录。请在终端运行 codex login，或改为在 AI Bro 里单独登录。', !detected.installed || !detected.loggedIn);
          if (status.authenticated) await loadModels(version);
          if (version !== lifecycleVersion) return status;
          paint(); schedule(); return status;
        }
        detected = null;
        const nextStatus = await request('/__auth/status');
        if (version !== lifecycleVersion) return status;
        status = nextStatus;
        const failure = status.error?.message || status.message || (typeof status.error === 'string' ? status.error : '') || status.login?.error;
        const oauth = mode() === 'oauth';
        const pendingText = status.login?.userCode ? `请在 ${status.login.verificationUrl || 'auth.openai.com/codex/device'} 输入代码 ${status.login.userCode}` : '等待你在浏览器中完成登录…';
        writeStatus(failure || (oauth && status.needsReauth ? OAUTH_ERRORS.needs_reauth : status.available === false ? '未找到 Codex 运行环境。安装 Codex CLI 后重新检测。' : status.authenticated ? (oauth ? '已连接 · 登录信息保存在 macOS 钥匙串' : '已连接 · 登录信息由本地 Codex 安全管理') : status.login?.pending || status.pending ? pendingText : '尚未登录'), !!failure || status.available === false || !!(oauth && status.needsReauth));
        if (status.authenticated && (!wasAuthenticated || $('openaiModel')?.options.length < 2)) await loadModels(version);
        if (version !== lifecycleVersion) return status;
        if (!wasAuthenticated && status.authenticated) hooks.toast?.('OpenAI 账号已连接');
        paint(); schedule(); hooks.onAccount?.(); return status;
      } catch (error) { if (version === lifecycleVersion) { writeStatus(error.message, true); paint(); } throw error; }
      finally { if (version === lifecycleVersion) loading = null; }
    })();
    return loading;
  }
  function safeAuthURL(value) {
    try { const url = new URL(value); return url.protocol === 'https:' && ['auth.openai.com', 'chatgpt.com'].includes(url.hostname) && !url.username && !url.password && (!url.port || url.port === '443') ? url.href : null; } catch (_) { return null; }
  }
  async function testAvailability() {
    if (testing || busy) return null;
    invalidateRefresh(); testing = true; testMessage = '正在测试…'; paint();
    let outcome = { ok: false, message: '' };
    try {
      const result = await request('/__codex/test', {});
      testMessage = result.message || (result.ok ? '可用' : '不可用');
      outcome = { ok: !!result.ok, message: testMessage };
      if (result.ok) { modelsLoaded = false; await loadModels(lifecycleVersion); }
    } catch (error) { testMessage = error.message; outcome = { ok: false, message: testMessage }; }
    finally { testing = false; paint(); }
    return outcome;
  }
  function setMode(next) {
    const value = next === 'shared' || next === 'oauth' ? next : 'private';
    if (value === mode()) return;
    hooks.setCodexMode?.(value); invalidateRefresh(); status = null; detected = null; testMessage = ''; modelsLoaded = false;
    hooks.save?.(); hooks.onChange?.(); paint(); refresh().catch(() => {});
  }
  // The sign-in kind was changed from the provider page: forget everything learned under the old one.
  function modeChanged() {
    invalidateRefresh(); status = null; detected = null; testMessage = ''; modelsLoaded = false;
    paint(); return refresh().catch(() => {});
  }
  async function signIn() {
    if (busy) return;
    invalidateRefresh();
    busy = true; paint(); writeStatus('正在准备安全登录…');
    try {
      const result = await request('/__auth/login', {});
      const url = safeAuthURL(result.authUrl || result.verificationUrl);
      if (!url) throw new Error('登录地址校验失败，请重新连接。');
      status = { ...status, available: true, login: { pending: true, loginId: result.loginId, userCode: result.userCode || null, verificationUrl: result.verificationUrl || null } };
      const link = $('openaiLoginLink'); link.href = url; link.hidden = false;
      if (root.workstationDesktop?.openAuthURL) await root.workstationDesktop.openAuthURL(url);
      else link.click();
      // 1455 端口被占用时服务端会改用设备码登录：把代码和原因告诉用户。
      writeStatus(result.userCode ? `${result.note ? result.note + ' ' : ''}请在打开的页面输入代码 ${result.userCode}` : '等待你在浏览器中完成登录…'); schedule(); hooks.onAccount?.();
    } catch (error) { writeStatus(error.message, true); }
    finally { busy = false; paint(); }
  }
  async function mutate(path) {
    if (busy) return; invalidateRefresh(); busy = true; paint();
    try { await request(path, { loginId: status?.login?.loginId }); status = null; await refresh(); }
    catch (error) { writeStatus(error.message, true); }
    finally { busy = false; paint(); schedule(); }
  }
  function persist() {
    localStorage.setItem('workstation-provider', provider());
    localStorage.setItem('workstation-openai-model', model());
    const state = hooks.getState?.();
    if (state) { state.settings ||= {}; state.settings.provider = provider(); state.settings.openaiModel = model(); }
  }
  function render() { paint(); }
  async function ensureReady() {
    const latest = await refresh();
    if (mode() === 'shared') {
      if (!latest?.available) throw new Error('没有找到 Codex CLI，请在设置中安装并重新检测。');
      if (!latest?.authenticated) throw new Error('平时使用的 Codex 尚未登录：请在终端运行 codex login，或在设置里改为在 AI Bro 里单独登录。');
      return;
    }
    if (!latest?.available) throw new Error('没有找到 Codex 运行环境，请在设置中安装并重新检测。');
    if (mode() === 'oauth' && latest?.needsReauth) throw new Error('ChatGPT 登录已失效，请在设置里重新登录。');
    if (!latest?.authenticated) throw new Error(mode() === 'oauth' ? '请先在设置里登录 ChatGPT 账号。' : '请先在设置 → OpenAI 账号登录中完成登录。');
  }
  function init(options) {
    hooks = options;
    if (!$('provider')) return;
    const saved = localStorage.getItem('workstation-provider') || hooks.getState?.().settings?.provider;
    const claudeOk = hooks.claudeEnabled ? hooks.claudeEnabled() : true;
    $('provider').value = saved === 'openai-auth' || (saved === 'claude-auth' && claudeOk) ? saved : 'api';
    $('provider').addEventListener('change', () => { persist(); hooks.save?.(); hooks.onChange?.(); if (provider() === 'openai-auth') refresh().catch(() => {}); else clearTimeout(timer); root.ClaudeAuth?.providerChanged(); });
    $('openaiModel')?.addEventListener('change', () => { persist(); hooks.save?.(); hooks.onChange?.(); });
    $('openaiSignIn')?.addEventListener('click', signIn);
    $('openaiCancelLogin')?.addEventListener('click', () => mutate('/__auth/cancel'));
    $('openaiSignOut')?.addEventListener('click', () => mutate('/__auth/logout'));
    $('openaiRefreshStatus')?.addEventListener('click', () => { testMessage = ''; return refresh().catch(() => {}); });
    $('codexLoginMode')?.addEventListener('change', event => setMode(event.target.value));
    $('codexTest')?.addEventListener('click', () => void testAvailability());
    render(); hooks.onChange?.(); if (provider() === 'openai-auth') refresh().catch(() => {});
  }
  root.OpenAIAuth = { init, render, persist, modeChanged, provider, model, ensureReady, safeAuthURL, mode, testAvailability, refresh: () => refresh().catch(() => status) };
})(typeof globalThis !== 'undefined' ? globalThis : this);
