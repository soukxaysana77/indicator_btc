'use strict';
// "ระบบทดลอง" (paper trading, no real money) on the BTC page:
//   1. Hold BTC while its daily close is above its N-day average, else cash.
//   2. While in cash, when any asset on the site closes with STH ≥ 99, put the
//      cash into it (split equally if several) and sell at its next close.
// Decisions are made at the daily close (07:00 Thai time), 0.1% fee per buy
// and per sell. The page sets a start date and a pretend amount; this replays
// the rules on the real closes from that day on, so the record never depends
// on anyone pressing buttons on time.
//
// Tested 2026-11-11 (2014 → 2026-11), against simply holding BTC (CAGR 43%,
// worst fall −84%): the average filter alone gave 55–64% a year with a worst
// fall of about −61% to −64% for 50- to 150-day averages, and it matched or
// beat holding in every halving cycle with a smaller fall. Adding the STH ≥ 99
// bounce with the idle cash (15 trades) added about 10–14 points a year with no
// deeper fall. 30- and 200-day averages were no better than holding; STH 95–98
// bounces, LTH-based exits and the same filter on gold or alts did not hold up.
// Past results only; the per-cycle table is recomputed from the data on each build.

const { assetsOf } = require('./sth99');

const FEE = 0.001;
const BOUNCE_LEVEL = 99;
const WINDOWS = [50, 100, 120, 150];
const DEFAULT_MA = 100;
const CHART_DAYS = 366; // price vs average on the card: the last year
const CYCLES = [
  ['2014-01-01', '2016-07-09'],
  ['2016-07-09', '2020-05-11'],
  ['2020-05-11', '2024-04-20'],
  ['2024-04-20', null],
  ['2014-01-01', null],
];

function sma(p, w) {
  const out = new Array(p.length).fill(null);
  let sum = 0;
  for (let i = 0; i < p.length; i++) {
    sum += p[i];
    if (i >= w) sum -= p[i - w];
    if (i >= w - 1) out[i] = sum / w;
  }
  return out;
}

// Replays the rules from the close of `from` to `to` (or the live day).
// bounce = false runs the average filter alone.
function simulate(ctx, { ma, from, to = null, bounce = true, capital = 1 }) {
  const b = ctx.btc;
  const avg = ctx.avg[ma];
  const last = b.dates.length - 1; // the live (unfinished) day
  const i0 = b.dates.findIndex((d) => d >= from);
  if (i0 < 0) return null;
  let iEnd = to ? b.dates.findIndex((d) => d >= to) : last;
  if (iEnd < 0) iEnd = last;
  let eq = capital;
  let pos = 0;
  let open = null; // a bounce trade: { legs: [{ symbol, s, j }], date }
  let peak = capital;
  let dd = 0;
  const trades = [];
  const curve = [];
  const bh0 = b.price[i0];
  const legPrices = (legs, k) => legs.map((l) => ({ symbol: l.symbol, price: l.s.price[l.j + k] }));

  for (let i = i0; i <= iEnd; i++) {
    const d = b.dates[i];
    const closed = i < last;
    if (i > i0 && pos) eq *= b.price[i] / b.price[i - 1];
    // A bounce sells at each leg's next close; it settles once all have closed.
    if (open && open.legs.every((l) => l.s.dates[l.j + 1] != null && l.s.dates[l.j + 1] <= d && l.j + 1 < l.s.dates.length - 1)) {
      const r = open.legs.reduce((sum, l) => sum + (l.s.price[l.j + 1] / l.s.price[l.j]) * (1 - FEE) - 1, 0) / open.legs.length;
      eq *= 1 + r;
      trades.push({ date: open.legs.map((l) => l.s.dates[l.j + 1]).sort().pop(), kind: 'bounce-sell', legs: legPrices(open.legs, 1), ret: r * 100, equity: eq });
      open = null;
    }
    // Live day: value an open bounce at the live prices, make no decision.
    let shown = eq;
    if (!closed && open) {
      const r = open.legs.reduce((sum, l) => sum + l.s.price[l.s.price.length - 1] / l.s.price[l.j] - 1, 0) / open.legs.length;
      shown = eq * (1 + r);
    }
    curve.push({ d, eq: shown, bh: (capital * (1 - FEE) * b.price[i]) / bh0, live: !closed });
    if (closed) { peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1); }
    if (!closed || open || i === iEnd && to) continue;

    // Decision at this close.
    const want = avg[i] != null && b.price[i] > avg[i] ? 1 : 0;
    if (want !== pos) {
      eq *= 1 - FEE;
      pos = want;
      trades.push({ date: d, kind: want ? 'buy' : 'sell', price: b.price[i], avg: avg[i], equity: eq });
    }
    if (!pos && bounce) {
      const legs = [];
      for (const a of ctx.assets) {
        const j = a.index.get(d);
        if (j == null || j >= a.s.dates.length - 1) continue; // that asset's close must be final
        if (a.s.sth[j] != null && a.s.sth[j] >= BOUNCE_LEVEL) legs.push({ symbol: a.symbol, s: a.s, j });
      }
      if (legs.length) {
        eq *= 1 - FEE;
        open = { legs, date: d };
        trades.push({ date: d, kind: 'bounce-buy', legs: legPrices(legs, 0), equity: eq });
      }
    }
  }
  const endDate = b.dates[iEnd];
  const years = (Date.parse(endDate) - Date.parse(b.dates[i0])) / 31557600000;
  const closedCurve = curve.filter((c) => !c.live);
  const endEq = closedCurve.length ? closedCurve[closedCurve.length - 1].eq : capital;
  return {
    from: b.dates[i0],
    to: endDate,
    equity: curve[curve.length - 1].eq,
    bh: curve[curve.length - 1].bh,
    cagr: years > 0.5 ? ((endEq / capital) ** (1 / years) - 1) * 100 : null,
    dd: dd * 100,
    pos,
    open: open ? { date: open.date, legs: open.legs.map((l) => ({ symbol: l.symbol, price: l.s.price[l.j], live: l.s.price[l.s.price.length - 1], sellDate: l.s.dates[l.j + 1] ?? null })) } : null,
    trades,
    curve,
  };
}

