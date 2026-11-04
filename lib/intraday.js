'use strict';
// LTH/STH for the 24-hour chart. The scores are daily, so each 5-minute price is
// scored as if its daily bar had closed there — what the live page shows for
// today as the price moves. One Thai day spans two daily bars (crypto bars start
// at 07:00 Thai time), each scored on a grid of prices across its own range
// and interpolated for every point (a full re-score takes ~20 ms).

const GRID = 12;
const HOUR = 3600 * 1000;

// Daily bar of a timestamp: crypto bars are UTC days; a gold futures session
// runs from 18:00 New York time and is dated by the day it ends.
const utcBarOf = (t) => new Date(t).toISOString().slice(0, 10);
const goldBarOf = (t) => new Date(t + 6 * HOUR).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// Linear interpolation of `key` at price x on a grid sorted by price.
function interpolate(grid, key, x) {
  if (grid.some((g) => g[key] == null)) return null;
  if (grid.length === 1 || x <= grid[0].p) return grid[0][key];
  for (let k = 1; k < grid.length; k++) {
    if (x <= grid[k].p) {
      const a = grid[k - 1];
      const b = grid[k];
      return a[key] + ((b[key] - a[key]) * (x - a.p)) / (b.p - a.p);
    }
  }
  return grid[grid.length - 1][key];
}

// rows: [time, open, high, low, close]; scoreAt(barDate, price) → { lth, sth } or null.
// Returns per-row lth/sth (null where the day cannot be scored) and where each bar starts.
function scoreIntraday(rows, barOf, scoreAt, round) {
  const bars = [];
  rows.forEach((r, i) => {
    const day = barOf(r[0]);
    if (bars[bars.length - 1]?.day === day) bars[bars.length - 1].to = i;
    else bars.push({ day, from: i, to: i });
  });
  const lth = new Array(rows.length).fill(null);
  const sth = new Array(rows.length).fill(null);
  for (const b of bars) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = b.from; i <= b.to; i++) { lo = Math.min(lo, rows[i][4]); hi = Math.max(hi, rows[i][4]); }
    const steps = hi > lo ? GRID : 1;
    const grid = [];
    for (let k = 0; k < steps; k++) {
      const p = steps === 1 ? lo : lo + ((hi - lo) * k) / (steps - 1);
      const s = scoreAt(b.day, p);
      if (!s) break;
      grid.push({ p, lth: s.lth, sth: s.sth });
    }
    if (grid.length < steps) continue;
    for (let i = b.from; i <= b.to; i++) {
      lth[i] = round(interpolate(grid, 'lth', rows[i][4]), 4);
      sth[i] = round(interpolate(grid, 'sth', rows[i][4]), 4);
    }
  }
  return { lth, sth, bars: bars.map((b) => ({ day: b.day, from: b.from })) };
}

module.exports = { scoreIntraday, utcBarOf, goldBarOf };
