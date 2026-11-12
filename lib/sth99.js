'use strict';
// "เตือน STH" card, shown on the BTC, gold and altcoin pages: which assets have
// a short-term (STH) score at or above the chosen level (90–100, default 99)
// today, and what followed such days in the past: buy at that day's close,
// sell at the next day's close.
//
// Tested 2026-11-11 on every asset in the dashboard (BTC, gold, 11 coins), at
// the close of each day with STH ≥ 99:
//   • the next close was more than 1% higher on 32 of 35 days (91%; up at all
//     on 34), median +5.5%. A normal day is up more than 1% only 33% of the time.
//   • It is a one-day bounce: 3 days later only 63% were up more than 1% and 26%
//     were down more than 1% (Nov 2018 alts: −15% to −20% after a week).
//   • 35 days but only about 15 separate events; several coins often hit 99 on
//     the same crash day.
//   • The wait from selling to the next event: on the whole site since Sep 2017
//     about one a year (average 305 days, median 167, 31 days to 2.3 years);
//     for one asset on its own about 2.6 years (BTC 2.3–5.2 years, gold not
//     since 2013). Hits within a week of each other count as one event.
// Lower levels come more often and win less often; the card shows each level's
// own figures, so the trade-off can be seen side by side.
// The STH inputs (RSI, distance from the 50-day average, Bollinger %B, …) use
// fixed breakpoints and past data only, so the record has no look-ahead. The
// score of the current day moves with the live price until the daily close.
// Display only; every figure is recomputed from the three data sets on each build.

const LEVELS = [90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100];
const DEFAULT_LEVEL = 99;
const WATCH_GAP = 5; // within this many points below the level = "getting close"
const OVER = 0.01; // "more than 1%"
const EVENT_GAP_DAYS = 7; // hits closer than this (any asset) count as one event
// Waiting time on the whole site is measured from here: most coins on the page
// have data by then (before it, only BTC and gold could reach the level).
const WAIT_FROM = '2017-09-01';
const DAY_MS = 86400000;

const msOf = (d) => Date.parse(`${d}T00:00:00Z`);
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((msOf(b) - msOf(a)) / DAY_MS);
const sellDay = (d) => iso(msOf(d) + DAY_MS); // the plan sells at the next close
const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : null;
};
// Scores are cut (not rounded) to 3 decimals, so 98.9996 never shows as 99.
const cut = (v) => (v == null ? null : Math.floor(v * 1000) / 1000);

// Days from selling after one event to the next one (hits within a week of
// each other are the same event). `dates`: sorted, unique.
function waitsBetween(dates) {
  const out = [];
  for (let k = 1; k < dates.length; k++) {
    const gap = daysBetween(sellDay(dates[k - 1]), dates[k]);
    if (gap > EVENT_GAP_DAYS) out.push(gap);
  }
  return out;
}
const waitStats = (gaps) => (gaps.length
  ? { n: gaps.length, avg: Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length), median: median(gaps), min: Math.min(...gaps), max: Math.max(...gaps) }
  : { n: 0 });

function countEvents(dates) {
  let events = 0;
  let prevT = -Infinity;
  for (const d of dates) {
    if (msOf(d) - prevT > EVENT_GAP_DAYS * DAY_MS) events++;
    prevT = msOf(d);
  }
  return events;
}

// The assets on the three pages as { symbol, name, page, dates, price, sth }.
function assetsOf({ btc, gold, alts }) {
  const out = [];
  if (btc?.history) out.push({ symbol: 'BTC', name: 'Bitcoin', page: '/', ...btc.history });
  if (gold?.history) out.push({ symbol: 'GOLD', name: 'ทองคำ', page: '/gold.html', ...gold.history });
  const ch = alts?.overview?.chart;
  for (const c of alts?.overview?.coins || []) {
    const s = ch?.coins?.[c.symbol];
    if (c.error || !s || c.symbol === 'BTC') continue;
    out.push({
      symbol: c.symbol,
      name: c.name,
      page: `/coin.html?c=${encodeURIComponent(c.symbol)}`,
      dates: ch.dates.slice(s.start, s.start + s.price.length),
      price: s.price,
      sth: s.sth,
    });
  }
  return out;
}

// Results (in %) → counts and median / worst / best.
function summarise(values) {
  const r = values.filter((v) => v != null);
  if (!r.length) return { n: 0 };
  return {
    n: r.length,
    over: r.filter((v) => v > OVER * 100).length,
    up: r.filter((v) => v > 0).length,
    downOver: r.filter((v) => v < -OVER * 100).length,
    median: median(r),
    worst: Math.min(...r),
    best: Math.max(...r),
  };
}

