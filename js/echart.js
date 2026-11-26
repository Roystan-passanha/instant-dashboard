// Extra chart types drawn with Apache ECharts (vendor/echarts.min.js, Apache-2.0).
// The library is 1 MB, so it is only fetched the first time someone picks one of these types.
let loading = null;
export function loadECharts() {
  if (window.echarts) return Promise.resolve();
  if (!loading) loading = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'vendor/echarts.min.js';
    s.onload = () => res();
    s.onerror = () => { loading = null; rej(new Error('chart library did not load')); };
    document.head.append(s);
  });
  return loading;
}

const live = new Set();
const esc = t => String(t).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const short = (t, n = 16) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

/** Chart types for a column of categories, and for a trend over time. */
export const CATEGORY_TYPES = [['bar', 'Bars'], ['column', 'Columns'], ['pie', 'Pie'], ['donut', 'Donut'], ['rose', 'Rose'], ['funnel', 'Funnel'], ['treemap', 'Treemap'], ['radar', 'Radar']];
export const TREND_TYPES = [['line', 'Line'], ['smooth', 'Smooth line'], ['area', 'Area'], ['step', 'Step line'], ['columns', 'Columns'], ['stackedArea', 'Stacked area'], ['stackedColumns', 'Stacked columns']];
export const NEEDS_WHOLE = new Set(['pie', 'donut', 'rose', 'funnel', 'treemap']);

/**
 * kind: one of the keys above (not 'bar', 'donut' or 'line', which have their own renderers).
 * data for categories: { items: [{ key, value, count, other }], label, f, ff, total, onPick }
 * data for trends: { labels, series: [{ name, values }], label, f, ff }
 */
export function eChart(host, kind, data) {
  host.replaceChildren();
  host.classList.add('plot--e');
  host.style.height = (data.height || (data.series ? 290 : data.points ? 340 : 320)) + 'px';
  loadECharts().then(() => {
    if (!host.isConnected) return;
    for (const c of live) if (!c.getDom().isConnected) { c.dispose(); live.delete(c); }
    const chart = window.echarts.init(host, null, { renderer: 'svg' });
    live.add(chart);
    chart.setOption(build(kind, data, host.clientWidth, host));
    if (data.onPick && kind !== 'radar' && kind !== 'scatter') chart.on('click', p => { if (p && p.name && !(p.data && p.data.other)) data.onPick(p.data && p.data.key ? p.data.key : p.name); });
  }).catch(() => { host.style.height = ''; host.textContent = 'This chart type could not be loaded. Check your connection and pick it again, or use another type.'; });
}

