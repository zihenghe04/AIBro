(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ModelChain = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 模型来源逐级回退：**对话 → 项目 → 工作区 → 全局默认**。
  // 每一级只有在"显式配置过"时才生效；没配过的层级一律跳过——不猜测、也不继承别的项目的设置。
  // 自动任务与后台执行没有"对话设定"时，就能自然地落到项目或工作区上，而不是一律用全局默认。
  const SOURCES = ['conversation', 'project', 'workspace', 'default'];
  const LABELS = { conversation: '对话设定', project: '项目设定', workspace: '工作区设定', default: '全局默认' };

  function normalized(value) {
    if (!value || typeof value !== 'object') return null;
    const model = String(value.model || '').trim();
    const account = ['openai-auth', 'claude-auth'].includes(value.provider);
    if (!model && !account) return null; // Explicit account provider may use its official default.
    const provider = account ? value.provider : 'api';
    const effort = value.effort && value.effort !== 'auto' ? String(value.effort) : '';
    return { provider, model, effort };
  }

  function workspaceConfig(settings, workspace) {
    const name = typeof workspace === 'string' ? workspace.trim() : '';
    if (!name) return null;
    const map = settings && settings.workspaceModelConfig;
    if (!map || typeof map !== 'object') return null;
    return map[name];
  }

  function candidates({ conversation, project, settings, workspace } = {}, defaults = {}) {
    return {
      conversation: normalized(conversation && conversation.modelConfig),
      project: normalized(project && project.modelConfig),
      workspace: normalized(workspaceConfig(settings, workspace)),
      default: normalized(defaults)
    };
  }

  // 返回 config 与 source；source 用于如实告诉用户"这条模型是从哪来的"。
  function resolve(context = {}, defaults = {}) {
    const pool = candidates(context, defaults);
    for (const source of SOURCES) {
      if (pool[source]) return { ...pool[source], source };
    }
    // 四级都没有模型名（例如尚未配置）：保留提供方的形态，交由调用方按既有方式提示。
    const fallback = normalized(defaults) || { provider: 'api', model: '', effort: '' };
    return { ...fallback, source: 'default' };
  }

  function label(source) { return LABELS[source] || LABELS.default; }

  // 一句话说明来源；"全局默认"不必赘述，非默认来源才值得提示。
  function describe(config) {
    const source = config && config.source;
    if (!source || source === 'default') return '';
    return `模型来自${label(source)}`;
  }

  return Object.freeze({ SOURCES, LABELS, normalized, workspaceConfig, candidates, resolve, label, describe });
}));
