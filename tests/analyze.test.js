import test from 'node:test';
import assert from 'node:assert/strict';
import { clean } from '../js/cleaner.js';
import { makeSample } from '../js/sample.js';
import { buildModel, defaultChoices, groupBy, topN, timeSeries, histogram, suggestions, findings, kpis, total, applyFilters, pickGrain, forecast, profile } from '../js/analyze.js';

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

const D = iso => ({ date: iso });

test('weeks are labelled by their Monday, with the year', () => {
  const rows = [[D('2024-01-01'), 1], [D('2024-01-03'), 2], [D('2024-01-08'), 4], [D('2024-01-14'), 8]]; // Mon, Wed, Mon, Sun
  const ts = timeSeries(rows, 0, 1, 'sum', 'week');
  assert.deepEqual(ts.labels, ['1 Jan 2024', '8 Jan 2024']);
  assert.deepEqual(ts.series[0].values, [3, 12]);
  assert.equal(timeSeries(rows, 0, 1, 'sum', 'day').labels[0], '1 Jan 2024');
});

test('a grouping that would give too many points is coarsened', () => {
  const rows = [[D('1950-01-01'), 1], [D('2050-12-31'), 1]];
  const ts = timeSeries(rows, 0, 1, 'sum', 'day');
  assert.ok(ts.labels.length <= 500);
  assert.equal(ts.asked, 'day');
  assert.notEqual(ts.grain, 'day');
  assert.equal(ts.series[0].values.reduce((a, b) => a + b, 0), 2);
});

test('histogram survives extreme numbers and gives whole-number bins for small ranges', () => {
  const big = [[1e308], [-1e308], [5], [7]];
  assert.ok(histogram(big, 0).length >= 1);
  assert.ok(histogram([[5e-324], [0], [1e-320]], 0).length >= 1);
  const ratings = Array.from({ length: 40 }, (_, i) => [1 + (i % 5)]);
  const bins = histogram(ratings, 0);
  assert.deepEqual(bins.map(b => b.from), [1, 2, 3, 4, 5]);
  assert.ok(bins.every(b => b.single && b.count === 8));
});

test('rates are averaged and never totalled; lat/long are not measures', () => {
  const rows = Array.from({ length: 30 }, (_, i) => [`c${i}`, ['Email', 'SMS'][i % 2], `${30 + i}%`, 100 + i, 25.2 + i / 100, 500 + i]);
  const m = buildModel(clean(['Campaign Name', 'Channel', 'Open Rate', 'Sent', 'Latitude', 'Spend'], rows, { hr: false }));
  assert.deepEqual(m.measures.map(c => c.name), ['Open Rate', 'Sent', 'Spend']);
  const c = defaultChoices(m);
  assert.equal(m.headers[c.measure], 'Spend');
  c.measure = m.headers.indexOf('Open Rate'); c.agg = 'sum';
  assert.deepEqual(kpis(m, c).filter(k => k.kind === 'number').map(k => k.label), ['Average Open Rate']);
});

test('blank groups and mixed signs do not produce false shares', () => {
  const headers = ['Ref Code', 'Reason', 'Pallets'];
  const rows = Array.from({ length: 90 }, (_, i) => [`R${i}`, i % 3 === 0 ? 'Traffic' : null, 10]);
  rows.push(...Array.from({ length: 10 }, (_, i) => [`S${i}`, 'Weather', 10]));
  const m = buildModel(clean(headers, rows, { hr: false }));
  const c = defaultChoices(m); c.dimension = m.headers.indexOf('Reason');
  const f = findings(m, c);
  assert.ok(f.some(x => /Traffic has the largest share.*30% of the total/.test(x)), f.join('\n')); // 300 of 1,000, not 300 of 400
  const mixed = buildModel(clean(['Txn Code', 'Centre', 'Amount'], Array.from({ length: 40 }, (_, i) => [`T${i}`, ['Sales', 'Ops', 'HR', 'IT'][i % 4], i % 4 === 0 ? 500 : -100]), { hr: false }));
  const fm = findings(mixed, defaultChoices(mixed));
  assert.ok(!fm.some(x => /% of the total|make up/.test(x)), fm.join('\n'));
});

test('small files do not get trend claims', () => {
  const rows = Array.from({ length: 12 }, (_, i) => [`c${i}`, D(`2026-${String(i + 1).padStart(2, '0')}-05`), 100 + i * 10]);
  const m = buildModel(clean(['Campaign Name', 'Send Date', 'Spend'], rows, { hr: false }));
  assert.ok(!findings(m, defaultChoices(m)).some(x => /second half/.test(x)));
});

test('forecast extends a straight line and gives a range', () => {
  const f = forecast([10, 20, 30, 40, 50, 60], 3);
  assert.equal(f.from, 6);
  assert.deepEqual(f.values.map(v => Math.round(v)), [70, 80, 90]);
  assert.ok(f.low[0] <= 70 && f.high[0] >= 70);
  assert.equal(forecast([1, 2, 3], 3), null); // too few points
  const noisy = forecast([100, 90, 120, 95, 130, 110, 140, 20], 2, true); // unfinished last period left out
  assert.equal(noisy.from, 7);
  assert.ok(noisy.values[0] > 100);
  assert.ok(noisy.high[1] - noisy.low[1] > noisy.high[0] - noisy.low[0] - 1e-9); // range widens further out
  assert.ok(forecast([50, 40, 30, 20, 10, 5], 4).values.every(v => v >= 0)); // never below zero for positive data
});

test('timeSeries marks an unfinished last period', () => {
  const rows = [];
  for (let m = 1; m <= 6; m++) rows.push([D(`2025-0${m}-15`), 10], [D(`2025-0${m}-27`), 10]);
  assert.equal(timeSeries(rows, 0, 1, 'sum', 'month').partial, false);
  rows.push([D('2025-07-03'), 10]);
  assert.equal(timeSeries(rows, 0, 1, 'sum', 'month').partial, true);
});

test('profile describes one sales rep', () => {
  const m = sample(), c = defaultChoices(m);
  const rep = m.headers.indexOf('Sales Rep'), rev = m.headers.indexOf('Revenue'), cust = m.headers.indexOf('Customer');
  const p = profile(m, c, rep, 'Omar Ali');
  const mine = m.rows.filter(r => r[rep] === 'Omar Ali');
  assert.equal(p.rows, mine.length);
  assert.equal(p.value, mine.reduce((a, r) => a + r[rev], 0));
  assert.ok(p.rank >= 1 && p.rank <= 8 && p.of === 8);
  assert.ok(p.share > 0 && p.share < 1);
  const customers = p.related.find(x => x.name === 'Customer');
  assert.equal(customers.distinct, new Set(mine.map(r => r[cust])).size);
  assert.equal(customers.top.length, 5);
  assert.ok(customers.top[0].value >= customers.top[1].value);
  assert.ok(p.measures.some(x => x.name === 'Units' && x.total > 0));
  assert.ok(p.trend.labels.length >= 6);
  assert.equal(kpis(m, c).find(k => k.kind === 'top').label, 'Highest Product');
});
