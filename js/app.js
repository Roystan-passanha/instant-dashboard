import { clean, isDateCell } from './cleaner.js';
import { buildModel, defaultChoices, applyFilters, groupBy, topN, timeSeries, histogram, suggestions, findings, kpis, measureLabel } from './analyze.js';
import { lineChart, barChart, columnChart, fmt, fmtFull, SERIES } from './charts.js';
import { makeSample } from './sample.js';

const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); for (const k of kids) n.append(k); return n; };
const show = (node, on = true) => { node.hidden = !on; };

const state = { workbook: null, csv: false, fileName: '', model: null, choices: null, toggles: {}, tables: new Set(), draw: [] };

// ---------- reading files ----------
const serialToIso = n => { const d = XLSX.SSF.parse_date_code(n); return d ? `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}` : null; };

function sheetToMatrix(ws, csv) {
  if (!ws['!ref']) return [];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const out = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      let v = null;
      if (cell && cell.t !== 'z' && cell.t !== 'e') {
        if (cell.t === 'n' && cell.z && XLSX.SSF.is_date(cell.z)) { const d = serialToIso(cell.v); v = d ? { date: d } : cell.v; }
        else if (cell.t === 'd') v = { date: cell.v.toISOString().slice(0, 10) };
        else v = cell.v;
        // CSV cells are read as text so dates are not guessed in US order; turn plain numbers back into numbers
        if (csv && typeof v === 'string' && /^-?(0|[1-9]\d*)(\.\d+)?$/.test(v.trim()) && v.trim().length < 16) v = Number(v);
      }
      row.push(v);
    }
    out.push(row);
  }
  return out;
}

async function openFile(file) {
  show($('file-error'), false);
  try {
    if (file.size > 30 * 1024 * 1024) throw new Error('big');
    const csv = /\.csv$/i.test(file.name);
    if (!csv) {
      const sig = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      if (!(sig[0] === 0x50 && sig[1] === 0x4b) && !(sig[0] === 0xd0 && sig[1] === 0xcf)) throw new Error('not a workbook');
    }
    state.csv = csv;
    state.workbook = csv ? XLSX.read(await file.text(), { type: 'string', raw: true }) : XLSX.read(await file.arrayBuffer(), { type: 'array', cellNF: true });
    state.fileName = file.name;
    const names = state.workbook.SheetNames;
    $('sheet').replaceChildren(...names.map(n => el('option', { value: n, textContent: n })));
    // start on the sheet with the most data
    const size = n => { const ref = state.workbook.Sheets[n]['!ref']; if (!ref) return 0; const r = XLSX.utils.decode_range(ref); return (r.e.r - r.s.r + 1) * (r.e.c - r.s.c + 1); };
    $('sheet').value = names.reduce((a, b) => (size(b) > size(a) ? b : a));
    show($('sheet-wrap'), names.length > 1);
    loadSheet();
  } catch (e) {
    fail(e.message === 'big' ? 'That file is over 30 MB, which is too large to chart in a browser.' : 'That file could not be read. Check it is an Excel or CSV file and is not password protected.');
  }
}

function fail(message) { $('file-error').textContent = message; show($('file-error')); show($('landing')); show($('dash'), false); }

function loadSheet() {
  const m = sheetToMatrix(state.workbook.Sheets[$('sheet').value], state.csv);
  const filled = r => r.filter(v => v !== null && v !== '').length;
  const hr = Math.max(0, m.findIndex(r => filled(r) >= 2));
  const headers = (m[hr] || []).map(v => (v === null ? '' : isDateCell(v) ? v.date : String(v)));
  useTable(headers, m.slice(hr + 1), hr + 2);
}

function useTable(headers, rows, firstDataRow = 2) {
  const result = clean(headers, rows, { hr: false, missing: false, ids: false, firstDataRow });
  const model = buildModel(result);
  if (model.rows.length < 2 || !model.cols.length) return fail('That sheet has no table of data to chart. Check the first row holds the column names.');
  state.model = model;
  state.choices = defaultChoices(model);
  state.toggles = {};
  state.tables = new Set();
  const s = result.summary;
  const notes = [[s.datesFixed, 'dates converted'], [s.numbersFixed, 'numbers converted'], [s.categoriesFixed, 'spellings merged'], [s.duplicateRows, 'duplicate rows removed'], [s.emptyRows, 'empty rows removed'], [s.placeholders, 'placeholders cleared']]
    .filter(([n]) => n).map(([n, t]) => `${n.toLocaleString('en-US')} ${n === 1 ? t.replace(/(\w)s( |$)/, '$1$2') : t}`);
  $('clean-note').textContent = notes.length ? `Cleaned before charting: ${notes.join(', ')}.` : 'The file was already clean.';
  $('file-name').textContent = state.fileName;
  $('file-meta').textContent = `${model.rows.length.toLocaleString('en-US')} rows, ${model.cols.length} columns`;
  show($('file-error'), false); show($('landing'), false); show($('dash'));
  renderQuestions();
  render();
}

