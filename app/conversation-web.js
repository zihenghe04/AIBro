(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ConversationWeb = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const active = item => item && !item.archived && !item.deletedAt;
  const cancelled = () => Object.assign(new Error('已取消联网读取。'), { code: 'CANCELLED' });
  function declinesWeb(goal) {
    return /(?:不要|不用|无需|禁止|别|不允许).{0,10}(?:联网|上网|搜索网页|访问链接|读取链接|打开链接|下载)|(?:do not|don't|without|no need to)\s+(?:browse|search the web|access (?:the )?(?:internet|links)|fetch|download)/i.test(String(goal || ''));
  }
  function sourceURL(value) {
    try {
      const url = new URL(String(value));
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
      url.hash = '';
      // arXiv abstract and PDF links are two views of the same source; keep
      // explicit version suffixes so v1 and v2 are never silently conflated.
      if (/(^|\.)arxiv\.org$/i.test(url.hostname)) {
        const match = url.pathname.match(/^\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)(?:\.pdf)?\/?$/i);
        if (match) return `https://arxiv.org/pdf/${match[1]}`;
      }
      return url.href;
    } catch (_) { return null; }
  }
  function links(goal) {
    if (declinesWeb(goal)) return [];
    const values = String(goal || '').match(/https?:\/\/[^\s<>"'`\u3000\u3001\u3002\uff0c\uff1b\uff01\uff1f\uff08\uff09\u3010\u3011]+/gi) || [];
    return [...new Set(values.map(value => {
      value = value.replace(/[.,;!?]+$/, '');
      // A closing parenthesis is legal inside a URL, but Markdown's wrapper
      // is not part of it. Remove only unmatched trailing delimiters.
      for (const [open, close] of [['(', ')'], ['[', ']']]) {
        while (value.endsWith(close) && value.split(close).length > value.split(open).length) value = value.slice(0, -1);
      }
      return sourceURL(value);
    }).filter(Boolean))];
  }
  function isPaperGoal(goal) {
    const text = String(goal || '');
    return /^\/paper(?:\s|$)/i.test(text) || /(?:分析|阅读|解读|读).*?(?:论文|文献)|(?:论文|文献).*(?:分析|笔记|解读)|(?:read|analy[sz]e|review).*(?:paper|arxiv)/i.test(text) || links(text).some(url => /^https:\/\/arxiv\.org\/pdf\//.test(url));
  }
  function searchSupported(provider, base, goal) {
    if (declinesWeb(goal)) return false;
    if (provider === 'openai-auth') return true;
    try { const url = new URL(base); return url.protocol === 'https:' && url.hostname === 'api.openai.com'; } catch (_) { return false; }
  }
  const snapshot = item => ({ id: item.id, name: item.name || item.originalName || '网页资料', originalName: item.originalName || item.name || '', mimeType: item.mimeType || '', size: Number(item.size) || 0 });
  function reusable(item, url) {
    return active(item) && item.status !== 'parse-error' && (item.fileStored || String(item.content || '').trim()) && [item.url, item.finalUrl].some(value => sourceURL(value) === url);
  }
  async function acquire({ goal, imports = [], attachments = [], signal, fetch: fetcher, assertActive = () => {}, onSource = () => {}, stage = () => {}, permissionMode, confirmRead, onTool = () => {} }) {
    const urls = links(goal);
    const check = () => { if (signal?.aborted) throw cancelled(); assertActive(); };
    check();
    if (!urls.length) return [];
    if (permissionMode === 'request') {
      stage('等待联网读取的批准');
      if (!await confirmRead({ title: '读取本条消息中的链接', detail: `获取并保存以下公开资料，交给当前模型分析：\n${urls.join('\n')}`, signal })) throw cancelled();
      check();
    }
    const items = [];
    for (const url of urls) {
      check();
      const activity={kind:'tool',id:'web-read:'+url,name:'web_read',url,text:url};
      onTool({...activity,status:'running'});
      try {
      let item = [...attachments, ...imports].find(candidate => reusable(candidate, url));
      let created = false;
      if (item) stage(`复用已保存的资料：${item.name}`, 'done');
      else {
        stage(`正在读取 ${url}`);
        const response = await fetcher('/__fetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, native: true }), signal });
        const parsed = await response.json().catch(() => ({})); check();
        if (!response.ok) throw new Error(`链接读取失败：${url}\n${parsed.error || `HTTP ${response.status}`}。可直接重试；已保存的资料会复用。`);
        if (!parsed.id || !(parsed.fileStored || parsed.storedLocally)) throw new Error('网页原件尚未保存，请重启更新后的工作站再重试。');
        if (parsed.mimeType !== 'application/pdf' && !/^image\//.test(parsed.mimeType || '') && !String(parsed.content || '').trim()) throw new Error(`链接没有可读取的正文：${url}。未将空白内容作为分析来源。`);
        const now = Date.now();
        item = { id: parsed.id, name: parsed.name || url, originalName: parsed.name || url,
          url, finalUrl: parsed.finalUrl || parsed.url || url, mimeType: parsed.mimeType || 'text/html',
          size: Number(parsed.size) || 0, fileStored: true, dataUrl: null,
          content: String(parsed.content || ''), pages: parsed.pages || [], parser: parsed.parser || 'web-original',
          paperMetadata: parsed.paperMetadata || null, contentTruncated: !!parsed.truncated,
          status: parsed.content ? 'parsed' : 'original-only', error: parsed.warning || '', tags: [],
          workspace: isPaperGoal(goal) ? '科研' : null, projectId: null, folderPath: '原始资料',
          analysis: { status: 'pending' }, importOrigin: 'conversation-url', fetchedAt: now, createdAt: now, updatedAt: now };
        created = true;
      }
      check();
      await onSource(item, created); check();
      if (!items.some(entry => entry.id === item.id)) items.push(item);
      if (created) stage(`已保存原件：${item.name}`, 'done');
      onTool({...activity,status:'completed',text:item.name||url});
      }catch(error){onTool({...activity,status:error.code==='CANCELLED'||signal?.aborted?'cancelled':'failed',text:error.message});throw error;}
    }
    return items;
  }
  return Object.freeze({ declinesWeb, sourceURL, links, isPaperGoal, searchSupported, snapshot, acquire });
});
