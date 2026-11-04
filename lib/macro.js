'use strict';
// Global Liquidity macro gauge (weekly).
// Proxy in USD: Fed balance sheet − Treasury General Account − Reverse Repo
// + ECB and BoJ balance sheets at spot FX. PBoC and shadow-banking collateral
// are not available as free data, so this is a partial version of the
// liquidity indices popularised by Michael Howell / CrossBorder Capital.

const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;
const LEAD_WEEKS = 13;
const START = '2011-01-01';
const STATS_START = '2012-01-01';
const CHART_START = '2014-01-01';
const RECENT_WEEKS = 209;

const ETF_START = '2024-01-10'; // US spot Bitcoin ETFs began trading 2024-01-11
const CORR_LAGS = [0, 4, 8, 13, 26];

// Optional series may fail to download without disabling the whole gauge.
const FRED_OPTIONAL = ['SOFR', 'IORB', 'WRESBAL'];
const FRED_SERIES = ['WALCL', 'WTREGEN', 'RRPONTSYD', 'ECBASSETSW', 'JPNASSETS', 'DEXUSEU', 'DEXJPUS', 'DTWEXBGS', ...FRED_OPTIONAL];
// Fed securities held outright (weekly, USD millions): Treasury bills, MBS, and all of them.
// Fetched as a separate source; only the bill tracker needs them.
const FRED_HOLDINGS = ['WSHOBL', 'WSHOMCB', 'WSHOSHO'];
// 2-year Treasury yield and effective fed funds rate (stands in for SOFR before 2018).
const FRED_RATES = ['DGS2', 'DFF'];
// Bands of the display-only cards, as in the research tables: [low, high, label].
const TWOY_BANDS = [[-Infinity, 0, 'ต่ำกว่า 0 bps'], [0, 50, '0–50 bps'], [50, 100, '50–100 bps'], [100, 200, '100–200 bps'], [200, Infinity, '200 bps ขึ้นไป']];
const MOVE_BANDS = [[-Infinity, 80, 'ต่ำกว่า 80'], [80, 100, '80–100'], [100, 135, '100–135'], [135, Infinity, '135 ขึ้นไป']];

// "In the past, in this band: BTC 13 weeks later …" for a card's extra line.
const bandNote = (b, what) => (b?.n
  ? `ในอดีตช่วง ${what} ${b.label}: BTC 13 สัปดาห์ถัดไป ค่ากลาง ${b.median >= 0 ? '+' : ''}${b.median.toFixed(1)}% · ราคาขึ้น ${Math.round(b.upPct)}% ของครั้ง (${b.n} สัปดาห์)`
  : null);
// The Fed's "reserve management purchases" of Treasury bills began on 2025-12-12;
// this is the last weekly (Wednesday) reading before them.
const RMP_START = '2025-12-10';
const BILL_MONTHS = 15;

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const msOf = (d) => Date.parse(`${d}T00:00:00Z`);
const tn = (usdMn) => `$${(usdMn / 1e6).toFixed(2)}T`;
const signedPct = (v) => (v == null ? '–' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);

function asOf(map, date, maxDays) {
  const ms = msOf(date);
  for (let k = 0; k <= maxDays; k++) {
    const key = iso(ms - k * DAY_MS);
    if (map.has(key)) return map.get(key);
  }
  return null;
}

// Least-squares fit of y on x over [x, y] pairs: { n, beta (slope), r } or null when too few points.
function linearFit(pairs) {
  const p = pairs.filter(([x, y]) => x != null && y != null);
  if (p.length < 30) return null;
  const mx = p.reduce((s, [x]) => s + x, 0) / p.length;
  const my = p.reduce((s, [, y]) => s + y, 0) / p.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of p) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  return { n: p.length, beta: sxy / sxx, r: sxy / Math.sqrt(sxx * syy) };
}

const correlation = (pairs) => linearFit(pairs)?.r ?? null;