// ---------- questions ----------
function ask(text, options, value, onChange) {
  const sel = el('select', {}, ...options.map(([v, t]) => el('option', { value: String(v), textContent: t })));
  sel.value = String(value);
  sel.addEventListener('change', () => { onChange(sel.value); renderQuestions(); render(); });
  return el('label', {}, text, sel);
}

function renderQuestions() {
  const { model: m, choices: c } = state;
  const qs = [];
  const name = col => [col.index, col.name];
  if (m.measures.length) {
    qs.push(ask('Which number matters most?', [...m.measures.map(name), [-1, 'None, just count the rows']], c.agg === 'count' ? -1 : c.measure, v => {
      c.measure = Number(v);
      c.agg = c.measure < 0 ? 'count' : defaultChoices({ ...m, measures: [m.cols[c.measure]] }).agg;
    }));
    if (c.agg !== 'count') qs.push(ask(`Should ${m.headers[c.measure]} be added up or averaged?`, [['sum', 'Added up (total)'], ['avg', 'Averaged']], c.agg, v => { c.agg = v; }));
  }
  if (m.dates.length) {
    qs.push(ask('Which date says when things happened?', [...m.dates.map(name), [-1, "None, don't show a trend"]], c.date, v => { c.date = Number(v); }));
    if (c.date >= 0) qs.push(ask('How should time be grouped?', [['auto', 'Pick for me'], ['day', 'By day'], ['week', 'By week'], ['month', 'By month'], ['quarter', 'By quarter'], ['year', 'By year']], c.grain, v => { c.grain = v; }));
  }
  if (m.dimensions.length) {
    qs.push(ask('What do you most want to compare by?', m.dimensions.map(name), c.dimension, v => { c.dimension = Number(v); }));
    if (c.date >= 0) qs.push(ask('Should the trend be split into groups?', [[-1, 'No, one line'], ...m.dimensions.map(name)], c.split, v => { c.split = Number(v); }));
  }
  if (!qs.length) qs.push(el('p', { className: 'muted small', textContent: 'This file has no number, date or repeated-value columns to ask about.' }));
  $('questions').replaceChildren(...qs);
}

