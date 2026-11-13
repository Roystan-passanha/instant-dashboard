// Small SVG charts: line (trend), ranked horizontal bars, and columns (histogram).
// Colours come from CSS variables, so light and dark mode need no re-render.
const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, text) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
};
const html = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

export const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];

/** Compact number: 1,234 / 12.3K / 4.5M. */
export function fmt(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '';
  if (!Number.isFinite(v)) return v > 0 ? 'too large' : 'too small';
  const a = Math.abs(v);
  if (a >= 1e15) return v.toExponential(1);
  if (a >= 1e9) return (v / 1e9).toFixed(a >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'K';
  if (Number.isInteger(v)) return v.toLocaleString('en-US');
  if (a > 0 && a < 0.01) return v.toPrecision(2);
  return v.toLocaleString('en-US', { maximumFractionDigits: a < 10 ? 2 : a < 1000 ? 1 : 0 });
}
export function fmtFull(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '';
  if (!Number.isFinite(v) || Math.abs(v) >= 1e15) return fmt(v);
  const a = Math.abs(v);
  if (a > 0 && a < 0.01) return v.toPrecision(3);
  return v.toLocaleString('en-US', { maximumFractionDigits: a < 100 ? 2 : 0 });
}
/** Percent formatter for columns that hold rates stored as fractions (0.425 -> 42.5%). */
export const fmtPercent = v => (v === null || v === undefined || !Number.isFinite(v) ? '' : (v * 100).toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) < 0.1 ? 2 : 1 }) + '%');

const minOf = a => { let m = Infinity; for (const v of a) if (v < m) m = v; return m; };
const maxOf = a => { let m = -Infinity; for (const v of a) if (v > m) m = v; return m; };

/** Round axis ticks from lo up past hi. With whole, ticks are whole numbers (for counts). */
function ticks(lo, hi, count = 4, whole = false) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (hi === lo) hi = lo + 1;
  const raw = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(raw));
  let step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  if (whole) step = Math.max(1, Math.ceil(step));
  if (!Number.isFinite(step) || !(step > 0)) return [lo, hi];
  const start = Math.floor(lo / step) * step, out = [];
  for (let t = start; t < hi + step * 0.999 && out.length < 12; t += step) out.push(Math.round(t * 1e6) / 1e6);
  return out;
}

