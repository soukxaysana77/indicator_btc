'use strict';
// BTC price against the cost lines analysts watch. Display only:
//   • STH cost basis — average cost of coins that moved in the last 155 days
//     (already scored through STH-MVRV in the STH gauge);
//   • True Market Mean — average cost of coins still active; as a price ratio
//     it moved almost exactly with MVRV (r ≈ 0.97, 2012–2026), so no new signal;
//   • $70,000 — the level Michael Howell said BTC must hold for his liquidity
//     reading to be right (Capital Wars, "What Is Bitcoin Telling Us?", 2026-10-16).
//     A check on a theory, not a trading level.
//
// Evidence shown with the card (recomputed live, 2014 onward): price within ±3%
// of the STH cost basis while the LTH score is ≥ 70 — the "buy at the short-term
// holders' cost in a cheap market" idea from a 2026-11-04 TonHor livestream. As
// of 2026-11 it was followed by a higher price a year later in all 15 episodes
// (median +144%), but often with a deep drop first (Nov 2018: −50%).

const { forwardOutcomes } = require('./stats');

const DAY_MS = 86400000;
const CHART_DAYS = 1461; // 4 years
const HOWELL = { value: 70000, date: '2026-10-16' };
const EVIDENCE_FROM = '2014-01-01';
const NEAR_PCT = 3;
const LTH_MIN = 70;
const HORIZONS = [90, 365];

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const msOf = (d) => Date.parse(`${d}T00:00:00Z`);

function buildEvidence(sthAt, history, round) {
  if (!history?.dates?.length) return null;
  const h = history;
  const sth = h.dates.map((d) => sthAt.get(d) ?? null);
  const near = (i) => sth[i] != null && Math.abs(h.price[i] / sth[i] - 1) * 100 <= NEAR_PCT;
  const cheap = (i) => h.lth[i] != null && h.lth[i] >= LTH_MIN;
  const outcomes = (h2, cond) => forwardOutcomes(h2, cond, { from: EVIDENCE_FROM, horizons: HORIZONS, round });
  return {
    from: EVIDENCE_FROM,
    nearPct: NEAR_PCT,
    lthMin: LTH_MIN,
    horizons: HORIZONS,
    rows: [
      { id: 'all', ...outcomes(h, () => true) },
      { id: 'near', ...outcomes(h, near) },
      { id: 'nearCheap', ...outcomes(h, (i) => near(i) && cheap(i)) },
    ],
  };
}

function buildCostBasis(src, c, { round, history }) {
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
  const lthNow = history?.lth?.[history.lth.length - 1] ?? null;
  const sthGap = (price / sth[n - 1] - 1) * 100;

  return {
    price: round(price, 6),
    date: c.dates[c.n - 1],
    // Is today one of the evidence days?
    now: { sthGapPct: round(sthGap, 4), lth: round(lthNow, 4), near: Math.abs(sthGap) <= NEAR_PCT, cheap: lthNow != null && lthNow >= LTH_MIN },
    evidence: buildEvidence(sthAt, history, round),
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