// ---------- dashboard ----------
function render() {
  const { model: m, choices: c } = state;
  const rows = applyFilters(m.rows, c.filters);
  const measure = c.agg === 'count' ? -1 : c.measure;
  const label = measureLabel(m, c);

  // filters: the three columns with the fewest values
  const fcols = [...m.dimensions].sort((a, b) => a.distinct - b.distinct).slice(0, 3);
  const fnodes = fcols.map(col => {
    const values = [...new Set(m.rows.map(r => r[col.index]).filter(v => v !== null && v !== '').map(String))].sort();
    const sel = el('select', { ariaLabel: `Filter by ${col.name}` }, el('option', { value: '', textContent: `All ${col.name}` }), ...values.map(v => el('option', { value: v, textContent: v })));
    sel.value = c.filters[col.index] || '';
    sel.addEventListener('change', () => { c.filters[col.index] = sel.value; render(); });
    return sel;
  });
  const anyFilter = Object.values(c.filters).some(Boolean);
  if (anyFilter) fnodes.push(el('button', { className: 'link', textContent: 'Clear filters', onclick: () => { c.filters = {}; render(); } }));
  $('filters').replaceChildren(...fnodes);
  const filterText = Object.entries(c.filters).filter(([, v]) => v).map(([i, v]) => `${m.headers[i]}: ${v}`).join(', ');

  $('kpis').replaceChildren(...kpis(m, c).map(k => el('div', { className: 'tile' }, el('span', { className: 'tile__label', textContent: k.label }),
    el('span', { className: 'tile__value' + (k.kind === 'text' ? ' tile__value--text' : ''), textContent: k.kind === 'text' ? k.value : k.kind === 'count' ? k.value.toLocaleString('en-US') : fmt(k.value), title: k.kind === 'number' ? fmtFull(k.value) : '' }))));

  const f = findings(m, c, fmt);
  $('findings').replaceChildren(...f.map(t => el('li', { textContent: t })));
  show($('findings-panel'), f.length > 0);

  const sugg = suggestions(m, c);
  const isOn = s => (s.id in state.toggles ? state.toggles[s.id] : s.on);
  $('suggestions').replaceChildren(...sugg.map(s => {
    const box = el('input', { type: 'checkbox', checked: isOn(s) });
    box.addEventListener('change', () => { state.toggles[s.id] = box.checked; render(); });
    return el('label', { className: 'suggestion' }, box, el('span', { className: 'suggestion__title', textContent: s.title }), el('span', { className: 'suggestion__why', textContent: s.reason }));
  }));

  state.draw = [];
  const cards = sugg.filter(isOn).map(s => {
    const plot = el('div', { className: 'plot' });
    const sub = [];
    let legend = null, tableData = null, wide = false, drawFn = null;
    if (s.kind === 'trend') {
      wide = true;
      const ts = timeSeries(rows, s.date, measure, c.agg, c.grain, s.split);
      sub.push(`By ${ts.grain}`);
      if (ts.series.length > 1) legend = el('div', { className: 'legend' }, ...ts.series.map((x, i) => { const sw = el('span', { className: 'swatch' }); sw.style.background = SERIES[i]; return el('span', {}, sw, x.name); }));
      tableData = { head: [m.headers[s.date], ...ts.series.map(x => x.name || label)], rows: ts.labels.map((l, i) => [l, ...ts.series.map(x => x.values[i])]) };
      if (ts.labels.length) drawFn = () => lineChart(plot, { labels: ts.labels, series: ts.series, label });
      else plot.append(el('p', { className: 'muted small', textContent: 'No rows with a valid date.' }));
    } else if (s.kind === 'bars') {
      const agg = s.count ? 'count' : c.agg, ms = s.count ? -1 : measure;
      const groups = groupBy(rows, s.dim, ms, agg);
      const items = topN(groups, s.top || 12, agg, !s.top);
      const lab = s.count ? 'Number of rows' : label;
      if (groups.length > items.length || items.some(i => i.other)) sub.push(`Largest ${items.filter(i => !i.other).length} of ${groups.length}` + (items.some(i => i.other) ? ', the rest grouped as Other' : ''));
      tableData = { head: [m.headers[s.dim], lab, 'Rows'], rows: groups.map(g => [g.key, g.value, g.count]) };
      if (items.length) drawFn = () => barChart(plot, { items, label: lab, total: agg === 'avg' ? 0 : groups.reduce((a, g) => a + Math.max(0, g.value), 0) });
      else plot.append(el('p', { className: 'muted small', textContent: 'No rows to show.' }));
    } else {
      const bins = histogram(rows, s.measure);
      sub.push('Number of rows in each range' + (bins.some(b => b.over) ? '. The last bar holds the few largest values' : ''));
      tableData = { head: ['From', 'To', 'Rows'], rows: bins.map(b => [b.from, b.to, b.count]) };
      if (bins.length) drawFn = () => columnChart(plot, { bins, label: m.headers[s.measure] });
      else plot.append(el('p', { className: 'muted small', textContent: 'No numbers to show.' }));
    }
    if (filterText) sub.push(`Filtered to ${filterText}`);
    const asTable = state.tables.has(s.id);
    const toggle = el('button', { className: 'btn btn--ghost', textContent: asTable ? 'Show chart' : 'Show table' });
    toggle.addEventListener('click', () => { asTable ? state.tables.delete(s.id) : state.tables.add(s.id); render(); });
    const body = asTable ? tableView(tableData) : plot;
    if (drawFn && !asTable) state.draw.push(drawFn);
    return el('section', { className: 'card' + (wide ? ' card--wide' : '') },
      el('div', { className: 'card__head' }, el('div', {}, el('h2', { textContent: s.title }), el('div', { className: 'card__sub', textContent: sub.join(' · ') })), toggle),
      ...(legend && !asTable ? [legend] : []), body);
  });
  $('charts').replaceChildren(...cards);
  show($('empty'), cards.length === 0);
  requestAnimationFrame(drawAll);
}

function tableView({ head, rows }) {
  const numeric = head.map((_, c) => rows.some(r => typeof r[c] === 'number'));
  return el('div', { className: 'tablewrap' }, el('table', {},
    el('thead', {}, el('tr', {}, ...head.map((h, c) => el('th', { textContent: h, className: numeric[c] ? 'num' : '' })))),
    el('tbody', {}, ...rows.map(r => el('tr', {}, ...r.map((v, c) => el('td', { className: numeric[c] ? 'num' : '', textContent: v === null ? '' : typeof v === 'number' ? fmtFull(v) : v })))))));
}

const drawAll = () => { for (const d of state.draw) d(); };

// ---------- wiring ----------
const drop = $('drop');
drop.addEventListener('click', () => $('file').click());
drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
$('file').addEventListener('change', e => { if (e.target.files[0]) openFile(e.target.files[0]); e.target.value = ''; });
for (const t of ['dragenter', 'dragover']) drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('is-over'); });
for (const t of ['dragleave', 'drop']) drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('is-over'); });
drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) openFile(f); });
$('btn-sample').addEventListener('click', () => { const s = makeSample(900); state.workbook = null; state.fileName = 'sample_sales.xlsx'; show($('sheet-wrap'), false); useTable(s.headers, s.rows); });
$('sheet').addEventListener('change', () => { if (state.workbook) loadSheet(); });
$('btn-new').addEventListener('click', () => { show($('dash'), false); show($('landing')); window.scrollTo(0, 0); });
$('btn-print').addEventListener('click', () => window.print());
let timer;
window.addEventListener('resize', () => { clearTimeout(timer); timer = setTimeout(() => { if (!$('dash').hidden) drawAll(); }, 150); });
