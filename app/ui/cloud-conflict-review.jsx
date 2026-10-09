import React, { useId, useLayoutEffect, useState } from 'react';
import { AlertBanner, Badge, Button, Card, EmptyState } from './halaska-kit.jsx';
import styles from './cloud-conflict-review.css';

if (!document.getElementById('cloud-conflict-review-styles')) {
  const style = document.createElement('style'); style.id = 'cloud-conflict-review-styles';
  style.textContent = styles; document.head.append(style);
}
const t = (zh, en) => /^en(?:-|$)/i.test(document.documentElement.lang || '') ? en : zh;
const text = value => {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value, null, 2); } catch { return t('无法显示此版本，请重新载入。', 'This version could not be displayed. Reload to try again.'); }
};
const hasRevision = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const cardStyle = { background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 16, boxShadow: 'none', minWidth: 0 };

function VersionColumn({ label, preview, fields, deleted, version, locked }) {
  return <section className="cloud-conflict-version" aria-label={label}>
    <div className="cloud-conflict-version-heading"><strong>{label}</strong><Badge variant={deleted ? 'danger' : 'default'}>{deleted ? t('已删除', 'Deleted') : t('保留内容', 'Content retained')}</Badge></div>
    {version != null && <p className="cloud-conflict-version-id">{t('服务器版本：', 'Server version: ')}<span data-user-content>{String(version)}</span></p>}
    {deleted && <p className="cloud-conflict-deletion">{t('选择这一版本会保留删除结果。', 'Choosing this version keeps the deletion.')}</p>}
    <pre tabIndex={0} aria-label={t(`${label}内容`, `${label} content`)} data-user-content>{deleted ? t('此版本已删除。', 'This version is deleted.') : text(preview) || t('没有可显示的正文，请查看全部字段。', 'No preview text is available. Review all fields below.')}</pre>
    <details className="cloud-conflict-fields"><summary aria-disabled={locked || undefined} tabIndex={locked ? -1 : 0} onClick={event => { if (locked) event.preventDefault(); }}>{t('全部字段', 'All fields')}</summary><pre tabIndex={0} aria-label={t(`${label}全部字段`, `${label}: all fields`)} data-user-content>{text(fields) || t('没有保存字段。', 'No fields were saved.')}</pre></details>
  </section>;
}

