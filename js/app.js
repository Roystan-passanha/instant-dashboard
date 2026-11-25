import { clean, isDateCell, detectHeaderRow } from './cleaner.js';
import { buildModel, defaultChoices, defaultAgg, applyFilters, groupBy, topN, timeSeries, histogram, suggestions, findings, kpis, measureLabel, forecast, profile, periodLabel, scatterPoints, linkText, BLANK } from './analyze.js';
import { lineChart, barChart, pieChart, columnChart, fmt, fmtFull, fmtPercent, SERIES } from './charts.js';
import { makeSample } from './sample.js';
import { eChart, CATEGORY_TYPES, TREND_TYPES, NEEDS_WHOLE } from './echart.js';
import { extract, toCsv, toSheetCells, cellText } from './extract.js';
import { startHero } from './hero.js';

const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); for (const k of kids) n.append(k); return n; };
const show = (node, on = true) => { node.hidden = !on; };
const plural = (n, one, many = one + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

const MAX_BYTES = 30 * 1024 * 1024, MAX_ROWS = 300000;
const state = { workbook: null, matrices: {}, csv: false, fileName: '', model: null, choices: null, toggles: {}, tables: new Set(), types: {}, draw: [] };

// ---------- reading files ----------
const serialToIso = n => { const d = XLSX.SSF.parse_date_code(n); return d ? `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}` : null; };

function sheetToMatrix(ws, csv) {
  // Use the cells that exist. A sheet's declared range can run to row 1,048,576 because of one stray cell.
  let maxR = -1, maxC = -1;
  const cells = [];
  for (const addr in ws) {
    if (addr[0] === '!') continue;
    const cell = ws[addr];
    if (!cell || cell.t === 'z' || cell.t === 'e' || cell.v === undefined || cell.v === '') continue;
    const { r, c } = XLSX.utils.decode_cell(addr);
    cells.push([r, c, cell]);
    if (r > maxR) maxR = r;
    if (c > maxC) maxC = c;
  }
  if (maxR < 0) return [];
  if (cells.length && maxR + 1 > MAX_ROWS + 50 && cells.length > MAX_ROWS) throw new Error('rows');
  // rows that hold at least one cell, in order, so a stray cell far down the sheet costs nothing
  const used = [...new Set(cells.map(x => x[0]))].sort((a, b) => a - b);
  const dense = used.length && used[used.length - 1] - used[0] + 1 <= used.length * 3;
  const index = dense ? null : new Map(used.map((r, i) => [r, i]));
  const height = dense ? maxR + 1 : used.length;
  const out = Array.from({ length: height }, () => new Array(maxC + 1).fill(null));
  for (const [r, c, cell] of cells) {
    let v;
    if (cell.t === 'n' && cell.z && XLSX.SSF.is_date(cell.z)) {
      // a serial below 1 is a time of day with no date
      if (cell.v < 1) v = XLSX.SSF.format('hh:mm', cell.v);
      else { const d = serialToIso(cell.v); v = d ? { date: d } : cell.v; }
    } else if (cell.t === 'd') v = { date: cell.v.toISOString().slice(0, 10) };
    else v = cell.v;
    // CSV cells are read as text so dates are not guessed in US order; turn plain numbers back into numbers
    if (csv && typeof v === 'string' && /^-?(0|[1-9]\d*)(\.\d+)?$/.test(v.trim()) && v.trim().length < 16) v = Number(v);
    out[dense ? r : index.get(r)][c] = v;
  }
  return out;
}

const hasDash = () => state.model !== null;
function busy(on) { show($('busy'), on && !hasDash()); show($('dash-busy'), on && hasDash()); }
/** Show a problem without throwing away a dashboard that is already on screen. */
function fail(message) {
  busy(false);
  const target = hasDash() ? $('dash-error') : $('file-error');
  target.textContent = message;
  show(target);
  if (!hasDash()) { show($('landing')); show($('dash'), false); }
}
const MESSAGES = {
  big: 'That file is over 30 MB, which is too large to chart in a browser. Remove columns you do not need, or split it into smaller files.',
  rows: `That sheet has more than ${MAX_ROWS.toLocaleString('en-US')} rows, which is too many to chart in a browser. Filter it down in Excel first, for example to one year.`,
  unreadable: 'That file could not be read. Check it is an Excel or CSV file and is not password protected.',
  empty: 'That sheet has no table of data to chart. Check it has a row of column names with data below it.',
  internal: 'Something went wrong while building the dashboard for this file. The file was read, so the problem is on this site, not in your file.'
};
const nextFrame = () => new Promise(r => setTimeout(r, 30));

async function openFile(file) {
  show($('file-error'), false); show($('dash-error'), false);
  if (file.size > MAX_BYTES) return fail(MESSAGES.big);
  busy(true);
  await nextFrame(); // let the "Reading" message paint before the heavy work starts
  let workbook, csv;
  try {
    csv = /\.(csv|tsv|txt)$/i.test(file.name);
    if (!csv) {
      const sig = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      if (!(sig[0] === 0x50 && sig[1] === 0x4b) && !(sig[0] === 0xd0 && sig[1] === 0xcf)) throw new Error('unreadable');
    }
    workbook = csv ? XLSX.read(await file.text(), { type: 'string', raw: true }) : XLSX.read(await file.arrayBuffer(), { type: 'array', cellNF: true });
  } catch (e) { return fail(MESSAGES.unreadable); }

  // hidden sheets are left out; start on the sheet with the most data
  const info = (workbook.Workbook && workbook.Workbook.Sheets) || [];
  const visible = workbook.SheetNames.filter((n, i) => !(info[i] && info[i].Hidden));
  const matrices = {};
  let best = null, error = 'empty';
  for (const n of visible.length ? visible : workbook.SheetNames) {
    try {
      matrices[n] = sheetToMatrix(workbook.Sheets[n], csv);
      const size = matrices[n].length * (matrices[n][0] ? matrices[n][0].length : 0);
      if (!best || size > best.size) best = { name: n, size };
    } catch (e) { matrices[n] = null; if (e.message === 'rows') error = 'rows'; }
  }
  if (!best || !best.size) return fail(MESSAGES[error]);
  const previous = { workbook: state.workbook, matrices: state.matrices, csv: state.csv, fileName: state.fileName, options: [...$('sheet').options].map(o => o.value), sheet: $('sheet').value };
  Object.assign(state, { workbook, matrices, csv, fileName: file.name });
  const listed = Object.keys(matrices);
  $('sheet').replaceChildren(...listed.map(n => el('option', { value: n, textContent: n })));
  $('sheet').value = best.name;
  if (!loadSheet(null)) {
    // put the old file back so the dashboard on screen still matches its controls
    Object.assign(state, previous);
    $('sheet').replaceChildren(...previous.options.map(n => el('option', { value: n, textContent: n })));
    $('sheet').value = previous.sheet;
  } else show($('sheet-wrap'), listed.length > 1);
}

/** Build the dashboard from the selected sheet. headerRow is 1-based, or null to detect it. Returns true on success. */
function loadSheet(headerRow) {
  show($('dash-error'), false);
  const m = state.matrices[$('sheet').value];
  if (!m || !m.length) { fail(MESSAGES.empty); return false; }
  const found = detectHeaderRow(m);
  const row = headerRow ? Math.min(Math.max(1, headerRow), m.length) - 1 : found.row;
  const noHeader = !headerRow && !found.hasHeader;
  let width = 0;
  for (const r of m.slice(row, row + 50)) if (r.length > width) width = r.length;
  const headers = noHeader ? Array.from({ length: width }, () => '') : (m[row] || []).map(v => (v === null ? '' : isDateCell(v) ? v.date : String(v)));
  const ok = useTable(headers, m.slice(noHeader ? row : row + 1), noHeader ? row + 1 : row + 2);
  if (ok) {
    $('header-row').value = row + 1;
    if (noHeader) state.model.warnings.unshift(`Row ${row + 1} looks like data, not column names, so the columns were named "Column 1", "Column 2" and so on. If row ${row + 1} does hold the names, type ${row + 1} in "Headings on row".`);
    renderNotes();
  }
  return ok;
}

function useTable(headers, rows, firstDataRow = 2) {
  let result, model;
  try {
    if (rows.length > MAX_ROWS) { fail(MESSAGES.rows); return false; }
    result = clean(headers, rows, { hr: false, missing: false, ids: false, firstDataRow });
    model = buildModel(result);
  } catch (e) { console.error(e); fail(MESSAGES.internal); return false; }
  if (model.rows.length < 2 || !model.cols.length) { fail(MESSAGES.empty); return false; }
  const before = { model: state.model, choices: state.choices, toggles: state.toggles, tables: state.tables, summary: state.summary };
  Object.assign(state, { model, choices: defaultChoices(model), toggles: {}, tables: new Set(), types: {}, summary: result.summary });
  try {
    renderQuestions();
    render();
  } catch (e) {
    console.error(e);
    Object.assign(state, before);
    if (state.model) { renderQuestions(); render(); }
    fail(MESSAGES.internal);
    return false;
  }
  busy(false);
  $('file-name').textContent = state.fileName;
  $('file-meta').textContent = `${plural(model.rows.length, 'row')}, ${plural(model.cols.length, 'column')}`;
  show($('file-error'), false); show($('landing'), false); show($('dash'));
  window.scrollTo(0, 0);
  renderNotes();
  return true;
}

function renderNotes() {
  const s = state.summary;
  const notes = [[s.datesFixed, 'dates converted'], [s.numbersFixed, 'numbers converted'], [s.categoriesFixed, 'spellings merged'], [s.duplicateRows, 'duplicate rows removed'], [s.emptyRows, 'empty rows removed'], [s.placeholders, 'placeholders cleared']]
    .filter(([n]) => n).map(([n, t]) => `${n.toLocaleString('en-US')} ${n === 1 ? t.replace(/(\w)s( |$)/, '$1$2') : t}`);
  $('clean-note').textContent = notes.length ? `Cleaned before charting: ${notes.join(', ')}.` : 'Nothing needed cleaning.';
  const w = state.model.warnings;
  $('warnings').replaceChildren(...w.map(t => el('li', { textContent: t })));
  $('warnings-title').textContent = `${plural(w.length, 'thing')} to know about this file`;
  show($('warnings-wrap'), w.length > 0);
  $('warnings-wrap').open = w.length > 0 && w.length <= 3;
}

// ---------- questions ----------
/** Re-rendering rebuilds the controls, so put keyboard focus back on the one that was just used. */
function refocus(container, index) { const n = container.querySelectorAll('select, input')[index]; if (n) n.focus(); }

function ask(text, options, value, onChange) {
  const sel = el('select', {}, ...options.map(([v, t]) => el('option', { value: String(v), textContent: t })));
  sel.value = String(value);
  sel.addEventListener('change', () => {
    const index = [...$('questions').querySelectorAll('select')].indexOf(sel);
    onChange(sel.value); renderQuestions(); render(); refocus($('questions'), index);
  });
  return el('label', {}, text, sel);
}

function renderQuestions() {
  const { model: m, choices: c } = state;
  const qs = [];
  const name = col => [col.index, col.name];
  if (m.measures.length) {
    qs.push(ask('Which number matters most?', [...m.measures.map(name), [-1, 'None, just count the rows']], c.agg === 'count' ? -1 : c.measure, v => {
      c.measure = Number(v);
      c.agg = c.measure < 0 ? 'count' : defaultAgg(m.cols[c.measure]);
    }));
    if (c.agg !== 'count') qs.push(ask(`Should ${m.headers[c.measure]} be added up or averaged?`, [['sum', 'Added up (total)'], ['avg', 'Averaged']], c.agg, v => { c.agg = v; }));
  }
  if (m.dates.length) {
    qs.push(ask('Which date says when things happened?', [...m.dates.map(name), [-1, "None, don't show a trend"]], c.date, v => { c.date = Number(v); if (c.date < 0) c.split = -1; }));
    if (c.date >= 0) qs.push(ask('How should time be grouped?', [['auto', 'Pick for me'], ['day', 'By day'], ['week', 'By week'], ['month', 'By month'], ['quarter', 'By quarter'], ['year', 'By year']], c.grain, v => { c.grain = v; }));
  }
  if (m.dimensions.length) {
    qs.push(ask('What do you most want to compare by?', m.dimensions.map(name), c.dimension, v => { c.dimension = Number(v); }));
    if (c.date >= 0) qs.push(ask('Should the trend be split into groups?', [[-1, 'No, one line'], ...m.dimensions.map(name)], c.split, v => { c.split = Number(v); }));
  }
  if (!qs.length) qs.push(el('p', { className: 'muted small', textContent: 'This sheet has no number, date or repeated-value columns to ask about.' }));
  $('questions').replaceChildren(...qs);
}

// ---------- dashboard ----------
function render() {
  const { model: m, choices: c } = state;
  const rows = applyFilters(m.rows, c.filters);
  const measure = c.agg === 'count' ? -1 : c.measure;
  const label = measureLabel(m, c);
  // rates stored as fractions (0.425) are shown as percentages
  const pctCol = measure >= 0 && m.cols[measure].percent;
  const f = pctCol ? fmtPercent : fmt, ff = pctCol ? fmtPercent : fmtFull;

  // filters: the three columns with the fewest values
  const fcols = [...m.dimensions].sort((a, b) => a.distinct - b.distinct).slice(0, 3);
  const fnodes = fcols.map((col, fi) => {
    const values = [...new Set(m.rows.map(r => r[col.index]).filter(v => v !== null && v !== '').map(String))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const sel = el('select', { ariaLabel: `Filter by ${col.name}` }, el('option', { value: '', textContent: `All ${col.name}` }), ...values.map(v => el('option', { value: v, textContent: v })));
    sel.value = c.filters[col.index] || '';
    sel.addEventListener('change', () => { c.filters[col.index] = sel.value; render(); refocus($('filters'), fi); });
    return sel;
  });
  // filters set from a details panel on columns that have no dropdown show as removable chips
  for (const [i, v] of Object.entries(c.filters)) {
    if (!v || fcols.some(col => col.index === Number(i))) continue;
    fnodes.push(el('button', { className: 'chip', textContent: `${m.headers[i]}: ${v}  ✕`, title: 'Remove this filter', onclick: () => { delete c.filters[i]; render(); } }));
  }
  const anyFilter = Object.values(c.filters).some(Boolean);
  if (anyFilter) fnodes.push(el('button', { className: 'link', textContent: 'Clear filters', onclick: () => { c.filters = {}; render(); } }));
  $('filters').replaceChildren(...fnodes);
  const filterText = Object.entries(c.filters).filter(([, v]) => v).map(([i, v]) => `${m.headers[i]}: ${v}`).join(', ');

  const tileText = k => (k.kind === 'text' || k.kind === 'top' ? k.value : k.kind === 'count' ? k.value.toLocaleString('en-US') : k.value === null ? 'none' : k.col.percent ? fmtPercent(k.value) : fmt(k.value));
  $('kpis').replaceChildren(...kpis(m, c).map(k => el('div', { className: 'tile' }, el('span', { className: 'tile__label', textContent: k.label }),
    el('span', { className: 'tile__value' + (k.kind === 'text' ? ' tile__value--text' : k.kind === 'top' ? ' tile__value--top' : ''), textContent: tileText(k), title: k.kind === 'number' && k.value !== null && !k.col.percent ? fmtFull(k.value) : '' }),
    ...(k.kind === 'top' ? [el('span', { className: 'tile__sub', textContent: `${k.col && k.col.percent ? fmtPercent(k.amount) : fmt(k.amount)} ${c.agg === 'count' ? 'rows' : label.toLowerCase().split(' ')[0]}` })] : []))));

  const sugg = suggestions(m, c);
  const isOn = s => (s.id in state.toggles ? state.toggles[s.id] : s.on);
  $('suggestions').replaceChildren(...(sugg.length ? sugg.map((s, si) => {
    const box = el('input', { type: 'checkbox', checked: isOn(s) });
    box.addEventListener('change', () => { state.toggles[s.id] = box.checked; render(); refocus($('suggestions'), si); });
    return el('label', { className: 'suggestion' }, box, el('span', { className: 'suggestion__title', textContent: s.title }), el('span', { className: 'suggestion__why', textContent: s.reason }));
  }) : [el('p', { className: 'muted small', textContent: 'No charts fit this sheet. It needs a column of numbers, dates or repeated values.' })]));

  state.draw = [];
  if (!rows.length) {
    $('findings').replaceChildren(); show($('findings-panel'), false);
    $('charts').replaceChildren();
    $('empty').textContent = 'No rows match these filters. Clear a filter to see the charts again.';
    show($('empty'));
    return;
  }
  const facts = findings(m, c, f);
  const addons = { forecast: $('addon-forecast').checked, drill: $('addon-drill').checked };
  // one forecast for the main trend, shared by the chart and the sentence about it
  let main = null;
  if (addons.forecast && c.date >= 0) {
    const ts = timeSeries(rows, c.date, measure, c.agg, c.grain);
    const vals = ts.series[0] ? ts.series[0].values : [];
    const steps = Math.max(2, Math.min(6, Math.round(vals.length / 4)));
    const fc = rows.length >= 30 ? forecast(vals, steps, ts.partial) : null; // too little data makes a forecast meaningless
    if (fc) {
      main = { fc, labels: fc.values.map((_, k) => periodLabel(ts.last - (ts.partial ? 1 : 0) + 1 + k, ts.grain)), partial: ts.partial };
      const dir = Math.abs(fc.slope) < 1e-9 ? 'flat' : fc.slope > 0 ? 'rising' : 'falling';
      facts.splice(Math.min(facts.length, 1), 0, `Forecast: the trend is ${dir}. If it continues, ${label} for ${main.labels[0]} would be about ${f(fc.values[0])} (likely between ${f(fc.low[0])} and ${f(fc.high[0])}). This is a straight-line estimate and ignores seasons and one-off events.`);
    }
  }
  $('findings').replaceChildren(...facts.map(t => el('li', { textContent: t })));
  show($('findings-panel'), facts.length > 0);

  const cards = sugg.filter(isOn).map(s => {
    const plot = el('div', { className: 'plot' });
    const sub = [];
    let legend = null, tableData = null, wide = false, drawFn = null, types = null;
    let type = state.types[s.id];
    if (s.kind === 'trend') {
      wide = true;
      const ts = timeSeries(rows, s.date, measure, c.agg, c.grain, s.split);
      sub.push(`By ${ts.grain}`);
      if (ts.grain !== ts.asked) sub.push(`"By ${ts.asked}" would give too many points to read`);
      if (ts.series.length > 1) legend = el('div', { className: 'legend' }, ...ts.series.map((x, i) => { const sw = el('span', { className: 'swatch' }); sw.style.background = SERIES[i]; return el('span', {}, sw, x.name); }));
      tableData = { head: [m.headers[s.date], ...ts.series.map(x => x.name || label)], rows: ts.labels.map((l, i) => [l, ...ts.series.map(x => x.values[i])]), counts: false };
      // the forecast goes on the main one-line trend only
      const split = ts.series.length > 1;
      types = TREND_TYPES.filter(([k]) => !k.startsWith('stacked') || (split && c.agg !== 'avg'));
      if (!types.some(([k]) => k === type)) type = 'line';
      const useFc = type === 'line' && main && s.split < 0 && s.date === c.date && ts.grain === (c.grain === 'auto' ? ts.grain : c.grain) ? main : null;
      let labels = ts.labels;
      if (useFc) {
        labels = [...ts.labels.slice(0, useFc.fc.from), ...useFc.labels];
        sub.push(`Dashed line is an estimate for the next ${useFc.labels.length} ${ts.grain}s` + (useFc.partial ? `; ${ts.labels[ts.labels.length - 1]} is not finished yet, so it is estimated too` : ''));
        tableData.rows.push(...useFc.labels.map((l, k) => [`${l} (estimate)`, useFc.fc.values[k]]));
      } else if (addons.forecast && s.split < 0 && s.date === c.date) sub.push(type === 'line' ? 'No forecast: it needs at least 30 rows and 6 periods' : 'The forecast shows on the Line type only');
      if (ts.labels.length && type !== 'line') drawFn = () => eChart(plot, type, { labels: ts.labels, series: ts.series, label, f, ff });
      else if (ts.labels.length) drawFn = () => lineChart(plot, { labels, series: ts.series, label, title: s.title, f, ff, fc: useFc ? useFc.fc : null });
      else plot.append(el('p', { className: 'muted small', textContent: `No rows have a valid "${m.headers[s.date]}".` }));
    } else if (s.kind === 'bars') {
      const agg = s.count ? 'count' : c.agg, ms = s.count ? -1 : measure;
      const all = groupBy(rows, s.dim, ms, agg);
      // rows with nothing in this column are left out of the bars and mentioned instead
      const empty = all.find(g => g.key === BLANK);
      const groups = all.filter(g => g.key !== BLANK);
      const items = topN(groups, s.top || 12, agg, !s.top);
      const lab = s.count ? 'Number of rows' : label;
      const bf = s.count ? fmt : f, bff = s.count ? fmtFull : ff;
      const real = items.filter(i => !i.other).length;
      if (groups.length > real) sub.push(`Largest ${real} of ${groups.length.toLocaleString('en-US')}` + (items.some(i => i.other) ? ', the rest grouped as Other' : ''));
      if (empty) sub.push(`${plural(empty.count, 'row')} with no ${m.headers[s.dim]} left out`);
      const positive = all.every(g => g.value >= 0);
      const whole = agg === 'avg' || !positive ? 0 : all.reduce((a, g) => a + g.value, 0);
      const pieOk = whole > 0 && groups.length > 1; // these types only make sense for parts that add up to a whole
      types = CATEGORY_TYPES;
      if (!types.some(([k]) => k === type)) type = 'bar';
      const onPick = addons.drill && !s.count ? key => openDetail(s.dim, key) : null;
      const name = types.find(([k]) => k === type)[1];
      const eight = topN(groups, 8, agg, true);
      if (NEEDS_WHOLE.has(type) && groups.length > 8) sub.push('Largest 7 shown, the rest grouped as Other');
      if (onPick && type !== 'radar') sub.push(type === 'bar' ? 'Click a bar for details' : 'Click a part for details');
      tableData = { head: agg === 'count' ? [m.headers[s.dim], 'Rows'] : [m.headers[s.dim], lab, 'Rows'], rows: all.map(g => (agg === 'count' ? [g.key, g.count] : [g.key, g.value, g.count])), f: bff, counts: true };
      const why = NEEDS_WHOLE.has(type) && !pieOk ? (groups.length < 2 ? `${name} needs at least two groups.` : agg === 'avg' ? `${name} shows parts of a whole, and averages do not add up to one. Under "A few questions", switch to a total or a count, or use Bars or Columns.` : `${name} cannot show negative numbers. Use Bars or Columns.`)
        : type === 'radar' && groups.length < 3 ? 'Radar needs at least three groups.' : '';
      if (why && items.length) plot.append(el('p', { className: 'muted small', textContent: why }));
      else if (!items.length) plot.append(el('p', { className: 'muted small', textContent: 'No rows to show.' }));
      else if (type === 'bar') drawFn = () => barChart(plot, { items, label: lab, title: s.title, total: whole, f: bf, ff: bff, onPick, colours: true });
      else if (type === 'donut') drawFn = () => pieChart(plot, { items: eight, label: lab, title: s.title, f: bf, ff: bff, onPick });
      else drawFn = () => eChart(plot, type, { items: NEEDS_WHOLE.has(type) ? eight : type === 'radar' ? groups.slice(0, 8) : items, label: lab, f: bf, ff: bff, total: whole, onPick });
    } else if (s.kind === 'scatter') {
      const sc = scatterPoints(rows, s.x, s.y, c.dimension);
      const xn = m.headers[s.x], yn = m.headers[s.y];
      const fx = m.cols[s.x].percent ? fmtPercent : fmt, fy = m.cols[s.y].percent ? fmtPercent : fmt;
      sub.push(`${plural(sc.n, 'row')}, one dot each` + (sc.sampled ? ` (${sc.points.length.toLocaleString('en-US')} shown)` : ''));
      sub.push(linkText(sc.r, yn, xn));
      if (sc.groups.length) { sub.push(`Coloured by ${m.headers[c.dimension]}`); legend = el('div', { className: 'legend' }, ...sc.groups.map((g, i) => { const sw = el('span', { className: 'swatch' }); sw.style.background = g === 'Other' ? 'var(--muted-fill)' : SERIES[i]; return el('span', {}, sw, g); })); }
      tableData = { head: sc.groups.length ? [xn, yn, m.headers[c.dimension]] : [xn, yn], rows: sc.points.slice(0, 500).map(p => (sc.groups.length ? [p.x, p.y, p.g] : [p.x, p.y])), f: fmtFull, counts: false };
      if (sc.n >= 2) drawFn = () => eChart(plot, 'scatter', { points: sc.points, groups: sc.groups, xName: xn, yName: yn, f: fy, fx, ff: fmtFull });
      else plot.append(el('p', { className: 'muted small', textContent: 'Fewer than two rows have both numbers.' }));
    } else {
      const bins = histogram(rows, s.measure);
      const hp = m.cols[s.measure].percent;
      sub.push('Number of rows in each range' + (bins.some(b => b.over) ? '. The last bar holds the few largest values' : ''));
      tableData = bins.some(b => b.single) ? { head: [m.headers[s.measure], 'Rows'], rows: bins.map(b => [b.from, b.count]) } : { head: ['From', 'To', 'Rows'], rows: bins.map(b => [b.from, b.to, b.count]) };
      Object.assign(tableData, { f: hp ? fmtPercent : fmtFull, counts: true });
      if (bins.length) drawFn = () => columnChart(plot, { bins, label: m.headers[s.measure], title: s.title, f: hp ? fmtPercent : fmt, ff: hp ? fmtPercent : fmtFull });
      else plot.append(el('p', { className: 'muted small', textContent: 'No numbers to show.' }));
    }
    if (filterText) sub.push(`Filtered to ${filterText}`);
    const asTable = state.tables.has(s.id);
    const refocus = label => { const again = [...document.querySelectorAll('.card')].find(n => n.dataset.id === s.id); const b = again && [...again.querySelectorAll('button')].find(x => x.textContent === label); if (b) b.focus(); };
    let toggle;
    if (types) {
      // every chart can be switched to another type that fits its data, or to a table
      toggle = el('select', { className: 'typepick', ariaLabel: `Chart type for ${s.title}` }, ...types.map(([k, t]) => el('option', { value: k, textContent: t })), el('option', { value: 'table', textContent: 'Table' }));
      toggle.value = asTable ? 'table' : type;
      toggle.addEventListener('change', () => {
        if (toggle.value === 'table') state.tables.add(s.id); else { state.tables.delete(s.id); state.types[s.id] = toggle.value; }
        render();
        const again = [...document.querySelectorAll('.card')].find(n => n.dataset.id === s.id);
        if (again) again.querySelector('select').focus();
      });
    } else {
      toggle = el('button', { className: 'btn btn--ghost', textContent: asTable ? 'Show chart' : 'Show table' });
      toggle.addEventListener('click', () => { if (asTable) state.tables.delete(s.id); else state.tables.add(s.id); render(); refocus(asTable ? 'Show table' : 'Show chart'); });
    }
    if (drawFn && !asTable) state.draw.push(drawFn);
    const card = el('section', { className: 'card' + (wide ? ' card--wide' : '') },
      el('div', { className: 'card__head' }, el('div', {}, el('h2', { textContent: s.title }), el('div', { className: 'card__sub', textContent: sub.join(' · ') })), toggle),
      ...(legend && !asTable ? [legend] : []), asTable ? tableView(tableData, ff) : plot);
    card.dataset.id = s.id;
    return card;
  });
  $('charts').replaceChildren(...cards);
  $('empty').textContent = sugg.length ? 'No charts are selected. Tick one under "Suggested charts".' : 'This sheet has nothing to chart. It needs a column of numbers, dates or repeated values.';
  show($('empty'), cards.length === 0);
  requestAnimationFrame(drawAll);
}

function tableView({ head, rows, f, counts }, fallback) {
  const numeric = head.map((_, c) => rows.some(r => typeof r[c] === 'number'));
  const last = head.length - 1; // in grouped tables the last column is a row count
  const cell = (v, c) => (v === null ? '' : typeof v !== 'number' ? v : counts && c === last ? v.toLocaleString('en-US') : (f || fallback)(v));
  const shown = rows.slice(0, 1000);
  return el('div', { className: 'tablewrap', tabIndex: 0 }, el('table', {},
    el('thead', {}, el('tr', {}, ...head.map((h, c) => el('th', { textContent: h, className: numeric[c] ? 'num' : '', scope: 'col' })))),
    el('tbody', {}, ...shown.map(r => el('tr', {}, ...r.map((v, c) => el('td', { className: numeric[c] ? 'num' : '', textContent: cell(v, c) })))),
      ...(rows.length > shown.length ? [el('tr', {}, el('td', { colSpan: head.length, className: 'muted', textContent: `Showing the first 1,000 of ${rows.length.toLocaleString('en-US')} rows.` }))] : []))));
}

// ---------- details for one bar ----------
function openDetail(dim, key) {
  const { model: m, choices: c } = state;
  const p = profile(m, c, dim, key);
  const label = measureLabel(m, c);
  const mcol = c.agg === 'count' ? null : m.cols[c.measure];
  const f = mcol && mcol.percent ? fmtPercent : fmt;
  $('detail-kind').textContent = p.column;
  $('detail-title').textContent = key;
  const tile = (l, v) => el('div', { className: 'tile' }, el('span', { className: 'tile__label', textContent: l }), el('span', { className: 'tile__value', textContent: v }));
  const tiles = [tile('Rows', p.rows.toLocaleString('en-US'))];
  if (c.agg !== 'count' && p.value !== null) tiles.push(tile(label, f(p.value)));
  if (p.share !== null) tiles.push(tile('Share of total', fmtPercent(p.share)));
  if (p.rank) tiles.push(tile(c.agg === 'count' ? 'Rank by rows' : `Rank by ${label.toLowerCase().split(' ')[0]}`, `${p.rank} of ${p.of}`));
  $('detail-tiles').replaceChildren(...tiles);

  const body = [];
  const others = p.measures;
  if (others.length) body.push(el('div', { className: 'detail__section' }, el('h3', { textContent: 'Numbers' }), el('ul', { className: 'facts' }, ...others.flatMap(x => {
    const pf = x.percent ? fmtPercent : fmtFull, out = [];
    if (x.total !== null) out.push(el('li', {}, el('span', { textContent: `Total ${x.name}` }), el('span', { textContent: pf(x.total) })));
    if (x.average !== null) out.push(el('li', {}, el('span', { textContent: `Average ${x.name}` }), el('span', { textContent: pf(x.average) })));
    return out;
  }))));
  if (p.related.length) body.push(el('div', { className: 'detail__section detail__grid' }, ...p.related.slice(0, 6).map(r => {
    const max = Math.max(...r.top.map(t => Math.abs(t.value))) || 1;
    return el('div', {}, el('h3', { textContent: `${r.name}: ${plural(r.distinct, 'different value')}` }),
      el('ol', { className: 'rank' }, ...r.top.map(t => { const bar = el('i'); bar.style.width = `${Math.max(1, (Math.abs(t.value) / max) * 100)}%`; return el('li', {}, el('span', { textContent: t.key, title: t.key }), el('span', { textContent: c.agg === 'count' ? t.count.toLocaleString('en-US') : f(t.value) }), bar); })),
      ...(r.distinct > r.top.length ? [el('p', { className: 'muted small', textContent: `Top ${r.top.length} by ${label.toLowerCase()}` })] : []));
  })));
  const plot = el('div', { className: 'plot' });
  const trend = p.trend && p.trend.labels.length >= 2;
  if (trend) body.push(el('div', { className: 'detail__section' }, el('h3', { textContent: `${label} over time, by ${p.trend.grain}` }), plot));
  $('detail-body').replaceChildren(...body);
  $('detail-focus').textContent = `Show only ${key} on the dashboard`;
  $('detail-focus').onclick = () => { c.filters[dim] = key; $('detail').close(); render(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  $('detail').showModal();
  if (trend) lineChart(plot, { labels: p.trend.labels, series: p.trend.series, label, title: `${label} over time for ${key}`, f, ff: mcol && mcol.percent ? fmtPercent : fmtFull, height: 200 });
}

// One chart failing must not stop the others from drawing.
function drawAll() { for (const d of state.draw) { try { d(); } catch (e) { console.error(e); } } }

// ---------- wiring ----------
const drop = $('drop');
drop.addEventListener('click', () => $('file').click());
drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
$('file').addEventListener('change', e => { if (e.target.files[0]) openFile(e.target.files[0]); e.target.value = ''; });
for (const t of ['dragenter', 'dragover']) drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('is-over'); });
for (const t of ['dragleave', 'drop']) drop.addEventListener(t, () => drop.classList.remove('is-over'));
// a file dropped anywhere on the page is opened here instead of replacing the page
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) openFile(f); });
$('btn-sample').addEventListener('click', () => {
  const s = makeSample(900);
  Object.assign(state, { workbook: null, matrices: { Sample: [s.headers, ...s.rows] }, csv: false, fileName: 'sample_sales.xlsx' });
  $('sheet').replaceChildren(el('option', { value: 'Sample', textContent: 'Sample' }));
  show($('sheet-wrap'), false);
  loadSheet(null);
});
let lastSheet = '';
$('sheet').addEventListener('focus', () => { lastSheet = $('sheet').value; });
$('sheet').addEventListener('change', () => { if (loadSheet(null)) lastSheet = $('sheet').value; else $('sheet').value = lastSheet; });
$('header-row').addEventListener('change', () => { const n = parseInt($('header-row').value, 10); if (n >= 1) loadSheet(n); });
$('btn-new').addEventListener('click', () => $('file').click());
$('btn-choose').addEventListener('click', () => $('file').click());
startHero($('hero-canvas'), 'bars');
$('btn-print').addEventListener('click', () => window.print());