// weight: contribution to the macro score. bp: [value, score] breakpoints.
const INDICATORS = [
  {
    id: 'glob13',
    name: 'Global Liquidity (13 สัปดาห์)',
    weight: 3,
    bp: [[-4, 5], [-2, 25], [0, 45], [2, 70], [4, 90], [6, 100]],
    desc: 'การเปลี่ยนแปลงของสภาพคล่องโลก (Fed − TGA − Reverse Repo + ECB + BoJ ในรูปดอลลาร์) ย้อนหลัง 13 สัปดาห์ — ตัวหลักที่ในอดีตนำราคา BTC ประมาณ 3 เดือน',
    guide: '> +2% ขยายตัว (ลมส่ง) · ±1% ทรงตัว · < −2% หดตัว (ลมต้าน)',
    pick: (r) => r.glob13,
    extra: (r) => `สภาพคล่องโลก ≈ ${tn(r.glob)} (US ${tn(r.usNet)} · ECB ${tn(r.ecbUsd)} · BoJ ${tn(r.bojUsd)})`,
  },
  {
    id: 'glob26',
    name: 'Global Liquidity (26 สัปดาห์)',
    weight: 1.5,
    bp: [[-6, 5], [-3, 25], [0, 45], [3, 70], [6, 90], [9, 100]],
    desc: 'แนวโน้มสภาพคล่องโลกระยะกลาง 6 เดือน ช่วยกรองสัญญาณหลอกของรอบ 13 สัปดาห์',
    guide: '> +3% แนวโน้มขาขึ้น · < −3% แนวโน้มขาลง',
    pick: (r) => r.glob26,
  },
  {
    id: 'us13',
    name: 'US Net Liquidity (13 สัปดาห์)',
    weight: 1.5,
    bp: [[-8, 5], [-4, 25], [0, 45], [4, 70], [8, 90], [12, 100]],
    desc: 'สภาพคล่องสุทธิของสหรัฐฯ = งบดุล Fed − บัญชีกระทรวงการคลัง (TGA) − Reverse Repo คือเงินที่ไหลเข้าตลาดได้จริง',
    guide: '> +4% เงินไหลเข้าระบบ · < −4% ถูกดูดเงินออก',
    pick: (r) => r.us13,
    extra: (r) => `Fed ${tn(r.fed)} − TGA ${tn(r.tga)} − RRP ${tn(r.rrp)} = ${tn(r.usNet)}`,
  },
  {
    id: 'dxy13',
    name: 'ดัชนีดอลลาร์ Broad USD (13 สัปดาห์)',
    weight: 2,
    bp: [[-5, 100], [-3, 85], [-1, 60], [1, 40], [3, 15], [5, 0]],
    desc: 'ค่าเงินดอลลาร์เทียบสกุลหลักของโลก — ดอลลาร์อ่อนมักทำให้สภาพคล่องโลกคลายตัวและหนุนสินทรัพย์เสี่ยงอย่าง BTC',
    guide: 'อ่อนค่า < −2% หนุน BTC · แข็งค่า > +2% กดดัน',
    pick: (r) => r.dxy13,
    extra: (r) => `ค่าดัชนีล่าสุด ${r.dxy.toFixed(2)}`,
  },
  {
    id: 'sofr',
    name: 'SOFR − IORB (ความตึงของเงินสด)',
    weight: 1,
    bp: [[-10, 75], [-5, 65], [0, 55], [5, 35], [10, 15], [20, 0]],
    format: (v) => (v == null ? '–' : `${v >= 0 ? '+' : ''}${v.toFixed(1)} bps`),
    desc: 'ส่วนต่างดอกเบี้ยกู้ข้ามคืนของตลาด (SOFR) กับดอกเบี้ยที่ Fed จ่ายให้เงินสำรองธนาคาร (IORB) — SOFR สูงกว่าแปลว่าเงินสดในระบบเริ่มตึง สภาพคล่องหดได้แม้ Fed ไม่ได้ประกาศอะไร',
    guide: 'ติดลบ = เงินสดเหลือ · 0 ถึง +5 bps เริ่มตึง · > +10 bps ระบบขาดเงินสด',
    pick: (r) => r.sofr,
    extra: (r) => (r.sofrInfo ? `SOFR ${r.sofrInfo.sofr.toFixed(2)}% − IORB ${r.sofrInfo.iorb.toFixed(2)}% (ล่าสุด ${r.sofrInfo.d}) · ค่าที่แสดงเฉลี่ย 5 วันทำการ` : null),
  },
  {
    // Display-only (weight 0). Tested 2012–2026: a wider spread preceded weaker
    // BTC in every period, but adding it to the score moved the score's
    // correlation with BTC 13 weeks ahead only from 0.418 to 0.423 (and lower in
    // the ETF era) — the liquidity gauges already carry this information.
    id: 'twoy',
    name: 'ยีลด์ 2 ปี − SOFR (ตลาดคาดเฟดขึ้นดอกเบี้ย)',
    weight: 0,
    refLines: [100],
    bp: [[0, 50]],
    format: (v) => (v == null ? '–' : `${v >= 0 ? '+' : ''}${v.toFixed(0)} bps`),
    desc: 'ยีลด์พันธบัตรสหรัฐอายุ 2 ปี ลบดอกเบี้ยกู้ข้ามคืน (SOFR) — บอกว่าตลาดคาดว่าเฟดจะขึ้นดอกเบี้ยอีกแค่ไหนใน 2 ปีข้างหน้า ดอกเบี้ยเงินกู้ในตลาดขยับตามทันที เงินจึงตึงได้ก่อนเฟดลงมือจริง (ตัววัดที่ Michael Howell ใช้) · ทดสอบตั้งแต่ 2012 ส่วนต่างยิ่งสูง BTC ยิ่งแย่จริงทุกช่วงเวลา แต่ใส่ในคะแนน Macro แล้วแทบไม่ช่วย เพราะตัวสภาพคล่องจับเรื่องนี้อยู่แล้ว จึงแสดงเป็นข้อมูลประกอบ ไม่คิดคะแนน',
    guide: '< 0 ตลาดคาดเฟดลดดอกเบี้ย · 0–50 bps ปกติ · 50–100 เริ่มตึง · > 100 ตึงมาก (เส้นประ · สูงสุด 276 bps ในปี 2022) · ก่อนปี 2018 ใช้ Fed Funds แทน SOFR',
    pick: (r) => r.twoy,
    bands: TWOY_BANDS,
    extra: (r) => [
      r.twoInfo ? `ยีลด์ 2 ปี ${r.twoInfo.two.toFixed(2)}% − SOFR ${r.twoInfo.short.toFixed(2)}% (ล่าสุด ${r.twoInfo.d}, ค่าที่แสดงเฉลี่ย 5 วันทำการ)` : null,
      bandNote(r.bands?.twoy, 'ส่วนต่าง'),
    ].filter(Boolean).join(' · ') || null,
  },
  {
    // Display-only (weight 0): Howell's early warning for collateral haircuts.
    // Tested 2012–2026 against BTC 13 weeks ahead, it failed: the sign flipped
    // between periods, and his "markets turn bad" band 100–135 preceded a
    // median BTC gain of about +20%.
    id: 'move',
    name: 'ดัชนี MOVE (ความผันผวนพันธบัตรสหรัฐ)',
    weight: 0,
    refLines: [100, 135],
    bp: [[0, 50]],
    format: (v) => (v == null ? '–' : v.toFixed(1)),
    desc: 'ความผันผวนของราคาพันธบัตรรัฐบาลสหรัฐ คล้าย VIX ของตลาดหุ้น — Michael Howell ใช้ดูล่วงหน้าว่าผู้ให้กู้จะหักมูลค่าหลักประกัน (haircut) เพิ่มไหม ถ้าเพิ่ม เงินที่ยืมต่อกันในระบบจะหดเร็ว · ⚠ ทดสอบกับ BTC ตั้งแต่ 2012 แล้วใช้ทำนายไม่ได้: ผลกลับทิศไปมาระหว่างช่วงเวลา และเกณฑ์ของ Howell ไม่ตรงกับผลของ BTC จึงแสดงเป็นข้อมูลประกอบ ไม่คิดคะแนน',
    guide: '< 80 สบาย · 85 เริ่มไม่ดี · > 100 ตลาดเริ่มแย่ · > 135 มักตามด้วยเศรษฐกิจถดถอย (ตามที่ Howell ให้ไว้ · เส้นประ 100 / 135)',
    pick: (r) => r.move,
    asOf: (r) => r.moveDate || r.d,
    bands: MOVE_BANDS,
    extra: (r) => bandNote(r.bands?.move, 'MOVE'),
  },
  {
    // Display-only (weight 0): a level with a watched stress line, not a tested signal.
    id: 'reserves',
    name: 'เงินสำรองธนาคารที่เฟด',
    weight: 0,
    refLines: [2.9],
    bp: [[0, 50]],
    format: (v) => (v == null ? '–' : `$${v.toFixed(2)}T`),
    desc: 'เงินที่ธนาคารพาณิชย์ฝากไว้ที่เฟด — เชื้อเพลิงของระบบชำระเงิน ถ้าลดลงมากตลาดกู้ข้ามคืนจะตึง และเฟดมักต้องกลับมาเติมเงิน (ที่คลิปเรียกว่า "Not QE") · แสดงเป็นข้อมูลประกอบ ไม่คิดคะแนน',
    guide: 'ราว $2.9T คือระดับที่ตลาดเริ่มจับตาว่าตึง (เส้นประในกราฟ) · สูงกว่านั้นถือว่ายังพอ',
    pick: (r) => (r.reserves == null ? null : r.reserves / 1e6),
  },
  {
    id: 'accel',
    name: 'Liquidity Momentum (เร่ง/ชะลอ)',
    weight: 1,
    bp: [[-3, 10], [-1, 35], [0, 50], [1, 65], [3, 90]],
    format: (v) => (v == null ? '–' : `${v >= 0 ? '+' : ''}${v.toFixed(2)} pp`),
    desc: 'อัตราเปลี่ยนแปลง 13 สัปดาห์ของตอนนี้ เทียบกับเมื่อ 4 สัปดาห์ก่อน — บอกว่าสภาพคล่องกำลังเร่งขึ้นหรือชะลอลง (มักเปลี่ยนทิศก่อนตัวอื่น)',
    guide: '> 0 กำลังเร่งตัว · < 0 กำลังชะลอ',
    pick: (r) => r.accel,
  },
];

