import React from 'react';
import { Button } from './halaska-kit.jsx';

const paths = {
  copyMessage: <><rect x="7" y="7" width="11" height="12" rx="2"/><path d="M14 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2"/></>,
  quoteMessage: <><path d="M8 7H4v5h4V7Zm10 0h-4v5h4V7ZM8 12c0 3-1 4-3 5m13-5c0 3-1 4-3 5"/></>,
  more: <><circle cx="4" cy="11" r="1"/><circle cx="11" cy="11" r="1"/><circle cx="18" cy="11" r="1"/></>,
};
function Glyph({ name }) {
  return <svg viewBox="0 0 22 22" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
function Action({ action, compact = false }) {
  return <span className={compact ? 'message-action-slot is-compact' : 'message-action-slot'} data-message-action-key={action.key}>
    <Button variant="ghost" size="sm" type="button" title={action.title || action.label} aria-label={action.label}
      disabled={action.disabled} style={{ boxShadow: 'none', minWidth: 0, padding: compact ? 6 : '7px 10px', width: compact ? 30 : '100%', height: compact ? 30 : 'auto', minHeight: 30, justifyContent: compact ? 'center' : 'flex-start' }}>
      {compact ? <Glyph name={action.key}/> : action.label}
    </Button>
  </span>;
}

// A native disclosure contains regular buttons (not an ARIA menu with an
// incomplete keyboard contract). Tab remains natural; arrows/Home/End are
// convenient additions. The host retains outside-click dismissal.
export function handleActionKeys(event) {
  if (event.isComposing || event.nativeEvent?.isComposing) return;
  const menu = event.currentTarget, summary = menu.querySelector('summary');
  const buttons = [...menu.querySelectorAll('.message-action-options button:not([disabled])')];
  if (event.key === 'Escape' && menu.open) {
    event.preventDefault(); event.stopPropagation(); menu.open = false; summary?.focus(); return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  if (!buttons.length) return;
  event.preventDefault(); event.stopPropagation(); menu.open = true;
  const current = buttons.indexOf(menu.ownerDocument.activeElement);
  const index = event.key === 'Home' ? 0 : event.key === 'End' || (current < 0 && event.key === 'ArrowUp') ? buttons.length - 1
    : event.key === 'ArrowDown' ? (current + 1) % buttons.length : (current - 1 + buttons.length) % buttons.length;
  buttons[index].focus();
}
export function MessageActionBar({ actions = [], label = '消息操作', moreLabel = '更多消息操作' }) {
  const primary = actions.filter(item => ['copyMessage', 'quoteMessage'].includes(item.key));
  const overflow = actions.filter(item => !['copyMessage', 'quoteMessage'].includes(item.key));
  return <span className="message-action-bar" role="group" aria-label={label}>
    {primary.map(action => <Action key={action.key} action={action} compact/>)}
    {overflow.length > 0 && <details className="message-action-menu message-actions-overflow" onKeyDown={handleActionKeys}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }}>
      <summary title={moreLabel} aria-label={moreLabel}><Glyph name="more"/></summary>
      <span className="message-action-options" onClick={event => {
        if (event.target.closest('button:not([disabled])')) event.currentTarget.parentElement.open = false;
      }}>{overflow.map(action => <Action key={action.key} action={action}/>)}</span>
    </details>}
  </span>;
}