export function CloudConflictReview({ entries = [], busy = false, resolvingId = null, error = null, onChoose, onReload }) {
  const [page, setPage] = useState(0), headingId = useId();
  const items = Array.isArray(entries) ? entries : [], total = items.length, pages = Math.max(1, Math.ceil(total / 5)), currentPage = Math.min(page, pages - 1);
  const locked = !!busy || resolvingId != null, visible = items.slice(currentPage * 5, currentPage * 5 + 5);
  useLayoutEffect(() => { if (page !== currentPage) setPage(currentPage); }, [page, currentPage]);
  const reload = () => { if (!locked) onReload?.(); };
  return <section className="cloud-conflict-review" aria-labelledby={headingId} aria-busy={locked}>
    <div className="cloud-conflict-review-heading"><div><h3 id={headingId}>{t('对比冲突版本', 'Compare conflicting versions')}</h3><p>{t('查看本机与服务器的内容，再逐项选择保留哪一版。', 'Compare this device with the server, then choose which version to keep for each item.')}</p></div><Badge variant={total ? 'warning' : 'default'}>{t(`待处理 ${total} 项`, `${total} to review`)}</Badge></div>
    {error?.message && <div role="alert"><AlertBanner variant="warning" title={t('暂未完成处理', 'Review is not complete')} description={String(error.message)} /></div>}
    <div className="cloud-conflict-review-toolbar"><p role="status" aria-live="polite">{locked ? resolvingId != null ? t('正在保存你的选择…', 'Saving your choice…') : t('正在载入版本…', 'Loading versions…') : total ? t(`显示第 ${currentPage * 5 + 1}–${Math.min(total, (currentPage + 1) * 5)} 项，共 ${total} 项`, `Showing ${currentPage * 5 + 1}–${Math.min(total, (currentPage + 1) * 5)} of ${total}`) : t('当前没有待处理条目。', 'There are no pending items.')}</p><Button size="sm" variant="ghost" disabled={locked || !onReload} onClick={reload}>{t('重新载入', 'Reload')}</Button></div>
    <div className="cloud-conflict-review-list">
      {visible.map((entry, index) => {
        // Capture exactly the version the user is comparing, not a later object
        // mutation. The host revalidates this token before resolving the conflict.
        const { id, revision } = entry, stale = !hasRevision(revision) || error?.staleId === '*' || error?.staleId === id;
        const disabled = locked || stale || !onChoose, titleId = `${headingId}-${currentPage * 5 + index}`;
        const choose = choice => { if (!disabled) onChoose(id, choice, revision); };
        return <article key={id} className="cloud-sync-conflict" aria-labelledby={titleId} data-conflict-id={id}>
          <Card padding={0} style={cardStyle}><div className="cloud-conflict-card-heading"><h4 id={titleId} data-user-content>{entry.title || t('未命名记录', 'Untitled record')}</h4><Badge variant={!!entry.localDeleted !== !!entry.remoteDeleted ? 'warning' : 'default'}>{!!entry.localDeleted !== !!entry.remoteDeleted ? t('删除与修改冲突', 'Deletion versus modification') : t('版本冲突', 'Version conflict')}</Badge></div>
            {entry.groupId ? <div className="cloud-conflict-group">
              <p>{t(`这次操作包含 ${entry.groupMembers?.length || 0} 项关联修改，需要一起处理。采用云端会替换下列全部本机版本；之后可重新提出修改。`, `This operation contains ${entry.groupMembers?.length || 0} related changes. Using cloud replaces all local versions below. You can then propose a new change.`)}</p>
              {(entry.groupMembers || []).map((member, memberIndex) => <details key={memberIndex} className="cloud-conflict-fields" open={memberIndex === 0}>
                <summary data-user-content>{member.title || t('关联记录', 'Related record')}</summary>
                <div className="cloud-sync-versions"><VersionColumn label={t('本机版本', 'Local version')} preview={member.localPreview} fields={member.localFields} deleted={!!member.localDeleted} locked={locked} /><VersionColumn label={t('服务器版本', 'Server version')} preview={member.remotePreview} fields={member.remoteFields} deleted={!!member.remoteDeleted} version={member.remoteVersion} locked={locked} /></div>
              </details>)}
            </div> : <div className="cloud-sync-versions"><VersionColumn label={t('本机版本', 'Local version')} preview={entry.localPreview} fields={entry.localFields} deleted={!!entry.localDeleted} locked={locked} /><VersionColumn label={t('服务器版本', 'Server version')} preview={entry.remotePreview} fields={entry.remoteFields} deleted={!!entry.remoteDeleted} version={entry.remoteVersion} locked={locked} /></div>}
            {stale && <div className="cloud-conflict-stale" role="status"><AlertBanner variant="warning" title={t('内容已变化，重新载入后再比较', 'Content changed. Reload before comparing again.')} /><Button size="sm" variant="outline" disabled={locked || !onReload} onClick={reload}>{t('重新载入', 'Reload')}</Button></div>}
            <div className="cloud-sync-conflict-actions">{!entry.groupId && <Button size="sm" variant="outline" disabled={disabled} onClick={() => choose('local')}>{t('保留本机', 'Keep local')}</Button>}<Button size="sm" variant="outline" disabled={disabled || !!entry.groupId && !entry.groupMembers?.length} onClick={() => choose('remote')}>{entry.groupId ? t('整组使用云端', 'Use entire cloud group') : t('使用云端', 'Use cloud')}</Button>{resolvingId === id && <span role="status">{t('正在保存…', 'Saving…')}</span>}</div>
          </Card>
        </article>;
      })}
      {!total && <EmptyState title={locked ? t('正在载入冲突', 'Loading conflicts') : error ? t('冲突尚未载入', 'Conflicts have not loaded') : t('没有待处理的冲突', 'No conflicts to review')} description={locked ? t('请稍候，载入后即可比较两个版本。', 'Wait for the versions to load before comparing them.') : error ? t('重新载入后再检查待处理版本。', 'Reload to check the pending versions.') : t('后续出现版本冲突时，会在这里列出。', 'Future version conflicts will appear here.')} />}
    </div>
    {pages > 1 && <nav className="cloud-conflict-pagination" aria-label={t('冲突列表分页', 'Conflict list pages')}><Button size="sm" variant="ghost" disabled={locked || currentPage === 0} onClick={() => { if (!locked) setPage(currentPage - 1); }}>{t('上一页', 'Previous')}</Button><span aria-live="polite">{t(`第 ${currentPage + 1} / ${pages} 页`, `Page ${currentPage + 1} of ${pages}`)}</span><Button size="sm" variant="ghost" disabled={locked || currentPage === pages - 1} onClick={() => { if (!locked) setPage(currentPage + 1); }}>{t('下一页', 'Next')}</Button></nav>}
  </section>;
}