function buildSth99(data, { round }) {
  const assets = assetsOf(data);
  if (!assets.length) return null;
  const minLevel = LEVELS[0];
  const pct = (v) => (v == null ? null : round(v * 100, 4));
  const hits = []; // every closed day at or above the lowest level
  let baseN = 0;
  let baseOver = 0;
  const baseBy = {}; // per asset: a normal day's chance of > +1% next day
  const now = assets.map((a) => {
    const own = (baseBy[a.symbol] = { n: 0, over: 0 });
    const last = a.dates.length - 1;
    // Closed days only: the last day is still trading. A result needs its
    // sell day closed too, so day i counts when i + hold < last.
    for (let i = 0; i < last; i++) {
      const p = a.price[i];
      if (p == null || a.sth[i] == null) continue;
      const after = (k) => (i + k < last && a.price[i + k] != null ? a.price[i + k] / p - 1 : null);
      const r1 = after(1);
      if (r1 != null) {
        baseN++;
        own.n++;
        if (r1 > OVER) { baseOver++; own.over++; }
      }
      if (a.sth[i] >= minLevel) {
        hits.push({
          symbol: a.symbol,
          date: a.dates[i],
          sth: cut(a.sth[i]),
          price: p,
          next: i + 1 < last ? a.price[i + 1] : null,
          r1: pct(r1),
          r3: pct(after(3)),
          r7: pct(after(7)),
        });
      }
    }
    let k = last;
    while (k > 0 && a.sth[k] == null) k--;
    return {
      symbol: a.symbol,
      name: a.name,
      page: a.page,
      date: a.dates[k],
      price: a.price[k],
      sth: cut(a.sth[k]),
      // the last closed day, for "it closed at the level yesterday"
      prevDate: k - 1 >= 0 ? a.dates[k - 1] : null,
      prevSth: k - 1 >= 0 ? cut(a.sth[k - 1]) : null,
      scoredSince: a.dates[a.sth.findIndex((v) => v != null)] || null,
    };
  });
  const today = now.reduce((m, a) => (a.date && a.date > m ? a.date : m), '');
  const round1 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? round(v, 4) : v]));

  // Each level's record and waiting times.
  function atLevel(level) {
    const hs = hits.filter((h) => h.sth >= level);
    const dates = [...new Set(hs.map((h) => h.date))].sort();
    const siteDates = dates.filter((d) => d >= WAIT_FROM);
    const siteLast = dates[dates.length - 1] || null;
    const siteEvents = siteDates.length ? countEvents(siteDates) : 0;
    const perAsset = {};
    for (const a of assets) {
      const own = hs.filter((h) => h.symbol === a.symbol);
      const ownDates = [...new Set(own.map((h) => h.date))].sort();
      const lastHit = ownDates[ownDates.length - 1] || null;
      const since = a.dates[a.sth.findIndex((v) => v != null)];
      const ownEvents = countEvents(ownDates);
      perAsset[a.symbol] = {
        ...round1(summarise(own.map((h) => h.r1))),
        day3: round1(summarise(own.map((h) => h.r3))),
        day7: round1(summarise(own.map((h) => h.r7))),
        events: ownEvents,
        perYear: since ? round(ownEvents / (daysBetween(since, today) / 365.25), 3) : 0,
        lastHit,
        waitDays: lastHit ? daysBetween(sellDay(lastHit), today) : null,
        typicalWait: waitStats(waitsBetween(ownDates)),
      };
    }
    return {
      events: countEvents(dates),
      next: round1(summarise(hs.map((h) => h.r1))),
      day3: round1(summarise(hs.map((h) => h.r3))),
      day7: round1(summarise(hs.map((h) => h.r7))),
      perAsset,
      wait: {
        from: WAIT_FROM,
        last: siteLast,
        lastSymbols: siteLast ? hs.filter((h) => h.date === siteLast).map((h) => h.symbol) : [],
        days: siteLast ? daysBetween(sellDay(siteLast), today) : null,
        typical: waitStats(waitsBetween(siteDates)),
        perYear: siteEvents ? round(siteEvents / (daysBetween(WAIT_FROM, today) / 365.25), 3) : 0,
      },
    };
  }

  return {
    levels: LEVELS,
    defaultLevel: DEFAULT_LEVEL,
    watchGap: WATCH_GAP,
    today,
    since: assets.reduce((m, a) => (a.dates[0] < m ? a.dates[0] : m), '9999'),
    assets: assets.length,
    base: { n: baseN, over: baseOver },
    baseBy,
    now: now.sort((x, y) => (y.sth ?? -1) - (x.sth ?? -1)),
    byLevel: Object.fromEntries(LEVELS.map((l) => [l, atLevel(l)])),
    // newest first; the card filters them by the chosen level
    hits: hits.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0)),
  };
}

module.exports = { buildSth99, assetsOf };
