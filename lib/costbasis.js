'use strict';
// BTC price against the cost lines analysts watch. Display only:
//   • STH cost basis — average cost of coins that moved in the last 155 days
//     (already scored through STH-MVRV in the STH gauge);
//   • True Market Mean — average cost of coins still active; as a price ratio
//     it moved almost exactly with MVRV (r ≈ 0.97, 2012–2026), so no new signal;
//   • $70,000 — the level Michael Howell said BTC must hold for his liquidity
//     reading to be right (Capital Wars, "What Is Bitcoin Telling Us?", 2026-10-16).
//     A check on a theory, not a trading level.

const DAY_MS = 86400000;
const CHART_DAYS = 1461; // 4 years
const HOWELL = { value: 70000, date: '2026-10-16' };

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const msOf = (d) => Date.parse(`${d}T00:00:00Z`);

function buildCostBasis(src, c, { round }) {
  if (!src?.sth?.v?.length || !src?.tmm?.v?.length) throw new Error('ยังไม่มีข้อมูลต้นทุนจาก Bitcoin Research Kit');
  const toMap = ({ start, v }) => {
    const t0 = msOf(start);
    return new Map(v.map((x, i) => [iso(t0 + i * DAY_MS), x]).filter(([, x]) => x > 0));
  };
  const sthAt = toMap(src.sth);
  const tmmAt = toMap(src.tmm);

  // Daily rows on the price dates; the newest day may be missing in the kit, so
  // the last known cost is carried forward for up to 3 days.
  const s = Math.max(0, c.n - CHART_DAYS);
  const dates = c.dates.slice(s);
  const carry = (map) => {
    let last = null;
    let gap = 0;
    return dates.map((d) => {
      if (map.has(d)) { last = map.get(d); gap = 0; return last; }
      gap++;
      return gap <= 3 ? last : null;
    });
  };
  const sth = carry(sthAt);
  const tmm = carry(tmmAt);
  const n = dates.length;
  const price = c.price[c.n - 1];
  if (sth[n - 1] == null || tmm[n - 1] == null) throw new Error('ข้อมูลต้นทุนจาก Bitcoin Research Kit ไม่เป็นปัจจุบัน');

  // Latest date the kit itself reported (not carried forward).
  const reported = (map) => dates.filter((d) => map.has(d)).pop() || null;
  const line = (id, value, asOf) => ({ id, value: round(value, 6), asOf, gapPct: round((price / value - 1) * 100, 4) });

  return {
    price: round(price, 6),
    date: c.dates[c.n - 1],
    lines: [
      line('sth', sth[n - 1], reported(sthAt)),
      line('tmm', tmm[n - 1], reported(tmmAt)),
      line('howell', HOWELL.value, HOWELL.date),
    ],
    chart: {
      dates,
      price: dates.map((d, i) => round(c.price[s + i], 6)),
      sth,
      tmm,
    },
  };
}

module.exports = { buildCostBasis };