function bhStats(b, from, to) {
  const i0 = b.dates.findIndex((d) => d >= from);
  let i1 = to ? b.dates.findIndex((d) => d >= to) : b.dates.length - 2;
  if (i1 < 0) i1 = b.dates.length - 2;
  let peak = 0;
  let dd = 0;
  for (let i = i0; i <= i1; i++) { peak = Math.max(peak, b.price[i]); dd = Math.min(dd, b.price[i] / peak - 1); }
  const years = (Date.parse(b.dates[i1]) - Date.parse(b.dates[i0])) / 31557600000;
  return { cagr: ((b.price[i1] / b.price[i0]) ** (1 / years) - 1) * 100, dd: dd * 100 };
}

function contextOf(data) {
  const all = assetsOf(data);
  const btcAsset = all.find((a) => a.symbol === 'BTC');
  if (!btcAsset) return null;
  const btc = { dates: btcAsset.dates, price: btcAsset.price, sth: btcAsset.sth };
  return {
    btc,
    avg: Object.fromEntries(WINDOWS.map((w) => [w, sma(btc.price, w)])),
    assets: all.map((a) => ({ symbol: a.symbol, s: a, index: new Map(a.dates.map((d, i) => [d, i])) })),
  };
}

// The per-cycle table for one average (independent of the start date).
function backtestTable(ctx, ma, round) {
  return CYCLES.map(([from, to]) => {
    const sys = simulate(ctx, { ma, from, to, bounce: true });
    const trend = simulate(ctx, { ma, from, to, bounce: false });
    const bh = bhStats(ctx.btc, from, to);
    const r = (v) => (v == null ? null : round(v, 4));
    return {
      from,
      to,
      system: { cagr: r(sys.cagr), dd: r(sys.dd) },
      trend: { cagr: r(trend.cagr), dd: r(trend.dd) },
      hold: { cagr: r(bh.cagr), dd: r(bh.dd) },
      trades: sys.trades.filter((t) => t.kind === 'buy').length,
      bounces: sys.trades.filter((t) => t.kind === 'bounce-buy').length,
    };
  });
}

// The card: today's signal, the paper record from `from`, and the backtest.
function buildPaper(data, { ma = DEFAULT_MA, from, capital = 1000 }, { round }) {
  const ctx = contextOf(data);
  if (!ctx) return null;
  if (!WINDOWS.includes(ma)) ma = DEFAULT_MA;
  const b = ctx.btc;
  const last = b.dates.length - 1;
  const today = b.dates[last];
  const start = from && from >= b.dates[0] && from <= today ? from : today;
  const paper = simulate(ctx, { ma, from: start, capital });
  const avgNow = ctx.avg[ma][last];
  const liveSth = ctx.assets
    .map((a) => ({ symbol: a.symbol, sth: a.s.sth[a.s.sth.length - 1], date: a.s.dates[a.s.dates.length - 1] }))
    .filter((x) => x.sth != null && x.sth >= BOUNCE_LEVEL);
  // Position after the last close, whether or not the paper record has started.
  const asOfClose = simulate(ctx, { ma, from: b.dates[Math.max(0, last - 400)] });
  const thin = (c) => ({ d: c.d, eq: round(c.eq, 6), bh: round(c.bh, 6) });
  // Price against the chosen average for the last year (the card's chart).
  const c0 = Math.max(0, b.dates.length - CHART_DAYS);
  const chart = {
    dates: b.dates.slice(c0),
    price: b.price.slice(c0).map((v) => round(v, 6)),
    avg: ctx.avg[ma].slice(c0).map((v) => (v == null ? null : round(v, 6))),
  };
  return {
    windows: WINDOWS,
    ma,
    level: BOUNCE_LEVEL,
    fee: FEE,
    today,
    lastClose: b.dates[last - 1],
    price: b.price[last],
    closePrice: b.price[last - 1],
    avg: avgNow,
    closeAvg: ctx.avg[ma][last - 1],
    above: avgNow != null && b.price[last] > avgNow,
    held: asOfClose.open ? 'bounce' : asOfClose.pos ? 'btc' : 'cash',
    heldBounce: asOfClose.open,
    liveSth,
    paper: {
      from: paper.from,
      capital,
      equity: paper.equity,
      bh: paper.bh,
      held: paper.open ? 'bounce' : paper.pos ? 'btc' : 'cash',
      open: paper.open,
      trades: paper.trades.map((t) => ({ ...t, equity: round(t.equity, 6), ret: t.ret == null ? null : round(t.ret, 4) })),
      curve: paper.curve.map(thin),
    },
    chart,
    backtest: backtestTable(ctx, ma, round),
  };
}

module.exports = { buildPaper, WINDOWS, DEFAULT_MA };
