// Showcase view: one designed page built from the same data, made to be shown to other people.
// A title, tabs to switch between groups, headline numbers around an optional picture, and four charts.
import { applyFilters, groupBy, topN, timeSeries, histogram, kpis, measureLabel, BLANK } from './analyze.js';
import { barChart, columnChart, fmt, fmtFull, fmtPercent } from './charts.js';
import { eChart } from './echart.js';

const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); for (const k of kids) if (k !== null && k !== undefined && k !== false) n.append(k); return n; };

export const THEMES = {
  sunset: { name: 'Sunset', accent: '#f26a1b', series: ['#f26a1b', '#d7261e', '#f4a300', '#f7c948', '#8c2f1b', '#ff8f6b', '#b5651d', '#5c5c5c'] },
  ocean: { name: 'Ocean', accent: '#1f7ae0', series: ['#1f7ae0', '#12a5bd', '#0b4f9e', '#6fbdf5', '#2bb673', '#5a6ff0', '#8fd3e8', '#5c5c5c'] },
  forest: { name: 'Forest', accent: '#2e8b57', series: ['#2e8b57', '#8ab833', '#1f5f3c', '#d4a017', '#5bb5a2', '#a3c585', '#6b8e23', '#5c5c5c'] },
  violet: { name: 'Violet', accent: '#7a4fd6', series: ['#7a4fd6', '#e0559b', '#4b2c9b', '#f29e4c', '#42a5f5', '#b39ddb', '#ad1457', '#5c5c5c'] }
};
const pretty = name => name.replace(/\.[^.]+$/, '').replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, ch => ch.toUpperCase());
export const defaultShowcase = fileName => ({ theme: 'sunset', accent: '', lead: 'Explore', title: pretty(fileName || 'Your data'), sub: '', image: '' });

