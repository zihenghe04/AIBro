import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Orb, StatusBadge, Button, Card, Heading, Kbd, Caption, Text } from './halaska-kit.jsx';
import { AICSSThinkingState } from './aicss-thinking-state.jsx';
import { KitTabs } from './kit-controls.jsx';
import { createLifecycleHeading } from './lifecycle-heading.mjs';
import { Clock3 } from 'lucide-react';

const uiLabel = text => window.WorkstationI18n?.t(text) || text;

export function AgentProcessTabs({ messageId, value, progressCount, toolCount, issueCount = 0, toolFilter = 'all', progressPanelId, toolsPanelId }) {
  const t = (zh, en) => window.WorkstationI18n?.getLanguage?.() === 'en' ? en : zh;
  // Keep labels stable: upstream Tabs keys its buttons by label. New events
  // must update counts without replacing the focused tab during streaming.
  const options = [
    { value: 'progress', label: t('进展', 'Progress'), id: progressPanelId + '-tab', controls: progressPanelId,
      attributes: { 'aria-label': t(`进展，${progressCount} 项记录`, `Progress, ${progressCount} entries`) } },
    { value: 'tools', label: t('工具', 'Tools'), id: toolsPanelId + '-tab', controls: toolsPanelId,
      attributes: { 'aria-label': t(`工具，${toolCount} 次调用${issueCount ? `，${issueCount} 次异常` : ''}`, `Tools, ${toolCount} calls${issueCount ? `, ${issueCount} issues` : ''}`) } },
  ].filter(option => option.value === 'progress' ? progressCount > 0 : toolCount > 0);
  const select = (view, filter) => document.dispatchEvent(new CustomEvent('conversation-process-view', { detail: { messageId, view, ...(filter ? { filter } : {}) } }));
  return <div className="halaska-process-controls">
    <div className="halaska-process-tabs">
    <KitTabs options={options} value={value} label={t('查看执行过程', 'Inspect this run')}
      onChange={view => select(view)} />
    <Caption style={{ fontSize: 10, lineHeight: 1.6 }}>
      {t(`${progressCount} 项进展 · ${toolCount} 次工具调用`, `${progressCount} entries · ${toolCount} tool calls`)}
    </Caption>
    </div>
    {(issueCount > 0 || toolFilter === 'issues') && <div className="conversation-tool-filters" role="group" aria-label={t('筛选工具调用', 'Filter tool calls')}>
      {value === 'tools' && <Button variant="ghost" size="sm" aria-pressed={toolFilter !== 'issues'}
        style={{ minHeight: 28, boxShadow: 'none' }} onClick={() => select('tools', 'all')}>{t('全部工具', 'All tools')}</Button>}
      <Button variant="ghost" size="sm" aria-pressed={value === 'tools' && toolFilter === 'issues'}
        style={{ minHeight: 28, boxShadow: 'none' }} onClick={() => select('tools', 'issues')}>
        {t(`仅看异常（${issueCount}）`, `Issues only (${issueCount})`)}
      </Button>
      <Caption style={{ fontSize: 10, lineHeight: 1.6 }}>{t('失败、超时或中断；不含主动停止', 'Failed, timed out, or interrupted; excludes deliberate stops')}</Caption>
    </div>}
  </div>;
}

function useLifecycleHeading(desired, live, identity) {
  const [shown, setShown] = useState(desired), current = useRef(desired), controller = useRef(null), node = useRef(null);
  const intersecting = useRef(true);
  current.current = desired;
  const visible = () => !document.hidden && window.__aibroPresentationVisible !== false && window.__aibroSurfaceVisible !== false && intersecting.current;
  const reduced = () => document.body?.classList.contains('reduce-motion') || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  useLayoutEffect(() => {
    const policy = createLifecycleHeading({ initial: current.current, identity, onChange: setShown });
    controller.current = policy;
    setShown(current.current);
    return () => { policy.destroy(); if (controller.current === policy) controller.current = null; };
  }, []);
  useLayoutEffect(() => {
    controller.current?.update(desired, { active: live, identity, immediate: !visible() || reduced() });
  }, [desired.phase, desired.label, desired.detail, live, identity]);
  useEffect(() => {
    if (!live) return;
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const flush = () => controller.current?.flush();
    const changed = () => { if (!visible() || reduced()) flush(); };
    const observer = window.IntersectionObserver ? new window.IntersectionObserver(entries => {
      intersecting.current = entries[0]?.isIntersecting !== false;
      // Returning from an invisible surface starts at the latest real event.
      flush();
    }) : null;
    if (node.current) observer?.observe(node.current);
    const preferences = window.MutationObserver ? new window.MutationObserver(changed) : null;
    if (document.body) preferences?.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('aibro:presentation-visibility', flush);
    window.addEventListener('aibro:surface-visibility', flush);
    media?.addEventListener('change', changed);
    return () => {
      observer?.disconnect(); preferences?.disconnect(); media?.removeEventListener('change', changed);
      document.removeEventListener('visibilitychange', flush);
      window.removeEventListener('aibro:presentation-visibility', flush);
      window.removeEventListener('aibro:surface-visibility', flush);
    };
  }, [live]);
  return { heading: live ? shown : desired, node };
}

