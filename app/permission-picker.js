(function () {
  'use strict';
  let api = {};
  const t = (zh, en) => /^en(?:-|$)/i.test(document.documentElement.lang) ? en : zh;
  const choices = [
    ['request', '请求批准', '读取本机文件、修改内容和网页操作前询问。', 'hand', 'Ask for approval', 'Ask before reading local files, editing content or interacting with websites.'],
    ['smart', '风险审批', '普通读取与整理自动进行，删除等风险动作询问。', 'shield', 'Ask for risky actions', 'Read and organize automatically. Ask before deletion and other risky actions.'],
    ['full', '完全访问', '自动执行当前支持的操作，含可撤销的删除（移入回收站）；永久删除等不可恢复的操作仍需你批准。限已连接的本机目录。', 'shield', 'Full access', 'Run supported actions automatically, including undoable deletions (moved to the trash). Permanent deletion and other irreversible actions still need your approval. Limited to connected local folders.'],
    ['legacy', '跟随空间设置', '沿用日常、课程、科研各自的审批设置。', 'folder', 'Follow workspace settings', 'Use the approval settings for Personal, Courses, and Research.']
  ];
  const label = mode => { const item = choices.find(item => item[0] === mode) || choices[3]; return t(item[1], item[4]); };
  function render(conversation) {
    const mode = window.WorkstationPermissionPolicy.effectiveMode(conversation);
    const button = document.getElementById('composerPermission');
    if (button) { const title=t(`当前对话：${label(mode)}，更改后应用于下次执行`, `This chat: ${label(mode)}. Changes apply to the next run.`); if(!window.ComposerUI?.setPermission({label:label(mode),title})){button.textContent = label(mode);button.title=title;}button.dataset.mode = mode; }
  }
  let activePicker = null;
  function dialogShell(className, ariaLabel, onClose) {
    const opener = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = `${className} kit-dialog`; dialog.setAttribute('aria-label', ariaLabel);
    const host = document.createElement('div'); dialog.append(host);
    let closed = false, outsideStart = false, languageHandler = null;
    const finish = value => {
      if (closed) return;
      closed = true;
      if (languageHandler) document.removeEventListener('workstation-language-change', languageHandler);
      window.HalaskaUI?.unmount(host);
      if (dialog.open) dialog.close(value || '');
      dialog.remove(); onClose?.(value);
      queueMicrotask(() => { if (opener?.isConnected && !document.querySelector('dialog[open]') && !window.ConversationModels?.isOpen?.()) opener.focus({ preventScroll: true }); });
    };
    const outside = event => {
      const rect = dialog.getBoundingClientRect();
      return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
    };
    dialog.addEventListener('pointerdown', event => { outsideStart = outside(event); });
    dialog.addEventListener('click', event => { if (outsideStart && outside(event)) finish(''); outsideStart = false; });
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(''); });
    dialog.addEventListener('close', () => finish(dialog.returnValue));
    return { dialog, host, finish, onLanguage(callback) { if (languageHandler) document.removeEventListener('workstation-language-change', languageHandler); languageHandler = callback; document.addEventListener('workstation-language-change', languageHandler); }, show() { document.body.append(dialog); dialog.showModal(); }, get closed() { return closed; } };
  }
  function open() {
    if (activePicker && !activePicker.closed) { activePicker.dialog.focus(); return; }
    const conversation = api.getConversation();
    if (!conversation || !window.HalaskaUI) return;
    let busy = false, error = '';
    const shell = dialogShell('permission-picker', t('当前对话的操作权限', 'This chat’s permissions'), () => { activePicker = null; });
    activePicker = shell;
    const fields = ['permissionMode', 'reviewerApprove', 'reviewerHalted', 'reviewerDenials'];
    const refresh = () => {
      if (shell.closed) return;
      window.HalaskaUI.mount(shell.host, 'KitPermissionPicker', {
        choices: choices.map(([id, title, description, icon, englishTitle, englishDescription]) => ({ id, title: t(title, englishTitle), description: t(description, englishDescription) })),
        mode: window.WorkstationPermissionPolicy.effectiveMode(conversation),
        reviewerApprove: conversation.reviewerApprove === true, reviewerHalted: conversation.reviewerHalted,
        busy, error, onClose: () => shell.finish(''),
        onModeChange: mode => mutate(() => { if (mode === 'legacy') delete conversation.permissionMode; else conversation.permissionMode = mode; }, true),
        onReviewerChange: checked => mutate(() => {
          if (checked) conversation.reviewerApprove = true; else delete conversation.reviewerApprove;
          delete conversation.reviewerHalted; delete conversation.reviewerDenials;
        }, false),
      });
    };
    async function mutate(change, closeOnSuccess) {
      if (busy || shell.closed) return;
      const previous = Object.fromEntries(fields.filter(key => Object.prototype.hasOwnProperty.call(conversation, key)).map(key => [key, conversation[key]]));
      busy = true; error = ''; change(); refresh();
      try {
        if ((await api.save()) === false || (api.flush && (await api.flush()) === false)) throw new Error(t('本机保存未完成，请重试。', 'Local saving did not finish. Please try again.'));
        render(api.getConversation()); api.onChange?.();
        busy = false;
        if (closeOnSuccess) shell.finish('saved'); else refresh();
      } catch (cause) {
        for (const key of fields) { if (Object.prototype.hasOwnProperty.call(previous, key)) conversation[key] = previous[key]; else delete conversation[key]; }
        // Restore the local snapshot too. A failed server flush must not leave
        // a queued successful-looking permission change behind.
        try { await api.save(); } catch (_) { /* The original failure remains visible. */ }
        busy = false; error = cause?.message || t('权限设置未保存，请重试。', 'Permissions were not saved. Please try again.');
        render(api.getConversation()); refresh();
      }
    }
    shell.onLanguage(() => { shell.dialog.setAttribute('aria-label', t('当前对话的操作权限', 'This chat’s permissions')); refresh(); render(api.getConversation()); });
    refresh(); shell.show();
    const selected = shell.dialog.querySelector('.permission-choice[aria-pressed="true"]');
    selected?.focus({ preventScroll: true });
  }
  function readCopy(value) {
    if (!/^en(?:-|$)/i.test(document.documentElement.lang) || typeof value !== 'string') return value;
    const copy = {
      '搜索并读取本机项目': 'Search and read local projects',
      '读取项目的最新文件': 'Read the latest project files',
      '读取本条消息中的链接': 'Read links in this message',
      '允许本轮网页搜索': 'Allow web search for this turn',
      '在已连接目录中查找候选项目，读取少量代码与说明，并发送给当前对话的模型分析。': 'Find candidate projects in connected folders, read a small amount of code and documentation, and send it to this chat’s model for analysis.',
      '模型可按当前问题查阅公开网页，并在回答中注明来源。': 'The model can consult public webpages for this question and cite its sources.',
    };
    if (Object.prototype.hasOwnProperty.call(copy, value)) return copy[value];
    // These are exact application templates; preserve project names and URLs.
    const project = value.match(/^读取「([\s\S]*)」关联目录中的少量代码与说明，并发送给当前对话的模型分析。$/);
    if (project) return `Read a small amount of code and documentation from the folders connected to “${project[1]}”, and send it to this chat’s model for analysis.`;
    const prefix = '获取并保存以下公开资料，交给当前模型分析：\n';
    if (value.startsWith(prefix)) return 'Fetch and save these public sources for the current model to analyze:\n' + value.slice(prefix.length);
    return value;
  }
  function confirmRead({ title, detail, signal }) {
    return new Promise(resolve => {
      if (signal?.aborted) { resolve(false); return; }
      let settled = false;
      const shell = dialogShell('permission-read', readCopy(title), value => finish(value === 'approved'));
      function finish(allowed) {
        if (settled) return;
        settled = true; signal?.removeEventListener('abort', abort);
        shell.finish(allowed ? 'approved' : ''); resolve(allowed && !signal?.aborted);
      }
      const abort = () => finish(false);
      signal?.addEventListener('abort', abort, { once: true });
      const refresh = () => {
        const localizedTitle = readCopy(title);
        shell.dialog.setAttribute('aria-label', localizedTitle);
        window.HalaskaUI.mount(shell.host, 'KitReadConfirmation', { title: localizedTitle, detail: readCopy(detail), onCancel: () => finish(false), onApprove: () => finish(true) });
      };
      shell.onLanguage(refresh); refresh();
      shell.show();
      // Cancellation is the initial keyboard action; granting access always
      // requires a deliberate activation of the clearly labelled Kit button.
      shell.dialog.querySelector('button')?.focus({ preventScroll: true });
    });
  }
  window.WorkstationPermissions = { init(options) { api = options; document.getElementById('composerPermission')?.addEventListener('click', open); render(api.getConversation()); }, render, label, confirmRead, open };
})();
