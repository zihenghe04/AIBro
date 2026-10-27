/* Models → Usage: four cards, a time range and request / provider / model tables. Counts only; no prompts or answers exist to show. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UsageStatsUI = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const Stats = () => root.UsageStats || (typeof require === 'function' ? require('./usage-stats.js') : null);
  const english = () => root.WorkstationI18n?.getLanguage?.() === 'en' || /^en(?:-|$)/i.test(root.document?.documentElement?.lang || '');
  const t = (zh, en) => english() ? en : zh;
  const RANGE_LABEL = { '24h': ['24 小时', '24 h'], '7d': ['7 天', '7 days'], '30d': ['30 天', '30 days'], all: ['全部', 'All'] };
  const ROLE_LABEL = { qa: ['问答', 'Q&A'], translate: ['翻译', 'Translate'], vision: ['视觉', 'Vision'], kernel: ['内核', 'Background'], other: ['其他', 'Other'] };
  const TABS = ['requests', 'providers', 'models'];
  const TAB_LABEL = { requests: ['请求日志', 'Requests'], providers: ['供应商', 'Providers'], models: ['模型', 'Models'] };

  function mount(hostEl, options = {}) {
    const doc = hostEl.ownerDocument, S = Stats();
    const state = { range: '7d', tab: 'requests', data: null, error: '', loading: false, pricesOpen: false };
    const el = (tag, props = {}, ...children) => {
      const node = doc.createElement(tag);
      for (const [key, value] of Object.entries(props)) {
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
        else if (value !== false && value != null) node.setAttribute(key, value === true ? '' : value);
      }
      for (const child of children.flat()) if (child) node.append(child);
      return node;
    };
    const name = id => options.providerName?.(id) || id;
    const time = ts => { const d = new Date(ts * 1000); const p = n => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

    async function load() {
      state.loading = true; state.error = ''; paint();
      try { state.data = await options.load(state.range); } catch (error) { state.error = error && error.message ? error.message : t('读取失败。', 'Could not load.'); }
      state.loading = false; paint();
    }

    function table(headers, rows) {
      return el('table', { class: 'pv-table' }, el('thead', {}, el('tr', {}, headers.map(label => el('th', { text: label })))),
        el('tbody', {}, rows.length ? rows.map(cells => el('tr', {}, cells.map(cell => el('td', typeof cell === 'object' && cell ? cell : { text: String(cell) })))) : [el('tr', {}, el('td', { colspan: String(headers.length), class: 'pv-note', text: t('这个时间范围内还没有请求。', 'No requests in this range yet.') }))]));
    }

    function paint() {
      const data = state.data, prices = options.getPrices?.() || {};
      const totals = data ? S.totals(data.byModel, prices) : null;
      const cards = data ? [
        [t('请求', 'Requests'), String(data.cards.requests), data.cards.failed ? t(`${data.cards.failed} 次未成功`, `${data.cards.failed} not completed`) : ''],
        [t('估算费用', 'Estimated cost'), totals.pricedRequests > 0 ? S.money(totals.cost) : (data.cards.requests - totals.subscriptionRequests === 0 ? S.money(0) : '—'),
          totals.subscriptionRequests ? t(`订阅请求 ${totals.subscriptionRequests} 次不计入`, `${totals.subscriptionRequests} subscription requests excluded`) : (totals.unknownModels.length ? t(`${totals.unknownModels.length} 个模型没有价格`, `${totals.unknownModels.length} models without a price`) : '')],
        ['Token', S.compact(data.cards.input + data.cards.output), t(`输入 ${S.compact(data.cards.input)} / 输出 ${S.compact(data.cards.output)}`, `In ${S.compact(data.cards.input)} / out ${S.compact(data.cards.output)}`)],
        [t('缓存命中率', 'Cache hit rate'), S.percent(data.cards.cacheHitRate), '']
      ] : [];
      const body = [];
      if (data) {
        if (state.tab === 'requests') body.push(table([t('时间', 'Time'), t('供应商', 'Provider'), t('模型', 'Model'), t('用途', 'Purpose'), 'Token', t('费用', 'Cost'), t('延迟', 'Latency'), t('状态', 'Status')],
          data.rows.map(row => {
            const cost = row.provider_kind === 'account' ? t('订阅', 'Subscription') : S.money(S.costOf({ model: row.model, input: row.input, output: row.output, cache_read: row.cache_read }, prices));
            const ok = row.outcome === 'completed';
            return [time(row.ts), name(row.provider_id), row.model, t(...(ROLE_LABEL[row.role] || ROLE_LABEL.other)), row.input === null && row.output === null ? '—' : S.compact((row.input || 0) + (row.output || 0)), cost, S.latency(row.latency_ms),
              { class: 'pv-status', 'data-ok': ok ? '1' : '0', text: row.status ? String(row.status) : ok ? '200' : t('未完成', 'Incomplete') }];
          })));
        else if (state.tab === 'providers') body.push(table([t('供应商', 'Provider'), t('请求', 'Requests'), t('输入', 'Input'), t('输出', 'Output'), t('费用', 'Cost')],
          data.byProvider.map(group => { const models = data.byModel.filter(m => m.provider_id === group.provider_id); const sub = group.provider_kind === 'account'; const sum = S.totals(models, prices);
            return [name(group.provider_id), String(group.requests), S.compact(group.input), S.compact(group.output), sub ? t('订阅', 'Subscription') : (sum.pricedRequests ? S.money(sum.cost) : '—')]; })));
        else body.push(table([t('模型', 'Model'), t('供应商', 'Provider'), t('请求', 'Requests'), t('输入', 'Input'), t('输出', 'Output'), t('费用', 'Cost')],
          data.byModel.map(group => [group.model, name(group.provider_id), String(group.requests), S.compact(group.input), S.compact(group.output), group.provider_kind === 'account' ? t('订阅', 'Subscription') : S.money(S.costOf(group, prices))])));
      }
      // 价格表：内置价格 + 你自己的覆盖（美元 / 百万 token）。
      const models = data ? [...new Set(data.byModel.filter(m => m.provider_kind !== 'account').map(m => m.model))] : [];
      const priceBox = el('details', { class: 'pv-more', id: 'usagePrices', ...(state.pricesOpen ? { open: true } : {}), ontoggle: event => { state.pricesOpen = event.target.open; } },
        el('summary', { text: t('定价配置', 'Pricing') }),
        el('p', { class: 'pv-note', text: t('美元 / 百万 token。内置价格随版本更新，只用于估算；填写后以你的价格为准，留空回到内置价格。', 'USD per million tokens. Built-in prices ship with the app and are estimates only; your values win, empty falls back to the built-in price.') }),
        models.length ? el('table', { class: 'pv-table' }, el('thead', {}, el('tr', {}, [t('模型', 'Model'), t('输入', 'Input'), t('输出', 'Output'), t('缓存读', 'Cache read')].map(label => el('th', { text: label })))),
          el('tbody', {}, models.map(model => {
            const own = prices[model] || null, built = S.priceFor(model, {});
            const field = key => { const input = el('input', { type: 'number', min: '0', step: 'any', class: 'pv-price', 'data-model': model, 'data-key': key, 'aria-label': `${model} ${key}`, value: own && own[key] != null ? String(own[key]) : '', placeholder: built && built[key] != null ? String(built[key]) : '—' });
              input.addEventListener('change', () => commitPrice(model)); return el('td', {}, input); };
            return el('tr', {}, el('td', { text: model }), field('input'), field('output'), field('cacheRead'));
          }))) : el('p', { class: 'pv-note', text: t('还没有按量计费的请求。', 'No pay-as-you-go requests yet.') }));
      const retention = el('select', { id: 'usageRetention', 'aria-label': t('保留时间', 'Retention'), onchange: event => void options.setRetention?.(Number(event.target.value)).then(load, () => {}) },
        [7, 30, 90, 365].map(days => el('option', { value: String(days), text: t(`保留 ${days} 天`, `Keep ${days} days`), ...(data && data.retentionDays === days ? { selected: true } : {}) })));
      hostEl.replaceChildren(
        el('div', { class: 'pu-top' },
          el('div', { class: 'pv-actions', role: 'group', 'aria-label': t('时间范围', 'Range') }, S.RANGES.map(range => el('button', { type: 'button', class: 'secondary pv-small', 'data-range': range, ...(state.range === range ? { 'aria-pressed': 'true' } : {}), text: t(...RANGE_LABEL[range]), onclick: () => { state.range = range; void load(); } }))),
          el('span', { class: 'pv-note', role: 'status', text: state.loading ? t('正在读取…', 'Loading…') : state.error })),
        data ? el('div', { class: 'pu-cards' }, cards.map(([label, value, sub]) => el('div', { class: 'pu-card' }, el('span', { class: 'pv-note', text: label }), el('b', { text: value }), sub ? el('span', { class: 'pv-note', text: sub }) : null))) : null,
        el('div', { class: 'pv-actions', role: 'tablist' }, TABS.map(tab => el('button', { type: 'button', role: 'tab', class: 'secondary pv-small', 'data-tab': tab, 'aria-selected': state.tab === tab ? 'true' : 'false', text: t(...TAB_LABEL[tab]), onclick: () => { state.tab = tab; paint(); } }))),
        ...body, priceBox,
        el('div', { class: 'pv-actions' }, retention, el('button', { type: 'button', class: 'secondary pv-small', id: 'usageClear', text: t('清空统计', 'Clear statistics'), onclick: () => { if (!options.confirm || options.confirm(t('清空全部使用统计？这不会影响对话和资料。', 'Clear all usage statistics? Conversations and materials are not affected.'))) void options.clear?.().then(load, () => {}); } })),
        el('p', { class: 'pv-note', text: t('只记录模型、Token、延迟和状态，不保存提示词和回答。授权登录用订阅额度，不计入总费用。', 'Only the model, tokens, latency and status are recorded, never prompts or answers. Subscription sign-ins use the plan quota and are not part of the total cost.') }));
    }
    function commitPrice(model) {
      const read = key => { const node = hostEl.querySelector(`input[data-model="${model.replace(/"/g, '\\"')}"][data-key="${key}"]`); const v = node && node.value.trim() !== '' ? Number(node.value) : null; return v !== null && Number.isFinite(v) && v >= 0 ? v : null; };
      const next = { input: read('input'), output: read('output'), cacheRead: read('cacheRead') };
      options.setPrice?.(model, next.input === null && next.output === null ? null : next);
      paint();
    }
    void load();
    return { reload: load, state: () => ({ range: state.range, tab: state.tab }) };
  }

  return Object.freeze({ mount });
}));
