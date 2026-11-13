// Turns a cleaned table into dashboard pieces: KPIs, chart data, suggestions and findings.
// Pure functions, no browser APIs, so they run in Node tests.
import { isDateCell } from './cleaner.js';

const MONEY_HINT = /revenue|sales|amount|profit|total|spend|income|turnover/;
const MEASURE_HINT = /cost|salary|qty|quantity|value|units|pallets|budget|hours|count|price|weight|clicks|opens|sent|delivered|impressions/;
const AVERAGE_HINT = /salary|price|rate|\bage\b|score|rating|percent|%|days|avg|average|duration|margin|time|delay|minutes|distance|roi|ratio|ctr|balance|followers|headcount|inventory|stock/;
const RATIO_HINT = /\brate\b|ratio|\broi\b|\bctr\b|%|percent|margin|average|\bavg\b|score|rating|likelihood|recommend|satisf|\bnps\b|\(\s*\d+\s*-\s*\d+\s*\)/;
const DIM_NUMBER_HINT = /^(year|month|quarter|week|period|rating|grade|level|tier|stage)$/;
const NOT_MEASURE = /^(lat|latitude|lng|lon|long|longitude)$/;
const FREE_TEXT = /remark|comment|note|description|address|feedback/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const blank = v => v === null || v === undefined || v === '';
export const BLANK = '(blank)';

/**
 * Build the model the dashboard works from.
 * @param result output of clean(): headers start with "Source Row" and end with "Issue Count", "Status"
 */
export function buildModel(result) {
  const n = result.columns.length;
  const headers = result.headers.slice(1, 1 + n);
  const rows = result.rows.map(r => r.slice(1, 1 + n));
  const cols = result.columns.map((c, i) => {
    const vals = rows.map(r => r[i]).filter(v => !blank(v));
    const distinct = new Set(vals.map(v => (isDateCell(v) ? v.date : String(v)))).size;
    const h = headers[i].toLowerCase().trim();
    const repeats = distinct ? vals.length / distinct : 0;
    let role = 'other';
    if (c.type === 'date' && vals.some(isDateCell)) role = 'date';
    else if (c.type === 'number') {
      const ints = vals.every(v => typeof v !== 'number' || Number.isInteger(v));
      if (NOT_MEASURE.test(h)) role = 'other';
      else if (distinct <= 12 && ints && DIM_NUMBER_HINT.test(h)) role = 'dimension';
      else if (vals.some(v => typeof v === 'number')) role = 'measure';
    } else if (FREE_TEXT.test(h) && distinct > 12) role = 'other';
    else if (['category', 'name', 'text', 'id'].includes(c.type) && distinct >= 2 && repeats >= 1.5) {
      // few values -> a group to compare by; many -> only useful as a "top 10"
      role = distinct <= 30 ? 'dimension' : 'entity';
    }
    return {
      index: i, name: headers[i], type: c.type, role, distinct, filled: vals.length,
      blankShare: rows.length ? 1 - vals.length / rows.length : 0,
      percent: Boolean(c.percent), ratio: Boolean(c.percent) || RATIO_HINT.test(h)
    };
  });
  // A column of names that never repeat (one row per campaign, per cost line) can still label a ranked chart.
  const label = cols.find(c => c.role === 'other' && ['name', 'text', 'category'].includes(c.type) && c.filled >= 2 && c.distinct === c.filled && c.blankShare <= 0.1 && !FREE_TEXT.test(c.name.toLowerCase()));
  if (label) { label.role = 'entity'; label.unique = true; }
  const by = role => cols.filter(c => c.role === role);
  return { headers, rows, cols, measures: by('measure'), dimensions: by('dimension'), dates: by('date'), entities: by('entity'), warnings: result.warnings || [] };
}

/** The aggregation that makes sense for a measure column when nothing else is known. */
export const defaultAgg = col => (!col ? 'count' : col.ratio || AVERAGE_HINT.test(col.name.toLowerCase()) ? 'avg' : 'sum');