function build(kind, d, width, host) {
  // colours are read from the chart's own element, so a section with its own theme gets its own colours
  const style = getComputedStyle(host), css = n => style.getPropertyValue(n).trim();
  const colors = [1, 2, 3, 4, 5, 6, 7, 8].map(n => css('--series-' + n));
  const t = { text: css('--text'), text2: css('--text-2'), grid: css('--grid'), axis: css('--axis'), surface: css('--surface'), muted: css('--muted-fill') };
  const f = d.f, ff = d.ff;
  const tip = { backgroundColor: t.surface, borderColor: t.axis, textStyle: { color: t.text, fontSize: 12.5 }, confine: true };
  const base = { color: colors, backgroundColor: 'transparent', textStyle: { fontFamily: 'inherit', color: t.text2 }, animationDuration: 350 };
  const valueAxis = { type: 'value', axisLabel: { color: t.text2, formatter: v => f(v) }, splitLine: { lineStyle: { color: t.grid } } };

  if (d.points) {
    const groups = d.groups.length ? d.groups : [''];
    const axis = (name, fmtr) => ({ type: 'value', scale: true, name, nameLocation: 'middle', nameTextStyle: { color: t.text2 }, axisLabel: { color: t.text2, formatter: v => fmtr(v) }, splitLine: { lineStyle: { color: t.grid } }, axisLine: { lineStyle: { color: t.axis } } });
    return { ...base,
      grid: { left: 14, right: 18, top: 14, bottom: 30, containLabel: true },
      tooltip: { ...tip, trigger: 'item', formatter: p => [p.seriesName ? `<b>${esc(p.seriesName)}</b>` : '', `${esc(d.xName)}: ${esc(d.ff(p.value[0]))}`, `${esc(d.yName)}: ${esc(d.ff(p.value[1]))}`].filter(Boolean).join('<br>') },
      xAxis: { ...axis(d.xName, d.fx), nameGap: 28 },
      yAxis: { ...axis(d.yName, d.f), nameGap: 52, nameRotate: 90 },
      series: groups.map((g, i) => ({ name: g, type: 'scatter', large: d.points.length > 1500, symbolSize: d.points.length > 600 ? 5 : 8,
        data: d.points.filter(p => !d.groups.length || p.g === g).map(p => [p.x, p.y]),
        itemStyle: { color: g === 'Other' ? t.muted : colors[i % colors.length], opacity: 0.75, borderColor: t.surface, borderWidth: 1 } }))
    };
  }
  if (d.series) {
    const stacked = kind === 'stackedArea' || kind === 'stackedColumns', bars = kind === 'columns' || kind === 'stackedColumns';
    return { ...base,
      grid: { left: 8, right: 16, top: 14, bottom: 6, containLabel: true },
      tooltip: { ...tip, trigger: 'axis', valueFormatter: v => (v === null || v === undefined ? 'no data' : ff(v)), axisPointer: { type: bars ? 'shadow' : 'line' } },
      xAxis: { type: 'category', data: d.labels, boundaryGap: bars, axisLabel: { color: t.text2, hideOverlap: true }, axisLine: { lineStyle: { color: t.axis } }, axisTick: { show: false } },
      yAxis: valueAxis,
      series: d.series.map(s => ({
        name: s.name || d.label, type: bars ? 'bar' : 'line', data: s.values, stack: stacked ? 'all' : undefined,
        smooth: kind === 'smooth' || kind === 'area' ? 0.35 : false, step: kind === 'step' ? 'middle' : false,
        showSymbol: d.labels.length <= 40, symbolSize: 5, lineStyle: { width: 2 }, barMaxWidth: 28,
        areaStyle: kind === 'area' || kind === 'stackedArea' ? { opacity: stacked ? 0.55 : 0.18 } : undefined,
        itemStyle: bars && !stacked ? { borderRadius: [3, 3, 0, 0] } : undefined
      }))
    };
  }

  const total = d.total > 0 ? d.total : 0;
  const items = d.items.map((it, i) => ({ name: it.key, key: it.key, value: it.value, count: it.count, other: Boolean(it.other), itemStyle: { color: it.other ? t.muted : colors[i % colors.length] } }));
  const lines = p => { const it = p.data; const out = [`<b>${esc(it.name)}</b>`, `${esc(d.label)}: ${esc(ff(it.value))}`]; if (total && it.value >= 0) out.push(`Share of total: ${Math.round((it.value / total) * 1000) / 10}%`); out.push(`Rows: ${it.count.toLocaleString('en-US')}`); return out.join('<br>'); };
  const itemTip = { ...tip, trigger: 'item', formatter: lines };
  const narrow = width < 420;

  if (kind === 'column') {
    const many = items.length > (narrow ? 4 : 7);
    return { ...base, grid: { left: 8, right: 12, top: 14, bottom: 6, containLabel: true }, tooltip: itemTip,
      xAxis: { type: 'category', data: items.map(i => i.name), axisLabel: { color: t.text2, interval: 0, rotate: many ? 35 : 0, formatter: v => short(v, many ? 14 : 18) }, axisLine: { lineStyle: { color: t.axis } }, axisTick: { show: false } },
      yAxis: valueAxis,
      series: [{ type: 'bar', data: items, barMaxWidth: 46, itemStyle: { borderRadius: [4, 4, 0, 0] } }] };
  }
  if (kind === 'ring') {
    return { ...base, tooltip: itemTip,
      title: { text: f(total || items.reduce((a, i) => a + i.value, 0)), subtext: 'Total', left: 'center', top: '39%', textStyle: { color: t.text, fontSize: 18, fontWeight: 700 }, subtextStyle: { color: t.text2, fontSize: 12 }, itemGap: 4 },
      series: [{ type: 'pie', data: items, radius: ['46%', '66%'], center: ['50%', '50%'], itemStyle: { borderColor: t.surface, borderWidth: 2 }, avoidLabelOverlap: true, minShowLabelAngle: 8,
        label: { color: t.text2, fontSize: 11, formatter: p => `${short(p.name, 12)}\n${p.percent}%` }, labelLine: { length: 6, length2: 4, lineStyle: { color: t.axis } } }] };
  }
  if (kind === 'pie' || kind === 'rose') {
    return { ...base, tooltip: itemTip,
      series: [{ type: 'pie', data: items, radius: kind === 'rose' ? ['14%', narrow ? '58%' : '70%'] : (narrow ? '56%' : '68%'), roseType: kind === 'rose' ? 'area' : undefined, center: ['50%', '50%'],
        itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: kind === 'rose' ? 5 : 0 }, avoidLabelOverlap: true, minShowLabelAngle: 4,
        label: { color: t.text, formatter: p => `${short(p.name, narrow ? 10 : 18)}  ${p.percent}%` }, labelLine: { lineStyle: { color: t.axis } } }] };
  }
  if (kind === 'funnel') {
    return { ...base, tooltip: itemTip,
      series: [{ type: 'funnel', data: [...items].sort((a, b) => b.value - a.value), sort: 'descending', left: '4%', width: width < 340 ? '42%' : narrow ? '52%' : '62%', top: 10, bottom: 10, minSize: '6%', gap: 2,
        itemStyle: { borderColor: t.surface, borderWidth: 1 }, label: { position: 'right', color: t.text, formatter: p => `${short(p.name, width < 340 ? 11 : narrow ? 12 : 20)}  ${f(p.value)}` }, labelLine: { lineStyle: { color: t.axis } } }] };
  }
  if (kind === 'treemap') {
    return { ...base, tooltip: itemTip,
      series: [{ type: 'treemap', data: items, roam: false, nodeClick: false, breadcrumb: { show: false }, left: 0, right: 0, top: 0, bottom: 0,
        itemStyle: { borderColor: t.surface, borderWidth: 2, gapWidth: 2 }, label: { color: '#fff', fontSize: 12.5, overflow: 'truncate', formatter: p => `${p.name}\n${f(p.value)}` } }] };
  }
  // radar: one spoke per group
  const max = Math.max(...items.map(i => i.value), 0) * 1.1 || 1;
  return { ...base,
    tooltip: { ...tip, trigger: 'item', formatter: () => [`<b>${esc(d.label)}</b>`, ...items.map(i => `${esc(i.name)}: ${esc(ff(i.value))}`)].join('<br>') },
    radar: { indicator: items.map(i => ({ name: short(i.name, narrow ? 10 : 16), max, min: Math.min(0, ...items.map(x => x.value)) })), radius: narrow ? '58%' : '68%', axisName: { color: t.text2 }, splitLine: { lineStyle: { color: t.grid } }, splitArea: { show: false }, axisLine: { lineStyle: { color: t.grid } } },
    series: [{ type: 'radar', data: [{ value: items.map(i => i.value), name: d.label }], areaStyle: { opacity: 0.22 }, lineStyle: { width: 2 }, symbolSize: 5 }] };
}
