/* Conversation preferences are separate from connection defaults and immutable run snapshots. */
(function(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ConversationModels = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(root) {
  'use strict';
  const labels = { none: '不使用推理', minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '非常高', max: '最大', ultra: '极高' };
  const idOf = entry => entry?.model || entry?.id || '';
  function configuration(conversation, defaults = {}) {
    const source = conversation?.modelConfig || defaults;
    return { provider: source.provider === 'openai-auth' ? 'openai-auth' : 'api', model: String(source.model || '').trim(), effort: source.effort && source.effort !== 'auto' ? String(source.effort) : '' };
  }
  function effortsFor(models, model) {
    const entry = model ? models.find(x => idOf(x) === model) : models.find(x => x.isDefault);
    return (entry?.supportedReasoningEfforts || []).map(x => typeof x === 'string' ? x : x.reasoningEffort).filter(x => typeof x === 'string' && x);
  }
  function setSelection(conversation, value) {
    const next = configuration({ modelConfig: value });
    conversation.modelConfig = next;
    conversation.modelChoices = { ...conversation.modelChoices, [next.provider]: { model: next.model, effort: next.effort } };
    return { ...next };
  }
  function describe(config) {
    return `${config.model || (config.provider === 'openai-auth' ? '账号默认模型' : '选择模型')} · ${config.effort ? (labels[config.effort] || config.effort) : '默认推理'}`;
  }
  let hooks = {}, models = [], version = 0, targetId = null, drafts = {}, loading = false, modelError = '';
  const $ = id => root.document.getElementById(id);
  const defaults = () => hooks.getDefaults?.() || {};
  const current = () => configuration(hooks.getConversation?.(), defaults());
  const target = () => hooks.getState?.().conversations.find(x => x.id === targetId && !x.archived);
  const selected = () => ({ provider: $('conversationProvider').value, model: $('conversationProvider').value === 'openai-auth' ? $('conversationAccountModel').value : $('conversationApiModel').value.trim(), effort: $('conversationEffort').value });
  async function fetchModels() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch('/__auth/models', { signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || result.message || '请先在设置中连接 OpenAI 账号。');
      return (result.data || result.models || []).filter(x => idOf(x));
    } catch (error) { if (error.name === 'AbortError') throw new Error('读取模型超时，请重新打开选择器重试。'); throw error; }
    finally { clearTimeout(timeout); }
  }
  function position() {
    const dialog = $('modelPicker'); if (!dialog?.open) return;
    const anchor = $('composerModel').getBoundingClientRect();
    const bounds = dialog.getBoundingClientRect();
    dialog.style.left = `${Math.max(12, Math.min(anchor.right - bounds.width, root.innerWidth - bounds.width - 12))}px`;
    dialog.style.top = `${Math.max(12, Math.min(anchor.top - bounds.height - 10, root.innerHeight - bounds.height - 12))}px`;
  }
  function paintEfforts(wanted = '') {
    const value = selected();
    const available = value.provider === 'openai-auth' ? effortsFor(models, value.model) : Object.keys(labels);
    const select = $('conversationEffort');
    select.replaceChildren(new Option('模型默认', ''));
    available.forEach(effort => select.add(new Option(`${labels[effort] || effort} · ${effort}`, effort)));
    if (loading && wanted && !available.includes(wanted)) select.add(new Option(labels[wanted] || wanted, wanted));
    select.value = available.includes(wanted) || loading ? wanted : '';
    select.disabled = value.provider === 'openai-auth' && (!available.length || loading);
    const status = $('modelPickerStatus');
    status.textContent = value.provider === 'openai-auth' ? modelError || (loading ? '正在读取账号可用模型…' : wanted && !available.includes(wanted) ? '此模型不支持原推理档位，已选择模型默认。' : '使用账号支持的模型与推理档位。切换从下一条消息生效。') : 'API 推理能力由服务商决定；不确定时使用模型默认。';
    status.classList.toggle('auth-error', !!modelError && value.provider === 'openai-auth');
    $('applyModelSelection').disabled = value.provider === 'openai-auth' && (loading || !!modelError || !models.length);
    position();
  }
  function paintProvider(value) {
    const auth = value.provider === 'openai-auth';
    $('conversationProvider').value = value.provider;
    $('conversationAccountModelField').hidden = !auth;
    $('conversationApiModelField').hidden = auth;
    $('conversationApiModel').value = value.model;
    const select = $('conversationAccountModel');
    select.replaceChildren(new Option('账号默认模型', ''));
    models.forEach(entry => select.add(new Option(entry.displayName || idOf(entry), idOf(entry))));
    if (value.model && !models.some(x => idOf(x) === value.model)) {
      const unavailable = new Option(`${value.model}（暂不可用）`, value.model); unavailable.disabled = true; select.add(unavailable);
    }
    select.value = value.model;
    select.disabled = loading || !models.length;
    paintEfforts(value.effort);
  }
  async function open() {
    const conversation = hooks.getConversation?.(); if (!conversation) return;
    targetId = conversation.id;
    const initial = current();
    drafts = { ...conversation.modelChoices, [initial.provider]: { ...initial } };
    modelError = ''; loading = true;
    const ownVersion = ++version;
    paintProvider(initial);
    const description = $('modelPickerDescription');
    description.setAttribute('data-i18n-template', '{title} · 仅影响后续消息');
    description.setAttribute('data-i18n-vars', JSON.stringify({title:conversation.title || '新对话'}));
    description.textContent = `${conversation.title || '新对话'} · 仅影响后续消息`;
    $('modelPicker').showModal(); $('composerModel').setAttribute('aria-expanded', 'true'); position();
    try { const next = await fetchModels(); if (ownVersion === version) models = next; }
    catch (error) { if (ownVersion === version) { models = []; modelError = error.message; } }
    finally {
      if (ownVersion === version && $('modelPicker').open) { const active = selected(); loading = false; paintProvider(active); }
    }
  }
  function apply() {
    const conversation = target(); if (!conversation) { $('modelPicker').close(); return; }
    const value = selected();
    if (value.provider === 'api' && !value.model) { $('conversationApiModel').focus(); hooks.toast?.('请输入模型名称'); return; }
    if (value.provider === 'openai-auth' && (loading || modelError || (value.model && !models.some(x => idOf(x) === value.model)))) { hooks.toast?.('该模型当前不可用，请重新选择。'); return; }
    conversation.modelChoices = { ...drafts };
    setSelection(conversation, value);
    hooks.save?.(); $('modelPicker').close(); sync(); hooks.toast?.('当前对话的模型已更新');
  }
  function sync() {
    const button = $('composerModel'); if (!button) return;
    const config = current();
    const name = root.document.createElement('span'); name.className = 'model-name'; name.textContent = config.model || (config.provider === 'openai-auth' ? '账号默认模型' : '选择模型');
    const effort = root.document.createElement('small'); effort.textContent = config.effort ? (labels[config.effort] || config.effort) : '默认推理';
    button.replaceChildren(name, effort);
    button.title = `${config.provider === 'openai-auth' ? 'OpenAI 账号' : '自定义 API'} · ${hooks.getConversation?.().modelConfig ? '当前对话' : '继承默认'} · 点击切换`;
  }
  async function resolve(config) {
    const snapshot = { ...config };
    if (snapshot.provider === 'openai-auth') {
      await root.OpenAIAuth.ensureReady();
      const available = await fetchModels();
      const entry = snapshot.model ? available.find(x => idOf(x) === snapshot.model) : available.find(x => x.isDefault);
      if (!entry) throw new Error('当前模型不可用，请在输入框旁重新选择模型。');
      if (snapshot.effort && !effortsFor(available, idOf(entry)).includes(snapshot.effort)) throw new Error(`此模型不支持 ${snapshot.effort} 推理强度，请重新选择。`);
      snapshot.model = idOf(entry);
      snapshot.effort = snapshot.effort || entry.defaultReasoningEffort || '';
    }
    return snapshot;
  }
  function init(options) {
    hooks = options;
    if (!$('modelPicker')) return;
    $('composerModel').addEventListener('click', open);
    $('closeModelPicker').addEventListener('click', () => $('modelPicker').close());
    $('modelPickerForm').addEventListener('submit', event => { event.preventDefault(); apply(); });
    $('modelPicker').addEventListener('close', () => { ++version; $('composerModel').setAttribute('aria-expanded', 'false'); });
    $('modelPicker').addEventListener('click', event => { if (event.target === $('modelPicker')) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close(); } });
    let previousProvider;
    $('conversationProvider').addEventListener('focus', () => { previousProvider = $('conversationProvider').value; });
    $('conversationProvider').addEventListener('change', () => {
      const provider = $('conversationProvider').value;
      const previous = previousProvider || (provider === 'api' ? 'openai-auth' : 'api');
      drafts[previous] = { model: previous === 'api' ? $('conversationApiModel').value.trim() : $('conversationAccountModel').value, effort: $('conversationEffort').value };
      const fallback = defaults();
      paintProvider({ provider, ...(drafts[provider] || (fallback.provider === provider ? fallback : { model: '', effort: '' })) });
      previousProvider = provider;
    });
    $('conversationAccountModel').addEventListener('change', () => paintEfforts($('conversationEffort').value));
    $('resetModelSelection').addEventListener('click', () => { const conversation = target(); if (conversation) { delete conversation.modelConfig; hooks.save?.(); } $('modelPicker').close(); sync(); });
    $('modelPickerSettings').addEventListener('click', () => { $('modelPicker').close(); hooks.openSettings?.(); });
    root.addEventListener('resize', position);
    sync();
  }
  return { init, configuration, setSelection, effortsFor, describe, current, resolve, sync };
});