/** Sensible starting answers to the questions the dashboard asks. */
export function defaultChoices(model) {
  // money-like totals first, then other measure-like names, then whatever number comes first; rates last
  const rank = m => { const h = m.name.toLowerCase(); return (m.ratio ? 4 : 0) + (/revenue|sales|income|turnover|profit/.test(h) ? 0 : MONEY_HINT.test(h) ? 1 : MEASURE_HINT.test(h) ? 2 : 3); };
  const measure = [...model.measures].sort((a, b) => rank(a) - rank(b) || a.index - b.index)[0] || null;
  // prefer a breakdown that is mostly filled in and has a readable number of groups
  const dims = [...model.dimensions].sort((a, b) => (a.blankShare > 0.3) - (b.blankShare > 0.3) || Math.abs(a.distinct - 6) - Math.abs(b.distinct - 6));
  return {
    measure: measure ? measure.index : -1, agg: defaultAgg(measure),
    date: model.dates.length ? model.dates[0].index : -1, grain: 'auto',
    dimension: dims.length ? dims[0].index : -1, split: -1, filters: {}
  };
}

export const applyFilters = (rows, filters) => {
  const active = Object.entries(filters || {}).filter(([, v]) => v !== '' && v !== undefined);
  return active.length ? rows.filter(r => active.every(([c, v]) => String(r[c]) === v)) : rows;
};

const reduce = (vals, agg) => {
  if (agg === 'count') return vals.length;
  let sum = 0, n = 0;
  for (const v of vals) if (typeof v === 'number') { sum += v; n++; }
  if (!n) return agg === 'sum' ? 0 : null;
  return agg === 'sum' ? sum : sum / n;
};
const measureVals = (rows, m) => (m < 0 ? rows : rows.map(r => r[m]));

export function total(rows, measure, agg) { return reduce(measureVals(rows, measure), agg); }

/** Group rows by one column. Returns [{ key, value, count }] largest first. Blank keys become "(blank)". */
export function groupBy(rows, dim, measure, agg) {
  const groups = new Map();
  for (const r of rows) {
    const k = blank(r[dim]) ? BLANK : isDateCell(r[dim]) ? r[dim].date : String(r[dim]);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(measure < 0 ? r : r[measure]);
  }
  return [...groups.entries()].map(([key, vals]) => ({ key, value: reduce(vals, agg), count: vals.length }))
    .filter(g => g.value !== null).sort((a, b) => b.value - a.value);
}

/** Keep the top N groups. With fold, the rest become one "Other" entry (totals only; averages can't be folded). */
export function topN(groups, n, agg, fold = true) {
  if (groups.length <= n) return groups;
  const head = groups.slice(0, n - (agg === 'avg' || !fold ? 0 : 1));
  if (agg === 'avg' || !fold) return head;
  const rest = groups.slice(head.length);
  return [...head, { key: `Other (${rest.length})`, value: rest.reduce((a, g) => a + g.value, 0), count: rest.reduce((a, g) => a + g.count, 0), other: true }];
}

const dayNum = iso => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000);
const GRAINS = ['day', 'week', 'month', 'quarter', 'year'];
export function pickGrain(rows, date) {
  let lo = Infinity, hi = -Infinity;
  for (const r of rows) { if (!isDateCell(r[date])) continue; const d = dayNum(r[date].date); if (d < lo) lo = d; if (d > hi) hi = d; }
  if (lo === Infinity) return 'month';
  const span = hi - lo;
  return span <= 45 ? 'day' : span <= 200 ? 'week' : span <= 1100 ? 'month' : span <= 3000 ? 'quarter' : 'year';
}

