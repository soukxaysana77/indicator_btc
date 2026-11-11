'use strict';
// Junk-bond stress for the Macro panel: the extra yield that the weakest US
// companies (rated CCC and below) and all high-yield companies pay over
// Treasuries. Source: ICE BofA option-adjusted spreads on FRED, which now keeps
// only about 3 years of them.
//
// Display only. Tested 2026-11-09 (Nov 2023 – Nov 2026) after Bitcoin Addict EP.34
// said the CCC spread is "77% correlated" with BTC:
//   • The level correlation depends on the window and even flips sign: last
//     6 months +0.6 (+0.8 with the spread 8 weeks ahead), 1 year ≈ 0,
//     2 years −0.5, 3 years −0.3.
//   • 13-week changes move with BTC in the same weeks (r ≈ −0.4: spreads widen
//     while BTC falls), but say nothing about the weeks after (r ≈ 0 for the
//     next 4 and 13 weeks).
// So it shows stress happening now and is not part of any score. Every figure
// is recomputed on each build.

const CCC = 'BAMLH0A3HYC';
const HY = 'BAMLH0A0HYM2';
const DAY_MS = 86400000;
const QUARTER = 91; // days in the 13-week change
const LEVEL_WINDOWS = [182, 365, 730, null]; // null = all the data FRED has

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const msOf = (d) => Date.parse(`${d}T00:00:00Z`);

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 20) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

// fred: { [id]: { d: [dates], v: [values] } }; c: daily BTC context (dates, price, index).
function buildCredit(fred, c, { round }) {
  const ccc = fred?.[CCC];
  if (!ccc?.d?.length) return null;
  const hy = fred[HY]?.d?.length ? fred[HY] : null;
  const lastBtcDay = c.dates[c.n - 1];
  const btcOn = (d) => {
    const i = c.index.get(d);
    return i == null ? null : c.price[i];
  };

  // Value on or before a date (spreads skip weekends and US holidays).
  const lookup = (s) => {
    const at = new Map(s.d.map((d, i) => [d, s.v[i]]));
    return (d) => {
      for (let k = 0; k < 7; k++) {
        const v = at.get(iso(msOf(d) - k * DAY_MS));
        if (v != null) return v;
      }
      return null;
    };
  };

  function describe(s) {
    const n = s.v.length;
    const last = s.v[n - 1];
    const date = s.d[n - 1];
    const on = lookup(s);
    const back = (days) => {
      const v = on(iso(msOf(date) - days * DAY_MS));
      return v == null ? null : round(last - v, 3);
    };
    let lo = 0;
    let hi = 0;
    for (let i = 1; i < n; i++) {
      if (s.v[i] < s.v[lo]) lo = i;
      if (s.v[i] > s.v[hi]) hi = i;
    }
    return {
      last,
      date,
      ch1m: back(30),
      ch3m: back(QUARTER),
      min: { v: s.v[lo], d: s.d[lo] },
      max: { v: s.v[hi], d: s.d[hi] },
      // share of days in the record at or below today's level
      pct: round((100 * s.v.filter((v) => v <= last).length) / n, 3),
    };
  }

  // Level against log BTC, over the last 6 months … all of it.
  function levelCorr(s) {
    const end = s.d[s.d.length - 1];
    return LEVEL_WINDOWS.map((days) => {
      const from = days == null ? '' : iso(msOf(end) - days * DAY_MS);
      const xs = [];
      const ys = [];
      s.d.forEach((d, i) => {
        const b = d >= from ? btcOn(d) : null;
        if (b) { xs.push(s.v[i]); ys.push(Math.log(b)); }
      });
      const r = pearson(xs, ys);
      return { days, r: r == null ? null : round(r, 3), n: xs.length };
    });
  }

  // Weekly samples: the spread's 13-week change against BTC over the same 13
  // weeks, and against BTC over the next 4 and next 13 weeks.
  function changeCorr(s) {
    const on = lookup(s);
    const rows = { same: [[], []], next4: [[], []], next13: [[], []] };
    let lastUsed = -Infinity;
    s.d.forEach((d, i) => {
      const t = msOf(d);
      if (t - lastUsed < 7 * DAY_MS) return;
      const before = on(iso(t - QUARTER * DAY_MS));
      const b0 = btcOn(d);
      if (before == null || !b0) return;
      lastUsed = t;
      const ds = s.v[i] - before;
      const add = (key, from, to) => {
        if (to > lastBtcDay) return;
        const p = btcOn(from);
        const q = btcOn(to);
        if (p && q) { rows[key][0].push(ds); rows[key][1].push(Math.log(q / p)); }
      };
      add('same', iso(t - QUARTER * DAY_MS), d);
      add('next4', d, iso(t + 28 * DAY_MS));
      add('next13', d, iso(t + QUARTER * DAY_MS));
    });
    return Object.fromEntries(Object.entries(rows).map(([k, [xs, ys]]) => {
      const r = pearson(xs, ys);
      return [k, { r: r == null ? null : round(r, 3), n: xs.length }];
    }));
  }

  const onHy = hy ? lookup(hy) : null;
  return {
    asOf: ccc.d[ccc.d.length - 1],
    since: ccc.d[0],
    ccc: { ...describe(ccc), levelCorr: levelCorr(ccc), changeCorr: changeCorr(ccc) },
    hy: hy ? { ...describe(hy), levelCorr: levelCorr(hy), changeCorr: changeCorr(hy) } : null,
    chart: {
      dates: ccc.d,
      ccc: ccc.v,
      hy: ccc.d.map((d) => onHy?.(d) ?? null),
      btc: ccc.d.map((d) => {
        const b = btcOn(d);
        return b == null ? null : round(b, 6); // round() keeps significant digits
      }),
    },
  };
}

module.exports = { buildCredit, FRED_CREDIT: [CCC, HY], FRED_CREDIT_OPTIONAL: [HY] };