// Daily spread observations ({ d, bps, ... }, oldest first) → lookup of the
// average of the last 5 business days up to a date, to damp month-end spikes.
// Returns date → { ...newest observation, avg } | null.
function fiveDayLookup(obs) {
  return (date) => {
    let lo = 0;
    let hi = obs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (obs[mid].d <= date) lo = mid + 1; else hi = mid;
    }
    const last = lo - 1;
    if (last < 4 || msOf(date) - msOf(obs[last].d) > 10 * DAY_MS) return null;
    let sum = 0;
    for (let k = last - 4; k <= last; k++) sum += obs[k].bps;
    return { ...obs[last], avg: sum / 5 };
  };
}

// SOFR − IORB in basis points.
function sofrSpreadLookup(fred) {
  if (!fred.SOFR?.d?.length || !fred.IORB?.d?.length) return () => null;
  const iorb = new Map(fred.IORB.d.map((d, i) => [d, fred.IORB.v[i]]));
  const obs = [];
  fred.SOFR.d.forEach((d, i) => {
    const ib = iorb.get(d);
    if (ib != null) obs.push({ d, sofr: fred.SOFR.v[i], iorb: ib, bps: (fred.SOFR.v[i] - ib) * 100 });
  });
  return fiveDayLookup(obs);
}

