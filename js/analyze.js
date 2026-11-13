// Turns a cleaned table into dashboard pieces: KPIs, chart data, suggestions and findings.
// Pure functions, no browser APIs, so they run in Node tests.
import { isDateCell } from './cleaner.js';

const MEASURE_HINT = /amount|sales|revenue|total|price|cost|salary|qty|quantity|value|units|pallets|profit|spend|budget|hours|count|score/;
const AVERAGE_HINT = /salary|price|rate|age|score|rating|percent|%|days|avg|average|duration|margin|time/;
const DIM_NUMBER_HINT = /^(year|month|quarter|week|rating|grade|level|tier|stage)$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const blank = v => v === null || v === undefined || v === '';

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
    const h = headers[i].toLowerCase();
    let role = 'other';
    if (c.type === 'date' && vals.some(isDateCell)) role = 'date';
    else if (c.type === 'number') {
      const ints = vals.every(v => typeof v !== 'number' || Number.isInteger(v));
      role = distinct <= 12 && ints && DIM_NUMBER_HINT.test(h) ? 'dimension' : 'measure';
    } else if (c.type === 'category' && distinct >= 2) role = 'dimension';
    else if ((c.type === 'name' || c.type === 'text' || c.type === 'id') && distinct >= 2) {
      // text with repeats can still be grouped: few values -> dimension, many -> "top N" entity
      const repeats = vals.length / distinct;
      if (distinct <= 30 && repeats >= 1.5) role = 'dimension';
      else if (repeats >= 1.5) role = 'entity';
    }
    return { index: i, name: headers[i], type: c.type, role, distinct, filled: vals.length };
  });
  const by = role => cols.filter(c => c.role === role);
  return { headers, rows, cols, measures: by('measure'), dimensions: by('dimension'), dates: by('date'), entities: by('entity') };
}

/** Sensible starting answers to the questions the dashboard asks. */
export function defaultChoices(model) {
  // money-like totals first, then other measure-like names, then whatever number comes first
  const rank = m => { const h = m.name.toLowerCase(); return /revenue|sales|amount|profit|total|spend/.test(h) ? 0 : MEASURE_HINT.test(h) ? 1 : 2; };
  const measure = [...model.measures].sort((a, b) => rank(a) - rank(b) || a.index - b.index)[0] || null;
  const agg = !measure ? 'count' : AVERAGE_HINT.test(measure.name.toLowerCase()) ? 'avg' : 'sum';
  // prefer the breakdown with a readable number of groups
  const dims = [...model.dimensions].sort((a, b) => Math.abs(a.distinct - 6) - Math.abs(b.distinct - 6));
  return {
    measure: measure ? measure.index : -1, agg,
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
  const nums = vals.filter(v => typeof v === 'number');
  if (!nums.length) return agg === 'sum' ? 0 : null;
  const sum = nums.reduce((a, b) => a + b, 0);
  return agg === 'sum' ? sum : sum / nums.length;
};
const measureVals = (rows, m) => (m < 0 ? rows : rows.map(r => r[m]));

export function total(rows, measure, agg) { return reduce(measureVals(rows, measure), agg); }

/** Group rows by one column. Returns [{ key, value, count }] largest first. Blank keys become "(blank)". */
export function groupBy(rows, dim, measure, agg) {
  const groups = new Map();
  for (const r of rows) {
    const k = blank(r[dim]) ? '(blank)' : isDateCell(r[dim]) ? r[dim].date : String(r[dim]);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(measure < 0 ? r : r[measure]);
  }
  return [...groups.entries()].map(([key, vals]) => ({ key, value: reduce(vals, agg), count: vals.length }))
    .filter(g => g.value !== null).sort((a, b) => b.value - a.value);
}

/** Keep the top N groups and fold the rest into "Other" (only for totals; averages can't be folded). */
export function topN(groups, n, agg, fold = true) {
  if (groups.length <= n) return groups;
  const head = groups.slice(0, n - (agg === 'avg' || !fold ? 0 : 1));
  if (agg === 'avg' || !fold) return head;
  const rest = groups.slice(head.length);
  return [...head, { key: `Other (${rest.length})`, value: rest.reduce((a, g) => a + g.value, 0), count: rest.reduce((a, g) => a + g.count, 0), other: true }];
}

const dayNum = iso => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000);
export function pickGrain(rows, date) {
  const days = rows.map(r => r[date]).filter(isDateCell).map(v => dayNum(v.date));
  if (!days.length) return 'month';
  let lo = Infinity, hi = -Infinity;
  for (const d of days) { if (d < lo) lo = d; if (d > hi) hi = d; }
  const span = hi - lo;
  return span <= 45 ? 'day' : span <= 200 ? 'week' : span <= 1100 ? 'month' : span <= 3000 ? 'quarter' : 'year';
}

