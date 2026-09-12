/* OpenAI account connection. Tokens stay inside the official local runtime. */
(function(root) {
  'use strict';
  const $ = id => document.getElementById(id);
  let hooks = {}, status = null, busy = false, timer = null, loading = null, modelsLoaded = false, lifecycleVersion = 0;
  const provider = () => $('provider')?.value === 'openai-auth' ? 'openai-auth' : 'api';
  const model = () => modelsLoaded && $('openaiModel') ? $('openaiModel').value : (localStorage.getItem('workstation-openai-model') || '');
  async function request(path, body) {
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
  function paint() {
    const enabled = provider() === 'openai-auth';
    if ($('apiCredentials')) $('apiCredentials').hidden = enabled;
    if ($('openaiAuthPanel')) $('openaiAuthPanel').hidden = !enabled;
    if (!$('openaiSignIn')) return;
    const authenticated = !!status?.authenticated;
    const pending = !!(status?.login?.pending || status?.pending);
    $('openaiSignIn').hidden = authenticated || pending;
    $('openaiSignIn').disabled = busy || status?.available === false;
    $('openaiSignOut').hidden = !authenticated;
    $('openaiSignOut').disabled = busy;
    $('openaiCancelLogin').hidden = !pending;
    $('openaiCancelLogin').disabled = busy;
    $('openaiRefreshStatus').disabled = busy;
    $('openaiModel').disabled = !authenticated || busy;
    if (!pending) $('openaiLoginLink').hidden = true;
    const account = status?.account;
    $('openaiAccountDetails').textContent = authenticated ? [account?.email || 'OpenAI 账号已连接', account?.planType].filter(Boolean).join(' · ') : '使用自己的 OpenAI 账号，登录后选择可用模型。';
  }
  async function loadModels(version) {
    const result = await request('/__auth/models');
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
    if (provider() === 'openai-auth' && (status?.login?.pending || status?.pending)) timer = setTimeout(() => refresh().catch(() => {}), 1800);
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
        const nextStatus = await request('/__auth/status');
        if (version !== lifecycleVersion) return status;
        status = nextStatus;
        const failure = status.error?.message || status.message || (typeof status.error === 'string' ? status.error : '') || status.login?.error;
        writeStatus(failure || (status.available === false ? '未找到 Codex 运行环境。安装 Codex CLI 后重新检测。' : status.authenticated ? '已连接 · 登录信息由本地 Codex 安全管理' : status.login?.pending || status.pending ? '等待你在浏览器中完成登录…' : '尚未登录'), !!failure || status.available === false);
        if (status.authenticated && (!wasAuthenticated || $('openaiModel')?.options.length < 2)) await loadModels(version);
        if (version !== lifecycleVersion) return status;
        if (!wasAuthenticated && status.authenticated) hooks.toast?.('OpenAI 账号已连接');
        paint(); schedule(); return status;
      } catch (error) { if (version === lifecycleVersion) { writeStatus(error.message, true); paint(); } throw error; }
      finally { if (version === lifecycleVersion) loading = null; }
    })();
    return loading;
  }
  function safeAuthURL(value) {
    try { const url = new URL(value); return url.protocol === 'https:' && ['auth.openai.com', 'chatgpt.com'].includes(url.hostname) && !url.username && !url.password && (!url.port || url.port === '443') ? url.href : null; } catch (_) { return null; }
  }
  async function signIn() {
    if (busy) return;
    invalidateRefresh();
    busy = true; paint(); writeStatus('正在准备安全登录…');
    try {
      const result = await request('/__auth/login', {});
      const url = safeAuthURL(result.authUrl);
      if (!url) throw new Error('登录地址校验失败，请重新连接。');
      status = { ...status, available: true, login: { pending: true, loginId: result.loginId } };
      const link = $('openaiLoginLink'); link.href = url; link.hidden = false;
      if (root.workstationDesktop?.openAuthURL) await root.workstationDesktop.openAuthURL(url);
      else link.click();
      writeStatus('等待你在浏览器中完成登录…'); schedule();
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
    if (!latest?.available) throw new Error('没有找到 Codex 运行环境，请在设置中安装并重新检测。');
    if (!latest?.authenticated) throw new Error('请先在设置 → OpenAI 账号登录中完成登录。');
  }
  function init(options) {
    hooks = options;
    if (!$('provider')) return;
    const saved = localStorage.getItem('workstation-provider') || hooks.getState?.().settings?.provider;
    $('provider').value = saved === 'openai-auth' ? 'openai-auth' : 'api';
    $('provider').addEventListener('change', () => { persist(); hooks.save?.(); hooks.onChange?.(); if (provider() === 'openai-auth') refresh().catch(() => {}); else clearTimeout(timer); });
    $('openaiModel')?.addEventListener('change', () => { persist(); hooks.save?.(); hooks.onChange?.(); });
    $('openaiSignIn')?.addEventListener('click', signIn);
    $('openaiCancelLogin')?.addEventListener('click', () => mutate('/__auth/cancel'));
    $('openaiSignOut')?.addEventListener('click', () => mutate('/__auth/logout'));
    $('openaiRefreshStatus')?.addEventListener('click', () => refresh().catch(() => {}));
    render(); hooks.onChange?.(); if (provider() === 'openai-auth') refresh().catch(() => {});
  }
  root.OpenAIAuth = { init, render, persist, provider, model, ensureReady, safeAuthURL };
})(typeof globalThis !== 'undefined' ? globalThis : this);
