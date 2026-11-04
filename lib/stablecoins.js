'use strict';
// Stablecoin supply (USDT + USDC): how many new dollars have entered crypto.
//
// Display only. Tested on 2019–2026 the same way as the other gauges (rank
// correlation with forward BTC returns, split in two periods):
//   • 90-day supply growth vs BTC 90 days ahead: r ≈ 0 overall and the sign
//     flips between the halves (about +0.1 before mid-2022, −0.2 after).
//   • BTC's past 90-day move vs supply growth over the following 90 days:
//     r ≈ +0.45 in both halves — supply follows the price, it does not lead it.
// So it confirms whether money is arriving, and is not part of any score.

const { spearman } = require('./stats');

const DAY_MS = 86400000;
const STATS_START = '2019-01-01'; // before this the supply was too small to matter
const SPLIT = '2022-07-01';
const HORIZON = 90;
const WINDOWS = [30, 90, 180, 365];
// 90-day change (%) → reading. Since mid-2022 the median 90-day growth was about +4%.
const STATES = [
  [5, 'เงินใหม่เข้าแรง', 'up'],
  [1, 'มีเงินใหม่เข้า', 'up'],
  [-1, 'ทรงตัว', 'flat'],
  [-Infinity, 'เงินไหลออก', 'down'],
];

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const msOf = (d) => Date.parse(`${d}T00:00:00Z`);

function buildStablecoins(src, c, { round }) {
  if (!src?.t?.length) throw new Error('ยังไม่มีข้อมูล Stablecoin');

  // One row per calendar day (short gaps in the source are carried forward).
  const usdtAt = new Map(src.t.map((d, i) => [d, src.usdt[i]]));
  const usdcAt = new Map(src.t.map((d, i) => [d, src.usdc[i]]));
  const rows = [];
  let usdt = null;
  let usdc = 0;
  let gap = 0;
  const lastMs = msOf(src.t[src.t.length - 1]);
  for (let ms = msOf(src.t[0]); ms <= lastMs; ms += DAY_MS) {
    const d = iso(ms);
    if (usdtAt.get(d) != null) { usdt = usdtAt.get(d); usdc = usdcAt.get(d) ?? usdc; gap = 0; } else gap++;
    if (usdt == null || gap > 7) continue;
    const pi = c.index.get(d);
    rows.push({ d, usdt, usdc, total: usdt + usdc, btc: pi != null ? c.price[pi] : null });
  }
  if (rows.length < 1000) throw new Error('ข้อมูล Stablecoin ไม่พอสำหรับคำนวณ');

  const byDate = new Map(rows.map((r) => [r.d, r]));
  const shift = (r, days) => byDate.get(iso(msOf(r.d) + days * DAY_MS));
  const pct = (now, then) => (now && then ? (now / then - 1) * 100 : null);
  for (const r of rows) {
    const p = shift(r, -HORIZON);
    const f = shift(r, HORIZON);
    r.flow90 = p ? r.total - p.total : null;
    r.s90 = pct(r.total, p?.total);
    r.btc90 = pct(r.btc, p?.btc);
    r.fwd90 = pct(f?.btc, r.btc);
  }

  // ---------- latest ----------
  const last = rows[rows.length - 1];
  const changes = WINDOWS.map((days) => {
    const p = shift(last, -days);
    return { days, usdMn: p ? round(last.total - p.total, 6) : null, pct: round(pct(last.total, p?.total), 3) };
  });
  const [, text, tone] = last.s90 == null ? [null, 'ข้อมูลไม่พอ', 'flat'] : STATES.find(([min]) => last.s90 >= min);
  const peak = rows.reduce((a, b) => (b.total > a.total ? b : a));

  // ---------- historical evidence ----------
  const stat = rows.filter((r) => r.d >= STATS_START);
  const rho = (list, x, y) => {
    const p = list.filter((r) => r[x] != null && r[y] != null);
    return round(spearman(p.map((r) => r[x]), p.map((r) => r[y])), 2);
  };
  const both = (x, y) => ({
    all: rho(stat, x, y),
    early: rho(stat.filter((r) => r.d < SPLIT), x, y),
    late: rho(stat.filter((r) => r.d >= SPLIT), x, y),
  });
  // Supply growth over the 90 days after each row, to test "price first, supply later".
  for (const r of rows) r.s90next = shift(r, HORIZON)?.s90 ?? null;
  const summarize = (list) => {
    const v = list.map((r) => r.fwd90).sort((a, b) => a - b);
    if (!v.length) return { n: 0, median: null, upPct: null };
    return { n: v.length, median: round(v[Math.floor(v.length / 2)], 3), upPct: round((100 * v.filter((x) => x > 0).length) / v.length, 3) };
  };
  const withFwd = stat.filter((r) => r.s90 != null && r.fwd90 != null);
  const evidence = {
    since: stat[0]?.d || null,
    split: SPLIT,
    horizon: HORIZON,
    leads: both('s90', 'fwd90'),
    follows: both('btc90', 's90next'),
    growing: summarize(withFwd.filter((r) => r.s90 >= 1)),
    flat: summarize(withFwd.filter((r) => r.s90 < 1)),
  };

  // ---------- chart: weekly points ending on the latest day ----------
  const chartRows = [];
  for (let i = rows.length - 1; i >= 0 && rows[i].d >= STATS_START; i -= 7) chartRows.push(rows[i]);
  chartRows.reverse();

  return {
    asOf: last.d,
    totalMn: round(last.total, 6),
    usdtMn: round(last.usdt, 6),
    usdcMn: round(last.usdc, 6),
    changes,
    state: { text, tone },
    peak: { date: peak.d, totalMn: round(peak.total, 6) },
    evidence,
    chart: {
      dates: chartRows.map((r) => r.d),
      flow90: chartRows.map((r) => (r.flow90 == null ? null : round(r.flow90 / 1e3, 4))), // USD billions
      total: chartRows.map((r) => round(r.total / 1e3, 5)),
    },
  };
}

module.exports = { buildStablecoins };
