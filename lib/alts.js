'use strict';
// Altcoin dashboards (one per coin in ./coins.js) plus a cross-coin overview.
//
// Research on 16 coins (the 10 here plus former top-10s LTC, BCH, XLM, DOT,
// AVAX, SHIB, to limit survivorship bias), split before/after 2022:
//   • long-term (1 year ahead) contrarian valuation works: price vs its 2-year
//     average, MVRV, depth below the all-time high, weakness vs BTC, and the
//     BTC cycle itself (BTC's LTH score). A composite ≥ 75 preceded a median
//     +34% year; < 30 a median −43%.
//   • short-term (30 days) oscillators (RSI, %B, distance from the 50-day
//     average) showed no edge at all, so the short-term gauge is descriptive.
//   • it does not work for every coin (steady climbers like BNB/TRX lose to
//     plain DCA), so each coin reports its own reliability and evidence.

const { COINS } = require('./coins');
const { scoreFrom, scoreLabel, sma, rollingStd, wilderRsi, round } = require('./indicators');
const { spearman } = require('./stats');
const { buildEtf } = require('./etf');

const DAY_MS = 86400000;
const RECENT_DAYS = 1461;
const LTH_HORIZON = 365;
const STH_HORIZON = 30;
const DCA_START_YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
// Same rule as the BTC backtest panel (public/backtest.js DEFAULT_TIERS).
const DCA_TIERS = [[80, 2.5], [65, 1.25], [50, 0.75], [35, 0.25], [-Infinity, 0]];

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const toMs = (d) => Date.parse(`${d}T00:00:00Z`);
const usd = (v) => {
  if (v == null || !Number.isFinite(v)) return '–';
  if (v >= 100) return `$${Math.round(v).toLocaleString('en-US')}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toLocaleString('en-US', { maximumSignificantDigits: 4 })}`;
};
const signed = (v, d = 0) => (v == null ? '–' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`);
const div = (a, b) => a.map((v, i) => (v != null && b[i] ? v / b[i] : null));

function ffill(a, maxGap) {
  let last = null;
  let gap = 0;
  return a.map((v) => {
    if (v != null && Number.isFinite(v)) { last = v; gap = 0; return v; }
    gap++;
    return gap <= maxGap ? last : null;
  });
}

// ---------- context ----------

function buildContext(coin, data, btc) {
  const hist = data[`alt-hist-${coin.symbol}`];
  if (!hist?.t?.length) throw new Error(`ยังไม่มีประวัติราคา ${coin.symbol} (ตรวจสอบอินเทอร์เน็ต)`);
  const dates = hist.t.slice();
  const price = hist.c.slice();

  const tick = data['alt-tickers']?.[coin.symbol] || null;
  const today = isoDate(Date.now());
  const lastDate = dates[dates.length - 1];
  if (tick?.price > 0) {
    if (today === lastDate) price[price.length - 1] = tick.price;
    else if (toMs(today) - toMs(lastDate) === DAY_MS) { dates.push(today); price.push(tick.price); }
  }
  const n = dates.length;

  const cache = new Map();
  const memo = (key, fn) => {
    if (!cache.has(key)) cache.set(key, fn());
    return cache.get(key);
  };

  // Bitcoin context from the BTC dashboard (price for relative strength, LTH score for the cycle).
  const bh = btc.history;
  const bIndex = new Map(bh.dates.map((d, i) => [d, i]));
  const pick = (arr) => ffill(dates.map((d) => (bIndex.has(d) ? arr[bIndex.get(d)] : null)), 3);

  // MVRV projected onto live prices via the (slow-moving) realized price.
  let mvrv = new Array(n).fill(null);
  let realized = mvrv;
  const mv = data[`alt-mvrv-${coin.symbol}`];
  if (mv?.d?.length) {
    const byDate = new Map(mv.d.map((d, i) => [d, mv.v[i]]));
    realized = ffill(dates.map((d, i) => (byDate.get(d) > 0 ? price[i] / byDate.get(d) : null)), 10);
    mvrv = div(price, realized);
  }

  let ath = 0;
  let athAt = 0;
  const athIdx = new Array(n);
  const drawdown = price.map((v, i) => {
    if (v > ath) { ath = v; athAt = i; }
    athIdx[i] = athAt;
    return (v / ath - 1) * 100;
  });

  return {
    coin, data, dates, price, n, tick, memo,
    sma: (k) => memo(`sma${k}`, () => sma(price, k)),
    btcPrice: pick(bh.price),
    btcLth: pick(bh.lth),
    mvrv,
    realized,
    drawdown,
    athIdx,
  };
}

// ---------- indicator catalogue ----------
// weights: contribution to the long-term (valuation) / short-term (state) score.

const INDICATORS = [
  {
    id: 'p2y',
    name: 'ราคาเทียบเส้นค่าเฉลี่ย 2 ปี',
    category: 'วัฏจักรราคา',
    weights: { lth: 3, sth: 0 },
    bp: [[0.25, 100], [0.4, 92], [0.6, 78], [0.85, 60], [1.2, 42], [1.8, 25], [2.8, 10], [4.5, 0]],
    format: (v) => (v == null ? '–' : `${v.toFixed(2)}×`),
    desc: 'ราคาหารด้วยค่าเฉลี่ย 2 ปี — ตัวชี้วัดที่ได้ผลสม่ำเสมอที่สุดกับเหรียญอื่น: ต่ำกว่าเส้นมากคือช่วงที่ตลาดเลิกสนใจ สูงกว่าเส้นหลายเท่าคือช่วงคนแห่ซื้อ',
    guide: '< 0.45× ในอดีต 1 ปีถัดไปขึ้น 72–87% ของครั้ง · ~1× กลาง ๆ · > 2× ขึ้นแค่ 18–26% ของครั้ง',
    compute: (c) => div(c.price, c.sma(730)),
    extra: (c, i) => `เส้นค่าเฉลี่ย 2 ปี: ${usd(c.sma(730)[i])}`,
  },
  {
    id: 'mvrv',
    name: 'MVRV (ราคาตลาด ÷ ต้นทุนเฉลี่ย)',
    category: 'On-chain',
    needsMvrv: true,
    refLines: [1],
    weights: { lth: 2.5, sth: 0 },
    bp: [[0.5, 100], [0.7, 90], [1, 72], [1.3, 50], [1.8, 25], [2.5, 10], [3.5, 0]],
    format: (v) => (v == null ? '–' : `${v.toFixed(2)}×`),
    desc: 'ราคาเทียบต้นทุนเฉลี่ยของทุกเหรียญในระบบ (Realized Price) — ต่ำกว่า 1 แปลว่าผู้ถือโดยเฉลี่ยขาดทุน ซึ่งในอดีตเป็นโซนสะสม',
    guide: '< 1 ในอดีต 1 ปีถัดไปขึ้น ~70% ของครั้ง · 1.5–3 ขึ้นเพียง 16–28% ของครั้ง',
    compute: (c) => c.mvrv,
    extra: (c, i) => `ต้นทุนเฉลี่ยตลาด: ${usd(c.realized[i])}`,
  },
  {
    id: 'ddath',
    name: 'ห่างจากจุดสูงสุดตลอดกาล',
    category: 'วัฏจักรราคา',
    weights: { lth: 1.5, sth: 0 },
    bp: [[-95, 100], [-90, 92], [-80, 75], [-70, 55], [-50, 40], [-25, 30], [0, 20]],
    format: (v) => (v == null ? '–' : v > -0.05 ? 'ที่จุดสูงสุด' : `${v.toFixed(0)}%`),
    desc: 'ราคาต่ำกว่าจุดสูงสุด (ATH) กี่ % — เหรียญอื่นมักลง 80–90% ในตลาดหมี ยิ่งลงลึกผลตอบแทนปีถัดไปในอดีตยิ่งดี แต่เหรียญที่ไม่ฟื้นเลยก็มี',
    guide: 'ลึกกว่า −90% ในอดีตขึ้น 82% ของครั้ง · −80 ถึง −90% ขึ้น 63% · ตื้นกว่า −70% ต่ำกว่าครึ่ง',
    compute: (c) => c.drawdown,
    extra: (c, i) => `จุดสูงสุด ${usd(c.price[c.athIdx[i]])} (${c.dates[c.athIdx[i]]}) — นับจากข้อมูล Binance ตั้งแต่ ${c.dates[0]}`,
  },
  {
    id: 'btccycle',
    name: 'วัฏจักร Bitcoin',
    category: 'ตลาดรวม',
    weights: { lth: 2, sth: 0 },
    bp: [[0, 0], [100, 100]],
    format: (v) => (v == null ? '–' : `BTC LTH ${Math.round(v)}%`),
    desc: 'คะแนนระยะยาวของ Bitcoin จากหน้าแรก — เหรียญอื่นขึ้นลงตามรอบของ BTC: ช่วงที่ BTC "ถูก" เหรียญอื่นมักให้ผลดีในปีถัดไป',
    guide: 'BTC LTH 60–80 ในอดีตเหรียญอื่น 1 ปีถัดไปค่ากลาง +59% · 20–60 ค่ากลาง −21% ถึง −38%',
    compute: (c) => c.btcLth,
  },
  {
    id: 'relbtc',
    name: 'ความแข็งแรงเทียบ Bitcoin',
    category: 'ตลาดรวม',
    weights: { lth: 1, sth: 0 },
    bp: [[0.4, 90], [0.6, 78], [0.85, 60], [1, 50], [1.3, 35], [1.8, 18], [2.5, 5]],
    format: (v) => (v == null ? '–' : signed((v - 1) * 100)),
    desc: 'ราคาเหรียญเทียบ BTC เมื่อเทียบกับค่าเฉลี่ย 1 ปีของตัวเอง — ติดลบมาก = แพ้ BTC มานาน ซึ่งในอดีตมักตามด้วยการไล่ตามทัน',
    guide: 'ต่ำกว่า −45% ในอดีตขึ้น 70% ของครั้ง · สูงกว่า +85% (ชนะ BTC มาแรง) ขึ้นแค่ 28%',
    compute: (c) => c.memo('relbtc', () => {
      const rel = div(c.price, c.btcPrice);
      return div(rel, sma(rel, 365));
    }),
  },
  {
    id: 'rsi14',
    name: 'RSI รายวัน (14D)',
    category: 'สภาวะระยะสั้น',
    weights: { lth: 0, sth: 2 },
    bp: [[20, 100], [30, 88], [40, 70], [50, 52], [60, 38], [70, 15], [80, 0]],
    format: (v) => (v == null ? '–' : v.toFixed(1)),
    desc: 'Relative Strength Index 14 วัน — บอกว่าระยะสั้นถูกซื้อหรือขายหนักแค่ไหน',
    guide: '< 30 ขายมากเกินไป · > 70 ซื้อมากเกินไป (กับเหรียญอื่น ทดสอบแล้วไม่ช่วยทำนาย 30 วันถัดไป)',
    compute: (c) => wilderRsi(c.price, 14).out,
  },
  {
    id: 'd50',
    name: 'ระยะห่างจากเส้น 50 วัน',
    category: 'สภาวะระยะสั้น',
    weights: { lth: 0, sth: 2 },
    bp: [[0.65, 100], [0.8, 85], [0.92, 68], [1, 55], [1.1, 40], [1.25, 22], [1.5, 5], [1.8, 0]],
    format: (v) => (v == null ? '–' : signed((v - 1) * 100, 1)),
    desc: 'ราคาห่างจากเส้นค่าเฉลี่ย 50 วันกี่ % — ดูการย่อ/ยืดตัวระยะสั้น',
    guide: 'ต่ำกว่า −20% ย่อลึก · สูงกว่า +25% ยืดมาก',
    compute: (c) => div(c.price, c.sma(50)),
    extra: (c, i) => `เส้น 50 วัน: ${usd(c.sma(50)[i])}`,
  },
  {
    id: 'bbpb',
    name: 'Bollinger Bands %B (20D)',
    category: 'สภาวะระยะสั้น',
    weights: { lth: 0, sth: 1 },
    bp: [[-0.1, 100], [0, 92], [0.2, 78], [0.5, 50], [0.8, 22], [1, 8], [1.1, 0]],
    format: (v) => (v == null ? '–' : v.toFixed(2)),
    desc: 'ตำแหน่งราคาในกรอบ Bollinger Bands (20 วัน, 2σ): 0 = ขอบล่าง, 1 = ขอบบน',
    guide: '< 0.2 ใกล้ขอบล่าง · > 0.8 ใกล้ขอบบน',
    compute: (c) => {
      const mid = c.sma(20);
      const sd = rollingStd(c.price, 20);
      return c.price.map((p, i) => (mid[i] != null && sd[i] ? (p - (mid[i] - 2 * sd[i])) / (4 * sd[i]) : null));
    },
  },
  {
    // Display-only: free funding history is under 6 months, too short to test.
    id: 'funding',
    name: 'Funding Rate (เฉลี่ย 3 วัน)',
    category: 'Derivatives',
    weights: { lth: 0, sth: 0 },
    showIn: ['sth'],
    currentOnly: true,
    bp: [[0, 50]],
    format: (v) => (v == null ? '–' : `${v >= 0 ? '+' : ''}${v.toFixed(4)}%`),
    desc: 'ค่า Funding ของสัญญา Perpetual จาก Binance หรือ OKX (ต่อ 8 ชม.) — บวกมาก = คนเปิด Long เยอะ, ติดลบ = คน Short เยอะ · แสดงเป็นข้อมูลประกอบ เพราะมีประวัติให้ทดสอบไม่ถึง 6 เดือน',
    guide: '~ +0.01% ปกติ · ติดลบ = ตลาดกลัว · > +0.05% Long ล้นตลาด',
    compute: (c) => {
      const out = new Array(c.n).fill(null);
      const f = c.data[`alt-fund-${c.coin.symbol}`];
      if (f?.rate != null) out[c.n - 1] = f.rate;
      return out;
    },
  },
];

// ---------- scoring & evidence ----------

function composite(horizon, list, i) {
  let sum = 0;
  let w = 0;
  let total = 0;
  for (const ind of list) {
    const wt = ind.def.weights[horizon];
    if (!wt) continue;
    total += wt;
    const s = ind.scores[i];
    if (s == null) continue;
    sum += s * wt;
    w += wt;
  }
  return { score: w ? sum / w : null, coverage: total ? w / total : 0 };
}

function forwardStats(price, scores, horizon, test) {
  const out = [];
  for (let i = 0; i + horizon < price.length; i++) {
    if (scores[i] != null && test(scores[i])) out.push((price[i + horizon] / price[i] - 1) * 100);
  }
  if (!out.length) return { n: 0, median: null, upPct: null };
  out.sort((a, b) => a - b);
  return {
    n: out.length,
    median: round(out[Math.floor(out.length / 2)], 3),
    upPct: round((100 * out.filter((x) => x > 0).length) / out.length, 3),
  };
}

const LTH_BUCKETS = [['ต่ำกว่า 30', 0, 30], ['30–45', 30, 45], ['45–60', 45, 60], ['60–75', 60, 75], ['75 ขึ้นไป', 75, 101]];
const STH_BUCKETS = [['ต่ำกว่า 30 (ยืดตัว)', 0, 30], ['30–60', 30, 60], ['60–80 (ย่อตัว)', 60, 80], ['80 ขึ้นไป (ย่อลึก)', 80, 101]];

function evidenceSection(price, scores, horizonDays, horizonText, strongMin, defs) {
  return {
    horizonDays,
    horizonText,
    strongMin,
    baseline: forwardStats(price, scores, horizonDays, () => true),
    strong: forwardStats(price, scores, horizonDays, (v) => v >= strongMin),
    buckets: defs.map(([label, lo, hi]) => ({ label, ...forwardStats(price, scores, horizonDays, (v) => v >= lo && v < hi) })),
  };
}

// Monthly deposits; returns final value of score-weighted DCA vs plain DCA (%),
// and plain DCA's own profit (%). null when fewer than 18 monthly buys.
function dcaRun(dates, price, scores, from) {
  let plainUnits = 0;
  let units = 0;
  let cash = 0;
  let periods = 0;
  let month = null;
  for (let i = 0; i < dates.length; i++) {
    if (dates[i] < from || dates[i].slice(0, 7) === month) continue;
    month = dates[i].slice(0, 7);
    periods++;
    plainUnits += 100 / price[i];
    cash += 100;
    const mult = scores[i] == null ? 1 : DCA_TIERS.find(([min]) => scores[i] >= min)[1];
    const buy = Math.min(cash, 100 * mult);
    cash -= buy;
    units += buy / price[i];
  }
  if (periods < 18) return null;
  const last = price[price.length - 1];
  return { edge: ((units * last + cash) / (plainUnits * last) - 1) * 100, plainRoi: ((plainUnits * last) / (periods * 100) - 1) * 100, periods };
}

function reliabilityOf(symbol, rho, dca) {
  const r = rho == null ? null : rho.toFixed(2);
  if (rho == null || !dca) {
    return { level: 'unknown', title: 'ข้อมูลยังไม่พอประเมิน', text: `${symbol} มีประวัติสั้นเกินไปที่จะบอกว่าคะแนนใช้ได้ผลหรือไม่ ควรใช้อย่างระวัง` };
  }
  if (rho < 0.1 && dca.avgEdge <= 0) {
    return { level: 'poor', title: 'คะแนนใช้กับเหรียญนี้ไม่ได้ผล', text: `ในอดีตคะแนนระยะยาวของ ${symbol} แทบไม่สัมพันธ์กับผลตอบแทน 1 ปีถัดไป (ค่าความสัมพันธ์ ${r} จากเต็ม 1) และซื้อตามคะแนนก็ได้น้อยกว่า DCA ปกติเฉลี่ย ${Math.abs(dca.avgEdge).toFixed(0)}%` };
  }
  if (rho < 0.1) {
    return { level: 'mixed', title: 'ผลทดสอบขัดกันเอง', text: `ซื้อตามคะแนนเคยได้มากกว่า DCA ปกติเฉลี่ย ${signed(dca.avgEdge)} แต่คะแนนแทบไม่สัมพันธ์กับผลตอบแทน 1 ปีถัดไป (ค่าความสัมพันธ์ ${r}) ผลดีนั้นจึงอาจเป็นความบังเอิญของจังหวะ` };
  }
  if (dca.avgEdge <= 0) {
    return { level: 'mixed', title: 'คะแนนบอกทิศได้ แต่ DCA ปกติดีกว่า', text: `คะแนนสูง-ต่ำสัมพันธ์กับผลตอบแทน (ค่าความสัมพันธ์ ${r}) แต่ซื้อมาก-น้อยตามคะแนนได้น้อยกว่า DCA ปกติเฉลี่ย ${Math.abs(dca.avgEdge).toFixed(0)}% เพราะ ${symbol} ขึ้นค่อนข้างต่อเนื่อง คะแนนจึงไม่ค่อยลงถึงโซนซื้อ` };
  }
  if (rho < 0.3) {
    return { level: 'mixed', title: 'ใช้ได้บ้าง หลักฐานยังอ่อน', text: `ซื้อตามคะแนนได้มากกว่า DCA ปกติเฉลี่ย ${signed(dca.avgEdge)} แต่ค่าความสัมพันธ์กับผลตอบแทน 1 ปีถัดไปยังต่ำ (${r})` };
  }
  // Two start years of scored history can rest on one rally (LUNC: Sep–Nov 2023).
  if (dca.years.length < 3) {
    return { level: 'mixed', title: 'ได้ผล แต่ประวัติยังสั้น', text: `ซื้อมาก-น้อยตามคะแนนได้มากกว่า DCA ปกติเฉลี่ย ${signed(dca.avgEdge)} และค่าความสัมพันธ์กับผลตอบแทน 1 ปีถัดไป = ${r} แต่ทดสอบได้แค่ ${dca.years.length} ปีเริ่มต้น ผลดีอาจมาจากขาขึ้นเพียงครั้งเดียว` };
  }
  return { level: 'good', title: 'คะแนนเคยใช้กับเหรียญนี้ได้ผล', text: `ซื้อมาก-น้อยตามคะแนนได้มูลค่าพอร์ตมากกว่า DCA ปกติเฉลี่ย ${signed(dca.avgEdge)} (ทดสอบ ${dca.years.length} ปีเริ่มต้น) และค่าความสัมพันธ์กับผลตอบแทน 1 ปีถัดไป = ${r}` };
}

// ---------- one coin ----------

// ---------- the 24-hour chart: scores if a day had closed at another price ----------

// A coin's sources as they would have stood if its daily bar `day` (UTC) had
// closed at `price` (later days dropped; MVRV scaled with the price).
function closedAt(coin, data, day, price) {
  const key = `alt-hist-${coin.symbol}`;
  const hist = data[key];
  if (!hist?.t?.length) return null;
  let k = hist.t.indexOf(day);
  let close;
  const out = { ...data, 'alt-tickers': null };
  if (k >= 0) {
    close = hist.c[k];
    out[key] = { t: hist.t.slice(0, k + 1), c: [...hist.c.slice(0, k), price] };
  } else if (toMs(day) - toMs(hist.t[hist.t.length - 1]) === DAY_MS) {
    // Today before the saved history has its candle: the live page appends it from the ticker.
    close = data['alt-tickers']?.[coin.symbol]?.price || price;
    out[key] = { t: [...hist.t, day], c: [...hist.c, price] };
    k = hist.t.length;
  } else return null;
  const mv = data[`alt-mvrv-${coin.symbol}`];
  if (mv?.d) out[`alt-mvrv-${coin.symbol}`] = { d: mv.d, v: mv.v.map((v, i) => (mv.d[i] === day ? v * (price / close) : v)) };
  return out;
}

// Long/short scores of `coin` on `day` had it closed at `price` — same rules as
// its history line; current-only gauges (funding) count only on the latest day.
function coinScoresIfClosedAt(coin, data, btc, day, price, isLatest) {
  const d = closedAt(coin, data, day, price);
  if (!d) return null;
  const c = buildContext(coin, d, btc);
  const D = c.n - 1;
  const defs = INDICATORS.filter((def) => !def.needsMvrv || c.mvrv.some((v) => v != null));
  const list = defs.map((def) => ({ def, scores: { [D]: def.currentOnly && !isLatest ? null : scoreFrom(def.bp, def.compute(c)[D]) } }));
  const l = composite('lth', list, D);
  const s = composite('sth', list, D);
  return { lth: l.coverage >= 0.6 ? l.score : null, sth: s.coverage >= 0.6 ? s.score : null };
}

// US spot ETF flows for coins marked `etf` in coins.js (context only, see etf.js).
// Without a SoSoValue key the source is not loaded at all, so the page shows how to add one.
function etfOf(coin, data, status, c) {
  if (!coin.etf) return null;
  const key = `etf-${coin.symbol}`;
  if (!(key in data)) return { asset: coin.symbol, needsKey: true };
  const src = data[key];
  if (!src?.t?.length) return { asset: coin.symbol, error: status.find((s) => s.key === key)?.error || 'ยังไม่มีข้อมูล' };
  const at = new Map(c.dates.map((d, i) => [d, c.price[i]]));
  const rows = src.t.flatMap((d, i) => (at.get(d) > 0 && src.flow[i] != null ? [{ d, flow: src.flow[i], aum: src.aum[i], cum: src.cum[i], price: at.get(d) }] : []));
  try {
    return buildEtf(rows, { round, asset: coin.symbol, source: 'SoSoValue' });
  } catch (err) {
    return { asset: coin.symbol, error: err.message };
  }
}

function buildCoin(coin, data, status, btc) {
  const c = buildContext(coin, data, btc);
  const last = c.n - 1;
  const defs = INDICATORS.filter((def) => !def.needsMvrv || c.mvrv.some((v) => v != null));
  const list = defs.map((def) => {
    const values = def.compute(c);
    return { def, values, scores: values.map((v) => scoreFrom(def.bp, v)) };
  });

  const lth = new Array(c.n);
  const sth = new Array(c.n);
  for (let i = 0; i < c.n; i++) {
    const l = composite('lth', list, i);
    const s = composite('sth', list, i);
    lth[i] = l.coverage >= 0.6 ? l.score : null;
    sth[i] = s.coverage >= 0.6 ? s.score : null;
  }

  const summary = (horizon, scoreNow) => {
    const members = list.filter((x) => x.def.weights[horizon]);
    const scored = members.filter((x) => x.scores[last] != null);
    return {
      score: round(scoreNow, 4),
      label: scoreLabel(scoreNow),
      used: scored.length,
      total: members.length,
      bullish: scored.filter((x) => x.scores[last] >= 60).length,
      bearish: scored.filter((x) => x.scores[last] < 40).length,
    };
  };

  // Evidence from this coin's own history.
  const xs = [];
  const ys = [];
  for (let i = 0; i + LTH_HORIZON < c.n; i++) {
    if (lth[i] != null) { xs.push(lth[i]); ys.push(Math.log(c.price[i + LTH_HORIZON] / c.price[i])); }
  }
  const rho = spearman(xs, ys);
  const firstScored = c.dates[lth.findIndex((v) => v != null)] || c.dates[0];
  const firstYear = Number(firstScored.slice(0, 4));
  const years = DCA_START_YEARS
    .filter((y) => y > firstYear)
    .map((year) => ({ year, run: dcaRun(c.dates, c.price, lth, `${year}-01-01`) }))
    .filter((x) => x.run)
    .map((x) => ({ year: x.year, edge: round(x.run.edge, 3) }));
  const edges = years.map((y) => y.edge);
  const dca = edges.length
    ? { years, avgEdge: round(edges.reduce((a, b) => a + b, 0) / edges.length, 3), best: Math.max(...edges), worst: Math.min(...edges) }
    : null;
  const plainFrom = c.dates[0] > '2021-01-01' ? c.dates[0] : '2021-01-01';
  const plain = dcaRun(c.dates, c.price, new Array(c.n).fill(null), plainFrom);
  const reliability = reliabilityOf(coin.symbol, rho, dca);

  const evLth = evidenceSection(c.price, lth, LTH_HORIZON, '1 ปี', 75, LTH_BUCKETS);
  const evSth = evidenceSection(c.price, sth, STH_HORIZON, '30 วัน', 80, STH_BUCKETS);
  const up = (s) => (s.n ? `${Math.round(s.upPct)}%` : '–');
  const lowBucket = evLth.buckets[0];
  const verdict = [
    { b: reliability.title, t: reliability.text },
    evLth.strong.n >= 30
      ? { b: 'คะแนนระยะยาว 75 ขึ้นไป', t: `1 ปีถัดไป ${coin.symbol} ขึ้น ${up(evLth.strong)} ของครั้ง (ค่ากลาง ${signed(evLth.strong.median)}) เทียบทุกช่วง ${up(evLth.baseline)} (${signed(evLth.baseline.median)})` }
      : { b: 'คะแนนระยะยาว 75 ขึ้นไป', t: `${coin.symbol} ยังมีช่วงคะแนนสูงที่ครบ 1 ปีให้วัดไม่พอ` },
    ...(lowBucket.n >= 30 ? [{ b: 'คะแนนระยะยาวต่ำกว่า 30', t: `1 ปีถัดไปขึ้นเพียง ${up(lowBucket)} ของครั้ง (ค่ากลาง ${signed(lowBucket.median)})` }] : []),
    { b: 'คะแนนระยะสั้นใช้จับจังหวะไม่ได้', t: `ทดสอบรวม 16 เหรียญแล้ว RSI / Bollinger / ระยะห่างจากเส้น 50 วัน ไม่ช่วยทำนายราคา 30 วันถัดไป${evSth.strong.n >= 30 ? ` (${coin.symbol}: คะแนน 80+ ขึ้น ${up(evSth.strong)} ของครั้ง เทียบปกติ ${up(evSth.baseline)})` : ''} — ใช้ดูสภาวะตลาดเท่านั้น` },
    { b: 'คะแนนสูงไม่ได้รับประกันว่าจะฟื้น', t: 'เหรียญที่อยู่ top 10 วันนี้คือเหรียญที่รอดมาได้ เหรียญที่เคยอยู่ top 10 แล้วหลุดไป (DOT, AVAX, SHIB) ได้คะแนนสูงแล้วยังขาดทุนต่อก็มี' },
  ];

  const recentStart = Math.max(0, c.n - RECENT_DAYS);
  const lastValid = (arr) => {
    for (let i = arr.length - 1; i >= Math.max(0, arr.length - 15); i--) if (arr[i] != null) return i;
    return -1;
  };
  const indicators = list.map(({ def, values, scores }) => {
    const li = lastValid(values);
    const value = li >= 0 ? values[li] : null;
    const scoredHere = def.weights.lth > 0 || def.weights.sth > 0;
    const score = li >= 0 && scoredHere ? scores[li] : null;
    return {
      id: def.id,
      name: def.name,
      category: def.category,
      weights: def.weights,
      showIn: def.showIn || null,
      refLines: def.refLines || null,
      desc: def.desc,
      guide: def.guide,
      value: round(value),
      valueText: def.format(value),
      extra: li >= 0 && def.extra ? def.extra(c, li) : null,
      score: round(score, 3),
      label: scoredHere ? scoreLabel(score) : { text: 'ข้อมูลประกอบ', tone: 'na' },
      asOf: li >= 0 ? c.dates[li] : null,
      history: def.currentOnly ? null : values.slice(recentStart).map((v) => round(v, 4)),
    };
  });

  const dashboard = {
    asset: 'alt',
    symbol: coin.symbol,
    name: coin.name,
    display: { title: `${coin.name} (${coin.symbol})`, priceLabel: `${coin.symbol} / USD` },
    generatedAt: new Date().toISOString(),
    price: { usd: c.price[last], changePct: c.tick?.changePct ?? null, date: c.dates[last], source: 'Binance' },
    composite: { lth: summary('lth', lth[last]), sth: summary('sth', sth[last]) },
    indicators,
    recentDates: c.dates.slice(recentStart),
    history: {
      dates: c.dates,
      price: c.price.map((v) => round(v, 6)),
      lth: lth.map((v) => round(v, 3)),
      sth: sth.map((v) => round(v, 3)),
    },
    evidence: {
      since: Number(c.dates[0].slice(0, 4)),
      assetName: coin.symbol,
      title: 'ข้อสรุปก่อนใช้คะแนน',
      subtitle: `จากประวัติของ ${coin.symbol} เองตั้งแต่ปี ${c.dates[0].slice(0, 4)}`,
      verdict,
      lth: evLth,
      sth: evSth,
      dca,
    },
    reliability,
    backtest: { unit: coin.symbol, assetLabel: ` ${coin.symbol} `, perLabel: ` ${coin.symbol}` },
    siblings: COINS.map((x) => ({ symbol: x.symbol, name: x.name })),
    macro: null,
    etf: etfOf(coin, data, status, c),
    sources: status.filter((s) => s.coin === coin.symbol || s.key === 'alt-tickers'),
  };

  const row = {
    symbol: coin.symbol,
    name: coin.name,
    price: c.price[last],
    changePct: c.tick?.changePct ?? null,
    lth: dashboard.composite.lth,
    sth: dashboard.composite.sth,
    drawdown: round(c.drawdown[last], 3),
    mvrv: round(c.mvrv[last], 3),
    reliability,
    spearman: round(rho, 2),
    dcaEdge: dca ? dca.avgEdge : null,
    plainDca: plain ? { from: plainFrom.slice(0, 7), roi: round(plain.plainRoi, 3) } : null,
    since: c.dates[0],
  };
  return { dashboard, row, series: { price: c.price, lth } };
}

// ---------- all coins ----------

function buildAlts({ data, status }, btc) {
  const coins = {};
  const rows = [];
  const pooledPrice = [];
  const pooledScores = [];

  for (const coin of COINS) {
    try {
      const built = buildCoin(coin, data, status, btc);
      coins[coin.symbol] = built.dashboard;
      rows.push(built.row);
      pooledPrice.push(built.series.price);
      pooledScores.push(built.series.lth);
    } catch (err) {
      console.warn(`[alts] ${coin.symbol}: ${err.message}`);
      rows.push({ symbol: coin.symbol, name: coin.name, error: err.message });
    }
  }

  // Full history of every coin for the per-coin charts on the overview page.
  // Dates are sent once as a shared daily axis; each coin says where on that
  // axis its own (shorter) series begins.
  const histories = Object.values(coins).map((d) => d.history);
  const chart = { dates: [], coins: {} };
  if (histories.length) {
    const firstMs = Math.min(...histories.map((h) => toMs(h.dates[0])));
    const lastMs = Math.max(...histories.map((h) => toMs(h.dates[h.dates.length - 1])));
    for (let ms = firstMs; ms <= lastMs; ms += DAY_MS) chart.dates.push(isoDate(ms));
    for (const [symbol, d] of Object.entries(coins)) {
      const h = d.history;
      const start = Math.round((toMs(h.dates[0]) - firstMs) / DAY_MS);
      const contiguous = toMs(h.dates[h.dates.length - 1]) - toMs(h.dates[0]) === (h.dates.length - 1) * DAY_MS;
      if (contiguous) {
        chart.coins[symbol] = { start, price: h.price, lth: h.lth, sth: h.sth };
      } else {
        // A gap in the exchange's daily candles: place each value by its date instead.
        const index = new Map(h.dates.map((x, i) => [x, i]));
        const pick = (arr) => chart.dates.slice(start).map((x) => (index.has(x) ? arr[index.get(x)] : null));
        chart.coins[symbol] = { start, price: pick(h.price), lth: pick(h.lth), sth: pick(h.sth) };
      }
    }
  }
  const bh = btc.history;

  // Pooled evidence across the listed coins: score bucket → price 1 year later.
  const pooled = LTH_BUCKETS.map(([label, lo, hi]) => {
    const out = [];
    pooledPrice.forEach((price, k) => {
      const scores = pooledScores[k];
      for (let i = 0; i + LTH_HORIZON < price.length; i++) {
        if (scores[i] != null && scores[i] >= lo && scores[i] < hi) out.push((price[i + LTH_HORIZON] / price[i] - 1) * 100);
      }
    });
    out.sort((a, b) => a - b);
    return {
      label,
      n: out.length,
      median: out.length ? round(out[Math.floor(out.length / 2)], 3) : null,
      upPct: out.length ? round((100 * out.filter((x) => x > 0).length) / out.length, 3) : null,
    };
  });

  return {
    overview: {
      generatedAt: new Date().toISOString(),
      btc: {
        price: btc.price.usd,
        lth: btc.composite.lth,
        sth: btc.composite.sth,
        drawdown: round((btc.price.usd / Math.max(...bh.price) - 1) * 100, 3),
      },
      coins: rows,
      chart,
      pooled,
      sources: status.filter((s) => s.key === 'alt-tickers' || /^alt-hist-/.test(s.key)),
    },
    coins,
  };
}

module.exports = { buildAlts, coinScoresIfClosedAt, INDICATORS };