// Only the running heading has a 150 ms minimum dwell. This never invents an
// event or delays the authoritative body, ledger, counters or terminal state.
export function AgentLifecycleSummary({ phase, status, label, detail, count, issueCount = 0, elapsed, startedAt, streamReception, keyboardHint }) {
  const live = status === 'running';
  const { heading, node } = useLifecycleHeading({ phase, label, detail }, live, `${startedAt}:${document.documentElement.lang}`);
  const [, setClockSecond] = useState(0);
  const reception = window.StreamReception?.project(streamReception, { live, phase });
  const receptionActive = !!reception;
  useEffect(() => {
    if (!receptionActive) return;
    return window.ActivityMotion?.subscribeClock(node.current, now => setClockSecond(Math.floor(now / 1000)));
  }, [receptionActive, reception?.requestId]);
  // Quietness is a receipt-age fact, not a new model phase. It bypasses the
  // 150ms title dwell, so fresh content or terminal state clears it immediately.
  const quiet = reception?.quiet === true;
  const en = window.WorkstationI18n?.getLanguage?.() === 'en';
  const visibleLabel = quiet ? reception.first
    ? en ? `Waiting for response · ${reception.seconds}s` : `等待模型响应 · ${reception.seconds} 秒`
    : en ? `No new content · ${reception.seconds}s` : `暂未收到新内容 · ${reception.seconds} 秒`
    : heading.label;
  const tone = status === 'failed' ? 'error' : status === 'awaiting-approval' ? 'pending'
    : ['completed', 'completed-local', 'done'].includes(status) ? 'online' : 'default';
  return <span ref={node} className="halaska-lifecycle-line" data-lifecycle-status={status} data-lifecycle-stable-heading="" data-reception-clock={receptionActive ? '' : undefined} data-reception-quiet={quiet ? '' : undefined}>
    {live ? <span className={`progress-heading-mark${quiet ? '' : ' progress-activity'}`} aria-hidden="true">
      {quiet ? <span style={{ width: 20, height: 20, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', opacity: 0.65 }}><Clock3 size={16} strokeWidth={1.6} /></span>
        : <Orb variant={heading.phase === 'tool' ? 'orbit' : heading.phase === 'writing' ? 'sweep' : 'pulse'} size={20} label={heading.label} />}
    </span> : null}
    {live ? <span className="progress-phase-label"><AICSSThinkingState label={visibleLabel} active={!quiet} /></span> : <StatusBadge status={tone}>{label}</StatusBadge>}
    {heading.detail ? <span className="progress-heading-text" data-user-content="">{heading.detail}</span> : null}
    <span className="progress-count">{count}</span>
    {issueCount > 0 ? <span className="progress-issues">{en ? `${issueCount} tool ${issueCount === 1 ? 'issue' : 'issues'}` : `${issueCount} 次工具异常`}</span> : null}
    {elapsed ? <span className="progress-elapsed" data-progress-start={live && startedAt > 0 ? startedAt : undefined}>{elapsed}</span> : null}
    <span className="halaska-lifecycle-key" aria-hidden="true"><Kbd>↵</Kbd><span>{keyboardHint}</span></span>
    <span className="progress-chevron" aria-hidden="true">›</span>
  </span>;
}

// This component owns only the contents of a native summary. The host keeps
// disclosure state, persisted user pins, keyboard focus and the full body.
export function AgentActivitySummary({ title, kindLabel, status, statusLabel, active = false, elapsed = '', countLabel = '', detail = '' }) {
  const tone = status === 'failed' ? 'error'
    : ['pending', 'awaiting-approval', 'awaiting-save', 'rejected'].includes(status) ? 'pending'
    : ['completed', 'completed-local', 'done'].includes(status) ? 'online'
    : status === 'running' && active ? 'accent' : 'default';
  return <span className="halaska-activity-line" data-activity-status={status}>
    <span className="halaska-activity-heading" data-user-content="">
      <Text size="sm" weight="medium" style={{ fontSize: 12, lineHeight: 1.65, color: 'inherit' }}>
        {active ? <AICSSThinkingState label={title} active /> : title}
      </Text>
      {countLabel ? <Caption style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{countLabel}</Caption> : null}
    </span>
    <span className="halaska-activity-meta">
      {kindLabel ? <Caption style={{ fontSize: 10 }}>{kindLabel}</Caption> : null}
      {elapsed ? <Caption style={{ fontSize: 10, whiteSpace: 'nowrap' }}>{elapsed}</Caption> : null}
      <span className="halaska-activity-state"><StatusBadge status={tone}>{statusLabel}</StatusBadge></span>
    </span>
    {detail ? <span className="halaska-activity-group-detail"><Caption style={{ fontSize: 11, lineHeight: 1.6 }}>{detail}</Caption></span> : null}
  </span>;
}

export function AgentLifecycleActions({ status, title, description, hint, statusLabel, actions = [], compact = false, diagnosticDetails = [], diagnosticLabel = '诊断详情', diagnosticOpen = false }) {
  const buttons = <div className="halaska-lifecycle-buttons">
    {actions.map(action => <span key={action.key} data-lifecycle-action={action.key}>
      <Button variant={action.variant || 'secondary'} size="sm" disabled={action.disabled} title={action.title}
        style={{ height: 'auto', minHeight: 32, whiteSpace: 'normal', textAlign: 'center', lineHeight: 1.4 }}>
        {uiLabel(action.label)}
      </Button>
    </span>)}
  </div>;
  if (compact) return buttons;
  return <Card padding={14} style={{ borderRadius: 14, boxShadow: 'none', background: 'var(--panel)' }}>
    <div className="halaska-lifecycle-card" data-lifecycle-status={status}>
      <div className="halaska-lifecycle-card-heading">
        <Heading level={6} style={{ fontSize: 13, lineHeight: 1.55 }}>{title}</Heading>
        <StatusBadge status={status === 'failed' ? 'error' : status === 'awaiting-approval' ? 'pending' : 'default'}>
          {statusLabel}
        </StatusBadge>
      </div>
      {description ? <p className="halaska-lifecycle-description" data-user-content="">{description}</p> : null}
      {buttons}
      {status === 'failed' && diagnosticDetails.length > 0 ? <details className="halaska-failure-diagnostics" open={diagnosticOpen}
        style={{ minWidth: 0, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
        <summary style={{ cursor: 'pointer', fontSize: 11, lineHeight: 1.6, padding: '3px 0', overflowWrap: 'anywhere' }}
          onKeyDown={event => {
            if (event.target !== event.currentTarget || event.key !== 'Enter' || event.repeat || event.isComposing || event.nativeEvent?.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
            event.preventDefault(); event.currentTarget.click();
          }}>
          <Caption style={{ fontSize: 11, lineHeight: 1.6 }}>{diagnosticLabel}</Caption>
        </summary>
        <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.5fr)', gap: '6px 12px', margin: '8px 0 0', minWidth: 0 }}>
          {diagnosticDetails.map((row, index) => <React.Fragment key={index}>
            <dt style={{ minWidth: 0, overflowWrap: 'anywhere' }}><Caption style={{ fontSize: 11, lineHeight: 1.6 }}>{row.label}</Caption></dt>
            <dd style={{ margin: 0, minWidth: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}><Text size="xs" style={{ fontSize: 11, lineHeight: 1.6 }}>{row.value}</Text></dd>
          </React.Fragment>)}
        </dl>
      </details> : null}
      {hint ? <Caption style={{ display: 'block', fontSize: 11, lineHeight: 1.6, whiteSpace: 'pre-line' }}>{hint}</Caption> : null}
    </div>
  </Card>;
}

export function AgentReceipt({ title, description, label }) {
  return <div className="halaska-agent-receipt">
    <div className="halaska-lifecycle-card-heading">
      <Heading level={6} style={{ fontSize: 13, lineHeight: 1.55 }}>{title}</Heading>
      <StatusBadge status="online">{label}</StatusBadge>
    </div>
    {description ? <Caption style={{ display: 'block', fontSize: 11, lineHeight: 1.6 }}>{description}</Caption> : null}
  </div>;
}
