/* Usage statistics maths: price lookup, cost estimate and display formatting. Pure; the price table is static data. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UsageStats = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const data = () => root.ModelPriceData || (typeof require === 'function' ? require('./model-prices-data.js') : { models: [] });
  const RANGES = ['24h', '7d', '30d', 'all'];
  const num = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

  let index = null, indexOf = null;
  function table() {
    const source = data();
    if (index && indexOf === source) return index;
    index = new Map(source.models.map(model => [model.id, model])); indexOf = source;
    return index;
  }

  // 价格：用户覆盖 > 内置表（精确匹配）> 内置表里最长的前缀（带日期 / 后缀的型号）。供应商前缀（a/b）先去掉。
  function priceFor(model, overrides = {}) {
    const id = String(model || '').trim().toLowerCase().split('/').pop();
    if (!id) return null;
    const own = overrides && overrides[model] ? overrides[model] : overrides && overrides[id];
    if (own && num(own.input) !== null && num(own.output) !== null) return { input: own.input, output: own.output, cacheRead: num(own.cacheRead), source: 'custom' };
    const map = table();
    let hit = map.get(id) || null;
    if (!hit) for (const [key, value] of map) if (id.startsWith(key) && (!hit || key.length > hit.id.length)) hit = value;
    return hit ? { input: hit.input, output: hit.output, cacheRead: num(hit.cacheRead), source: 'builtin' } : null;
  }

  // 一组请求的估算费用（美元）。缓存命中的输入按缓存价（有的话）算，其余输入按输入价。
  function costOf(group, overrides) {
    const price = priceFor(group.model, overrides);
    if (!price) return null;
    const input = group.input || 0, output = group.output || 0, cached = Math.min(group.cache_read || 0, input);
    const cachePrice = price.cacheRead === null ? price.input : price.cacheRead;
    return ((input - cached) * price.input + cached * cachePrice + output * price.output) / 1e6;
  }

  // 汇总：订阅类请求不计费用（显示“订阅”）；没有价格的型号单独计数，不拿 0 冒充。
  function totals(byModel, overrides) {
    let cost = 0, known = 0, unknownModels = new Set(), subscription = 0;
    for (const group of byModel) {
      if (group.provider_kind === 'account') { subscription += group.requests; continue; }
      const value = costOf(group, overrides);
      if (value === null) { unknownModels.add(group.model); continue; }
      cost += value; known += group.requests;
    }
    return { cost, pricedRequests: known, unknownModels: [...unknownModels], subscriptionRequests: subscription };
  }

  const compact = value => {
    const number = Number(value) || 0;
    if (number >= 1e9) return `${(number / 1e9).toFixed(1)}B`;
    if (number >= 1e6) return `${(number / 1e6).toFixed(number >= 1e7 ? 1 : 2)}M`;
    if (number >= 1e3) return `${(number / 1e3).toFixed(number >= 1e4 ? 1 : 2)}K`;
    return String(Math.round(number));
  };
  const money = value => value === null || value === undefined ? '—' : value >= 100 ? `$${value.toFixed(0)}` : value >= 1 ? `$${value.toFixed(2)}` : value >= 0.01 ? `$${value.toFixed(2)}` : value === 0 ? '$0.00' : `$${value.toFixed(4)}`;
  const latency = ms => ms === null || ms === undefined ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
  const percent = value => value === null || value === undefined ? '—' : `${(value * 100).toFixed(value >= 0.995 || value === 0 ? 0 : 1)}%`;

  return Object.freeze({ RANGES, priceFor, costOf, totals, compact, money, latency, percent });
}));