const bucketOf = (iso, grain) => {
  const [y, m, d] = iso.split('-').map(Number);
  if (grain === 'year') return { key: `${y}`, label: `${y}`, ord: y };
  if (grain === 'quarter') { const q = Math.ceil(m / 3); return { key: `${y}-Q${q}`, label: `Q${q} ${y}`, ord: y * 4 + q - 1 }; }
  if (grain === 'month') return { key: `${y}-${String(m).padStart(2, '0')}`, label: `${MONTHS[m - 1]} ${y}`, ord: y * 12 + m - 1 };
  const n = dayNum(iso);
  if (grain === 'week') { const start = n - ((new Date(n * 86400000).getUTCDay() + 6) % 7); return { key: 'w' + start, label: labelDay(start), ord: start / 7 }; }
  return { key: iso, label: `${d} ${MONTHS[m - 1]}`, ord: n };
};
const labelDay = n => { const d = new Date(n * 86400000); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const labelFor = (ord, grain) => {
  if (grain === 'year') return `${ord}`;
  if (grain === 'quarter') return `Q${(ord % 4) + 1} ${Math.floor(ord / 4)}`;
  if (grain === 'month') return `${MONTHS[ord % 12]} ${Math.floor(ord / 12)}`;
  return grain === 'week' ? labelDay(Math.round(ord * 7)) : labelDay(ord);
};

/**
 * Values over time, optionally split by a column (top 3 values + "Other").
 * @returns { grain, labels, series: [{ name, values }] } with empty periods filled in.
 */
export function timeSeries(rows, date, measure, agg, grain = 'auto', split = -1) {
  const g = grain === 'auto' ? pickGrain(rows, date) : grain;
  const dated = rows.filter(r => isDateCell(r[date]));
  if (!dated.length) return { grain: g, labels: [], series: [] };
  let names = ['all'];
  let nameOf = () => 'all';
  if (split >= 0) {
    const all = groupBy(dated, split, measure, agg === 'avg' ? 'count' : agg);
    const top = all.slice(0, all.length <= 4 ? 4 : 3).map(x => x.key); // four colours at most
    const more = new Set(dated.map(r => String(r[split]))).size > top.length;
    names = more && agg !== 'avg' ? [...top, 'Other'] : top;
    nameOf = r => { const k = blank(r[split]) ? '(blank)' : String(r[split]); return top.includes(k) ? k : 'Other'; };
  }
  const cells = new Map();
  let lo = Infinity, hi = -Infinity;
  for (const r of dated) {
    const b = bucketOf(r[date].date, g);
    const ord = Math.round(b.ord);
    if (ord < lo) lo = ord; if (ord > hi) hi = ord;
    const k = nameOf(r) + '|' + ord;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(measure < 0 ? r : r[measure]);
  }
  const ords = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  const empty = agg === 'avg' ? null : 0;
  return {
    grain: g, labels: ords.map(o => labelFor(o, g)),
    series: names.map(name => ({ name: name === 'all' ? '' : name, values: ords.map(o => (cells.has(name + '|' + o) ? reduce(cells.get(name + '|' + o), agg) : empty)) }))
  };
}

/**
 * Bucket a numeric column into about 10 round-numbered bins.
 * A few extreme values would squash everything into one bar, so values past the
 * 98th percentile share one last bin marked `over: true`.
 */
export function histogram(rows, measure, target = 10) {
  const vals = rows.map(r => r[measure]).filter(v => typeof v === 'number').sort((a, b) => a - b);
  if (!vals.length) return [];
  const lo = vals[0], max = vals[vals.length - 1];
  if (lo === max) return [{ from: lo, to: max, count: vals.length }];
  const p98 = vals[Math.floor((vals.length - 1) * 0.98)];
  const clip = p98 > lo && max > p98 * 2;
  const hi = clip ? p98 : max;
  const raw = (hi - lo) / target, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  const start = Math.floor(lo / step) * step;
  const bins = Array.from({ length: Math.floor((hi - start) / step) + 1 }, (_, i) => ({ from: start + i * step, to: start + (i + 1) * step, count: 0 }));
  const edge = bins[bins.length - 1].to;
  let over = 0;
  for (const v of vals) { if (clip && v >= edge) over++; else bins[Math.min(bins.length - 1, Math.floor((v - start) / step))].count++; }
  if (over) bins.push({ from: edge, to: max, count: over, over: true });
  return bins;
}

const AGG_WORD = { sum: 'Total', avg: 'Average', count: 'Number of rows' };
export const measureLabel = (model, c) => (c.measure < 0 || c.agg === 'count' ? 'Number of rows' : `${AGG_WORD[c.agg]} ${model.headers[c.measure]}`);

/** Headline numbers. */
export function kpis(model, c) {
  const rows = applyFilters(model.rows, c.filters);
  const out = [{ label: 'Rows', value: rows.length, kind: 'count' }];
  if (c.measure >= 0 && c.agg !== 'count') {
    const name = model.headers[c.measure];
    out.push({ label: `Total ${name}`, value: total(rows, c.measure, 'sum'), kind: 'number' });
    out.push({ label: `Average ${name}`, value: total(rows, c.measure, 'avg'), kind: 'number' });
  }
  if (c.dimension >= 0) out.push({ label: `Different ${model.headers[c.dimension]} values`, value: new Set(rows.map(r => r[c.dimension]).filter(v => !blank(v)).map(String)).size, kind: 'count' });
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
  const m = c.agg === 'count' ? -1 : c.measure;
  const name = i => model.headers[i];
  if (c.date >= 0) {
    out.push({ id: `trend:${c.date}`, kind: 'trend', date: c.date, split: -1, title: `${label} over time`, reason: `"${name(c.date)}" holds dates, so the data can be shown as a trend.`, on: true });
    if (c.split >= 0) out.push({ id: `trend:${c.date}:${c.split}`, kind: 'trend', date: c.date, split: c.split, title: `${label} over time by ${name(c.split)}`, reason: `Shows whether every ${name(c.split)} moves the same way.`, on: true });
  }
  const dims = [...model.dimensions].sort((a, b) => (a.index === c.dimension ? -1 : b.index === c.dimension ? 1 : a.distinct - b.distinct));
  dims.forEach((d, i) => out.push({ id: `bars:${d.index}`, kind: 'bars', dim: d.index, title: `${label} by ${d.name}`, reason: `"${d.name}" has ${d.distinct} repeated values, which makes a clear comparison.`, on: i < 3 }));
  model.entities.forEach((e, i) => out.push({ id: `bars:${e.index}`, kind: 'bars', dim: e.index, top: 10, title: `Top 10 ${e.name} by ${label.toLowerCase()}`, reason: `"${e.name}" has ${e.distinct} values, too many to show at once, so only the largest are shown.`, on: i === 0 }));
  model.measures.forEach(ms => out.push({ id: `hist:${ms.index}`, kind: 'histogram', measure: ms.index, title: `How ${ms.name} is spread`, reason: `Shows whether "${ms.name}" is mostly small values with a few large ones.`, on: ms.index === c.measure && model.measures.length <= 3 }));
  model.dates.filter(d => d.index !== c.date).forEach(d => out.push({ id: `trend:${d.index}`, kind: 'trend', date: d.index, split: -1, title: `${label} by ${d.name}`, reason: `A second date column. Useful if "${d.name}" matters more than "${name(c.date)}".`, on: false }));
  if (c.measure >= 0 && c.agg !== 'count') dims.slice(0, 2).forEach(d => out.push({ id: `count:${d.index}`, kind: 'bars', dim: d.index, count: true, title: `Number of rows by ${d.name}`, reason: `Shows volume, which can tell a different story from ${label.toLowerCase()}.`, on: false }));
  return out;
}

const pct = x => `${Math.round(x * 100)}%`;

/** Plain-language findings worked out from the numbers. `fmt` formats a value for display. */
export function findings(model, c, fmt = v => String(Math.round(v * 100) / 100)) {
  const rows = applyFilters(model.rows, c.filters);
  const out = [];
  if (!rows.length) return out;
  const m = c.agg === 'count' ? -1 : c.measure;
  const label = measureLabel(model, c).toLowerCase();
  if (c.dimension >= 0) {
    const g = groupBy(rows, c.dimension, m, c.agg).filter(x => x.key !== '(blank)');
    const dn = model.headers[c.dimension];
    if (g.length >= 2) {
      const sum = g.reduce((a, x) => a + x.value, 0);
      if (c.agg !== 'avg' && sum > 0) {
        out.push(`${g[0].key} has the largest share of ${label}: ${fmt(g[0].value)}, which is ${pct(g[0].value / sum)} of the total.`);
        if (g.length >= 4) { const top2 = (g[0].value + g[1].value) / sum; if (top2 >= 0.6) out.push(`The top two ${dn} values (${g[0].key} and ${g[1].key}) make up ${pct(top2)} of ${label}.`); }
      } else if (c.agg === 'avg') out.push(`${g[0].key} has the highest ${label} (${fmt(g[0].value)}) and ${g[g.length - 1].key} the lowest (${fmt(g[g.length - 1].value)}).`);
      const last = g[g.length - 1];
      if (c.agg !== 'avg' && last.value > 0 && g[0].value / last.value >= 3) out.push(`${g[0].key} is ${(g[0].value / last.value).toFixed(1)} times ${last.key}, the smallest ${dn}.`);
    }
  }
  if (c.date >= 0) {
    const ts = timeSeries(rows, c.date, m, c.agg, c.grain);
    const v = ts.series[0] ? ts.series[0].values : [];
    const pts = v.map((x, i) => ({ x, i })).filter(p => p.x !== null);
    if (pts.length >= 3) {
      const hi = pts.reduce((a, p) => (p.x > a.x ? p : a)), lo = pts.reduce((a, p) => (p.x < a.x ? p : a));
      out.push(`The highest ${ts.grain} was ${ts.labels[hi.i]} (${fmt(hi.x)}) and the lowest was ${ts.labels[lo.i]} (${fmt(lo.x)}).`);
      // compare complete halves so a short last period does not distort the trend
      const half = Math.floor(pts.length / 2);
      const avg = a => a.reduce((s, p) => s + p.x, 0) / a.length;
      const first = avg(pts.slice(0, half)), second = avg(pts.slice(pts.length - half));
      if (first > 0) {
        const change = (second - first) / first;
        if (Math.abs(change) >= 0.1) out.push(`${measureLabel(model, c)} per ${ts.grain} is ${pct(Math.abs(change))} ${change > 0 ? 'higher' : 'lower'} in the second half of the period than in the first.`);
        else out.push(`${measureLabel(model, c)} per ${ts.grain} is steady across the period (within 10%).`);
      }
    }
  }
  if (c.measure >= 0) {
    const vals = rows.map(r => r[c.measure]).filter(v => typeof v === 'number').sort((a, b) => a - b);
    if (vals.length >= 20) {
      const q = p => vals[Math.floor((vals.length - 1) * p)];
      const iqr = q(0.75) - q(0.25), cut = q(0.75) + 3 * iqr;
      const big = vals.filter(v => v > cut).length;
      const mn = model.headers[c.measure];
      if (iqr > 0 && big > 0) out.push(`${big} ${big === 1 ? 'row has' : 'rows have'} an unusually high ${mn} (above ${fmt(cut)}). Worth checking they are correct.`);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length, med = q(0.5);
      if (med > 0 && mean / med >= 1.5) out.push(`The average ${mn} (${fmt(mean)}) is well above the typical value (${fmt(med)}), so a few large rows are pulling it up.`);
    }
  }
  const blanks = model.cols.map(col => ({ col, n: rows.filter(r => blank(r[col.index])).length })).filter(b => b.n / rows.length >= 0.1).sort((a, b) => b.n - a.n)[0];
  if (blanks) out.push(`"${blanks.col.name}" is empty in ${pct(blanks.n / rows.length)} of rows, so charts using it leave those rows out or show them as "(blank)".`);
  return out;
}
