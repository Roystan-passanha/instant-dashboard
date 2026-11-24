import test from 'node:test';
import assert from 'node:assert/strict';
import { extract, toCsv, toSheetCells, cellText } from '../js/extract.js';

const H = ['Date', 'Customer ID', 'Address', 'Phone', 'Amount'];
const R = [
  [{ date: '2026-03-02' }, 'C010', 'Flat 1, Dubai', '0501234567', 20],
  [{ date: '2026-01-15' }, 'C002', 'Villa "A"', '0507654321', 5],
  [null, 'C002', 'Villa "A"', '0507654321', null],
  [{ date: '2026-02-01' }, 'C100', 'Office 9', '+971 50 111 2222', 100]
];

test('keeps only the chosen columns, in the chosen order', () => {
  const x = extract(H, R, { cols: [3, 1] });
  assert.deepEqual(x.headers, ['Phone', 'Customer ID']);
  assert.deepEqual(x.rows[0], ['0501234567', 'C010']);
  assert.equal(x.rows.length, 4);
});
test('phone numbers keep their leading zero and plus sign', () => {
  const x = extract(H, R, { cols: [3] });
  assert.equal(x.rows[0][0], '0501234567');
  assert.equal(x.rows[3][0], '+971 50 111 2222');
});
test('removes repeated rows judged on the chosen columns only', () => {
  const x = extract(H, R, { cols: [1, 3], dedupe: true });
  assert.equal(x.rows.length, 3);
  assert.equal(x.removed, 1);
});
test('sorts numbers, dates and text; empty cells last both ways', () => {
  assert.deepEqual(extract(H, R, { cols: [4], sortBy: 4 }).rows.map(r => r[0]), [5, 20, 100, null]);
  assert.deepEqual(extract(H, R, { cols: [4], sortBy: 4, desc: true }).rows.map(r => r[0]), [100, 20, 5, null]);
  assert.deepEqual(extract(H, R, { cols: [1], sortBy: 0 }).rows.map(r => r[0]), ['C002', 'C100', 'C010', 'C002']);
  assert.deepEqual(extract(H, R, { cols: [1], sortBy: 1 }).rows.map(r => r[0]), ['C002', 'C002', 'C010', 'C100']);
});
test('can sort by a column that is not kept', () => {
  assert.deepEqual(extract(H, R, { cols: [1], sortBy: 4, desc: true }).rows.map(r => r[0]), ['C100', 'C010', 'C002', 'C002']);
});
test('CSV quotes commas and quotes', () => {
  const x = extract(H, R, { cols: [1, 2, 0] });
  const csv = toCsv(x.headers, x.rows).split('\r\n');
  assert.equal(csv[0], 'Customer ID,Address,Date');
  assert.equal(csv[1], 'C010,"Flat 1, Dubai",2026-03-02');
  assert.equal(csv[2], 'C002,"Villa ""A""",2026-01-15');
});
test('sheet cells: text stays text, dates become date cells', () => {
  const x = extract(H, R, { cols: [0, 3, 4] });
  const cells = toSheetCells(x.headers, x.rows);
  assert.equal(cells[1][1].t, 's');
  assert.equal(cells[1][1].v, '0501234567');
  assert.equal(cells[1][0].z, 'yyyy-mm-dd');
  assert.equal(cells[1][0].v, 46083); // 2 March 2026
  assert.equal(cells[3][0], null);
  assert.equal(cellText({ date: '2026-01-01' }), '2026-01-01');
});
