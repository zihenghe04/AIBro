import React, { useLayoutEffect, useRef } from 'react';
import { DataTable, Button, Checkbox } from './halaska-kit.jsx';
import styles from './library-data-table.css';

if (!document.getElementById('halaska-library-data-table')) {
  const style = document.createElement('style'); style.id = 'halaska-library-data-table'; style.textContent = styles; document.head.append(style);
}
const t = (zh, en) => document.documentElement.lang.startsWith('en') ? en : zh;

function TableSelection({ checked, indeterminate, disabled, onChange, row, all }) {
  const ref = useRef(null), label = all ? t('选择全部可见项', 'Select all visible items') : t(`选择 ${row.title}`, `Select ${row.title}`);
  useLayoutEffect(() => { if (ref.current) ref.current.indeterminate = !!indeterminate; }, [indeterminate]);
  return <span className="library-data-selection" data-mixed={indeterminate || undefined}>
    <input ref={ref} type="checkbox" checked={checked} disabled={disabled} aria-label={label} aria-checked={indeterminate ? 'mixed' : checked}
      data-cui-check={all ? undefined : ''} data-cui-all={all ? '' : undefined}
      onChange={event => { if (!disabled) onChange?.(event.target.checked); }} />
    <span className="library-data-check-visual" aria-hidden="true"><Checkbox checked={checked} disabled={disabled} />{indeterminate && <span className="library-data-mixed">−</span>}</span>
  </span>;
}

// Button is the upstream Kit component; the pinned bridge does not forward
// arbitrary data attributes, so expose the existing controller selectors on
// its actual button after mount rather than putting an extra hit target around it.
function TableAction({ attribute, attributeValue = '', className, children, ...props }) {
  const ref = useRef(null);
  useLayoutEffect(() => { ref.current?.querySelector('button')?.setAttribute(attribute, attributeValue); }, [attribute, attributeValue]);
  return <span ref={ref} className={className}><Button type="button" variant="ghost" size="sm" {...props}>{children}</Button></span>;
}
function FileIcon({ kind }) {
  return <svg className={`library-data-icon ${kind}`} viewBox="0 0 24 24" aria-hidden="true">
    {kind === 'task' ? <path d="M5 6h14M5 12h14M5 18h9" /> : <><path d="M6 3h9l3 3v15H6zM15 3v4h3" /><path d="M9 11h6M9 15h6" /></>}
  </svg>;
}
const typeLabel = kind => ({ note: t('笔记', 'Note'), import: t('资料', 'Source'), paper: t('论文', 'Paper'), task: t('任务', 'Task') })[kind] || '';
const statusLabel = value => ({ '笔记': 'Note', '待审阅': 'Needs review', '已审阅': 'Reviewed', '项目日记': 'Project journal', '项目计划': 'Project plan', '长期记忆': 'Long-term memory', '待 AI 分析': 'Awaiting AI analysis', '已分析': 'Analyzed', '待开始': 'Not started', '进行中': 'In progress', '已完成': 'Completed', '受阻': 'Blocked' })[value] || value;

export function LibraryDataTable({ rows = [], selectedKeys = [], sort = { key: 'updated', dir: 'desc' }, projectScoped = false, busy = false, canDelete = false,
  onToggle, onToggleAll, onSort, onOpen, onDelete, onProject }) {
  const columns = [
    { key: 'name', label: t('名称', 'Name'), sortKey: 'name' },
    ...(!projectScoped ? [{ key: 'project', label: t('归属项目', 'Project') }] : []),
    { key: 'status', label: t('状态', 'Status') }, { key: 'updated', label: t('更新时间', 'Updated'), sortKey: 'updated' },
    { key: 'actions', label: <span className="library-data-sr-only">{t('操作', 'Actions')}</span> },
  ];
  const cells = row => {
    const updated = typeof row.updated === 'number' && Number.isFinite(row.updated) && row.updated > 0 ? new Date(row.updated) : null;
    const date = updated && Number.isFinite(updated.getTime()) ? updated : null;
    const tone = ['done', 'analysis-pending', 'warning', 'error'].includes(row.statusTone) ? row.statusTone : '';
    const values = {
      name: <TableAction className="library-data-open" attribute="data-cui-open" disabled={busy || typeof onOpen !== 'function'}
        aria-label={t(`打开${typeLabel(row.kind)}：${row.title}`, `Open ${typeLabel(row.kind).toLowerCase()}: ${row.title}`)} title={row.title}
        onClick={event => { if (!busy) onOpen?.(row.key, event.currentTarget); }}>
        <FileIcon kind={row.kind} /><span className="library-data-name" aria-hidden="true"><strong>{row.title}</strong><small>{row.folder || typeLabel(row.kind)}</small></span>
      </TableAction>,
      project: row.projectId ? <TableAction className="library-data-project" attribute="data-cui-project" attributeValue={row.projectId}
        disabled={busy || typeof onProject !== 'function'} onClick={() => { if (!busy) onProject?.(row.key); }}>{row.projectName}</TableAction> : <span className="library-data-unassigned">{row.projectName || t('未归属项目', 'No project')}</span>,
      status: <span className={`library-data-status ${tone}`} title={row.statusDetail || undefined}>{t(row.status, statusLabel(row.status))}</span>,
      updated: <time dateTime={date?.toISOString()}>{date ? date.toLocaleDateString(t('zh-CN', 'en-US'), { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</time>,
      actions: <TableAction className="library-data-delete" attribute="data-cui-delete" disabled={busy || !canDelete || typeof onDelete !== 'function'}
        title={t(`移入回收站：${row.title}`, `Move to Trash: ${row.title}`)} aria-label={t(`移入回收站：${row.title}`, `Move to Trash: ${row.title}`)}
        onClick={() => { if (!busy && canDelete) onDelete?.(row.key); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7" /></svg></TableAction>,
    };
    return columns.map(column => values[column.key]);
  };
  return <div className="library-data-table" data-project-scoped={projectScoped || undefined}>
    <DataTable columns={columns.map(column => column.label)} columnKeys={columns.map(column => column.key)} rows={rows}
      getRowId={row => row.key} getRowCells={cells} selectedIds={selectedKeys} disabled={busy}
      onToggleRow={(key, checked) => { if (!busy) onToggle?.(key, checked); }} onToggleAll={checked => { if (!busy) onToggleAll?.(checked); }}
      manualSort sort={sort} sortKeys={columns.map(column => column.sortKey ?? null)} onSortChange={key => { if (!busy) onSort?.(key); }}
      tableLabel={projectScoped ? t('项目资料', 'Project sources') : t('知识与资料', 'Knowledge and sources')} renderSelection={({ key, ...props }) => <TableSelection key={key} {...props} />}
      getRowProps={row => ({ 'data-cui-key': row.key, 'data-cui-id': row.id, 'data-cui-kind': row.kind })} />
  </div>;
}
