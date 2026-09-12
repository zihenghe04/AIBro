(function (root, factory) {
  const api = factory(root, typeof module === 'object' && module.exports ? require('./activity-core.js') : root.WorkstationActivityCore);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ActivityUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, Core) {
  'use strict';
  if (!Core) throw new Error('activity-core.js must load before activity-ui.js');
  const preferences = new WeakMap();
  let chartSequence = 0;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  const uiText = value => `<span data-i18n>${esc(value)}</span>`;
  const metrics = [{ key: 'tasks', label: '完成任务' }, { key: 'materials', label: '收集资料' }];
  const dayStamp = key => Date.parse(`${key}T00:00:00Z`);
  function dateCaption(key, full = false) {
    const locale = root.WorkstationI18n?.getLanguage?.() === 'en' ? 'en' : 'zh-CN';
    return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', month: 'short', day: 'numeric', ...(full ? { year: 'numeric', weekday: 'short' } : {}) }).format(new Date(dayStamp(key)));
  }
  function chartGeometry(data, width = 800, d3 = root.d3) {
    width = Math.max(250, Math.round(width || 800));
    const height = width < 480 ? 250 : 286, pad = { left: 32, right: 18, top: 22, bottom: 38 };
    const maximum = Math.max(1, ...data.series.flatMap(day => [day.tasks, day.materials]));
    const step = Math.max(1, d3?.tickStep ? d3.tickStep(0, maximum, 4) : 10 ** Math.floor(Math.log10(maximum)) * (maximum / 10 ** Math.floor(Math.log10(maximum)) > 5 ? 2 : 1));
    const ceiling = Math.ceil(maximum / step) * step;
    const ticks = Array.from({ length: Math.round(ceiling / step) + 1 }, (_, i) => i * step);
    const first = dayStamp(data.keys[0]), last = dayStamp(data.keys[data.keys.length - 1]);
    const x = d3?.scaleUtc ? d3.scaleUtc().domain([first, last]).range([pad.left, width - pad.right]) : value => pad.left + (Number(value) - first) / Math.max(1, last - first) * (width - pad.left - pad.right);
    const y = d3?.scaleLinear ? d3.scaleLinear().domain([0, ceiling]).range([height - pad.bottom, pad.top]) : value => height - pad.bottom - value / ceiling * (height - pad.top - pad.bottom);
    const budget = Math.max(2, Math.floor((width - pad.left - pad.right) / (width < 480 ? 85 : 95)));
    // Select calendar days, never fractional time ticks with repeated labels.
    const tickIndices = Array.from({ length: Math.min(data.keys.length, budget) }, (_, i) => Math.round(i * (data.keys.length - 1) / Math.max(1, Math.min(data.keys.length, budget) - 1)));
    const series = metrics.map(metric => {
      const points = data.series.map((day, index) => ({ ...day, index, x: x(dayStamp(day.key)), y: y(day[metric.key]), value: day[metric.key] }));
      const line = d3?.line ? d3.line().x(point => point.x).y(point => point.y).curve(d3.curveMonotoneX)(points) : points.map((point, i) => `${i ? 'L' : 'M'}${point.x},${point.y}`).join(' ');
      const area = d3?.area ? d3.area().x(point => point.x).y0(y(0)).y1(point => point.y).curve(d3.curveMonotoneX)(points) : `${line} L${points.at(-1).x},${y(0)} L${points[0].x},${y(0)} Z`;
      return { ...metric, points, line, area };
    });
    return { width, height, pad, ticks, tickIndices, x, y, series, ceiling, engine: d3?.scaleUtc && d3?.line ? 'd3' : 'fallback' };
  }
  function currentData(ui) {
    return Core.aggregate(ui.options.getState?.() || ui.state || {}, { workspace: ui.options.workspace, projectId: ui.options.projectId, days: ui.days, now: ui.options.now });
  }
  function emit(container, type, detail) {
    const Event = root.CustomEvent || globalThis.CustomEvent;
    if (Event) container.dispatchEvent(new Event(type, { bubbles: true, detail }));
  }
  function bindEntries(container, ui, data) {
    container.querySelectorAll('[data-activity-entry]').forEach(button => button.addEventListener('click', () => {
      const type = button.dataset.activityType, id = button.dataset.activityEntry;
      const entry = currentData(ui).series.find(day => day.key === ui.selectedKey)?.entries.find(item => item.type === type && item.id === id);
      if (!entry) { render(container, ui.options.getState?.() || ui.state, ui.options); return; }
      if (ui.options.openEntity) ui.options.openEntity(type, id);
      else emit(container, 'activity-entity-jump', { type, id });
    }));
    container.querySelector('[data-activity-close-day]')?.addEventListener('click', () => { ui.selectedKey = null; render(container, ui.state, ui.options); });
  }
  function dayDetails(ui, data) {
    const day = data.series.find(item => item.key === ui.selectedKey); if (!day) return '';
    const entries = day.entries.filter(item => !ui.hidden.has(item.metric));
    const types = { task: '任务', note: '笔记', import: '资料' };
    return `<section class="activity-ui-day" aria-label="${esc(dateCaption(day.key, true))}"><header><div><small data-i18n>当天活动</small><h3>${esc(dateCaption(day.key, true))}</h3></div><button type="button" class="activity-ui-close" data-activity-close-day aria-label="关闭当天活动">×</button></header><div class="activity-ui-day-items">${entries.length ? entries.map(item => `<button type="button" class="activity-ui-entry" data-activity-entry="${esc(item.id)}" data-activity-type="${item.type}"><i class="${item.metric}" aria-hidden="true"></i><span class="activity-ui-entry-copy"><strong data-user-content>${esc(item.title || ({ task: '未命名任务', note: '未命名笔记', import: '未命名资料' }[item.type]))}</strong><small>${uiText(types[item.type])}<span aria-hidden="true"> · </span>${uiText(item.workspace)}${item.projectName ? `<span aria-hidden="true"> / </span><span data-user-content>${esc(item.projectName)}</span>` : ''}</small></span><span aria-hidden="true">↗</span></button>`).join('') : `<p class="activity-ui-day-empty" data-i18n>${day.entries.length ? '所选系列在这一天没有活动。' : '这一天没有记录活动。'}</p>`}</div></section>`;
  }
  function drawChart(container, ui, data) {
    const chart = container.querySelector('.activity-ui-chart'); if (!chart) return;
    const measuredWidth = chart.clientWidth || ui.width || 800, geometry = chartGeometry(data, measuredWidth), { width, height, pad, x, y } = geometry;
    ui.width = measuredWidth; ui.geometry = geometry;
    const grid = geometry.ticks.map(value => `<g><line class="activity-ui-grid${value === 0 ? ' baseline' : ''}" x1="${pad.left}" y1="${y(value)}" x2="${width-pad.right}" y2="${y(value)}"/><text class="activity-ui-axis" data-activity-tick="${value}" x="${pad.left-10}" y="${y(value)+4}" text-anchor="end">${value}</text></g>`).join('');
    const axis = geometry.tickIndices.map(index => `<text class="activity-ui-axis" x="${x(dayStamp(data.keys[index]))}" y="${height-12}" text-anchor="${index === 0 ? 'start' : index === data.keys.length-1 ? 'end' : 'middle'}">${esc(dateCaption(data.keys[index]))}</text>`).join('');
    const gradients = geometry.series.map(metric => `<linearGradient id="${ui.id}-${metric.key}" x1="0" y1="0" x2="0" y2="1"><stop class="activity-ui-gradient ${metric.key}" offset="0" stop-opacity=".22"/><stop class="activity-ui-gradient ${metric.key}" offset="1" stop-opacity=".012"/></linearGradient>`).join('');
    const paths = geometry.series.filter(metric => data.totals[metric.key] > 0).map(metric => `<g data-activity-metric="${metric.key}"><path class="activity-ui-area ${metric.key}" d="${metric.area}" fill="url(#${ui.id}-${metric.key})"/><path class="activity-ui-line ${metric.key}" d="${metric.line}"/>${metric.points.filter(point => point.value > 0).map(point => `<circle class="activity-ui-point ${metric.key}" cx="${point.x}" cy="${point.y}" r="3.5"/>`).join('')}</g>`).join('');
    const points = geometry.series[0].points;
    const hits = points.map((point, index) => {
      const left = index ? (points[index-1].x+point.x)/2 : pad.left, right = index+1 < points.length ? (points[index+1].x+point.x)/2 : width-pad.right;
      return `<g class="activity-ui-hit" tabindex="${index === points.length-1 ? 0 : -1}" role="button" data-activity-index="${index}" aria-label="${esc(dateCaption(point.key))}: ${data.series[index].tasks} / ${data.series[index].materials}" aria-pressed="${ui.selectedKey === point.key}"><rect x="${left}" y="${pad.top}" width="${right-left}" height="${height-pad.top-pad.bottom}"/></g>`;
    }).join('');
    chart.innerHTML = `<svg viewBox="0 0 ${geometry.width} ${height}" data-chart-engine="${geometry.engine}" role="group" aria-label="活动趋势图"><title>活动趋势图</title><defs>${gradients}</defs>${grid}${axis}${paths}<g class="activity-ui-crosshair" data-activity-guide hidden><line data-activity-vertical y1="${pad.top}" y2="${height-pad.bottom}"/><line data-activity-horizontal x1="${pad.left}" x2="${width-pad.right}"/><circle class="tasks" r="4.5"/><circle class="materials" r="4.5"/></g>${hits}</svg><div class="activity-ui-tooltip" role="tooltip" hidden></div>${!data.totals.tasks && !data.totals.materials ? '<div class="activity-ui-empty" data-i18n>所选时间段暂无活动记录</div>' : ''}`;
    const tooltip = chart.querySelector?.('.activity-ui-tooltip') || container.querySelector('.activity-ui-tooltip'), guide = chart.querySelector?.('[data-activity-guide]');
    const show = index => {
      const item = data.series[index]; if (!item || !tooltip) return;
      const point = points[index];
      tooltip.innerHTML = `<strong>${esc(dateCaption(item.key, true))}</strong>${metrics.filter(metric => !ui.hidden.has(metric.key)).map(metric => `<div class="${metric.key}">${uiText(metric.label)}<b>${item[metric.key]}</b></div>`).join('')}<small data-i18n>点击日期查看真实条目</small>`;
      tooltip.hidden = false;
      const cardWidth = tooltip.offsetWidth || 210;
      tooltip.style.left = `${Math.min(Math.max(8, point.x + (point.x > width / 2 ? -cardWidth-14 : 14)), Math.max(8, width-cardWidth-8))}px`;
      tooltip.style.top = '10px';
      if (guide) {
        guide.hidden = false; guide.removeAttribute('hidden');
        const vertical = guide.querySelector('[data-activity-vertical]'), horizontal = guide.querySelector('[data-activity-horizontal]');
        vertical.setAttribute('x1', point.x); vertical.setAttribute('x2', point.x);
        horizontal.setAttribute('y1', y(Math.max(...metrics.filter(metric => !ui.hidden.has(metric.key)).map(metric => item[metric.key]), 0))); horizontal.setAttribute('y2', horizontal.getAttribute('y1'));
        metrics.forEach(metric => { const dot = guide.querySelector(`circle.${metric.key}`); dot.setAttribute('cx', point.x); dot.setAttribute('cy', y(item[metric.key])); dot.style.display = ui.hidden.has(metric.key) ? 'none' : ''; });
      }
      root.WorkstationI18n?.translate?.(tooltip);
    };
    const hide = () => { if (tooltip) tooltip.hidden = true; guide?.setAttribute('hidden', ''); };
    const select = index => { ui.selectedKey = data.keys[index]; render(container, ui.options.getState?.() || ui.state, ui.options); container.querySelector(`[data-activity-index="${index}"]`)?.focus?.({ preventScroll: true }); };
    container.querySelectorAll('[data-activity-index]').forEach(node => {
      const index = Number(node.dataset.activityIndex);
      node.addEventListener('pointerenter', () => show(index)); node.addEventListener('mouseenter', () => show(index)); node.addEventListener('focus', () => show(index));
      node.addEventListener('click', () => select(index));
      node.addEventListener('blur', hide);
      node.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(index); }
        else if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? data.keys.length-1 : Math.max(0, Math.min(data.keys.length-1, index + (event.key === 'ArrowRight' ? 1 : -1))); node.setAttribute('tabindex', '-1'); const target = container.querySelector(`[data-activity-index="${next}"]`); target?.setAttribute('tabindex', '0'); target?.focus?.(); }
        else if (event.key === 'Escape') hide();
      });
    });
    chart.addEventListener?.('pointerleave', hide);
    ui.hidden.forEach(metric => container.querySelectorAll(`[data-activity-metric="${metric}"]`).forEach(node => { node.style.display = 'none'; }));
    root.WorkstationI18n?.translate?.(chart);
  }
  function render(container, state, options = {}) {
    if (!container) throw new Error('ActivityUI.render 需要容器');
    const scope = `${options.workspace || ''}:${options.projectId || ''}`;
    let ui = preferences.get(container); ui?.resizeObserver?.disconnect();
    if (!ui || ui.scope !== scope) {
      if (ui?.localeListener) root.document?.removeEventListener?.('workstation-language-change', ui.localeListener);
      ui = { scope, id: `activity-chart-${++chartSequence}`, days: Number(options.days) === 30 ? 30 : 7, hidden: new Set(), selectedKey: null };
      ui.localeListener = () => { if (container.isConnected !== false) render(container, ui.options.getState?.() || ui.state, ui.options); };
      root.document?.addEventListener?.('workstation-language-change', ui.localeListener);
    }
    ui.state = state; ui.options = options; preferences.set(container, ui);
    const data = currentData(ui), activeDays = data.series.filter(day => day.tasks + day.materials > 0).length;
    if (!data.keys.includes(ui.selectedKey)) ui.selectedKey = null;
    const total = data.totals.tasks + data.totals.materials;
    const workspaceRows = Core.WORKSPACES.filter(workspace => !data.workspace || workspace === data.workspace).map(workspace => {
      const item = data.workspaces[workspace], percent = total ? item.total / total * 100 : 0;
      return `<div class="activity-ui-workspace"><div class="activity-ui-workspace-head"><button type="button" class="activity-ui-jump" data-activity-workspace="${workspace}" data-i18n>${esc(workspace)}</button><span>${Math.round(percent)}%</span></div><div class="activity-ui-track"><div class="activity-ui-fill" style="width:${percent}%"></div></div><small data-i18n>${item.tasks} 个任务 · ${item.materials} 份资料 · ${item.daysActive} 天有记录</small></div>`;
    }).join('');
    const metricButtons = metrics.map(metric => `<button type="button" class="activity-ui-button" data-activity-toggle="${metric.key}" aria-pressed="${!ui.hidden.has(metric.key)}" aria-label="显示${metric.label}，共 ${data.totals[metric.key]} 项">${uiText(metric.label)}<strong>${data.totals[metric.key]}</strong><small data-i18n>点击筛选曲线</small></button>`).join('');
    container.classList.add('activity-ui');
    container.innerHTML = `<div class="activity-ui-header"><div><div class="activity-ui-kicker" data-i18n>工作节奏</div><h2 class="activity-ui-title" data-i18n>活动分析</h2><p class="activity-ui-subtitle" data-i18n>${data.projectId ? '当前项目 · ' : data.workspace ? esc(data.workspace)+' · ' : ''}按天统计已完成任务与收集资料</p></div><div class="activity-ui-tabs" aria-label="分析时间范围">${[7,30].map(days => `<button type="button" class="activity-ui-button" data-activity-days="${days}" data-i18n aria-pressed="${data.days === days}">${days} 天</button>`).join('')}</div></div><div class="activity-ui-metrics">${metricButtons}<div class="activity-ui-active-days"><span data-i18n>活跃天数</span><strong>${activeDays}<small> / ${data.days}</small></strong></div></div><div class="activity-ui-chart-layout"><div class="activity-ui-chart"></div></div><div class="activity-ui-chart-caption">${uiText('点击日期查看真实条目')}<span><span data-i18n>资料包含原件与笔记</span> · ${data.keys[0]} — ${data.keys.at(-1)}</span></div>${dayDetails(ui, data)}<aside class="activity-ui-progress"><h3 data-i18n>活动分布</h3>${workspaceRows}</aside>`;
    drawChart(container, ui, data); bindEntries(container, ui, data);
    container.querySelectorAll('[data-activity-toggle]').forEach(toggle => toggle.addEventListener('click', () => { const metric = toggle.dataset.activityToggle; ui.hidden.has(metric) ? ui.hidden.delete(metric) : ui.hidden.add(metric); render(container, ui.options.getState?.() || ui.state, ui.options); container.querySelector(`[data-activity-toggle="${metric}"]`)?.focus?.({ preventScroll: true }); }));
    container.querySelectorAll('[data-activity-days]').forEach(toggle => toggle.addEventListener('click', () => { ui.days = Number(toggle.dataset.activityDays); render(container, ui.options.getState?.() || ui.state, ui.options); container.querySelector(`[data-activity-days="${ui.days}"]`)?.focus?.({ preventScroll: true }); }));
    container.querySelectorAll('[data-activity-workspace]').forEach(node => node.addEventListener('click', () => emit(container, 'activity-view-jump', { workspace: node.dataset.activityWorkspace })));
    if (typeof root.ResizeObserver === 'function') { ui.resizeObserver = new root.ResizeObserver(() => { const chart = container.querySelector('.activity-ui-chart'); if (chart?.clientWidth && Math.abs(chart.clientWidth - ui.width) > 1) drawChart(container, ui, currentData(ui)); }); ui.resizeObserver.observe(container); }
    root.WorkstationI18n?.translate?.(container);
    return data;
  }
  function destroy(container) { const ui = preferences.get(container); ui?.resizeObserver?.disconnect(); if (ui?.localeListener) root.document?.removeEventListener?.('workstation-language-change', ui.localeListener); preferences.delete(container); }
  return { render, chartGeometry, destroy };
});
