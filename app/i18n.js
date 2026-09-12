/* Local UI language. Only declared interface nodes are translated; never content. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkstationI18n = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const STORAGE_KEY = 'ai-bro-language';
  const normalizeLanguage = value => value === 'en' ? 'en' : 'zh-CN';
  const BLOCKED = 'textarea,script,style,pre,code,[contenteditable="true"],[data-user-content],.message-text,.message-content,.message-body,.rich-text,.markdown-body,.note-document-preview,.note-editor-ai-draft,.note-document-ai-content,.reading-tab-title,.collection-title,.skills-name,.skill-option-copy,.local-projects-reader,.local-projects-path,.run-history-delete-list,.trash-purge-preview,#previewTitle,#projectTitle,#conversationTitle,#taskDialogTitle,#paperTitle,#assignFileName';
  // These selectors describe UI roles, not text values. In particular, entity
  // names, result cards, document bodies and ordinary links are absent.
  const UI_SELECTORS = [
    '[data-i18n]', '[data-i18n-template]', '[data-i18n-attrs]', '.layout-theme-label', '.manual-task-entry>span', '.agent-message:not(.live-message) .progress-heading-text', '.progress-count', '.progress-elapsed', '#polishPromptLabel', '#polishHelp', '#polishUndo', '#polishReview', '#polishStatus', '#polishCopy', '.polish-heading p',
    'label[for]', '.setting-label', '.setting-help', '.dialog-actions button', '.dialog-actions a',
    '[data-space-tab]', '[data-space-filter]', '[data-project-tab]', '[data-paper-filter]', '.paper-review-status', '.inspector-tab',
    '[data-permission] option', '#provider option', '#contextWorkspace option', '#newProjectWorkspaceInput option', '#assignWorkspaceInput option',
    '#taskStatusInput option', '#taskPriorityInput option', '#taskWorkspaceInput option',
    '#contextProject option[value=""]', '#assignProjectInput option[value=""]', '#taskProjectInput option[value=""]',
    '#folderEyebrow', '#folderTitle', '#manageEyebrow', '#manageTitle', '#manageMeta', '#manageArchive', '#projectWorkspace', '#projectLocalFiles', '#projectTreeCount', '#projectTitleToggle', '#projectLocalSummary>strong', '#projectLocalSummary>button', '#connectionState', '#runStatus', '#permissionValue', '#composerPermission', '#composerHint', '#buildInfo',
    '#apiStatus', '#testApi', '#apiCredentialNotice', '#clearApiKey', '#saveSettings', '#testConnection', '#openOnboarding', '#viewRecoveryDrafts',
    '#projectListLabel', '#dailyTaskCount', '#literatureCount', '#searchMeta', '#selectedFileSummary', '#importProgress',
    '.overview-stat>span', '.overview-stat>small', '.overview-due-label', '.overview-progress-head>span',
    '#projectMetrics>div>span', '#projectMetrics>div>small', '.project-summary-main>.eyebrow', '.project-summary-main>b', '.project-summary-meta>span', '.project-summary-meta>b:first-of-type', '.project-summary-bar>small', '#projectPendingAnalysis strong', '#projectPendingAnalysis p', '#projectPendingAnalysis button', '.tree-subheading', '#projectTree>.tree-section>summary', '.tree-empty', '.tree-node[data-open-task]>small', '.tree-node[data-open-conversation]>small', '.task-row>.priority', '.project-summary-label', '.project-summary-stat>span', '.project-summary-stat>small', '.project-stat>span',
    '.chat-empty .empty-kicker', '.chat-empty .suggestion', '.manual-task-entry', '.empty-list', '.task-empty-source', '.chat-empty h2', '.chat-empty p',
    '.task-field>label', '.task-inline label', '.task-summary span', '.task-summary b', '.check-add button',
    '.source-link>small', '.import-row-actions button', '.analysis-badge', '.preview-analysis-status>span', '.preview-analysis-status>button',
    '#previewRelatedSources>summary', '.pdf-page-status', '#previewEyebrow', '#previewExtracted>summary', '#editPreviewNote', '.pdf-preview-controls button', '.pdf-preview-controls label',
    '.reading-heading', '.reading-caption', '.reading-control', '.reading-toggle', '.reading-tab-kind',
    '.note-document-toolbar button', '.note-document-count', '.note-document-outline>summary', '.note-document-folder-field>span', '.note-document-ai>summary', '.note-document-ai>p', '[data-note-action]', '.note-document-pane-label', '.note-document-status', '.note-document-history>summary',
    '.note-document-leave h2', '.note-document-leave strong', '.note-document-leave p', '.note-document-leave-actions button',
    '.note-editor-header h2', '.note-editor-button', '.note-editor-status', '.note-editor-field>span', '.note-editor-history>summary',
    '.collection-toolbar button', '.collection-toolbar select option', '.collection-head', '.collection-head>*', '.collection-count',
    '.collection-batch button', '.collection-batch>span', '.collection-actions-label', '.collection-empty', '.collection-empty p',
    '.collection-status', '.collection-tree-select', '.collection-empty>b', '.collection-analysis-hint', '.collection-analysis-hint button',
    '.planning-heading h2', '.planning-heading p', '[data-planning-create]', '.planning-card>h3', '.planning-axis-detail', '.planning-completion-copy>span', '.planning-completion-copy>small', '.planning-card-heading h3', '.planning-card-heading p', '.planning-card-heading>span', '.planning-timeline-axis>span', '.planning-unassigned>summary', '.planning-donut small', '.planning-project-progress small', '.planning-entity>small', '.planning-relation-project>small', '.planning-timeline-title>small', '.planning-caption', '.planning-empty',
    '.planning-legend-item', '.planning-today-marker', '.planning-move', '.planning-dialog h2', '.planning-dialog .eyebrow',
    '.planning-dialog label', '.planning-dialog option[value="日常"]', '.planning-dialog option[value="课程"]', '.planning-dialog option[value="科研"]',
    '.planning-dialog option[value="todo"]', '.planning-dialog option[value="done"]', '.planning-dialog option[value="in_progress"]', '.planning-dialog option[value="blocked"]',
    '.planning-dialog option[value="low"]', '.planning-dialog option[value="medium"]', '.planning-dialog option[value="high"]', '.planning-error',
    '.activity-ui-progress>h3', '.activity-ui-jump', '.activity-ui-workspace>small', '.activity-ui-tooltip>div', '.activity-ui-title', '.activity-ui-subtitle', '.activity-ui-button', '.activity-ui-tabs button', '.activity-ui-legend', '.activity-ui-legend>*',
    '.activity-ui-metrics span', '.activity-ui-metrics small', '.activity-ui-empty', '.activity-ui-workspace-head>span',
    '.trash-select-all>span', '.trash-bulk-actions button', '.trash-row-actions button', '.trash-row-copy>small', '.trash-empty-message',
    '#trashPurgeTitle', '#trashPurgeHelp', '.trash-purge-note', '.trash-purge-actions button',
    '#runHistoryTitle', '.run-history-header p', '.run-history-button', '.run-history-back', '.run-history-count', '.run-history-selection-count',
    '.run-history-select-all>span', '#runHistoryStatus option', '.run-history-empty', '.run-history-delete-hint', '.run-history-delete-status',
    '#runHistoryDeleteTitle', '#runHistoryDeleteDescription', '.run-history-detail-actions button', '.run-history-detail section>h3',
    '.run-history-section>h4', '.run-history-meta dt', '.run-history-meta .run-status',
    '.model-picker-field label', '#composerModel>small', '#conversationProvider option', '#conversationModel option[value=""]', '#conversationEffort option',
    '.model-picker-status', '.model-picker-actions button', '.model-picker-footer button', '.model-picker-footer>span',
    '#openaiSignIn', '#openaiSignOut', '#openaiRefreshStatus', '#openaiLoginLink', '#openaiAuthHelp', '#openaiAuthStatus',
    '.cloud-sync-heading h2', '.cloud-sync-description', '.cloud-sync-button', '.cloud-sync-badge', '.cloud-sync-message', '.cloud-sync-error',
    '.cloud-sync-fields label', '.cloud-sync-fields label>span', '.cloud-sync-refresh', '.cloud-sync-agreement>span', '.cloud-sync-auto>span', '.cloud-sync-metrics span',
    '.cloud-sync-dialog-header h2', '.cloud-sync-confirm p', '.cloud-sync-confirm button', '.cloud-sync-versions h3', '.cloud-sync-versions h4', '.cloud-sync-record-fields>summary', '.cloud-sync-muted', '.cloud-sync-confirm',
    '.permission-picker-heading', '.permission-picker-heading h2', '.permission-picker-heading p', '.permission-choice strong', '.permission-choice small', '.permission-picker-note', '.permission-read h2', '.permission-read p',
    '.local-projects-header h2', '.local-projects-button', '.local-projects-empty', '.local-projects-status', '.local-projects-manual>label',
    '.local-projects-scope>span', '.local-projects-footer>span',
    '.polish-trigger', '.polish-heading h2', '.polish-controls label', '.polish-controls option', '.polish-options label', '.polish-options option', '.polish-settings-status', '.polish-feedback',
    '.skills-header h2', '.skills-header p', '.skills-button', '.skills-empty', '.skills-status', '.skills-field>span', '.skills-field>label',
    '.message-identity', '.plan-streaming-state', '.message-steps>summary', '[data-stage-import]', '[data-approve-run]', '[data-reject-run]', '[data-stop-run]', '[data-retry-run]', '[data-copy-message]', '.message-time', '#contentDeleteTitle', '#contentDeleteDialog>p', '.content-delete-list>li>span', '.content-delete-explanation', '.content-delete-error', '.note-merge-dialog header>h2', '.note-merge-dialog header>p', '.note-merge-review>label', '.note-merge-review>p', '.note-merge-review summary', '[data-merge-cancel]', '[data-merge-submit]', '.note-merge-error', '#onboardingCard', '#onboardingCard *', '#toast'
  ].join(',');
  const ATTRIBUTE_SELECTORS = [
    '[data-i18n-attrs]', '.layout-theme-button', '.activity-ui-close', '#polishPrompt', '#polishSettings', '#polishClose', 'label[for]', 'input[placeholder]:not([data-user-content])', 'textarea[placeholder]',
    '.dialog-actions button', '.reading-control', '.reading-toggle', '.reading-tab-close', '.run-history-close',
    '.run-history-controls input', '.run-history-controls select', '.trash-check', '.trash-select-all input',
    '.collection-toolbar button', '.collection-toolbar input', '.collection-toolbar select',
    '.note-document-toolbar button', '.note-editor-close', '.model-picker-close', '.local-projects-close',
    '.pdf-toolbar button', '.pdf-toolbar input', '.pdf-viewport', '.permission-picker', '.permission-picker-heading button', '.reading-pane', '.reading-tabs', '#collapseSidebar', '#themeBtn', '#agentSend', '#composerModel', '#chatHeaderAttach', '#chatAttach', '#inspectorToggle',
    '#conversationMenu', '#projectMenu', '#composerLocal', '#conversationFilter', '.folder-menu', '#onboardingCard *'
  ].join(',');
  const controlText = new WeakMap(), attributeText = new WeakMap();
  let language = 'zh-CN', document, storage, observer, initialized = false, scheduled = false;
  const pendingRoots = new Set();
  let dictionary = null;
  const dictionaryValue = () => dictionary || root.WorkstationEnglish || { exact: {}, patterns: [] };
  function translateString(value, vars, locale = language) {
    const original = String(value ?? '');
    let output = original;
    if (locale === 'en') {
      const { exact = {}, patterns = [] } = dictionaryValue();
      if (Object.prototype.hasOwnProperty.call(exact, original)) output = exact[original];
      else for (const pattern of patterns) {
        try {
          const expression = new RegExp(pattern.source, pattern.flags || '');
          if (expression.test(original)) { output = original.replace(expression, pattern.replacement); break; }
        } catch (_) { /* A bad optional dictionary entry never breaks the UI. */ }
      }
    }
    if (vars) output = output.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) => Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match);
    return output;
  }
  function blocked(element) {
    const block = element?.closest?.(BLOCKED);
    const status = element?.matches?.('.collection-status') && block?.matches?.('.collection-title') && !block.parentElement?.closest?.(BLOCKED);
    // Only Core's immutable builtin catalog receives this class. User-created
    // skill titles/descriptions remain explicitly protected as user content.
    const builtinSkill = block?.matches?.('.skills-name') && block.matches?.('.skills-builtin') && !block.parentElement?.closest?.(BLOCKED);
    return !element || (Boolean(block) && !status && !builtinSkill) || (Boolean(element.closest?.('#previewContent')) && !element.closest?.('.note-document'));
  }
  function originalText(current, previous) { return previous && current === previous.output ? previous.source : current; }
  function translateDirect(element) {
    if (blocked(element)) return;
    if (element.hasAttribute?.('data-i18n-template')) {
      // Translate a declared UI template first, then insert user text verbatim.
      // This also works in <option>, which cannot contain protective spans.
      try {
        const vars = JSON.parse(element.getAttribute('data-i18n-vars') || '{}');
        if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return;
        const output = translateString(element.getAttribute('data-i18n-template'), vars);
        if (element.textContent !== output) element.textContent = output;
      } catch (_) { /* Incomplete UI metadata leaves the current label intact. */ }
      return;
    }
    for (const node of Array.from(element.childNodes || [])) {
      if (node.nodeType !== 3) continue;
      const current = node.nodeValue || '', previous = controlText.get(node);
      const source = originalText(current, previous), leading = source.match(/^\s*/)[0], trailing = source.match(/\s*$/)[0];
      const key = source.trim();
      if (!key) continue;
      const translated = translateString(key);
      const output = leading + translated + trailing;
      controlText.set(node, { source, output });
      if (current !== output) node.nodeValue = output;
    }
  }
  function translateAttributes(element) {
    // Placeholder/accessible control descriptions are UI metadata; never
    // touch value, name, href, data IDs, or user-authored document attributes.
    if (!element || element.closest?.('[data-user-content],.note-document-preview,.message-content,.message-body,.rich-text,.markdown-body')) return;
    let records = attributeText.get(element); if (!records) { records = {}; attributeText.set(element, records); }
    for (const attribute of ['placeholder', 'title', 'aria-label']) {
      if (!element.hasAttribute?.(attribute)) continue;
      const current = element.getAttribute(attribute) || '';
      const source = originalText(current, records[attribute]);
      const output = translateString(source);
      records[attribute] = { source, output };
      if (current !== output) element.setAttribute(attribute, output);
    }
  }
  function matches(element, selector) { try { return element?.matches?.(selector); } catch (_) { return false; } }
  function elements(container, selector) {
    const result = [];
    if (matches(container, selector)) result.push(container);
    if (container?.querySelectorAll) result.push(...container.querySelectorAll(selector));
    return result;
  }
  function translate(container = document) {
    if (!container) return;
    elements(container, UI_SELECTORS).forEach(translateDirect);
    elements(container, ATTRIBUTE_SELECTORS).forEach(translateAttributes);
  }
  function mark(element, key, attribute) {
    if (!element) return element;
    if (attribute) { element.setAttribute(attribute, key); element.setAttribute('data-i18n-attrs', attribute); translateAttributes(element); }
    else { element.setAttribute('data-i18n', ''); element.textContent = key; translateDirect(element); }
    return element;
  }
  function updateNative() {
    try { const result = root.workstationDesktop?.setLanguage?.(language); result?.catch?.(() => {}); } catch (_) {}
  }
  function syncControls() {
    if (document?.documentElement) document.documentElement.lang = language;
    const control = document?.getElementById?.('interfaceLanguage');
    if (control) control.value = language;
  }
  function setLanguage(value) {
    language = normalizeLanguage(value);
    try { storage?.setItem(STORAGE_KEY, language); } catch (_) {}
    syncControls(); translate(); updateNative();
    // Reposition the existing guide/reader after text wrapping changes.
    if (root.dispatchEvent && root.Event) root.dispatchEvent(new root.Event('resize'));
    if (document?.dispatchEvent && root.CustomEvent) document.dispatchEvent(new root.CustomEvent('workstation-language-change', { detail: { language } }));
    return language;
  }
  function init(options = {}) {
    if (initialized) { translate(); return api; }
    document = options.document || root.document;
    storage = options.storage;
    if (!storage) { try { storage = root.localStorage; } catch (_) {} }
    dictionary = options.dictionary || null;
    try { language = normalizeLanguage(storage?.getItem(STORAGE_KEY)); } catch (_) { language = 'zh-CN'; }
    initialized = true; syncControls();
    const select = document?.getElementById?.('interfaceLanguage');
    select?.addEventListener('change', event => setLanguage(event.target.value));
    translate(); updateNative();
    if (document && root.MutationObserver) {
      observer = new root.MutationObserver(records => {
        // Translate only the changed UI subtree. Document streaming and
        // keystrokes in editable/user content never schedule a global pass.
        for (const record of records) {
          const target = record.target?.nodeType === 3 ? record.target.parentElement : record.target;
          if (blocked(target)) {
            // The reader host is user-content protected, but a newly mounted
            // note editor contains declared controls around a protected body.
            if (record.type === 'childList') for (const node of record.addedNodes || []) {
              if (node.nodeType === 1 && matches(node, '.note-document') && !blocked(node)) pendingRoots.add(node);
            }
            continue;
          }
          if (record.type === 'childList') {
            if (matches(target, UI_SELECTORS)) pendingRoots.add(target);
            for (const node of record.addedNodes || []) if (node.nodeType === 1 && !blocked(node)) pendingRoots.add(node);
          } else if (matches(target, UI_SELECTORS) || matches(target, ATTRIBUTE_SELECTORS)) pendingRoots.add(target);
        }
        if (!pendingRoots.size || scheduled) return;
        scheduled = true;
        (root.queueMicrotask || (callback => Promise.resolve().then(callback)))(() => {
          scheduled = false; const roots = [...pendingRoots]; pendingRoots.clear(); roots.forEach(translate);
        });
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'title', 'aria-label', 'data-i18n-template', 'data-i18n-vars'] });
    }
    return api;
  }
  const api = { STORAGE_KEY, UI_SELECTORS, ATTRIBUTE_SELECTORS, BLOCKED, normalizeLanguage, init, setLanguage, getLanguage: () => language, t: translateString, translate, mark };
  return api;
});