/** Draws the page into host. `again` re-renders after a change; `draw` collects the chart drawing functions. */
export function drawShowcase(host, { model: m, choices: c, sc, again, draw, onImage, onBack }) {
  const theme = THEMES[sc.theme] || THEMES.sunset, accent = sc.accent || theme.accent;
  host.style.setProperty('--accent', accent);
  theme.series.forEach((col, i) => host.style.setProperty(`--series-${i + 1}`, i === 0 ? accent : col));

  const dim = c.dimension, measure = c.agg === 'count' ? -1 : c.measure, label = measureLabel(m, c);
  const pct = measure >= 0 && m.cols[measure].percent;
  const f = pct ? fmtPercent : fmt, ff = pct ? fmtPercent : fmtFull;
  const rows = applyFilters(m.rows, c.filters);
  // charts that compare the tabbed column keep every group in view, so they ignore the tab that is selected
  const wide = dim >= 0 ? applyFilters(m.rows, { ...c.filters, [dim]: '' }) : rows;
  const picked = dim >= 0 ? c.filters[dim] || '' : '';
  const groups = dim >= 0 ? groupBy(wide, dim, measure, c.agg).filter(g => g.key !== BLANK) : [];
  const whole = c.agg !== 'avg' && groups.length > 1 && groups.every(g => g.value >= 0) && groups.some(g => g.value > 0);

  // ----- top bar: name, tabs, controls
  const tabs = dim >= 0 && groups.length > 1 ? el('div', { className: 'sc__tabs', role: 'group', ariaLabel: `Show one ${m.headers[dim]}` }, ...[{ key: '', text: 'All' }, ...groups.slice(0, 5).map(g => ({ key: g.key, text: g.key }))].map(t => {
    const b = el('button', { className: 'sc__tab' + (picked === t.key ? ' is-on' : ''), textContent: t.text, title: t.text });
    b.setAttribute('aria-pressed', picked === t.key);
    b.addEventListener('click', () => { if (t.key) c.filters[dim] = t.key; else delete c.filters[dim]; again(); });
    return b;
  })) : null;
  const swatches = Object.entries(THEMES).map(([k, t]) => { const b = el('button', { className: 'sc__swatch' + (sc.theme === k && !sc.accent ? ' is-on' : ''), title: `${t.name} colours`, ariaLabel: `${t.name} colours` }); b.style.background = t.accent; b.addEventListener('click', () => { sc.theme = k; sc.accent = ''; again(); }); return b; });
  const colour = el('input', { type: 'color', value: accent, title: 'Pick your own main colour', ariaLabel: 'Pick your own main colour' });
  colour.addEventListener('change', () => { sc.accent = colour.value; again(); });
  const btn = (text, fn, kind = '') => { const b = el('button', { className: `btn ${kind}`, textContent: text }); b.addEventListener('click', fn); return b; };
  const controls = el('div', { className: 'sc__controls' }, el('span', { className: 'sc__swatches' }, ...swatches, colour),
    btn(sc.image ? 'Change picture' : 'Add a picture', onImage), sc.image ? btn('Remove picture', () => { sc.image = ''; again(); }) : null,
    btn('Print or save as PDF', () => window.print()), btn('Back to dashboard', onBack, 'btn--primary'));

  // ----- text a person can type over
  const editable = (tag, cls, key, hint) => {
    const n = el(tag, { className: cls, textContent: sc[key], spellcheck: false });
    n.setAttribute('contenteditable', 'plaintext-only'); n.setAttribute('aria-label', hint); n.title = 'Click to edit';
    n.addEventListener('blur', () => { sc[key] = n.textContent.trim(); });
    n.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); n.blur(); } });
    return n;
  };
  if (!sc.sub) sc.sub = dim >= 0 ? `Compare ${label.toLowerCase()} across ${m.headers[dim]}, from ${m.rows.length.toLocaleString('en-US')} rows.` : `${m.rows.length.toLocaleString('en-US')} rows of data at a glance.`;

  // ----- headline numbers
  const text = k => (k.kind === 'text' || k.kind === 'top' ? k.value : k.kind === 'count' ? k.value.toLocaleString('en-US') : k.value === null ? 'none' : k.col.percent ? fmtPercent(k.value) : fmt(k.value));
  const all = kpis(m, c).filter(k => k.kind !== 'text');
  const main = all.find(k => k.kind === 'number') || all[0];
  const rest = all.filter(k => k !== main).slice(0, 4);
  const lead = el('div', { className: 'sc__lead' },
    el('h2', { className: 'sc__title' }, editable('span', 'sc__title-lead', 'lead', 'First word of the title'), ' ', editable('span', 'sc__title-name', 'title', 'Title')),
    editable('p', 'sc__sub', 'sub', 'Subtitle'),
    main ? el('div', { className: 'sc__main' }, el('span', { className: 'sc__main-pill', textContent: picked || (dim >= 0 ? `All ${m.headers[dim]}` : 'All rows') }), el('span', { className: 'sc__main-label', textContent: main.label }), el('span', { className: 'sc__main-value', textContent: text(main) })) : null);
  const callout = (k, i) => el('div', { className: `sc__callout sc__callout--${i}` }, el('span', { className: 'sc__callout-label', textContent: k.label }), el('span', { className: 'sc__callout-value', textContent: text(k), title: String(text(k)) }));
  const art = el('div', { className: 'sc__art' + (sc.image ? ' has-image' : '') }, sc.image ? el('img', { src: sc.image, alt: '' }) : el('div', { className: 'sc__shape', ariaHidden: 'true' }), ...rest.map(callout));

  // ----- four charts, chosen from what the sheet can support
  const cards = [];
  const card = (title, sub, fn, note) => { const plot = el('div', { className: 'plot' }); if (note) plot.append(el('p', { className: 'muted small', textContent: note })); else draw.push(() => fn(plot)); cards.push(el('section', { className: 'sc__card' }, el('h3', { textContent: title }), el('p', { className: 'sc__card-sub', textContent: sub }), plot)); };
  const H = 230;
  if (dim >= 0 && groups.length > 1) {
    const top = topN(groups, 6, c.agg, false);
    if (whole) card(`${label} by ${m.headers[dim]}`, 'Ranked, largest at the top', plot => eChart(plot, 'funnel', { items: top, label, f, ff, total: groups.reduce((a, g) => a + g.value, 0), height: H }));
    else card(`${label} by ${m.headers[dim]}`, 'Ranked, largest at the top', plot => barChart(plot, { items: top, label, title: label, total: 0, f, ff, colours: true }));
  }
  if (c.date >= 0) {
    const ts = timeSeries(rows, c.date, measure, c.agg, c.grain);
    if (ts.labels.length > 1) card(`${label} trend`, `By ${ts.grain}` + (picked ? `, ${picked} only` : ''), plot => eChart(plot, 'smooth', { labels: ts.labels, series: ts.series, label, f, ff, height: H }));
  }
  // the second comparison: another column with a handful of groups, mostly filled in
  const second = [...m.dimensions].filter(d => d.index !== dim && d.distinct >= 2 && d.distinct <= 12 && d.blankShare <= 0.3).sort((a, b) => Math.abs(a.distinct - 5) - Math.abs(b.distinct - 5))[0] || m.dimensions.find(d => d.index !== dim) || m.entities.find(e => e.index !== dim);
  if (second) {
    const g2 = groupBy(rows, second.index, measure, c.agg).filter(g => g.key !== BLANK);
    if (g2.length > 1) card(`${label} by ${second.name}`, picked ? `${picked} only` : 'All rows', plot => eChart(plot, 'column', { items: topN(g2, 7, c.agg, false), label, f, ff, total: 0, height: H }));
  }
  if (whole) card(`Share of ${label.toLowerCase()}`, `Each ${m.headers[dim]} as a part of the total`, plot => eChart(plot, 'ring', { items: topN(groups, 6, c.agg, true), label, f, ff, total: groups.reduce((a, g) => a + g.value, 0), height: H }));
  for (const ms of m.measures) {
    if (cards.length >= 4) break;
    const bins = histogram(rows, ms.index);
    if (bins.length > 1) card(`How ${ms.name} is spread`, 'Number of rows in each range', plot => columnChart(plot, { bins, label: ms.name, title: ms.name, f: ms.percent ? fmtPercent : fmt, ff: ms.percent ? fmtPercent : fmtFull }));
  }
  if (!cards.length) card('Nothing to chart yet', '', null, 'This sheet needs a column of numbers, dates or repeated values. Go back and check the questions on the left.');

  host.replaceChildren(
    el('div', { className: 'sc__bar' }, el('div', { className: 'sc__brand' }, el('span', { className: 'sc__mark', ariaHidden: 'true' }), el('span', { textContent: sc.title || 'Dashboard' })), tabs, controls),
    el('div', { className: 'sc__hero' }, lead, art),
    rows.length ? el('div', { className: 'sc__row' }, ...cards.slice(0, 4)) : el('p', { className: 'muted', textContent: 'No rows match this tab. Choose "All".' }),
    el('p', { className: 'sc__tip', textContent: 'Click the title or the line under it to type your own. Use the questions on the dashboard to change the number, the date or the column behind the tabs.' }));
}
