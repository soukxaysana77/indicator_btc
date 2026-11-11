'use strict';
// Net realized profit/loss: what the coins moved each day were sold for versus
// what they last cost (Bitcoin Research Kit, all holders).
//
// Display only. A 2026-11-04 TonHor livestream (citing Glassnode) read a run of
// net realized LOSS after a rally as the late, bullish part of an accumulation
// phase. Tested 2014–2026 on forward BTC returns, split 2014–19 / 2020+, it is not:
//   • 14 days of net loss → next 90 / 180 days median +2% / +13%, against
//     +7% / +21% on all days;
//   • in a cheap market (LTH ≥ 70) the days with 14-day net PROFIT did better
//     than net-loss days in both periods (1 year: about +129% vs +85%): profit
//     taking coming back meant the recovery was already under way;
//   • the 7- and 30-day net share vs the next 90/180 days: r ≈ +0.2 in 2014–19, ≈ 0 since 2020.
// The evidence below is recomputed on every build.

const DAY_MS = 86400000;
const EVIDENCE_FROM = '2014-01-01';
const SPLIT = '2020-01-01';
const WINDOW = 14;
const LTH_MIN = 70;
const HORIZONS = [90, 365];
const CHART_WEEKS = 209; // 4 years

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const msOf = (d) => Date.parse(`${d}T00:00:00Z`);

function buildRealizedPnl(src, history, { round }) {
  if (!src?.p?.length || !history?.dates?.length) throw new Error('ยังไม่มีข้อมูลกำไร/ขาดทุนที่ขายจริง');
  const t0 = msOf(src.start);
  const at = new Map(src.p.map((p, k) => [iso(t0 + k * DAY_MS), [p, src.l[k]]]));
  // The kit's newest day is still running, so stop at yesterday (UTC).
  const today = iso(Date.now());
  const h = history;
  const n = h.dates.length;
  const profit = h.dates.map((d) => (d < today ? at.get(d)?.[0] ?? null : null));
  const loss = h.dates.map((d) => (d < today ? at.get(d)?.[1] ?? null : null));
  let last = n - 1;
  while (last > 0 && profit[last] == null) last--;

  // Sums over the w days ending at i; share = (profit − loss) / (profit + loss), −1..+1.
  const sums = (i, w) => {
    if (i - w + 1 < 0) return null;
    let p = 0;
    let l = 0;
    for (let k = i - w + 1; k <= i; k++) {
      if (profit[k] == null) return null;
      p += profit[k];
      l += loss[k];
    }
    return { p, l, share: p + l > 0 ? (p - l) / (p + l) : null };
  };
  const share14 = h.dates.map((_, i) => sums(i, WINDOW)?.share ?? null);
  let lossDays = 0;
  for (let k = last - WINDOW + 1; k <= last; k++) if (loss[k] > profit[k]) lossDays++;

  // ---------- historical evidence ----------
  const outcome = (cond, from = EVIDENCE_FROM, to = '9999') => {
    const out = {};
    for (const H of HORIZONS) {
      const r = [];
      const idx = [];
      for (let i = 0; i + H < n; i++) {
        if (h.dates[i] < from || h.dates[i] >= to || !cond(i)) continue;
        r.push(h.price[i + H] / h.price[i] - 1);
        idx.push(i);
      }
      let prev = -99;
      let episodes = 0;
      for (const i of idx) { if (i - prev > 30) episodes++; prev = i; }
      r.sort((a, b) => a - b);
      out[H] = r.length
        ? { n: r.length, episodes, median: round(r[r.length >> 1] * 100, 4), upPct: round((100 * r.filter((x) => x > 0).length) / r.length, 3) }
        : { n: 0 };
    }
    return out;
  };
  const isLoss = (i) => share14[i] != null && share14[i] < 0;
  const isProfit = (i) => share14[i] != null && share14[i] >= 0;
  const cheap = (i) => h.lth[i] != null && h.lth[i] >= LTH_MIN;
  const split = (cond) => ({ early: outcome(cond, EVIDENCE_FROM, SPLIT), late: outcome(cond, SPLIT) });
  const evidence = {
    from: EVIDENCE_FROM,
    split: SPLIT,
    window: WINDOW,
    lthMin: LTH_MIN,
    horizons: HORIZONS,
    all: outcome(() => true),
    loss: outcome(isLoss),
    profit: outcome(isProfit),
    cheapLoss: { ...outcome((i) => cheap(i) && isLoss(i)), ...split((i) => cheap(i) && isLoss(i)) },
    cheapProfit: { ...outcome((i) => cheap(i) && isProfit(i)), ...split((i) => cheap(i) && isProfit(i)) },
  };

  // ---------- latest ----------
  const recent = [1, 7, WINDOW, 30].map((days) => {
    const s = sums(last, days);
    return { days, profitBn: round(s.p / 1e6, 4), lossBn: round(s.l / 1e6, 4), netBn: round((s.p - s.l) / 1e6, 4), share: round(s.share, 3) };
  });

  // ---------- chart: weekly net (USD billions) and the week's last price ----------
  const weeks = [];
  for (let i = 0; i <= last; i++) {
    if (profit[i] == null) continue;
    const ms = msOf(h.dates[i]);
    const monday = iso(ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS);
    const w = weeks[weeks.length - 1];
    const net = profit[i] - loss[i];
    if (w?.monday === monday) { w.net += net; w.d = h.dates[i]; w.price = h.price[i]; } else weeks.push({ monday, d: h.dates[i], net, price: h.price[i] });
  }
  const shown = weeks.slice(-CHART_WEEKS);

  return {
    asOf: h.dates[last],
    recent,
    lossDays,
    window: WINDOW,
    lth: h.lth[n - 1],
    evidence,
    chart: {
      dates: shown.map((w) => w.d),
      netBn: shown.map((w) => round(w.net / 1e6, 4)),
      price: shown.map((w) => round(w.price, 6)),
    },
  };
}

module.exports = { buildRealizedPnl };
