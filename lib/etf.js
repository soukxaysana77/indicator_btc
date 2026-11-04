'use strict';
// US spot ETF net flows: BTC (bitcoin-data.com, in BTC) and XRP (SoSoValue, in USD).
//
// Display only. Tested 2026-10-31 by rank correlation over 1, 5 and 20 trading days:
//   • BTC 2024-01 → 2026-10: flows vs the same window's price move r ≈ +0.4 to +0.8,
//     the past move vs the next window's flows ≈ +0.3 to +0.45, but flows vs the
//     next window's move ≈ 0 (−0.15 to +0.11, the sign flips between years).
//   • XRP 2025-11 → 2026-10: $1.8B net inflow while XRP fell 46%; flows vs the next
//     window's move ≤ 0, on too few independent months to mean much.
// Flows follow the price: they show the current mood, not the next move. The
// evidence is recomputed on every build so the page shows up-to-date numbers.

const { spearman } = require('./stats');

const WINDOW = 20; // trading days, about one month
const SKIP = 10; // launch days: seed money from the issuers, not investor demand
const MIN_PAIRS = 60;

const msOf = (d) => Date.parse(`${d}T00:00:00Z`);
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

// rows: trading days, oldest first: { d, flow (USD), price, units?, aum?, cum? }.
function buildEtf(rows, { round, asset, source, unit = null }) {
  const n = rows.length;
  if (n < WINDOW + 10) throw new Error(`ข้อมูล ETF ${asset} ยังน้อยเกินไป`);

  // Prefix sums: flowSum(a, b) is the net flow of rows a..b inclusive.
  const pre = [0];
  const preUnits = [0];
  for (const r of rows) { pre.push(pre[pre.length - 1] + r.flow); preUnits.push(preUnits[preUnits.length - 1] + (r.units || 0)); }
  const flowSum = (a, b) => pre[b + 1] - pre[a];
  const unitSum = (a, b) => (unit ? preUnits[b + 1] - preUnits[a] : null);
  const mn = (usd) => round(usd / 1e6, 4); // USD → USD millions
  const last = n - 1;
  const lastRow = rows[last];

  // ---------- latest ----------
  // Every 20-day window since launch, to say how unusual the latest one is.
  const sums = [];
  for (let i = SKIP + WINDOW - 1; i < n; i++) sums.push(flowSum(i - WINDOW + 1, i));
  const now = flowSum(n - WINDOW, last);
  const recent = [1, 5, WINDOW].map((days) => ({
    days,
    flowMn: mn(flowSum(n - days, last)),
    units: round(unitSum(n - days, last), 4),
  }));
  recent[2].abovePct = round((100 * sums.filter((v) => v < now).length) / sums.length, 3);
  const cumUsd = lastRow.cum ?? pre[n];

  // ---------- historical evidence ----------
  const lead = [[], []];
  const follow = [[], []];
  const same = [[], []];
  for (let i = SKIP + WINDOW; i + WINDOW < n; i++) {
    const past = flowSum(i - WINDOW + 1, i);
    const before = rows[i].price / rows[i - WINDOW].price - 1;
    const after = rows[i + WINDOW].price / rows[i].price - 1;
    lead[0].push(past); lead[1].push(after);
    follow[0].push(before); follow[1].push(flowSum(i + 1, i + WINDOW));
    same[0].push(past); same[1].push(before);
  }
  const rho = ([x, y]) => round(spearman(x, y, MIN_PAIRS), 2);
  const halves = (p) => {
    const h = Math.floor(p[0].length / 2);
    return { all: rho(p), early: rho([p[0].slice(0, h), p[1].slice(0, h)]), late: rho([p[0].slice(h), p[1].slice(h)]) };
  };
  // Next-month price move after the strongest and the weakest third of 20-day flows.
  const order = lead[0].map((v, k) => k).sort((a, b) => lead[0][a] - lead[0][b]);
  const third = Math.floor(order.length / 3);
  const outcome = (ks) => {
    const v = ks.map((k) => lead[1][k] * 100).sort((a, b) => a - b);
    if (!v.length) return { n: 0, median: null, upPct: null };
    return { n: v.length, median: round(v[Math.floor(v.length / 2)], 3), upPct: round((100 * v.filter((x) => x > 0).length) / v.length, 3) };
  };
  const evidence = {
    window: WINDOW,
    from: rows[Math.min(SKIP, last)].d,
    to: lastRow.d,
    months: Math.floor((n - SKIP) / WINDOW),
    lead: halves(lead),
    follow: halves(follow),
    same: halves(same),
    high: outcome(order.slice(order.length - third)),
    low: outcome(order.slice(0, third)),
  };

  // ---------- chart: one point per week (Monday to Friday) ----------
  const weeks = [];
  for (const r of rows) {
    const ms = msOf(r.d);
    const monday = iso(ms - ((new Date(ms).getUTCDay() + 6) % 7) * 86400000);
    const w = weeks[weeks.length - 1];
    if (w?.monday === monday) { w.flow += r.flow; w.d = r.d; w.price = r.price; } else weeks.push({ monday, d: r.d, flow: r.flow, price: r.price });
  }

  return {
    asset,
    source,
    unit,
    asOf: lastRow.d,
    recent,
    cum: { since: rows[0].d, flowMn: mn(cumUsd), units: round(unitSum(0, last), 4) },
    aumMn: lastRow.aum == null ? null : mn(lastRow.aum),
    priceSince: { from: rows[0].price, to: lastRow.price, pct: round((lastRow.price / rows[0].price - 1) * 100, 3) },
    evidence,
    chart: {
      dates: weeks.map((w) => w.d),
      flowMn: weeks.map((w) => mn(w.flow)),
      price: weeks.map((w) => round(w.price, 6)),
    },
  };
}

module.exports = { buildEtf };