// Day 0 of the epoch was a Thursday, so Mondays are the days where (n - 4) % 7 === 0.
const labelDay = n => { const d = new Date(n * 86400000); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const ordOf = (iso, grain) => {
  const [y, m] = iso.split('-').map(Number);
  if (grain === 'year') return y;
  if (grain === 'quarter') return y * 4 + Math.ceil(m / 3) - 1;
  if (grain === 'month') return y * 12 + m - 1;
  const n = dayNum(iso);
  return grain === 'week' ? Math.floor((n - 4) / 7) : n;
};
const labelFor = (ord, grain) => {
  if (grain === 'year') return `${ord}`;
  if (grain === 'quarter') return `Q${(ord % 4) + 1} ${Math.floor(ord / 4)}`;
  if (grain === 'month') return `${MONTHS[ord % 12]} ${Math.floor(ord / 12)}`;
  return grain === 'week' ? labelDay(ord * 7 + 4) : labelDay(ord);
};

export const periodLabel = labelFor;
/** First day of a period and first day of the next one, as day numbers. */
function periodBounds(ord, grain) {
  const d = (y, m) => Math.round(Date.UTC(y, m, 1) / 86400000);
  if (grain === 'year') return [d(ord, 0), d(ord + 1, 0)];
  if (grain === 'quarter') return [d(Math.floor(ord / 4), (ord % 4) * 3), d(Math.floor((ord + 1) / 4), ((ord + 1) % 4) * 3)];
  if (grain === 'month') return [d(Math.floor(ord / 12), ord % 12), d(Math.floor((ord + 1) / 12), (ord + 1) % 12)];
  return grain === 'week' ? [ord * 7 + 4, ord * 7 + 11] : [ord, ord + 1];
}

/**
 * Values over time, optionally split by a column (up to four lines; more are folded into "Other").
 * Empty periods are filled in. If the grouping asked for would give more than 500 points, a coarser one is used.
 * @returns { grain, asked, labels, series: [{ name, values }], undated }
 */
export function timeSeries(rows, date, measure, agg, grain = 'auto', split = -1) {
  const asked = grain === 'auto' ? pickGrain(rows, date) : grain;
  const dated = rows.filter(r => isDateCell(r[date]));
  const undated = rows.length - dated.length;
  if (!dated.length) return { grain: asked, asked, labels: [], series: [], undated };
  let g = asked, lo, hi;
  for (;;) {
    lo = Infinity; hi = -Infinity;
    for (const r of dated) { const o = ordOf(r[date].date, g); if (o < lo) lo = o; if (o > hi) hi = o; }
    if (hi - lo + 1 <= 500 || g === 'year') break;
    g = GRAINS[GRAINS.indexOf(g) + 1];
  }
  let names = ['all'];
  let nameOf = () => 'all';
  if (split >= 0) {
    const all = groupBy(dated, split, measure, agg === 'avg' ? 'count' : agg);
    const top = all.slice(0, all.length <= 4 ? 4 : 3).map(x => x.key); // four colours at most
    names = all.length > top.length && agg !== 'avg' ? [...top, 'Other'] : top;
    nameOf = r => { const k = blank(r[split]) ? BLANK : String(r[split]); return top.includes(k) ? k : 'Other'; };
  }
  const cells = new Map();
  for (const r of dated) {
    const k = nameOf(r) + '|' + ordOf(r[date].date, g);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(measure < 0 ? r : r[measure]);
  }
  const ords = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  const empty = agg === 'avg' ? null : 0;
  // the last period is "partial" when the data stops well before the period ends
  let lastDay = -Infinity;
  for (const r of dated) { const n = dayNum(r[date].date); if (n > lastDay) lastDay = n; }
  const [from, to] = periodBounds(hi, g);
  return {
    grain: g, asked, undated, last: hi, partial: (lastDay - from + 1) / (to - from) < 0.6, labels: ords.map(o => labelFor(o, g)),
    series: names.map(name => ({ name: name === 'all' ? '' : name, values: ords.map(o => (cells.has(name + '|' + o) ? reduce(cells.get(name + '|' + o), agg) : empty)) }))
  };
}

/**
 * Bucket a numeric column into about 10 round-numbered bins.
 * A few extreme values would squash everything into one bar, so values past the
 * 98th percentile share one last bin marked `over: true`. Whole numbers over a
 * short range get one bin per value (marked `single: true`).
 */
export function histogram(rows, measure, target = 10) {
  const vals = rows.map(r => r[measure]).filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!vals.length) return [];
  const lo = vals[0], max = vals[vals.length - 1];
  if (lo === max) return [{ from: lo, to: max, count: vals.length, single: true }];
  if (max - lo <= 20 && vals.every(Number.isInteger)) {
    const bins = Array.from({ length: max - lo + 1 }, (_, i) => ({ from: lo + i, to: lo + i, count: 0, single: true }));
    for (const v of vals) bins[v - lo].count++;
    return bins;
  }
  const p98 = vals[Math.floor((vals.length - 1) * 0.98)];
  const clip = p98 > lo && max > p98 * 2;
  const hi = clip ? p98 : max;
  const raw = (hi - lo) / target, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  const start = Math.floor(lo / step) * step;
  const count = Math.floor((hi - start) / step) + 1;
  // numbers too large or too small to bin (1e308, 5e-324) get a single bar instead of a crash
  if (!Number.isFinite(step) || !(step > 0) || !Number.isFinite(count) || count < 1 || count > 200) return [{ from: lo, to: max, count: vals.length }];
  const bins = Array.from({ length: count }, (_, i) => ({ from: start + i * step, to: start + (i + 1) * step, count: 0 }));
  const edge = bins[bins.length - 1].to;
  let over = 0;
  for (const v of vals) { if (clip && v >= edge) over++; else bins[Math.max(0, Math.min(bins.length - 1, Math.floor((v - start) / step)))].count++; }
  if (over) bins.push({ from: edge, to: max, count: over, over: true });
  return bins;
}

