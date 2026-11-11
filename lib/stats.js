'use strict';
// Small statistics helpers shared by the research-backed modules.

// Spearman rank correlation of two equal-length arrays; null below minN points.
function spearman(xs, ys, minN = 300) {
  const n = xs.length;
  if (n < minN) return null;
  const rank = (a) => {
    const order = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(n);
    order.forEach(([, i], k) => { r[i] = k; });
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (rx[i] - ry[i]) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}

// What followed the days of history `h` (dates, price) that meet `cond`, from
// `from` on: per horizon the median price change, how often it was up, how
// many separate episodes (matching days more than 30 days apart) and the deepest
// fall on the way (median and worst), all in %.
function forwardOutcomes(h, cond, { from, horizons, round }) {
  const days = [];
  for (let i = 0; i < h.dates.length; i++) if (h.dates[i] >= from && cond(i)) days.push(i);
  const countEpisodes = (idx) => {
    let last = -99;
    let k = 0;
    for (const i of idx) { if (i - last > 30) k++; last = i; }
    return k;
  };
  const sorted = (v) => [...v].sort((a, b) => a - b);
  const out = { episodes: countEpisodes(days) };
  for (const H of horizons) {
    const r = [];
    const dd = [];
    const used = [];
    for (const i of days) {
      if (i + H >= h.dates.length) continue;
      used.push(i);
      r.push(h.price[i + H] / h.price[i] - 1);
      let lo = Infinity;
      for (let k = i + 1; k <= i + H; k++) lo = Math.min(lo, h.price[k]);
      dd.push(lo / h.price[i] - 1);
    }
    out[H] = r.length
      ? {
        n: r.length,
        episodes: countEpisodes(used),
        median: round(sorted(r)[r.length >> 1] * 100, 4),
        upPct: round((100 * r.filter((x) => x > 0).length) / r.length, 3),
        ddMedian: round(sorted(dd)[dd.length >> 1] * 100, 3),
        ddWorst: round(Math.min(...dd) * 100, 3),
      }
      : { n: 0 };
  }
  return out;
}

module.exports = { spearman, forwardOutcomes };
