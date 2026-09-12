/* A short, skippable tour of real workspace controls. No sample data or AI calls. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkstationOnboarding = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const VERSION = 1;
  const steps = [
    { id: 'connection', view: 'settings', title: '先连接你的模型', kicker: '让工作站准备就绪',
      body: '在设置中选择自定义 API 或 OpenAI 账号。使用 API 时填写服务地址、模型和 Key，点击“保存设置”。测试连接只检查当前输入，不会替你保存。',
      hint: '每个对话也可以单独选择模型、推理强度与操作权限。', selectors: ['#provider', '.settings-connection-card'], focus: '#provider', action: '前往连接设置', path: ['选择连接', '填写配置', '保存设置'] },
    { id: 'conversation', view: 'agent', title: '把材料和指令一起交给 AI', kicker: '持续对话，而不是一次性问答',
      body: '把文件拖进对话，或点击附件按钮。文件会先进入待发送区；写清希望整理、分析或更新什么，再点击发送。网页链接也可以直接写在消息里。',
      hint: '后续直接追问即可。旧附件保留在消息和项目中，不会在每轮重复发送。', selectors: ['#composer', '#agentInput'], focus: '#agentInput', action: '前往对话', path: ['添加材料', '写下指令', '查看执行结果'] },
    { id: 'spaces', view: 'courses', title: '空间之下，是独立的项目', kicker: '资料各归其位',
      body: '日常、课程、科研分别管理。每门课或研究主题可以有自己的项目、文件树和任务。Agent 会分析归属；课程名称不明确时，需要你确认，避免合入错误课程。',
      hint: '直接把文件拖入项目，只保存原件并标记“待 AI 分析”。没有合适项目的科研资料也可独立入库。', selectors: ['.primary-nav', '#projectList', '#courses .page-heading'], focus: '[data-view="courses"]', action: '查看课程空间', path: ['空间', '项目', '资料与任务'] },
    { id: 'notes', view: 'agent', title: '让一篇主笔记持续生长', kicker: '原件与 Markdown 文档并排阅读',
      body: '先完成一次资料整理，再点击对话结果中的笔记卡，在右侧阅读区打开。标签可以切换不同材料；笔记支持编辑、实时预览和保存，也可以继续让 AI 补充同一篇内容。',
      hint: '编辑过的正文会受到保护；AI 的新稿需要你合并。保存用 ⌘S / Ctrl+S，未保存离开时会提示。', selectors: ['#readingPane:not([hidden])', '#readingToggle:not([hidden])', '#messageList [data-open-note]', '#messageList', '#composer'], focus: '#agentInput', action: '回到对话整理笔记', path: ['打开主笔记', '编辑与预览', '保存修订'] },
    { id: 'overview', view: 'dashboard', title: '从总览开始行动', kicker: '今天与未来一周，一眼可见',
      body: '总览显示未完成任务、近期截止时间与活跃项目。点击任务查看详情、时间、清单和来源；完成后勾选即可。各空间也有自己的总览和全部内容。',
      hint: '删除的内容先进入回收站，可恢复。执行历史与项目成果分别保留，不会把删除日志当成删除知识。', selectors: ['#dashboardTasks', '#dashboard .metrics'], focus: '[data-view="dashboard"]', action: '打开任务总览', path: ['查看近期任务', '打开详情', '勾选完成'] }
  ].map(step => Object.freeze(step));
  const shouldStart = state => !state?.ui?.onboarding || state.ui.onboarding.version < VERSION || !['completed', 'skipped'].includes(state.ui.onboarding.status);
  function placement(anchor, card, viewport) {
    const margin = 16, width = Math.max(0, viewport.width), height = Math.max(0, viewport.height);
    const cardWidth = Math.min(card.width || 380, Math.max(0, width - margin * 2));
    const cardHeight = Math.min(card.height || 390, Math.max(0, height - margin * 2));
    let x = (width - cardWidth) / 2, y = Math.max(margin, (height - cardHeight) / 2);
    if (anchor && width >= 760) {
      const roomRight = width - anchor.right - margin * 2, roomLeft = anchor.left - margin * 2;
      if (roomRight >= cardWidth) { x = anchor.right + margin; y = anchor.top; }
      else if (roomLeft >= cardWidth) { x = anchor.left - margin - cardWidth; y = anchor.top; }
      else if (height - anchor.bottom - margin * 2 >= cardHeight) { x = anchor.left; y = anchor.bottom + margin; }
      else if (anchor.top - margin * 2 >= cardHeight) { x = anchor.left; y = anchor.top - margin - cardHeight; }
    } else if (width < 760) y = height - cardHeight - margin;
    return { left: Math.max(margin, Math.min(x, width - cardWidth - margin)), top: Math.max(margin, Math.min(y, height - cardHeight - margin)), width: cardWidth, maxHeight: Math.max(0, height - margin * 2) };
  }
  function createController(hooks, env = root) {
    const document = env.document;
    if (!document) throw Error('新手引导需要工作站界面。');
    let index = 0, opened = false, opener = null, activeAnchor = null, pendingFrame = null, generation = 0, starting = null, navigating = false;
    const create = (tag, className, text) => { const node = document.createElement(tag); node.className = className || ''; if (text !== undefined) node.textContent = text; return node; };
    const makeButton = (className, text, click) => { const node = create('button', className, text); node.type = 'button'; node.onclick = click; return node; };
    const layer = create('div', 'onboarding-layer'); layer.id = 'onboardingLayer'; layer.hidden = true;
    const spotlight = create('div', 'onboarding-spotlight'); spotlight.setAttribute('aria-hidden', 'true'); spotlight.hidden = true;
    const card = create('section', 'onboarding-card'); card.id = 'onboardingCard'; card.tabIndex = -1; card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'false'); card.setAttribute('aria-labelledby', 'onboardingTitle'); card.setAttribute('aria-describedby', 'onboardingBody');
    const top = create('div', 'onboarding-top'); const brand = create('span', 'onboarding-brand', 'AI BRO / 入门');
    const skip = makeButton('onboarding-skip', '跳过', () => close('skipped')); skip.id = 'onboardingSkip'; skip.setAttribute('aria-label', '跳过新手引导'); top.append(brand, skip);
    const stepLabel = create('p', 'onboarding-kicker'); stepLabel.id = 'onboardingStep'; stepLabel.setAttribute('aria-live', 'polite');
    const title = create('h2', '', ''); title.id = 'onboardingTitle'; const body = create('p', 'onboarding-body'); body.id = 'onboardingBody';
    const path = create('ol', 'onboarding-path'); path.setAttribute('aria-label', '操作流程');
    const hint = create('p', 'onboarding-hint');
    const action = makeButton('onboarding-action', '', () => useStep()); action.id = 'onboardingAction';
    const notice = create('p', 'onboarding-notice'); notice.setAttribute('role', 'status'); notice.id = 'onboardingNotice';
    const footer = create('div', 'onboarding-footer'); const back = makeButton('onboarding-back', '上一步', () => move(-1)); back.id = 'onboardingBack';
    const count = create('span', 'onboarding-count'); const next = makeButton('onboarding-next', '下一步', () => move(1)); next.id = 'onboardingNext'; footer.append(back, count, next);
    card.append(top, stepLabel, title, body, path, hint, action, notice, footer); layer.append(spotlight, card); document.body.append(layer);
    const entry = makeButton('secondary onboarding-entry', '新手引导', () => open()); entry.id = 'openOnboarding'; entry.setAttribute('aria-controls', card.id); entry.setAttribute('aria-expanded', 'false');
    (document.querySelector('#settings .page-heading') || document.querySelector('#settings'))?.append(entry);
    function visible(node) { if (!node || node.hidden || node.isConnected === false) return false; const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < env.innerHeight && rect.left < env.innerWidth; }
    function anchorFor(step) {
      for (const selector of step.selectors) {
        const match = Array.from(document.querySelectorAll(selector)).find(visible);
        if (match) return match;
      }
      return null;
    }
    function layout() {
      pendingFrame = null; if (!opened) return;
      // Measure at the new width, rather than retaining the prior narrow
      // inline width after a window expands again.
      card.style.width = Math.max(0, Math.min(380, env.innerWidth - 32)) + 'px';
      activeAnchor = anchorFor(steps[index]); const rect = activeAnchor?.getBoundingClientRect();
      if (rect && env.innerWidth >= 760) {
        spotlight.hidden = false; Object.assign(spotlight.style, { left: `${Math.max(4, rect.left - 5)}px`, top: `${Math.max(4, rect.top - 5)}px`, width: `${Math.min(rect.width + 10, env.innerWidth - Math.max(4, rect.left - 5) - 4)}px`, height: `${Math.min(rect.height + 10, env.innerHeight - Math.max(4, rect.top - 5) - 4)}px` });
      } else spotlight.hidden = true;
      const next = placement(rect, card.getBoundingClientRect(), { width: env.innerWidth, height: env.innerHeight }); Object.assign(card.style, { left: next.left + 'px', top: next.top + 'px', width: next.width + 'px', maxHeight: next.maxHeight + 'px' });
    }
    function scheduleLayout() { if (!opened || pendingFrame !== null) return; pendingFrame = (env.requestAnimationFrame || (fn => env.setTimeout(fn, 0)))(layout); }
    function listen(enabled) {
      const method = enabled ? 'addEventListener' : 'removeEventListener';
      env[method]?.('resize', scheduleLayout); document[method]('scroll', scheduleLayout, true); document[method]('keydown', keydown);
    }
    async function paint() {
      const own = ++generation, step = steps[index]; navigating = true; back.disabled = next.disabled = action.disabled = true; notice.textContent = '';
      title.textContent = step.title; body.textContent = step.body; hint.textContent = step.hint; stepLabel.textContent = `${index + 1} / ${steps.length} · ${step.kicker}`;
      count.textContent = `${index + 1} / ${steps.length}`; next.textContent = index === steps.length - 1 ? '完成引导' : '下一步'; action.textContent = step.action; path.replaceChildren(...step.path.map(value => create('li', '', value)));
      try { if (hooks.showView) await hooks.showView(step.view); }
      catch (_) { if (own === generation) notice.textContent = '当前界面暂不能切换，可以先阅读说明，或稍后从设置重开引导。'; }
      if (!opened || own !== generation) return;
      navigating = false; back.disabled = index === 0; next.disabled = false; action.disabled = !hooks.showView; layout(); card.focus({ preventScroll: true });
    }
    async function persist(status) {
      const state = hooks.getState?.(); if (!state) return;
      state.ui ||= {}; state.ui.onboarding = { version: VERSION, status, updatedAt: Date.now() };
      try { if (await hooks.save?.() === false) hooks.toast?.('入门记录尚未保存，下次可能再次显示。'); }
      catch (_) { hooks.toast?.('入门记录尚未保存，下次可能再次显示。'); }
    }
    async function open() {
      if (opened) return; if (starting) return starting;
      // Do not replace an active modal, login, or unsaved editor decision.
      if (document.querySelector('dialog[open]:not([aria-modal="false"])')) return false;
      opener = document.activeElement; opened = true; index = 0; layer.hidden = false; entry.setAttribute('aria-expanded', 'true'); listen(true); await paint(); return opened;
    }
    function close(status = 'skipped', options = {}) {
      if (!opened) return false;
      opened = false; navigating = false; generation += 1; layer.hidden = true; spotlight.hidden = true; activeAnchor = null; entry.setAttribute('aria-expanded', 'false'); listen(false);
      if (pendingFrame !== null) { (env.cancelAnimationFrame || env.clearTimeout)?.(pendingFrame); pendingFrame = null; }
      if (options.restoreFocus !== false) {
        const focusTarget = [opener, entry, document.querySelector('.primary-nav .active'), document.querySelector('#agentInput')].find(visible);
        focusTarget?.focus?.({ preventScroll: true });
      }
      void persist(status); return true;
    }
    async function move(direction) { if (!opened || navigating) return; if (direction > 0 && index === steps.length - 1) { close('completed'); return; } index = Math.max(0, Math.min(steps.length - 1, index + direction)); await paint(); }
    async function useStep() {
      if (!opened || navigating || !hooks.showView) return;
      const step = steps[index]; close(index === steps.length - 1 ? 'completed' : 'skipped', { restoreFocus: false });
      try { await hooks.showView(step.view); const target = document.querySelector(step.focus); if (visible(target)) target.focus({ preventScroll: true }); }
      catch (_) { hooks.toast?.('暂时无法打开入口，请通过侧栏打开对应页面。'); }
    }
    function keydown(event) {
      if (!opened) return;
      if (event.key === 'Escape' && !document.querySelector('dialog[open]:not([aria-modal="false"])')) { event.preventDefault(); event.stopPropagation(); close('skipped'); return; }
      // The surrounding app stays interactive. Never consume arrows used to
      // edit a message or select an option outside this tour card.
      if (!card.contains(document.activeElement) || event.altKey || event.metaKey || event.ctrlKey) return;
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); void move(event.key === 'ArrowRight' ? 1 : -1); }
    }
    async function maybeStart() {
      if (opened || starting || !shouldStart(hooks.getState?.())) return false;
      starting = Promise.resolve(hooks.ready?.()).then(() => { starting = null; return shouldStart(hooks.getState?.()) ? open() : false; }).finally(() => { starting = null; });
      return starting;
    }
    function destroy() { if (opened) close('skipped'); layer.remove(); entry.remove(); }
    const api = { open, close, maybeStart, next: () => move(1), previous: () => move(-1), layout, destroy, isOpen: () => opened, currentStep: () => steps[index].id };
    if (hooks.autoStart !== false) void maybeStart().catch(() => {});
    return api;
  }
  let controller = null;
  return { VERSION, steps, shouldStart, placement, createController, init(hooks) { if (!controller) controller = createController(hooks); return controller; }, open: () => controller?.open(), maybeStart: () => controller?.maybeStart(), close: () => controller?.close() };
});