/**
 * Straight-line forecast: fits a line through the values and extends it.
 * Needs at least 6 points. With skipLast, the last value is left out of the fit (an unfinished period)
 * and the forecast starts at that period instead of after it.
 * @returns null, or { from, values, low, high, slope } where `from` is the index of the first forecast point.
 *          low/high are a rough 80% range based on how far past points sat from the line.
 */
export function forecast(values, steps = 3, skipLast = false) {
  const n = values.length - (skipLast ? 1 : 0);
  const pts = [];
  for (let i = 0; i < n; i++) if (typeof values[i] === 'number' && Number.isFinite(values[i])) pts.push([i, values[i]]);
  if (pts.length < 6) return null;
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  let sxx = 0, sxy = 0;
  for (const [x, y] of pts) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); }
  if (!sxx) return null;
  const slope = sxy / sxx, icpt = my - slope * mx;
  const sd = Math.sqrt(pts.reduce((a, [x, y]) => a + (y - (icpt + slope * x)) ** 2, 0) / Math.max(1, pts.length - 2));
  const floor = pts.every(p => p[1] >= 0) ? 0 : -Infinity;
  const out = { from: n, values: [], low: [], high: [], slope };
  for (let k = 0; k < steps; k++) {
    const x = n + k, y = icpt + slope * x;
    const half = 1.28 * sd * Math.sqrt(1 + 1 / pts.length + (x - mx) ** 2 / sxx);
    out.values.push(Math.max(floor, y)); out.low.push(Math.max(floor, y - half)); out.high.push(Math.max(floor, y + half));
  }
  return out;
}

/**
 * Everything about one value of one column (one sales rep, one region): its totals, its rank,
 * and what it is made of in the other columns (how many customers, which ones matter most).
 */
export function profile(model, c, dim, key) {
  const rows = applyFilters(model.rows, c.filters);
  const m = c.agg === 'count' ? -1 : c.measure;
  const keyOf = r => (blank(r[dim]) ? BLANK : isDateCell(r[dim]) ? r[dim].date : String(r[dim]));
  const mine = rows.filter(r => keyOf(r) === key);
  const groups = groupBy(rows, dim, m, c.agg).filter(g => g.key !== BLANK);
  const me = groups.find(g => g.key === key);
  const sum = groups.reduce((a, g) => a + g.value, 0);
  const positive = groups.every(g => g.value >= 0) && sum > 0;
  return {
    key, column: model.headers[dim], rows: mine.length, value: me ? me.value : null,
    rank: me ? groups.indexOf(me) + 1 : null, of: groups.length,
    share: me && c.agg !== 'avg' && positive ? me.value / sum : null,
    measures: model.measures.map(col => ({ name: col.name, percent: col.percent, ratio: col.ratio, total: defaultAgg(col) === 'avg' ? null : total(mine, col.index, 'sum'), average: total(mine, col.index, 'avg') })),
    related: [...model.dimensions, ...model.entities].filter(col => col.index !== dim && !col.unique).map(col => {
      const g = groupBy(mine, col.index, m, c.agg).filter(x => x.key !== BLANK);
      return { name: col.name, distinct: g.length, top: g.slice(0, 5) };
    }).filter(x => x.distinct > 0),
    trend: c.date >= 0 && mine.length ? timeSeries(mine, c.date, m, c.agg, c.grain) : null
  };
}

