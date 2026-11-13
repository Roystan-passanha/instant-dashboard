import test from 'node:test';
import assert from 'node:assert/strict';
import { clean } from '../js/cleaner.js';
import { makeSample } from '../js/sample.js';
import { buildModel, defaultChoices, groupBy, topN, timeSeries, histogram, suggestions, findings, kpis, total, applyFilters, pickGrain } from '../js/analyze.js';

const sample = () => { const s = makeSample(900); return buildModel(clean(s.headers, s.rows, { hr: false })); };

test('buildModel assigns roles', () => {
  const m = sample();
  const role = Object.fromEntries(m.cols.map(c => [c.name, c.role]));
  assert.deepEqual(role, { 'Order ID': 'other', 'Order Date': 'date', Region: 'dimension', Product: 'dimension', Channel: 'dimension',
    'Sales Rep': 'dimension', Customer: 'entity', Units: 'measure', 'Unit Price': 'measure', Revenue: 'measure' });
  assert.equal(m.rows.length, 900);
});

test('defaultChoices picks a headline measure, date and breakdown', () => {
  const m = sample(), c = defaultChoices(m);
  assert.equal(m.headers[c.measure], 'Revenue');
  assert.equal(c.agg, 'sum');
  assert.equal(m.headers[c.date], 'Order Date');
  assert.ok(c.dimension >= 0);
});

test('groupBy totals match the grand total and spellings are merged', () => {
  const m = sample(), rev = m.headers.indexOf('Revenue'), reg = m.headers.indexOf('Region');
  const g = groupBy(m.rows, reg, rev, 'sum');
  assert.deepEqual(g.map(x => x.key).sort(), ['Abu Dhabi', 'Ajman', 'Dubai', 'Sharjah']);
  assert.equal(g.reduce((a, x) => a + x.value, 0), total(m.rows, rev, 'sum'));
  assert.ok(g[0].value >= g[1].value);
  assert.equal(groupBy(m.rows, reg, -1, 'count').reduce((a, x) => a + x.value, 0), 900);
});

test('topN folds the tail into Other without losing value', () => {
  const m = sample(), rev = m.headers.indexOf('Revenue'), cust = m.headers.indexOf('Customer');
  const g = groupBy(m.rows, cust, rev, 'sum'), t = topN(g, 10, 'sum');
  assert.equal(t.length, 10);
  assert.ok(t[9].other);
  assert.equal(Math.round(t.reduce((a, x) => a + x.value, 0)), Math.round(total(m.rows, rev, 'sum')));
  assert.equal(topN(g, 10, 'avg').length, 10);
});

test('timeSeries buckets by month, fills gaps and keeps totals', () => {
  const m = sample(), rev = m.headers.indexOf('Revenue'), d = m.headers.indexOf('Order Date');
  const ts = timeSeries(m.rows, d, rev, 'sum');
  assert.equal(ts.grain, 'month');
  assert.equal(ts.labels.length, 12);
  assert.equal(ts.labels[0], 'Jan 2025');
  assert.equal(ts.series[0].values.reduce((a, b) => a + b, 0), total(m.rows, rev, 'sum'));
  const split = timeSeries(m.rows, d, rev, 'sum', 'quarter', m.headers.indexOf('Region'));
  assert.deepEqual(split.labels, ['Q1 2025', 'Q2 2025', 'Q3 2025', 'Q4 2025']);
  assert.equal(split.series.length, 4);
  assert.ok(!split.series.some(x => x.name === 'Other')); // four regions fit without folding
  const byRep = timeSeries(m.rows, d, rev, 'sum', 'quarter', m.headers.indexOf('Sales Rep'));
  assert.equal(byRep.series.length, 4);
  assert.equal(byRep.series[3].name, 'Other');
  assert.equal(byRep.series.flatMap(s => s.values).reduce((a, b) => a + b, 0), total(m.rows, rev, 'sum'));
  assert.equal(split.series.flatMap(s => s.values).reduce((a, b) => a + b, 0), total(m.rows, rev, 'sum'));
});

test('timeSeries fills empty periods', () => {
  const rows = [[{ date: '2025-01-10' }, 5], [{ date: '2025-04-02' }, 7]];
  const ts = timeSeries(rows, 0, 1, 'sum', 'month');
  assert.deepEqual(ts.labels, ['Jan 2025', 'Feb 2025', 'Mar 2025', 'Apr 2025']);
  assert.deepEqual(ts.series[0].values, [5, 0, 0, 7]);
  assert.deepEqual(timeSeries(rows, 0, 1, 'avg', 'month').series[0].values, [5, null, null, 7]);
  assert.equal(pickGrain(rows, 0), 'week');
});

test('histogram bins cover every value', () => {
  const m = sample(), u = m.headers.indexOf('Units');
  const bins = histogram(m.rows, u);
  assert.equal(bins.reduce((a, b) => a + b.count, 0), m.rows.filter(r => typeof r[u] === 'number').length);
  assert.ok(bins.length >= 3 && bins.length <= 25);
});

test('filters, kpis, suggestions and findings', () => {
  const m = sample(), c = defaultChoices(m);
  c.measure = m.headers.indexOf('Revenue');
  const reg = m.headers.indexOf('Region');
  assert.ok(suggestions(m, c).filter(s => s.on).length >= 3);
  assert.ok(suggestions(m, c).some(s => s.kind === 'trend'));
  const f = findings(m, c);
  assert.ok(f.length >= 3, f.join('\n'));
  assert.ok(f.some(x => /unusually high/.test(x)));
  c.filters = { [reg]: 'Dubai' };
  assert.ok(applyFilters(m.rows, c.filters).every(r => r[reg] === 'Dubai'));
  assert.ok(kpis(m, c)[0].value < 900);
});

test('works with no numbers and no dates', () => {
  const headers = ['Name', 'Team', 'City'];
  const rows = Array.from({ length: 30 }, (_, i) => [`Person ${i}`, ['A', 'B', 'C'][i % 3], ['Dubai', 'Sharjah'][i % 2]]);
  const m = buildModel(clean(headers, rows, { hr: false })), c = defaultChoices(m);
  assert.equal(c.measure, -1);
  assert.equal(c.agg, 'count');
  assert.equal(c.date, -1);
  assert.ok(suggestions(m, c).some(s => s.on));
  assert.equal(kpis(m, c)[0].value, 30);
});
