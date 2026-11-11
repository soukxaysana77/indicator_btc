'use strict';
// "Local bottom during a recovery" checklist, from a 2026-11-03 TonHor Palakorn
// livestream: % of supply in profit < 60, price below the True Market Mean, Fear &
// Greed in fear (< 30), plus his "popcorn" cross (the STH cost basis crossing above
// the True Market Mean, said to precede a new high).
//
// Display only. Tested 2014–2026 (1 year ahead): being in a recovery is what matters
// (median +129%, up 84% of days); each tick alone adds little (+124% to +160%,
// up 85–92%); all three together were up a year later every time but in only 4
// episodes (2019-01, 2019-10, 2020-03, 2022-07). Our LTH score ≥ 70 inside a
// recovery did as well with far more history (+130%, up 96%). Popcorn crosses since
// 2014 took 113–526 days to a new high, and 2019's was −10% a year later. The
// evidence is recomputed on every build.

const { forwardOutcomes } = require('./stats');

const DAY_MS = 86400000;
const EVIDENCE_FROM = '2014-01-01';
const HORIZONS = [90, 365];
const SIP_MAX = 60;
const FEAR_MAX = 30;
const LTH_MIN = 70;
// Recovery: ≥ 30 days after a fall of ≥ 50% from the running high, price ≥ 1.15 ×
// that low, and still below the old high.
const FALL = 0.5;
const BOUNCE = 1.15;
const SETTLE_DAYS = 30;

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const msOf = (d) => Date.parse(`${d}T00:00:00Z`);

// A daily { start, v } series on the history dates; the newest days may lag a
// little, so the last value is carried forward up to `carry` days.
function align(dates, src, carry = 3) {
  const at = new Map();
  if (src?.v) {
    const t0 = msOf(src.start);
    src.v.forEach((x, k) => { if (x != null) at.set(iso(t0 + k * DAY_MS), x); });
  }
  let last = null;
  let gap = 0;
  return dates.map((d) => {
    if (at.has(d)) { last = at.get(d); gap = 0; return last; }
    gap++;
    return gap <= carry ? last : null;
  });
}

function buildBottomCheck({ sip: sipSrc, cost, fearGreed }, history, { round }) {
  const h = history;
  if (!h?.dates?.length || !sipSrc?.v?.length || !cost?.sth?.v?.length) throw new Error('ยังไม่มีข้อมูลสำหรับเช็คลิสต์');
  const n = h.dates.length;
  const sip = align(h.dates, sipSrc);
  const sth = align(h.dates, cost.sth);
  const tmm = align(h.dates, cost.tmm);
  const fgAt = new Map((fearGreed || []).map((r) => [r.date, r.value]));
  const fg = align(h.dates, { start: h.dates[0], v: h.dates.map((d) => fgAt.get(d) ?? null) });

  // Running high and the low since it; recovery as defined above.
  const recovery = new Array(n).fill(false);
  const cycle = new Array(n);
  let ath = 0;
  let athAt = 0;
  let low = Infinity;
  let lowAt = 0;
  for (let i = 0; i < n; i++) {
    const p = h.price[i];
    if (p > ath) { ath = p; athAt = i; low = Infinity; }
    if (p < low) { low = p; lowAt = i; }
    recovery[i] = low <= ath * FALL && i - lowAt >= SETTLE_DAYS && p >= low * BOUNCE && p < ath;
    cycle[i] = { athAt, lowAt };
  }

  const tick = {
    sip: (i) => sip[i] != null && sip[i] < SIP_MAX,
    tmm: (i) => tmm[i] != null && h.price[i] < tmm[i],
    fear: (i) => fg[i] != null && fg[i] < FEAR_MAX,
  };
  const ticks = (i) => Object.values(tick).filter((f) => f(i)).length;
  const cheap = (i) => h.lth[i] != null && h.lth[i] >= LTH_MIN;
  const popcorn = (i) => sth[i] != null && tmm[i] != null && sth[i] > tmm[i];

  // ---------- now ----------
  const L = n - 1;
  const { athAt: a, lowAt: lo } = cycle[L];
  let lastCross = null;
  for (let i = 1; i <= L; i++) if (popcorn(i) && !popcorn(i - 1) && sth[i - 1] != null) lastCross = h.dates[i];
  const now = {
    date: h.dates[L],
    price: round(h.price[L], 6),
    recovery: recovery[L],
    ath: { date: h.dates[a], price: round(h.price[a], 6) },
    low: { date: h.dates[lo], price: round(h.price[lo], 6) },
    fallPct: round((h.price[lo] / h.price[a] - 1) * 100, 3),
    bouncePct: round((h.price[L] / h.price[lo] - 1) * 100, 3),
    sip: round(sip[L], 4),
    tmm: round(tmm[L], 6),
    sth: round(sth[L], 6),
    fear: fg[L],
    lth: round(h.lth[L], 4),
    ticks: { sip: tick.sip(L), tmm: tick.tmm(L), fear: tick.fear(L), count: ticks(L) },
    popcorn: popcorn(L),
    lastPopcorn: lastCross,
  };

  // ---------- evidence ----------
  const out = (cond) => forwardOutcomes(h, cond, { from: EVIDENCE_FROM, horizons: HORIZONS, round });
  const rows = [
    { id: 'all', ...out(() => true) },
    { id: 'recovery', ...out((i) => recovery[i]) },
    { id: 'sip', ...out((i) => recovery[i] && tick.sip(i)) },
    { id: 'tmm', ...out((i) => recovery[i] && tick.tmm(i)) },
    { id: 'fear', ...out((i) => recovery[i] && tick.fear(i)) },
    { id: 'all3', ...out((i) => recovery[i] && ticks(i) === 3) },
    { id: 'lth', ...out((i) => recovery[i] && cheap(i)) },
  ];

  // First day of each all-three episode, and what followed a year later.
  const episodes = [];
  let prev = -99;
  for (let i = 0; i < n; i++) {
    if (h.dates[i] < EVIDENCE_FROM || !recovery[i] || ticks(i) !== 3) continue;
    if (i - prev > 30) {
      episodes.push({ date: h.dates[i], price: round(h.price[i], 6), sip: round(sip[i], 3), fear: fg[i], yearPct: i + 365 < n ? round((h.price[i + 365] / h.price[i] - 1) * 100, 4) : null });
    }
    prev = i;
  }

  // Popcorn crosses (ignoring re-crosses within 120 days): days until a new high.
  const crosses = [];
  let lastAt = -999;
  for (let i = 1; i < n; i++) {
    if (h.dates[i] < EVIDENCE_FROM || !popcorn(i) || popcorn(i - 1) || sth[i - 1] == null) continue;
    if (i - lastAt >= 120) {
      let high = 0;
      for (let k = 0; k <= i; k++) high = Math.max(high, h.price[k]);
      let k = i + 1;
      while (k < n && h.price[k] <= high) k++;
      crosses.push({ date: h.dates[i], price: round(h.price[i], 6), daysToHigh: k < n ? k - i : null, yearPct: i + 365 < n ? round((h.price[i + 365] / h.price[i] - 1) * 100, 4) : null });
    }
    lastAt = i;
  }

  return {
    rules: { sipMax: SIP_MAX, fearMax: FEAR_MAX, lthMin: LTH_MIN, fallPct: Math.round((1 - FALL) * 100), bouncePct: Math.round((BOUNCE - 1) * 100), settleDays: SETTLE_DAYS },
    now,
    evidence: { from: EVIDENCE_FROM, horizons: HORIZONS, rows, episodes, crosses },
  };
}

module.exports = { buildBottomCheck };