const AGG_WORD = { sum: 'Total', avg: 'Average' };
/** "Total Revenue", "Average Salary", "Number of rows". A header that already says Total/Average is left alone. */
export function measureLabel(model, c) {
  if (c.measure < 0 || c.agg === 'count') return 'Number of rows';
  const name = model.headers[c.measure];
  return new RegExp(`^${AGG_WORD[c.agg]}\\b`, 'i').test(name) ? name : `${AGG_WORD[c.agg]} ${name}`;
}
const lowerLabel = (model, c) => { const l = measureLabel(model, c); return l.charAt(0).toLowerCase() + l.slice(1); };

/** Headline numbers. kind: 'count' | 'number' | 'text'; `col` is the measure column for number tiles. */
export function kpis(model, c) {
  const rows = applyFilters(model.rows, c.filters);
  const out = [{ label: 'Rows', value: rows.length, kind: 'count' }];
  if (c.measure >= 0 && c.agg !== 'count') {
    const col = model.cols[c.measure];
    // adding up a rate or a percentage means nothing, so those only get an average
    if (c.agg === 'sum' && !col.ratio) out.push({ label: measureLabel(model, { ...c, agg: 'sum' }), value: total(rows, c.measure, 'sum'), kind: 'number', col });
    out.push({ label: measureLabel(model, { ...c, agg: 'avg' }), value: total(rows, c.measure, 'avg'), kind: 'number', col });
  }
  if (c.dimension >= 0) {
    // the best performer in the column being compared
    const m = c.agg === 'count' ? -1 : c.measure;
    const g = groupBy(rows, c.dimension, m, c.agg).filter(x => x.key !== BLANK && (c.agg !== 'avg' || x.count >= 3));
    if (g.length >= 2) out.push({ label: `Highest ${model.headers[c.dimension]}`, value: g[0].key, amount: g[0].value, kind: 'top', col: m >= 0 ? model.cols[m] : null });
    else out.push({ label: `${model.headers[c.dimension]} groups`, value: new Set(rows.map(r => r[c.dimension]).filter(v => !blank(v)).map(String)).size, kind: 'count' });
  }
  if (c.date >= 0) {
    const ds = rows.map(r => r[c.date]).filter(isDateCell).map(v => v.date).sort();
    if (ds.length) out.push({ label: `${model.headers[c.date]} range`, value: `${ds[0]} to ${ds[ds.length - 1]}`, kind: 'text' });
  }
  return out.slice(0, 5);
}

/**
 * Charts worth showing for this data, most useful first. Each has an id, a title and a reason.
 * kind: 'trend' | 'bars' | 'histogram'
 */