// 2-year Treasury yield − overnight rate in basis points: the hikes the market
// prices for the next two years, Michael Howell's preferred tightness gauge.
// SOFR starts in April 2018; before that the effective fed funds rate stands in.
function twoYearSpreadLookup(fred) {
  if (!fred.DGS2?.d?.length || (!fred.SOFR?.d?.length && !fred.DFF?.d?.length)) return () => null;
  const sofr = new Map((fred.SOFR?.d || []).map((d, i) => [d, fred.SOFR.v[i]]));
  const dff = new Map((fred.DFF?.d || []).map((d, i) => [d, fred.DFF.v[i]]));
  const obs = [];
  fred.DGS2.d.forEach((d, i) => {
    const short = sofr.get(d) ?? dff.get(d);
    if (short != null) obs.push({ d, two: fred.DGS2.v[i], short, bps: (fred.DGS2.v[i] - short) * 100 });
  });
  return fiveDayLookup(obs);
}

// How much money the Fed really adds, in USD billions: its Treasury-bill
// purchases, the MBS that matured meanwhile (that principal is reinvested in
// bills — a swap, not new money) and the change in everything it holds (net).
// Display only: the size of the balance sheet is already in the liquidity score.
function fedBills(holdings, fred, round) {
  const [bills, mbs, all] = FRED_HOLDINGS.map((id) => holdings?.[id]);
  if (!bills?.d?.length || !mbs?.d?.length || !all?.d?.length) return null;
  const toMap = (s) => new Map((s?.d || []).map((d, i) => [d, s.v[i]]));
  const maps = { bills: toMap(bills), mbs: toMap(mbs), net: toMap(all), reserves: toMap(fred.WRESBAL) };
  const dates = bills.d.filter((d) => maps.mbs.has(d) && maps.net.has(d));
  const n = dates.length;
  if (n < 60) return null;
  const last = dates[n - 1];
  const bn = (usdMn) => round(usdMn / 1e3, 4);
  // Change of every series between two dates, times `scale`.
  const delta = (from, to, scale = 1) => Object.fromEntries(Object.entries(maps).map(([k, m]) => [k, m.has(from) && m.has(to) ? bn((m.get(to) - m.get(from)) * scale) : null]));

  // Calendar months, each measured to its last Wednesday. MBS principal lands
  // right around month-end, so one month can show two paydowns and the next
  // none; netAvg (the 13 weeks to that month-end, per month) smooths that out.
  const monthEnd = new Map();
  for (const d of dates) monthEnd.set(d.slice(0, 7), d);
  const ends = [...monthEnd.entries()].slice(-(BILL_MONTHS + 1));
  const months = ends.slice(1).map(([month, d], i) => ({
    month,
    ...delta(ends[i][1], d),
    netAvg: delta(dates[dates.indexOf(d) - 13], d, 1 / 3).net,
  }));
  // The newest month is incomplete while another Wednesday still falls inside it.
  months[months.length - 1].partial = iso(msOf(last) + WEEK_MS).slice(0, 7) === last.slice(0, 7);
  const peak = months.filter((m) => m.month >= RMP_START.slice(0, 7)).reduce((a, b) => (!a || b.bills > a.bills ? b : a), null);

  return {
    asOf: last,
    start: RMP_START,
    levelBn: bn(maps.bills.get(last)),
    last4: delta(dates[n - 5], last),
    perMonth: delta(dates[n - 14], last, 1 / 3), // average of the last 13 weeks
    since: maps.bills.has(RMP_START) ? delta(RMP_START, last) : null,
    peak: peak ? { month: peak.month, bills: peak.bills } : null,
    months,
  };
}