// Real text widths, so labels are sized and shortened by what fits instead of by a guess.
let ruler = null;
function textWidth(t, size = 12) {
  if (!ruler) ruler = document.createElement('canvas').getContext('2d');
  ruler.font = `${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  return ruler.measureText(t).width;
}
function fit(t, max, size = 12) {
  if (textWidth(t, size) <= max) return t;
  let s = t;
  while (s.length > 1 && textWidth(s + '…', size) > max) s = s.slice(0, -1);
  return s + '…';
}

function tooltip(host) {
  const tip = html('div', 'tip');
  tip.hidden = true;
  host.append(tip);
  return {
    show(x, y, title, lines) {
      tip.replaceChildren(html('div', 'tip__title', title), ...lines.map(l => {
        const row = html('div', 'tip__row');
        if (l.color) { const sw = html('span', 'swatch'); sw.style.background = l.color; row.append(sw); }
        row.append(html('span', 'tip__name', l.name), html('span', 'tip__value', l.value));
        return row;
      }));
      tip.hidden = false;
      const w = tip.offsetWidth, hw = host.clientWidth;
      tip.style.left = Math.max(0, Math.min(hw - w, x + 14 + w > hw ? x - w - 14 : x + 14)) + 'px';
      tip.style.top = Math.max(0, y - tip.offsetHeight - 8) + 'px';
    },
    hide() { tip.hidden = true; }
  };
}

function frame(host, height, label) {
  host.replaceChildren();
  host.style.position = 'relative';
  const width = Math.max(260, host.clientWidth);
  const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': label });
  host.append(root);
  return { root, width, tip: tooltip(host) };
}

/**
 * Trend line. series: [{ name, values }] (null = no data). Up to 4 series.
 */
export function lineChart(host, { labels, series, label, title, f = fmt, ff = fmtFull, fc = null, height = 260 }) {
  // fc is an optional forecast { from, values, low, high }: drawn dashed, with a shaded range
  const multi = series.length > 1;
  const endW = multi ? Math.min(110, maxOf(series.map(s => textWidth(s.name))) + 14) : 16;
  const H = height, m = { l: 50, r: endW, t: 12, b: 26 };
  const { root, width, tip } = frame(host, H, title || label);
  const all = [];
  for (const s of series) for (const v of s.values) if (v !== null && Number.isFinite(v)) all.push(v);
  if (fc) all.push(...fc.low, ...fc.high);
  const tk = ticks(Math.min(0, minOf(all)), Math.max(0, maxOf(all)));
  const lo = tk[0], hi = tk[tk.length - 1];
  const pw = width - m.l - m.r, ph = H - m.t - m.b, n = labels.length;
  const x = i => m.l + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
  const y = v => m.t + ph - ((v - lo) / (hi - lo)) * ph;

  for (const t of tk) {
    root.append(svg('line', { x1: m.l, x2: m.l + pw, y1: y(t), y2: y(t), class: t === 0 ? 'axis' : 'grid' }));
    root.append(svg('text', { x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'tick' }, f(t)));
  }
  const slot = maxOf(labels.map(l => textWidth(l, 11))) + 18;
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / slot))));
  labels.forEach((l, i) => {
    if (i % every !== 0) return;
    // keep the first and last labels inside the plot
    const half = textWidth(l, 11) / 2;
    const anchor = x(i) - half < m.l - 4 ? 'start' : x(i) + half > m.l + pw + 4 ? 'end' : 'middle';
    root.append(svg('text', { x: x(i), y: H - 6, 'text-anchor': anchor, class: 'tick' }, l));
  });

  series.forEach((s, si) => {
    let d = '', pen = false;
    s.values.forEach((v, i) => { if (v === null || !Number.isFinite(v)) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; });
    if (!multi && n > 1) {
      const pts = s.values.map((v, i) => ({ v, i })).filter(p => p.v !== null);
      if (pts.length > 1) root.append(svg('path', { d: `${d}L${x(pts[pts.length - 1].i)},${y(Math.max(lo, 0))}L${x(pts[0].i)},${y(Math.max(lo, 0))}Z`, fill: SERIES[0], opacity: 0.1 }));
    }
    root.append(svg('path', { d, fill: 'none', stroke: SERIES[si], 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    if (n === 1 && s.values[0] !== null) root.append(svg('circle', { cx: x(0), cy: y(s.values[0]), r: 4, fill: SERIES[si] }));
  });
  if (fc) {
    const last = fc.from - 1, lv = series[0].values[last];
    const xs = fc.values.map((_, k) => x(fc.from + k));
    const band = [`M${x(last)},${y(lv)}`, ...fc.high.map((v, k) => `L${xs[k]},${y(v)}`), ...fc.low.map((v, k) => `L${xs[k]},${y(v)}`).reverse(), 'Z'].join('');
    root.append(svg('path', { d: band, fill: SERIES[0], opacity: 0.14 }));
    root.append(svg('path', { d: `M${x(last)},${y(lv)}` + fc.values.map((v, k) => `L${xs[k]},${y(v)}`).join(''), fill: 'none', stroke: SERIES[0], 'stroke-width': 2, 'stroke-dasharray': '5 5', 'stroke-linecap': 'round' }));
    // a thin divider and a word, so the estimate is never mistaken for data
    const dx = (x(last) + xs[0]) / 2;
    root.append(svg('line', { x1: dx, x2: dx, y1: m.t, y2: m.t + ph, class: 'grid' }));
    root.append(svg('text', { x: Math.min(dx + 6, m.l + pw - 52), y: m.t + 10, class: 'tick' }, 'Estimate'));
  }
  if (multi) {
    // end labels, nudged apart so they never overlap
    const ends = series.map((s, si) => { const i = s.values.findLastIndex(v => v !== null); return i < 0 ? null : { si, name: s.name, y: y(s.values[i]) }; }).filter(Boolean).sort((a, b) => a.y - b.y);
    for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 14) ends[k].y = ends[k - 1].y + 14;
    // if the nudging pushed labels below the plot, shift the whole stack up
    const overflow = ends.length ? ends[ends.length - 1].y - (m.t + ph - 4) : 0;
    if (overflow > 0) for (const e of ends) e.y -= overflow;
    for (const e of ends) root.append(svg('text', { x: m.l + pw + 8, y: e.y + 4, class: 'endlabel' }, fit(e.name, endW - 10)));
  }

  const cross = svg('line', { y1: m.t, y2: m.t + ph, class: 'cross', visibility: 'hidden' });
  const dots = series.map((_, si) => svg('circle', { r: 4.5, fill: SERIES[si], class: 'ring', visibility: 'hidden' }));
  root.append(cross, ...dots);
  const hit = svg('rect', { x: m.l, y: m.t, width: pw, height: ph, fill: 'transparent' });
  root.append(hit);
  const move = e => {
    const box = root.getBoundingClientRect();
    const px = (e.touches ? e.touches[0].clientX : e.clientX) - box.left;
    const i = n === 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / pw) * (n - 1))));
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    let top = H;
    const est = fc && i >= fc.from ? i - fc.from : -1;
    series.forEach((s, si) => {
      const v = est >= 0 ? fc.values[est] : s.values[i] ?? null;
      dots[si].setAttribute('visibility', v === null ? 'hidden' : 'visible');
      if (v !== null) { dots[si].setAttribute('cx', x(i)); dots[si].setAttribute('cy', y(v)); top = Math.min(top, y(v)); }
    });
    if (est >= 0) { tip.show(x(i), top, labels[i], [{ name: 'Estimate', value: ff(fc.values[est]) }, { name: 'Likely range', value: `${f(fc.low[est])} to ${f(fc.high[est])}` }]); return; }
    tip.show(x(i), top, labels[i], series.map((s, si) => ({ color: multi ? SERIES[si] : null, name: s.name || label, value: s.values[i] === null ? 'no data' : ff(s.values[i]) })));
  };
  const leave = () => { tip.hide(); cross.setAttribute('visibility', 'hidden'); dots.forEach(d => d.setAttribute('visibility', 'hidden')); };
  hit.addEventListener('mousemove', move); hit.addEventListener('touchstart', move, { passive: true }); hit.addEventListener('touchmove', move, { passive: true });
  hit.addEventListener('mouseleave', leave); hit.addEventListener('touchend', leave);
}

/** Ranked horizontal bars. items: [{ key, value, count, other }] already sorted. */
export function barChart(host, { items, label, title, total, f = fmt, ff = fmtFull, onPick = null }) {
  const row = 30, bar = 18, m = { t: 4, b: 4 };
  const H = m.t + m.b + items.length * row;
  const { root, width, tip } = frame(host, H, title || label);
  const labelW = Math.min(width * 0.42, Math.max(60, maxOf(items.map(i => textWidth(i.key))) + 18));
  const valueW = maxOf(items.map(i => textWidth(f(i.value)))) + 16;
  const pw = Math.max(40, width - labelW - valueW);
  const finite = items.map(i => (Number.isFinite(i.value) ? i.value : 0));
  const lo = Math.min(0, minOf(finite)), hi = Math.max(0, maxOf(finite));
  const span = hi - lo || 1;
  const x = v => labelW + (((Number.isFinite(v) ? v : 0) - lo) / span) * pw;
  items.forEach((it, i) => {
    const cy = m.t + i * row + row / 2;
    const g = svg('g', { class: 'barrow' });
    const name = fit(it.key, labelW - 16);
    g.append(svg('text', { x: labelW - 10, y: cy + 4, 'text-anchor': 'end', class: 'barlabel' }, name));
    const x0 = x(0), x1 = x(it.value), w = Math.max(1, Math.abs(x1 - x0)), r = Math.min(4, w);
    const top = cy - bar / 2, bot = cy + bar / 2;
    // rounded at the data end, square at the baseline
    const d = it.value >= 0
      ? `M${x0},${top}H${x1 - r}Q${x1},${top} ${x1},${top + r}V${bot - r}Q${x1},${bot} ${x1 - r},${bot}H${x0}Z`
      : `M${x0},${top}H${x1 + r}Q${x1},${top} ${x1},${top + r}V${bot - r}Q${x1},${bot} ${x1 + r},${bot}H${x0}Z`;
    g.append(svg('path', { d, fill: it.other ? 'var(--muted-fill)' : SERIES[0] }));
    g.append(svg('text', { x: Math.max(x0, x1) + 8, y: cy + 4, class: 'barvalue' }, f(it.value)));
    const hit = svg('rect', { x: 0, y: cy - row / 2, width, height: row, fill: 'transparent' });
    hit.addEventListener('mousemove', e => {
      const box = root.getBoundingClientRect();
      const lines = [{ name: label, value: ff(it.value) }];
      if (total > 0 && it.value >= 0) lines.push({ name: 'Share of total', value: Math.round((it.value / total) * 1000) / 10 + '%' });
      lines.push({ name: 'Rows', value: it.count.toLocaleString('en-US') });
      tip.show(e.clientX - box.left, cy - 4, it.key, lines);
      g.classList.add('is-hover');
    });
    hit.addEventListener('mouseleave', () => { tip.hide(); g.classList.remove('is-hover'); });
    if (onPick && !it.other) {
      // a bar can be opened for details with the mouse or the keyboard
      for (const [k, v] of Object.entries({ tabindex: 0, role: 'button', 'aria-label': `${it.key}: ${ff(it.value)}. Open details`, class: 'pick' })) hit.setAttribute(k, v);
      hit.addEventListener('click', () => { tip.hide(); onPick(it.key); });
      hit.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(it.key); } });
    }
    g.append(hit);
    root.append(g);
  });
  if (lo < 0) root.append(svg('line', { x1: x(0), x2: x(0), y1: 0, y2: H, class: 'axis' }));
}

/** Columns for a histogram. bins: [{ from, to, count }]. */
export function columnChart(host, { bins, label, title, f = fmt, ff = fmtFull }) {
  const H = 230, m = { l: 40, r: 10, t: 12, b: 26 };
  const { root, width, tip } = frame(host, H, title || label);
  const pw = width - m.l - m.r, ph = H - m.t - m.b, n = bins.length;
  const tk = ticks(0, maxOf(bins.map(b => b.count)), 4, true);
  const hi = tk[tk.length - 1];
  const y = v => m.t + ph - (v / hi) * ph;
  for (const t of tk) {
    root.append(svg('line', { x1: m.l, x2: m.l + pw, y1: y(t), y2: y(t), class: t === 0 ? 'axis' : 'grid' }));
    root.append(svg('text', { x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'tick' }, fmt(t)));
  }
  const band = pw / n, w = Math.max(2, Math.min(24, band - 2));
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 64))));
  bins.forEach((b, i) => {
    const cx = m.l + band * i + band / 2, top = y(b.count), base = y(0), r = Math.min(4, w / 2, base - top);
    const g = svg('g', { class: 'barrow' });
    if (b.count > 0) g.append(svg('path', { d: `M${cx - w / 2},${base}V${top + r}Q${cx - w / 2},${top} ${cx - w / 2 + r},${top}H${cx + w / 2 - r}Q${cx + w / 2},${top} ${cx + w / 2},${top + r}V${base}Z`, fill: SERIES[0] }));
    if (b.over) root.append(svg('text', { x: cx + band / 2, y: H - 6, 'text-anchor': 'end', class: 'tick' }, f(b.from) + '+'));
    else if (b.single) { if (i % every === 0) root.append(svg('text', { x: cx, y: H - 6, 'text-anchor': 'middle', class: 'tick' }, f(b.from))); }
    else if (i % every === 0 && !(bins[n - 1].over && i >= n - 2)) root.append(svg('text', { x: cx - band / 2, y: H - 6, 'text-anchor': 'start', class: 'tick' }, f(b.from)));
    const hit = svg('rect', { x: m.l + band * i, y: m.t, width: band, height: ph, fill: 'transparent' });
    hit.addEventListener('mousemove', () => { tip.show(cx, top, b.single ? `${label}: ${ff(b.from)}` : b.over ? `${ff(b.from)} and above (largest is ${ff(b.to)})` : `${ff(b.from)} to ${ff(b.to)}`, [{ name: 'Rows', value: b.count.toLocaleString('en-US') }]); g.classList.add('is-hover'); });
    hit.addEventListener('mouseleave', () => { tip.hide(); g.classList.remove('is-hover'); });
    g.append(hit);
    root.append(g);
  });
}