export function suggestions(model, c) {
  const out = [];
  const label = measureLabel(model, c);
  const lower = lowerLabel(model, c);
  const name = i => model.headers[i];
  if (c.date >= 0) {
    out.push({ id: `trend:${c.date}`, kind: 'trend', date: c.date, split: -1, title: `${label} over time`, reason: `"${name(c.date)}" holds dates, so the data can be shown as a trend.`, on: true });
    if (c.split >= 0) out.push({ id: `trend:${c.date}:${c.split}`, kind: 'trend', date: c.date, split: c.split, title: `${label} over time by ${name(c.split)}`, reason: `Shows whether every ${name(c.split)} moves the same way.`, on: true });
  }
  const dims = [...model.dimensions].sort((a, b) => (a.index === c.dimension ? -1 : b.index === c.dimension ? 1 : (a.blankShare > 0.3) - (b.blankShare > 0.3) || a.distinct - b.distinct));
  dims.forEach((d, i) => out.push({ id: `bars:${d.index}`, kind: 'bars', dim: d.index, title: `${label} by ${d.name}`, reason: `"${d.name}" has ${d.distinct} repeated values, which makes a clear comparison.`, on: i < 3 && (d.index === c.dimension || d.blankShare <= 0.3) }));
  const firstShared = model.entities.findIndex(e => !e.unique);
  model.entities.forEach((e, i) => {
    if (e.unique && c.agg === 'count') return; // every name appears once, so counting rows says nothing
    const few = e.distinct <= 12;
    out.push({ id: `bars:${e.index}`, kind: 'bars', dim: e.index, top: few ? 0 : 10, title: few ? `${label} by ${e.name}` : `Top 10 ${e.name} by ${lower}`,
      reason: few ? `Each row is one ${e.name}, so they can be ranked.` : `"${e.name}" has ${e.distinct.toLocaleString('en-US')} values, too many to show at once, so only the largest are shown.`,
      on: e.unique ? model.rows.length <= 60 : i === firstShared });
  });
  // the chosen number first, then up to three others
  const spread = [...model.measures].sort((a, b) => (a.index === c.measure ? -1 : b.index === c.measure ? 1 : 0)).slice(0, 4);
  spread.forEach(ms => out.push({ id: `hist:${ms.index}`, kind: 'histogram', measure: ms.index, title: `How ${ms.name} is spread`, reason: `Shows whether "${ms.name}" is mostly small values with a few large ones.`, on: ms.index === c.measure && c.agg !== 'count' && model.rows.length >= 30 }));
  model.dates.filter(d => d.index !== c.date).forEach(d => out.push({ id: `trend:${d.index}`, kind: 'trend', date: d.index, split: -1, title: `${label} by ${d.name}`, reason: c.date >= 0 ? `A second date column. Useful if "${d.name}" matters more than "${name(c.date)}".` : `"${d.name}" holds dates, so the data can be shown as a trend.`, on: false }));
  if (c.measure >= 0 && c.agg !== 'count') dims.slice(0, 2).forEach(d => out.push({ id: `count:${d.index}`, kind: 'bars', dim: d.index, count: true, title: `Number of rows by ${d.name}`, reason: `Shows volume, which can tell a different story from ${lower}.`, on: false }));
  return out;
}

const pct = x => `${Math.round(x * 100)}%`;

