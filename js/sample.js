// A fake, slightly messy sales file so people can try the dashboard without their own data.
export function makeSample(n = 900, seed = 7) {
  let s = seed;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const pick = a => a[Math.floor(rnd() * a.length)];
  const weighted = pairs => { let t = rnd() * pairs.reduce((a, p) => a + p[1], 0); for (const [v, w] of pairs) { if ((t -= w) <= 0) return v; } return pairs[0][0]; };
  const p2 = x => String(x).padStart(2, '0');
  const regions = [['Dubai', 5], ['Abu Dhabi', 3], ['Sharjah', 2], ['Ajman', 1]];
  const variants = { Dubai: ['Dubai', 'dubai', 'DUBAI', 'Dubai '], 'Abu Dhabi': ['Abu Dhabi', 'abu dhabi', 'Abu  Dhabi'], Sharjah: ['Sharjah', 'sharjah'], Ajman: ['Ajman'] };
  const products = { Laptops: 3200, Phones: 2100, Tablets: 1400, Monitors: 900, Accessories: 150 };
  const channels = [['Online', 5], ['Store', 3], ['Partner', 2]];
  const reps = ['Aisha Khan', 'Omar Ali', 'Priya Nair', 'John Smith', 'Sara Hassan', 'Ravi Kumar', 'Elena Rossi', 'Yusuf Saeed'];
  const customers = Array.from({ length: 60 }, (_, i) => `${pick(['Al Noor', 'Gulf', 'Desert', 'Marina', 'Falcon', 'Oasis', 'Pearl', 'Summit'])} ${pick(['Trading', 'Retail', 'Tech', 'Supplies', 'Group', 'Stores'])} ${i + 1}`);
  const headers = ['Order ID', 'Order Date', 'Region', 'Product', 'Channel', 'Sales Rep', 'Customer', 'Units', 'Unit Price', 'Revenue'];
  const rows = [];
  for (let i = 1; i <= n; i++) {
    const month = weighted([[0, 6], [1, 6], [2, 7], [3, 7], [4, 8], [5, 8], [6, 7], [7, 8], [8, 9], [9, 11], [10, 13], [11, 10]]);
    const day = 1 + Math.floor(rnd() * 28);
    const region = weighted(regions), product = pick(Object.keys(products));
    const units = 1 + Math.floor(rnd() * rnd() * 12);
    const price = Math.round(products[product] * (0.85 + rnd() * 0.3));
    const messy = rnd() < 0.25;
    const iso = `2025-${p2(month + 1)}-${p2(day)}`;
    rows.push([`ORD-${String(i).padStart(5, '0')}`, messy ? pick([`${p2(day)}/${p2(month + 1)}/2025`, `${day} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month]} 2025`, iso]) : { date: iso },
      pick(variants[region]), product, weighted(channels), pick(reps), pick(customers), units, messy ? `AED ${price.toLocaleString('en-US')}` : price, units * price]);
  }
  for (let k = 0; k < 6; k++) rows.push(rows[Math.floor(rnd() * n)].slice());
  for (let k = 0; k < 4; k++) { const r = rows[Math.floor(rnd() * n)]; r[9] = r[9] * 12; r[7] = r[7] * 12; } // a few very large orders
  for (let k = 0; k < 5; k++) rows[Math.floor(rnd() * n)][4] = 'N/A';
  rows.splice(40, 0, headers.map(() => null));
  return { headers, rows };
}
