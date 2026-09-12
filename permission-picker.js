(function () {
  'use strict';
  let api = {};
  const choices = [
    ['request', '请求批准', '读取本机文件、修改工作站内容前询问。', 'hand'],
    ['smart', '风险审批', '普通读取与整理自动进行，删除等风险动作询问。', 'shield'],
    ['full', '完全访问', '自动执行当前支持的操作，限已连接的本机目录。', 'shield'],
    ['legacy', '跟随空间设置', '沿用日常、课程、科研各自的审批设置。', 'folder']
  ];
  const label = mode => choices.find(item => item[0] === mode)?.[1] || '跟随空间设置';
  function render(conversation) {
    const mode = window.WorkstationPermissionPolicy.effectiveMode(conversation);
    const button = document.getElementById('composerPermission');
    if (button) { button.textContent = label(mode); button.dataset.mode = mode; button.title = `当前对话：${label(mode)}，更改后应用于下次执行`; }
  }
  function open() {
    const conversation = api.getConversation();
    const dialog = document.createElement('dialog'); dialog.className = 'permission-picker';
    dialog.setAttribute('aria-label', '当前对话的操作权限');
    const heading = document.createElement('div'); heading.className = 'permission-picker-heading'; heading.textContent = '如何批准 Agent 操作？';
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', '关闭权限选择'); close.onclick = () => dialog.close(); heading.append(close); dialog.append(heading);
    for (const [mode, title, detail] of choices) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'permission-choice'; button.dataset.mode = mode;
      button.setAttribute('aria-pressed', String(mode === window.WorkstationPermissionPolicy.effectiveMode(conversation)));
      const dot = document.createElement('span'); dot.className = 'permission-choice-dot'; dot.textContent = mode === 'full' ? '!' : '✓'; dot.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span'); const name = document.createElement('strong'); name.textContent = title; const small = document.createElement('small'); small.textContent = detail; text.append(name, small); button.append(dot, text);
      button.onclick = () => { if (mode === 'legacy') delete conversation.permissionMode; else conversation.permissionMode = mode; api.save(); render(conversation); api.onChange?.(); dialog.close(); };
      dialog.append(button);
    }
    const footer = document.createElement('p'); footer.className = 'permission-picker-note'; footer.textContent = '仅应用于此对话的后续执行。本机功能目前为只读搜索与项目关联，不包含任意文件写入或终端执行。'; dialog.append(footer);
    dialog.addEventListener('close', () => dialog.remove(), { once: true }); document.body.append(dialog); dialog.showModal();
  }
  function confirmRead({ title, detail, signal }) {
    return new Promise(resolve => {
      if (signal?.aborted) { resolve(false); return; }
      const dialog = document.createElement('dialog'); dialog.className = 'permission-read'; dialog.setAttribute('aria-label', title);
      const heading = document.createElement('h2'); heading.textContent = title; const body = document.createElement('p'); body.textContent = detail;
      const actions = document.createElement('div'); actions.className = 'dialog-actions';
      const cancel = document.createElement('button'); cancel.className = 'secondary'; cancel.textContent = '取消'; cancel.onclick = () => dialog.close();
      const approve = document.createElement('button'); approve.className = 'primary'; approve.textContent = '允许本次读取'; approve.onclick = () => dialog.close('approved');
      actions.append(cancel, approve); dialog.append(heading, body, actions);
      const abort = () => dialog.close(); signal?.addEventListener('abort', abort, { once: true });
      dialog.addEventListener('close', () => { signal?.removeEventListener('abort', abort); const allowed = dialog.returnValue === 'approved'; dialog.remove(); resolve(allowed); }, { once: true });
      document.body.append(dialog); dialog.showModal();
    });
  }
  window.WorkstationPermissions = { init(options) { api = options; document.getElementById('composerPermission')?.addEventListener('click', open); render(api.getConversation()); }, render, label, confirmRead, open };
})();