/** Plain-language findings worked out from the numbers. `fmt` formats a value for display. */
export function findings(model, c, fmt = v => String(Math.round(v * 100) / 100)) {
  const rows = applyFilters(model.rows, c.filters);
  const out = [];
  if (rows.length < 5) return out;
  const m = c.agg === 'count' ? -1 : c.measure;
  const label = measureLabel(model, c);
  const lower = lowerLabel(model, c);
  if (c.dimension >= 0) {
    const all = groupBy(rows, c.dimension, m, c.agg);
    const g = all.filter(x => x.key !== BLANK);
    const dn = model.headers[c.dimension];
    // shares only mean something when every group is positive; the blank group still counts in the total
    const sum = all.reduce((a, x) => a + x.value, 0);
    const positive = all.every(x => x.value >= 0) && sum > 0;
    if (g.length >= 2 && g.length <= 30) {
      if (c.agg !== 'avg' && positive) {
        const share = g[0].value / sum;
        if (share >= 0.1) out.push(`${g[0].key} has the largest share of ${lower}: ${fmt(g[0].value)}, which is ${pct(share)} of the total.`);
        if (g.length >= 4) { const top2 = (g[0].value + g[1].value) / sum; if (top2 >= 0.6) out.push(`The top two ${dn} values (${g[0].key} and ${g[1].key}) make up ${pct(top2)} of ${lower}.`); }
        const last = g[g.length - 1];
        const ratio = last.value > 0 ? g[0].value / last.value : 0;
        if (ratio >= 3 && ratio <= 50 && last.count >= 3) out.push(`${g[0].key} is ${ratio.toFixed(1)} times ${last.key}, the smallest ${dn}.`);
      } else if (c.agg === 'avg') {
        const solid = g.filter(x => x.count >= 3);
        if (solid.length >= 2 && fmt(solid[0].value) !== fmt(solid[solid.length - 1].value)) out.push(`${solid[0].key} has the highest ${lower} (${fmt(solid[0].value)}) and ${solid[solid.length - 1].key} the lowest (${fmt(solid[solid.length - 1].value)}).`);
      } else if (c.agg === 'sum' && !positive && g.length >= 2) {
        out.push(`${dn} has both positive and negative totals, from ${g[0].key} (${fmt(g[0].value)}) to ${g[g.length - 1].key} (${fmt(g[g.length - 1].value)}), so shares of the total are not shown.`);
      }
    }
  }
  if (c.date >= 0) {
    const ts = timeSeries(rows, c.date, m, c.agg, c.grain);
    const v = ts.series[0] ? ts.series[0].values : [];
    const pts = v.map((x, i) => ({ x, i })).filter(p => p.x !== null);
    if (pts.length >= 3) {
      const hi = pts.reduce((a, p) => (p.x > a.x ? p : a)), lo = pts.reduce((a, p) => (p.x < a.x ? p : a));
      if (hi.x !== lo.x) out.push(`The highest ${ts.grain} was ${ts.labels[hi.i]} (${fmt(hi.x)}) and the lowest was ${ts.labels[lo.i]} (${fmt(lo.x)}).`);
      // compare halves, leaving out the first and last period because they are often incomplete
      const inner = pts.slice(1, -1);
      const half = Math.floor(inner.length / 2);
      if (half >= 3 && rows.length >= 30) {
        const avg = a => a.reduce((s, p) => s + p.x, 0) / a.length;
        const first = avg(inner.slice(0, half)), second = avg(inner.slice(inner.length - half));
        if (first > 0 && second >= 0) {
          const change = (second - first) / first;
          if (Math.abs(change) >= 0.1) out.push(`${label} per ${ts.grain} is ${pct(Math.abs(change))} ${change > 0 ? 'higher' : 'lower'} in the second half of the period than in the first.`);
          else out.push(`${label} per ${ts.grain} is steady across the period (within 10%).`);
        }
      }
    }
    if (ts.undated > 0) out.push(`${ts.undated.toLocaleString('en-US')} ${ts.undated === 1 ? 'row has' : 'rows have'} no "${model.headers[c.date]}", so ${ts.undated === 1 ? 'it is' : 'they are'} missing from the trend.`);
  }
  if (c.measure >= 0) {
    const vals = rows.map(r => r[c.measure]).filter(v => typeof v === 'number').sort((a, b) => a - b);
    if (vals.length >= 20) {
      const q = p => vals[Math.floor((vals.length - 1) * p)];
      const iqr = q(0.75) - q(0.25), hiCut = q(0.75) + 3 * iqr, loCut = q(0.25) - 3 * iqr;
      const big = vals.filter(v => v > hiCut).length, small = vals.filter(v => v < loCut).length;
      const mn = model.headers[c.measure];
      if (iqr > 0 && big > 0) out.push(`${big} ${big === 1 ? 'row has' : 'rows have'} an unusually high ${mn} (above ${fmt(hiCut)}). Worth checking they are correct.`);
      if (iqr > 0 && small > 0) out.push(`${small} ${small === 1 ? 'row has' : 'rows have'} an unusually low ${mn} (below ${fmt(loCut)}). Worth checking they are correct.`);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length, med = q(0.5);
      if (med > 0 && mean / med >= 1.5) out.push(`The average ${mn} (${fmt(mean)}) is well above the typical value (${fmt(med)}), so a few large rows are pulling it up.`);
    }
  }
  const used = new Set([c.measure, c.date, c.dimension].filter(i => i >= 0));
  const gap = model.cols.filter(col => used.has(col.index)).map(col => ({ col, n: rows.filter(r => blank(r[col.index])).length })).filter(b => b.n / rows.length >= 0.1).sort((a, b) => b.n - a.n)[0];
  if (gap) out.push(`"${gap.col.name}" is empty in ${pct(gap.n / rows.length)} of rows. Charts that use it leave those rows out.`);
  return out;
}