// Liquidity is a tailwind or headwind, not "cheap" or "expensive".
const MACRO_LABELS = { 'strong-buy': 'ลมส่งแรง', buy: 'ลมส่ง', neutral: 'เป็นกลาง', sell: 'ลมต้าน', 'strong-sell': 'ลมต้านแรง' };

// move / gold: daily { t: [dates], c: [closes] } of the MOVE index and gold (optional).
function buildMacro(fred, c, { scoreFrom, scoreLabel: baseLabel, round, holdings = null, move = null, gold = null }) {
  const scoreLabel = (s) => {
    const label = baseLabel(s);
    return { ...label, text: MACRO_LABELS[label.tone] || label.text };
  };
  for (const id of FRED_SERIES) {
    if (!FRED_OPTIONAL.includes(id) && !fred?.[id]?.d?.length) throw new Error(`ไม่มีข้อมูล FRED ${id}`);
  }
  const sofrAt = sofrSpreadLookup(fred);
  const twoAt = twoYearSpreadLookup(fred);
  // Optional series that failed to download become empty maps (their values read as null).
  const maps = Object.fromEntries(FRED_SERIES.map((id) => [id, new Map((fred[id]?.d || []).map((d, i) => [d, fred[id].v[i]]))]));
  const daily = (s) => new Map((s?.t || []).map((d, i) => [d, s.c[i]]));
  const moveMap = daily(move);
  const goldMap = daily(gold);
  const btcAt = (d) => {
    for (let k = 0; k <= 3; k++) {
      const i = c.index.get(iso(msOf(d) - k * DAY_MS));
      if (i != null) return c.price[i];
    }
    return null;
  };

  // ---------- weekly liquidity rows (H.4.1 Wednesdays) ----------
  const rows = [];
  fred.WALCL.d.forEach((d, i) => {
    if (d < START) return;
    const fed = fred.WALCL.v[i];
    const tga = asOf(maps.WTREGEN, d, 10);
    const rrp = (asOf(maps.RRPONTSYD, d, 10) ?? 0) * 1000; // billions → millions
    // ECB and BoJ balance sheets reach FRED two to several weeks late. They move
    // slowly, so the last known value is carried forward rather than dropping the
    // newest (and most relevant) weeks while waiting for them.
    const ecb = asOf(maps.ECBASSETSW, d, 28);
    const eur = asOf(maps.DEXUSEU, d, 14);
    const boj = asOf(maps.JPNASSETS, d, 100); // monthly, units of ¥100 mn
    const jpy = asOf(maps.DEXJPUS, d, 14);
    const dxy = asOf(maps.DTWEXBGS, d, 14);
    if ([fed, tga, ecb, eur, boj, jpy, dxy].some((v) => v == null)) return;
    const usNet = fed - tga - rrp;
    const ecbUsd = ecb * eur;
    const bojUsd = (boj * 100) / jpy;
    const sofrInfo = sofrAt(d);
    const twoInfo = twoAt(d);
    rows.push({ d, fed, tga, rrp, usNet, ecbUsd, bojUsd, glob: usNet + ecbUsd + bojUsd, dxy, btc: btcAt(d), sofr: sofrInfo?.avg ?? null, sofrInfo, twoy: twoInfo?.avg ?? null, twoInfo, reserves: asOf(maps.WRESBAL, d, 10), move: asOf(moveMap, d, 7), gold: asOf(goldMap, d, 7) });
  });
  if (rows.length < 200) throw new Error('ข้อมูลสภาพคล่องไม่พอสำหรับคำนวณ');

  const byDate = new Map(rows.map((r) => [r.d, r]));
  const shift = (r, weeks) => byDate.get(iso(msOf(r.d) + weeks * WEEK_MS));
  const change = (r, weeks, key) => {
    const p = shift(r, -weeks);
    return p && p[key] && r[key] ? (r[key] / p[key] - 1) * 100 : null;
  };
  for (const r of rows) {
    r.glob13 = change(r, 13, 'glob');
    r.glob26 = change(r, 26, 'glob');
    r.us13 = change(r, 13, 'usNet');
    r.dxy13 = change(r, 13, 'dxy');
    r.btc13 = change(r, 13, 'btc');
    r.gold13 = change(r, 13, 'gold');
  }
  const totalWeight = INDICATORS.reduce((s, x) => s + x.weight, 0);
  for (const r of rows) {
    const p = shift(r, -4);
    r.accel = r.glob13 != null && p?.glob13 != null ? r.glob13 - p.glob13 : null;
  }
  for (const r of rows) {
    r.scores = {};
    let sum = 0;
    let w = 0;
    for (const ind of INDICATORS) {
      const s = scoreFrom(ind.bp, ind.pick(r));
      r.scores[ind.id] = s;
      if (s != null) { sum += s * ind.weight; w += ind.weight; }
    }
    r.macro = w / totalWeight >= 0.6 ? sum / w : null;
    const f = shift(r, LEAD_WEEKS);
    r.fwd13 = f?.btc && r.btc ? (f.btc / r.btc - 1) * 100 : null;
  }

  // ---------- historical evidence ----------
  const summarize = (list) => {
    const v = list.map((r) => r.fwd13).sort((a, b) => a - b);
    if (!v.length) return { n: 0, median: null, mean: null, upPct: null };
    return {
      n: v.length,
      median: round(v[Math.floor(v.length / 2)], 3),
      mean: round(v.reduce((s, x) => s + x, 0) / v.length, 3),
      upPct: round((100 * v.filter((x) => x > 0).length) / v.length, 3),
    };
  };
  const withFwd = rows.filter((r) => r.fwd13 != null && r.d >= STATS_START);
  const statRows = rows.filter((r) => r.d >= STATS_START);
  const latestScore = rows[rows.length - 1].macro; // marks the bucket today's score falls in
  const stats = {
    leadWeeks: LEAD_WEEKS,
    since: withFwd[0]?.d || null,
    rising: summarize(withFwd.filter((r) => r.glob13 != null && r.glob13 > 0)),
    falling: summarize(withFwd.filter((r) => r.glob13 != null && r.glob13 <= 0)),
    buckets: [
      ['ต่ำกว่า 40', (s) => s < 40],
      ['40–60', (s) => s >= 40 && s < 60],
      ['60 ขึ้นไป', (s) => s >= 60],
    ].map(([label, test]) => ({ label, current: latestScore != null && test(latestScore), ...summarize(withFwd.filter((r) => r.macro != null && test(r.macro))) })),
    corr: CORR_LAGS.map((lag) => ({
      lag,
      r: round(correlation(statRows.map((r) => [shift(r, -lag)?.glob13 ?? null, r.btc13])), 3),
    })),
    // Since spot ETFs, institutional flows made BTC track liquidity more tightly.
    etf: {
      since: ETF_START,
      corr: CORR_LAGS.map((lag) => ({
        lag,
        r: round(correlation(rows.filter((r) => r.d >= ETF_START).map((r) => [shift(r, -lag)?.glob13 ?? null, r.btc13])), 3),
      })),
      rising: summarize(withFwd.filter((r) => r.d >= ETF_START && r.glob13 != null && r.glob13 > 0)),
      falling: summarize(withFwd.filter((r) => r.d >= ETF_START && r.glob13 != null && r.glob13 <= 0)),
    },
  };

  // ---------- chart: liquidity change shifted forward LEAD_WEEKS ----------
  const chartRows = rows.filter((r) => r.d >= CHART_START);
  const dates = chartRows.map((r) => r.d);
  const lastMs = msOf(dates[dates.length - 1]);
  for (let k = 1; k <= LEAD_WEEKS; k++) dates.push(iso(lastMs + k * WEEK_MS));
  const pad = new Array(LEAD_WEEKS).fill(null);
  const chart = {
    dates,
    btc: [...chartRows.map((r) => round(r.btc, 6)), ...pad],
    liqLead: dates.map((d) => {
      const src = byDate.get(iso(msOf(d) - LEAD_WEEKS * WEEK_MS));
      return src ? round(src.glob13, 4) : null;
    }),
    macro: [...chartRows.map((r) => round(r.macro, 3)), ...pad],
    futureIndex: chartRows.length,
  };

  // ---------- latest ----------
  const last = rows[rows.length - 1];
  // MOVE trades daily: show its newest close rather than Wednesday's.
  const moveLast = move?.t?.length ? { d: move.t[move.t.length - 1], v: move.c[move.c.length - 1] } : null;
  if (moveLast && moveLast.d > last.d) { last.move = moveLast.v; last.moveDate = moveLast.d; }
  // For display-only cards with bands: how BTC did in the band today's value sits in.
  last.bands = {};
  for (const ind of INDICATORS.filter((x) => x.bands)) {
    const v = ind.pick(last);
    const b = v == null ? null : ind.bands.find(([lo, hi]) => v >= lo && v < hi);
    if (b) last.bands[ind.id] = { label: b[2], ...summarize(withFwd.filter((r) => ind.pick(r) != null && ind.pick(r) >= b[0] && ind.pick(r) < b[1])) };
  }
  const recent = rows.slice(-RECENT_WEEKS);
  const indicators = INDICATORS.map((ind) => {
    const value = ind.pick(last);
    const score = ind.weight ? last.scores[ind.id] : null; // weight 0 = shown for context only
    return {
      id: ind.id,
      name: ind.name,
      category: 'Macro',
      weights: { macro: ind.weight },
      refLines: ind.refLines || null,
      desc: ind.desc,
      guide: ind.guide,
      value: round(value),
      valueText: (ind.format || signedPct)(value),
      extra: ind.extra ? ind.extra(last) : null,
      score: round(score, 3),
      label: ind.weight ? scoreLabel(score) : { text: 'ข้อมูลประกอบ', tone: 'na' },
      asOf: ind.asOf ? ind.asOf(last) : last.d,
      history: recent.map((r) => round(ind.pick(r), 4)),
    };
  });
  const scored = indicators.filter((i) => i.score != null);

  // Liquidity that has already changed but, given the ~13-week lead, has not
  // reached the BTC price yet: the 13-week changes of the last LEAD_WEEKS weeks.
  const pending = rows.slice(-LEAD_WEEKS).map((r) => r.glob13).filter((v) => v != null);
  stats.pipeline = pending.length
    ? {
      weeks: pending.length,
      avg: round(pending.reduce((s, v) => s + v, 0) / pending.length, 3),
      positive: pending.filter((v) => v > 0).length,
      until: iso(msOf(last.d) + LEAD_WEEKS * WEEK_MS),
    }
    : null;

  // How strongly BTC has followed liquidity: % move in BTC per 1% move in
  // liquidity LEAD_WEEKS earlier (both as 13-week changes).
  const sensitivity = (list) => {
    const fit = linearFit(list.map((r) => [shift(r, -LEAD_WEEKS)?.glob13 ?? null, r.btc13]));
    return fit ? { beta: round(fit.beta, 3), r: round(fit.r, 2), n: fit.n } : null;
  };
  stats.beta = { etf: sensitivity(rows.filter((r) => r.d >= ETF_START)), all: sensitivity(statRows) };

  // The three US "pipes" over the last LEAD_WEEKS weeks, in USD billions.
  // Positive = added to the money circulating in markets.
  const before = shift(last, -LEAD_WEEKS);
  const bn = (usdMn) => round(usdMn / 1e3, 4);
  stats.pipes = before
    ? {
      weeks: LEAD_WEEKS,
      from: before.d,
      to: last.d,
      fed: bn(last.fed - before.fed),
      tga: bn(before.tga - last.tga),
      rrp: bn(before.rrp - last.rrp),
      net: bn(last.usNet - before.usNet),
      levels: { fed: bn(last.fed), tga: bn(last.tga), rrp: bn(last.rrp) },
    }
    : null;

  stats.bills = fedBills(holdings, fred, round);

  // Does liquidity lead BTC better than gold? (Behind The Crypto EP.33 / Howell,
  // "What Is Bitcoin Telling Us?"). Correlation of 13-week changes, liquidity
  // shifted forward by `lag` weeks, since 2012 and in the ETF era.
  if (rows.some((r) => r.gold13 != null)) {
    const etfRows = rows.filter((r) => r.d >= ETF_START);
    const lead = (list, key, lag) => round(correlation(list.map((r) => [shift(r, -lag)?.glob13 ?? null, r[key]])), 3);
    stats.vsGold = {
      since: STATS_START,
      etfSince: ETF_START,
      lags: CORR_LAGS.map((lag) => ({
        lag,
        btc: lead(statRows, 'btc13', lag),
        gold: lead(statRows, 'gold13', lag),
        btcEtf: lead(etfRows, 'btc13', lag),
        goldEtf: lead(etfRows, 'gold13', lag),
      })),
    };
  }

  return {
    score: round(last.macro, 4),
    label: scoreLabel(last.macro),
    used: scored.length,
    total: indicators.filter((i) => i.weights.macro > 0).length,
    bullish: scored.filter((i) => i.score >= 60).length,
    bearish: scored.filter((i) => i.score < 40).length,
    asOf: last.d,
    globalUsdMn: round(last.glob, 6),
    indicators,
    chart,
    stats,
  };
}

module.exports = { buildMacro, FRED_SERIES, FRED_OPTIONAL, FRED_HOLDINGS, FRED_RATES, INDICATORS };