// ---------- pick columns ----------
const pick = { on: new Set() };
function pickResult() {
  const { model: m, choices: c } = state;
  const useFilter = !$('pick-filter-wrap').hidden && $('pick-filter').checked;
  const rows = useFilter ? applyFilters(m.rows, c.filters) : m.rows;
  const cols = m.headers.map((_, i) => i).filter(i => pick.on.has(i));
  return extract(m.headers, rows, { cols, sortBy: Number($('pick-sort').value), desc: $('pick-dir').value === 'desc', dedupe: $('pick-dedupe').checked });
}
function drawPick() {
  const x = pickResult();
  const none = x.headers.length === 0;
  $('pick-csv').disabled = $('pick-xlsx').disabled = none || x.rows.length === 0;
  $('pick-count').textContent = none ? 'Tick at least one column.' : `${plural(x.rows.length, 'row')}, ${plural(x.headers.length, 'column')}` + (x.removed ? `. ${plural(x.removed, 'repeated row')} removed` : '') + (x.rows.length > 8 ? '. Showing the first 8' : '');
  if (none) { $('pick-preview').replaceChildren(); return; }
  $('pick-preview').replaceChildren(el('table', {},
    el('thead', {}, el('tr', {}, ...x.headers.map(h => el('th', { scope: 'col', textContent: h, title: h })))),
    el('tbody', {}, ...x.rows.slice(0, 8).map(r => el('tr', {}, ...r.map(v => el('td', { textContent: cellText(v), title: cellText(v) })))))));
}
function drawPickCols() {
  const m = state.model, q = $('pick-search').value.trim().toLowerCase();
  const shown = m.headers.map((h, i) => [h || `Column ${i + 1}`, i]).filter(([h]) => !q || h.toLowerCase().includes(q));
  $('pick-cols').replaceChildren(...(shown.length ? shown.map(([h, i]) => {
    const box = el('input', { type: 'checkbox', checked: pick.on.has(i) });
    box.addEventListener('change', () => { if (box.checked) pick.on.add(i); else pick.on.delete(i); drawPick(); });
    return el('label', { title: h }, box, el('span', { textContent: h }));
  }) : [el('p', { className: 'muted small', textContent: 'No column has that name.' })]));
}
function openPick() {
  const { model: m, choices: c } = state;
  pick.on = new Set();
  $('pick-search').value = '';
  $('pick-sort').replaceChildren(el('option', { value: -1, textContent: 'Keep the sheet order' }), ...m.headers.map((h, i) => el('option', { value: i, textContent: h || `Column ${i + 1}` })));
  $('pick-dedupe').checked = false;
  const filterText = Object.entries(c.filters).filter(([, v]) => v).map(([i, v]) => `${m.headers[i]}: ${v}`).join(', ');
  show($('pick-filter-wrap'), Boolean(filterText));
  $('pick-filter').checked = true;
  $('pick-filter-text').textContent = `Only rows matching the dashboard filter (${filterText})`;
  drawPickCols(); drawPick();
  $('pick').showModal();
}
function pickName(ext) { return `${(state.fileName || 'data').replace(/\.[^.]+$/, '')}-picked.${ext}`; }
function saveBlob(blob, name) { const a = el('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
$('btn-pick').addEventListener('click', openPick);
$('pick-close').addEventListener('click', () => $('pick').close());
$('pick').addEventListener('click', e => { if (e.target === $('pick')) $('pick').close(); });
$('pick-search').addEventListener('input', drawPickCols);
$('pick-all').addEventListener('click', () => { for (const b of $('pick-cols').querySelectorAll('input')) if (!b.checked) b.click(); });
$('pick-none').addEventListener('click', () => { pick.on = new Set(); drawPickCols(); drawPick(); });
for (const id of ['pick-sort', 'pick-dir', 'pick-dedupe', 'pick-filter']) $(id).addEventListener('change', drawPick);
$('pick-csv').addEventListener('click', () => { const x = pickResult(); saveBlob(new Blob(['\ufeff' + toCsv(x.headers, x.rows)], { type: 'text/csv;charset=utf-8' }), pickName('csv')); });
$('pick-xlsx').addEventListener('click', () => {
  const x = pickResult();
  const cells = toSheetCells(x.headers, x.rows);
  const ws = {};
  cells.forEach((r, ri) => r.forEach((cell, ci) => { if (cell) ws[XLSX.utils.encode_cell({ r: ri, c: ci })] = cell; }));
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: cells.length - 1, c: x.headers.length - 1 } });
  ws['!cols'] = x.headers.map((h, ci) => ({ wch: Math.min(40, Math.max(h.length, ...x.rows.slice(0, 200).map(r => cellText(r[ci]).length)) + 2) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Picked');
  XLSX.writeFile(wb, pickName('xlsx'));
});
$('detail-close').addEventListener('click', () => $('detail').close());
$('detail').addEventListener('click', e => { if (e.target === $('detail')) $('detail').close(); });
for (const id of ['addon-forecast', 'addon-drill']) $(id).addEventListener('change', () => { if (state.model) render(); });
let timer;
window.addEventListener('resize', () => { clearTimeout(timer); timer = setTimeout(() => { if (!$('dash').hidden) drawAll(); }, 150); });
