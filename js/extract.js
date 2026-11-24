// Pick columns out of a cleaned table: choose columns, sort, drop repeated rows, export.
const isDate = v => v !== null && typeof v === 'object' && typeof v.date === 'string';
const blank = v => v === null || v === undefined || v === '';
/** Text shown for a cell. Dates as YYYY-MM-DD. */
export const cellText = v => (blank(v) ? '' : isDate(v) ? v.date : String(v));

function compare(a, b) {
  const ea = blank(a), eb = blank(b);
  if (ea || eb) return ea && eb ? 0 : ea ? 1 : -1; // empty cells go last, whichever way the sort runs
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (isDate(a) && isDate(b)) return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  return cellText(a).localeCompare(cellText(b), undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * rows: array of arrays. opts.cols: column indexes to keep, in output order.
 * opts.sortBy: a column index (need not be kept) or -1. opts.desc, opts.dedupe: booleans.
 * Returns { headers, rows, removed } where removed is the number of repeated rows dropped.
 */
export function extract(headers, rows, { cols, sortBy = -1, desc = false, dedupe = false }) {
  let picked = rows.map((r, i) => ({ r, i }));
  if (sortBy >= 0) {
    picked.sort((x, y) => {
      const c = compare(x.r[sortBy], y.r[sortBy]);
      const empty = blank(x.r[sortBy]) || blank(y.r[sortBy]);
      return (empty ? c : desc ? -c : c) || x.i - y.i; // ties keep the sheet's order
    });
  }
  let out = picked.map(p => cols.map(c => (p.r[c] === undefined ? null : p.r[c])));
  let removed = 0;
  if (dedupe) {
    const seen = new Set();
    const kept = [];
    for (const r of out) {
      const key = r.map(cellText).join('\u0001');
      if (seen.has(key)) { removed++; continue; }
      seen.add(key); kept.push(r);
    }
    out = kept;
  }
  return { headers: cols.map(c => headers[c] || `Column ${c + 1}`), rows: out, removed };
}

/** CSV text. Fields with commas, quotes or line breaks are quoted. */
export function toCsv(headers, rows) {
  const q = v => { const t = cellText(v); return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  return [headers, ...rows].map(r => r.map(q).join(',')).join('\r\n');
}

/** Cells for a spreadsheet: dates become real date cells, everything else keeps its type. */
export function toSheetCells(headers, rows) {
  const serial = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000 + 25569;
  const cell = v => (blank(v) ? null : isDate(v) ? { t: 'n', v: serial(v.date), z: 'yyyy-mm-dd' } : typeof v === 'number' ? { t: 'n', v, z: Number.isInteger(v) ? '0' : undefined } : { t: 's', v: String(v) });
  return [headers.map(h => ({ t: 's', v: h })), ...rows.map(r => r.map(cell))];
}
