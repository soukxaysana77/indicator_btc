'use strict';
// Gold dashboard engine. Same output shape as the BTC dashboard, different logic.
//
// Research on 2003–2026 daily data (both halves agree) showed gold does NOT
// reward "buy cheap vs its averages" over a 1-year horizon — it trends:
//   • long-term: forward returns are higher when price is above its 200-day
//     average, 12-month momentum is positive and real yields are high; they
//     are poor in downtrends and when price is extremely extended.
//   • short-term (≈20 days): mean reversion only at the extremes — deep dips
//     below the 50-day average bounce, spikes above it fade.
// So the long-term score is "trend + macro support" and the short-term score
// is contrarian.

const { scoreFrom, sma, rollingStd, wilderRsi, round } = require('./indicators');

const DAY_MS = 86400000;
const HISTORY_START = '2004-01-01';
const RECENT_DAYS = 1008; // ≈ 4 years of trading days
const BAHT_GOLD_GRAMS = 15.244; // one Thai baht-weight of gold bar
const THAI_PURITY = 0.965;
const TROY_OUNCE_GRAMS = 31.1035;

const toMs = (d) => Date.parse(`${d}T00:00:00Z`);
const usd = (v) => (v == null ? '–' : `$${Math.round(v).toLocaleString('en-US')}`);
const signed = (v, d = 1, unit = '%') => (v == null ? '–' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}${unit}`);

const LABELS = {
  trend: [[80, 'แนวโน้มแข็งแรงมาก', 'strong-buy'], [60, 'น่าสะสม', 'buy'], [40, 'เป็นกลาง', 'neutral'], [20, 'แนวโน้มอ่อน', 'sell'], [-Infinity, 'ขาลง / ชะลอซื้อ', 'strong-sell']],
  contra: [[80, 'ย่อลึก น่าซื้อ', 'strong-buy'], [60, 'ย่อตัว', 'buy'], [40, 'เป็นกลาง', 'neutral'], [20, 'เริ่มยืดตัว', 'sell'], [-Infinity, 'ร้อนแรง / ระวัง', 'strong-sell']],
};

function labelOf(kind, s) {
  if (s == null) return { text: 'ไม่มีข้อมูล', tone: 'na' };
  const [, text, tone] = LABELS[kind].find(([min]) => s >= min);
  return { text, tone };
}

// Latest observation of `series` ({ d|t: dates, v|c: values }, sorted) known on
// each of `dates`: obsDate + lagDays ≤ date, and no older than maxDays.
function align(dates, series, maxDays, lagDays = 0) {
  const out = new Array(dates.length).fill(null);
  const sd = series?.d || series?.t;
  const sv = series?.v || series?.c;
  if (!sd?.length) return out;
  const obsMs = sd.map((d) => toMs(d) + lagDays * DAY_MS);
  let j = -1;
  for (let i = 0; i < dates.length; i++) {
    const ms = toMs(dates[i]);
    while (j + 1 < obsMs.length && obsMs[j + 1] <= ms) j++;
    if (j >= 0 && ms - obsMs[j] <= maxDays * DAY_MS) out[i] = sv[j];
  }
  return out;
}

// Share of the trailing window (weekly samples) below today's value, 0–100.
function trailingPercentile(values, windowDays = 2520, minSamples = 150, step = 5) {
  return values.map((x, i) => {
    if (x == null) return null;
    let lower = 0;
    let count = 0;
    for (let j = step; j <= windowDays && i - j >= 0; j += step) {
      const y = values[i - j];
      if (y == null) continue;
      count++;
      if (y < x) lower++;
    }
    return count < minSamples ? null : (100 * lower) / count;
  });
}

const div = (a, b) => a.map((v, i) => (v != null && b[i] ? v / b[i] : null));
const pctChange = (a, k) => a.map((v, i) => (i >= k && v != null && a[i - k] ? (v / a[i - k] - 1) * 100 : null));

function buildContext(data) {
  const hist = data['yahoo-gold'];
  if (!hist?.t?.length) throw new Error('ยังไม่มีข้อมูลราคาทองคำ (ตรวจสอบอินเทอร์เน็ต)');
  const dates = hist.t.slice();
  const price = hist.c.slice();

  // Freshest print: replace today's bar or append a new trading day.
  const quote = data['yahoo-gold-quote'];
  if (quote?.price > 0 && quote.date) {
    if (quote.date > dates[dates.length - 1]) { dates.push(quote.date); price.push(quote.price); }
    else if (quote.date === dates[dates.length - 1]) price[price.length - 1] = quote.price;
  }

  const n = dates.length;
  const cache = new Map();
  const memo = (key, fn) => {
    if (!cache.has(key)) cache.set(key, fn());
    return cache.get(key);
  };
  const fred = data['fred-gold'] || {};
  const c = {
    data,
    dates,
    price,
    n,
    quote,
    memo,
    sma: (k) => memo(`sma${k}`, () => sma(price, k)),
    silver: align(dates, data['yahoo-silver'], 5),
    realYield: align(dates, fred.DFII10, 7),
    cpi: align(dates, fred.CPIAUCSL, 75, 45), // monthly, published ~6 weeks later
  };
  let ath = 0;
  c.athIdx = new Array(n);
  let athAt = 0;
  c.drawdown = price.map((v, i) => {
    if (v > ath) { ath = v; athAt = i; }
    c.athIdx[i] = athAt;
    return (v / ath - 1) * 100;
  });
  return c;
}

function cotSeries(c) {
  return c.memo('cot', () => {
    const rows = c.data['cftc-cot-gold'];
    const empty = new Array(c.n).fill(null);
    if (!rows?.length) return { net: empty, pct: empty, rows: empty };
    const valid = rows.filter((r) => r.oi > 0);
    const series = { d: valid.map((r) => r.d), v: valid.map((r) => ((r.long - r.short) / r.oi) * 100) };
    const net = align(c.dates, series, 14, 4); // Tuesday data, released Friday
    const raw = align(c.dates, { d: valid.map((r) => r.d), v: valid }, 14, 4);
    return { net, pct: trailingPercentile(net, 756, 60), rows: raw };
  });
}

// weights: contribution to the LTH (trend + macro) / STH (contrarian) score.
// labels: which label set describes this indicator's score.
const INDICATORS = [
  {
    id: 'mom250',
    name: 'โมเมนตัม 12 เดือน',
    category: 'แนวโน้ม',
    labels: 'trend',
    weights: { lth: 2, sth: 0 },
    bp: [[-15, 15], [-6, 25], [0, 45], [6, 60], [12, 80], [30, 85], [45, 65]],
    format: (v) => signed(v),
    desc: 'ราคาทองเปลี่ยนไปกี่ % ใน 12 เดือน (250 วันทำการ) — ทองเป็นสินทรัพย์ที่วิ่งตามแนวโน้ม โมเมนตัมบวกมักไปต่อ',
    guide: 'ติดลบเกิน −6% = ขาลง (1 ปีถัดไปในอดีตเฉลี่ยไม่ขึ้น) · +11% ถึง +34% = ช่วงดีที่สุด · เกิน +45% เริ่มร้อนเกิน',
    compute: (c) => pctChange(c.price, 250),
  },
  {
    id: 'mayer',
    name: 'ราคาเทียบเส้น 200 วัน',
    category: 'แนวโน้ม',
    labels: 'trend',
    weights: { lth: 2, sth: 0 },
    bp: [[0.9, 25], [1, 40], [1.03, 70], [1.1, 85], [1.2, 75], [1.35, 55]],
    format: (v) => (v == null ? '–' : `${v.toFixed(3)}×`),
    desc: 'ราคาหารด้วยเส้นค่าเฉลี่ย 200 วัน — เหนือเส้น = ขาขึ้น ในอดีตช่วงที่ราคาอยู่เหนือเส้น 2–14% ให้ผลตอบแทน 1 ปีถัดไปดีที่สุด',
    guide: '< 1× ต่ำกว่าเส้น (แนวโน้มอ่อน) · 1.02–1.14× ขาขึ้นแข็งแรง · > 1.2× ยืดมาก',
    compute: (c) => div(c.price, c.sma(200)),
    extra: (c, i) => `เส้น 200 วัน: ${usd(c.sma(200)[i])}`,
  },
  {
    id: 'ext200w',
    name: 'ราคาเทียบเส้น 200 สัปดาห์',
    category: 'แนวโน้ม',
    labels: 'trend',
    weights: { lth: 1.5, sth: 0 },
    bp: [[0.85, 20], [0.92, 35], [1.04, 55], [1.24, 80], [1.4, 85], [1.5, 55], [1.65, 30]],
    format: (v) => (v == null ? '–' : `${v.toFixed(2)}×`),
    desc: 'ราคาเทียบค่าเฉลี่ย 4 ปี (1,000 วันทำการ) — บอกทั้งแนวโน้มใหญ่และการยืดตัวเกินไป: ต่ำกว่าเส้นคือขาลงใหญ่ แต่สูงเกิน 1.5 เท่าในอดีตผลตอบแทนปีถัดไปก็แย่',
    guide: '< 0.92× ขาลงใหญ่ · 1.04–1.4× ขาขึ้น · > 1.5× ยืดเกิน (เสี่ยงพักฐานยาว)',
    compute: (c) => div(c.price, c.sma(1000)),
    extra: (c, i) => `เส้น 200 สัปดาห์: ${usd(c.sma(1000)[i])} · 1.5× = ${usd(c.sma(1000)[i] * 1.5)}`,
  },
  {
    id: 'ddath',
    name: 'ห่างจากจุดสูงสุดตลอดกาล',
    category: 'แนวโน้ม',
    labels: 'trend',
    weights: { lth: 1, sth: 0 },
    bp: [[-45, 35], [-30, 25], [-20, 45], [-10, 55], [-5, 80], [0, 85]],
    format: (v) => (v == null ? '–' : v > -0.05 ? 'ที่จุดสูงสุด' : `${v.toFixed(1)}%`),
    desc: 'ราคาต่ำกว่าจุดสูงสุดตลอดกาล (ATH) กี่ % — ใกล้ ATH คือขาขึ้นยังไม่เสีย ในอดีตช่วงที่ห่างไม่เกิน 7% ราคาขึ้นต่อใน 1 ปีถัดไป 84–92% ของครั้ง',
    guide: '0 ถึง −7% ขาขึ้นแข็งแรง · −10% ถึง −27% พักฐาน · ราว −30% ในอดีตคือกลางตลาดหมี',
    compute: (c) => c.drawdown,
    extra: (c, i) => `จุดสูงสุด ${usd(c.price[c.athIdx[i]])} (${c.dates[c.athIdx[i]]})`,
  },
  {
    id: 'realyield',
    name: 'Real Yield 10 ปี (สหรัฐฯ)',
    category: 'เศรษฐกิจมหภาค',
    labels: 'trend',
    weights: { lth: 2, sth: 0 },
    bp: [[-1, 10], [0, 25], [0.5, 40], [1, 65], [1.6, 85], [2.2, 92]],
    format: (v) => (v == null ? '–' : `${v.toFixed(2)}%`),
    desc: 'ผลตอบแทนพันธบัตรสหรัฐฯ 10 ปีหลังหักเงินเฟ้อ (TIPS) — ในข้อมูล 2003–2026 ระดับที่สูงตามมาด้วยผลตอบแทนทองที่ดีใน 1 ปีถัดไป (ดอกเบี้ยมีที่ให้ลดลง) ส่วนช่วง real yield ติดลบทองมักขึ้นไปมากแล้ว',
    guide: 'ติดลบ = ทองมักใกล้อิ่มตัว · > 1% หนุนทองในอดีต · ข้อควรระวัง: มีรอบให้ดูเพียง ~3 รอบ',
    compute: (c) => c.realYield,
    extra: (c, i) => {
      const prev = i >= 65 ? c.realYield[i - 65] : null;
      return prev == null || c.realYield[i] == null ? null : `เปลี่ยนแปลง 3 เดือน: ${signed(c.realYield[i] - prev, 2, ' จุด')}`;
    },
  },
  {
    id: 'gsr',
    name: 'อัตราส่วนทอง/เงิน (Gold/Silver)',
    category: 'เศรษฐกิจมหภาค',
    labels: 'trend',
    weights: { lth: 1, sth: 0 },
    bp: [[50, 45], [60, 50], [75, 50], [80, 70], [86, 90], [95, 95]],
    format: (v) => (v == null ? '–' : v.toFixed(1)),
    desc: 'ทอง 1 ออนซ์แลกเงินได้กี่ออนซ์ — ค่าสูงมากเกิดตอนตลาดกลัว (คนทิ้งเงิน ถือทอง) ซึ่งในอดีตเป็นจุดเริ่มรอบขาขึ้นของโลหะมีค่า',
    guide: '< 75 ปกติ ไม่มีสัญญาณ · > 80 เริ่มน่าสนใจ · > 86 ในอดีตทองขึ้นต่อใน 1 ปีถัดไป 98% ของครั้ง',
    compute: (c) => div(c.price, c.silver),
    extra: (c, i) => (c.silver[i] == null ? null : `ราคาเงิน: $${c.silver[i].toFixed(2)}`),
  },
  {
    id: 'd50',
    name: 'ระยะห่างจากเส้น 50 วัน',
    category: 'จังหวะระยะสั้น',
    labels: 'contra',
    weights: { lth: 0, sth: 3 },
    bp: [[0.92, 100], [0.94, 92], [0.97, 72], [1, 55], [1.03, 45], [1.06, 28], [1.08, 12], [1.12, 0]],
    format: (v) => (v == null ? '–' : signed((v - 1) * 100)),
    desc: 'ราคาห่างจากเส้นค่าเฉลี่ย 50 วันกี่ % — ตัวจับจังหวะระยะสั้นที่ได้ผลที่สุดกับทอง แต่เฉพาะตอนสุดขั้ว',
    guide: 'ต่ำกว่า −6% = ย่อลึก (20 วันถัดไปเฉลี่ย +4.2% ขึ้น 78% ของครั้ง) · สูงกว่า +8% = ยืดเกิน (เฉลี่ย −1.3% ขึ้นแค่ 40%) · ช่วงกลางไม่มีความได้เปรียบ',
    compute: (c) => div(c.price, c.sma(50)),
    extra: (c, i) => `เส้น 50 วัน: ${usd(c.sma(50)[i])}`,
  },
  {
    id: 'rsi14',
    name: 'RSI รายวัน (14D)',
    category: 'จังหวะระยะสั้น',
    labels: 'contra',
    weights: { lth: 0, sth: 2 },
    bp: [[20, 100], [30, 88], [40, 68], [50, 52], [60, 42], [70, 28], [80, 8], [88, 0]],
    format: (v) => (v == null ? '–' : v.toFixed(1)),
    desc: 'Relative Strength Index 14 วัน — วัดแรงซื้อ/แรงขายระยะสั้น',
    guide: '< 30 ขายมากเกินไป (20 วันถัดไปขึ้น 69% ของครั้ง) · > 80 ซื้อมากเกินไป (ขึ้น 44%)',
    compute: (c) => wilderRsi(c.price, 14).out,
  },
  {
    id: 'bbpb',
    name: 'Bollinger Bands %B (20D)',
    category: 'จังหวะระยะสั้น',
    labels: 'contra',
    weights: { lth: 0, sth: 1 },
    bp: [[-0.1, 100], [0, 90], [0.2, 72], [0.5, 50], [0.8, 30], [1, 12], [1.15, 0]],
    format: (v) => (v == null ? '–' : v.toFixed(2)),
    desc: 'ตำแหน่งราคาในกรอบ Bollinger Bands (20 วัน, 2σ): 0 = ขอบล่าง, 1 = ขอบบน',
    guide: '< 0.2 ใกล้ขอบล่าง · 0.5 กลางกรอบ · > 0.8 ใกล้ขอบบน',
    compute: (c) => {
      const mid = c.sma(20);
      const sd = rollingStd(c.price, 20);
      return c.price.map((p, i) => (mid[i] != null && sd[i] ? (p - (mid[i] - 2 * sd[i])) / (4 * sd[i]) : null));
    },
  },
  {
    id: 'd100',
    name: 'ระยะห่างจากเส้น 20 สัปดาห์',
    category: 'จังหวะระยะสั้น',
    labels: 'contra',
    weights: { lth: 0, sth: 1 },
    bp: [[0.9, 100], [0.94, 85], [0.98, 65], [1.02, 50], [1.08, 32], [1.14, 12], [1.2, 0]],
    format: (v) => (v == null ? '–' : signed((v - 1) * 100)),
    desc: 'ราคาห่างจากเส้นค่าเฉลี่ย 20 สัปดาห์ (100 วันทำการ) — ดูการย่อ/ยืดตัวในกรอบ 1–3 เดือน',
    guide: 'ต่ำกว่า −6% ย่อลึก · ±2% ปกติ · สูงกว่า +14% ยืดเกิน',
    compute: (c) => div(c.price, c.sma(100)),
    extra: (c, i) => `เส้น 20 สัปดาห์: ${usd(c.sma(100)[i])}`,
  },
  {
    // Display-only: gold is expensive vs inflation for long stretches of every
    // bull market; as a signal it tested as momentum, not as value.
    id: 'realgold',
    name: 'ราคาทองหลังหักเงินเฟ้อ (เทียบ 10 ปี)',
    category: 'มูลค่า',
    labels: 'trend',
    weights: { lth: 0, sth: 0 },
    showIn: ['lth'],
    bp: [[10, 50], [50, 50], [100, 50]],
    format: (v) => (v == null ? '–' : `เปอร์เซ็นไทล์ ${Math.round(v)}`),
    desc: 'ราคาทองหารดัชนีเงินเฟ้อสหรัฐฯ (CPI) เทียบกับช่วง 10 ปีที่ผ่านมา: 100 = แพงที่สุดในรอบ 10 ปี · แสดงเป็นข้อมูลประกอบ ไม่คิดคะแนน เพราะในอดีตทอง "แพง" ได้นานหลายปีระหว่างขาขึ้น จึงใช้จับจังหวะไม่ได้',
    guide: 'ใช้ดูว่าราคาปัจจุบันสูง/ต่ำแค่ไหนเมื่อเทียบค่าเงินที่เสื่อมลง ไม่ใช่สัญญาณซื้อขาย',
    compute: (c) => c.memo('realgoldpct', () => trailingPercentile(div(c.price, c.cpi))),
  },
  {
    // Display-only: its relationship with forward returns flipped sign between
    // 2006–2014 and 2015–2026, so it is context, not a scored signal.
    id: 'cot',
    name: 'สถานะกองทุนในตลาดล่วงหน้า (COT)',
    category: 'Sentiment',
    labels: 'contra',
    weights: { lth: 0, sth: 0 },
    showIn: ['sth'],
    bp: [[0, 50], [50, 50]],
    format: (v) => (v == null ? '–' : `Net Long ${v.toFixed(1)}% ของ OI`),
    desc: 'สถานะซื้อสุทธิของกองทุน (Managed Money) ในทองคำ COMEX เทียบสัญญาคงค้างทั้งหมด จากรายงาน CFTC รายสัปดาห์ · แสดงเป็นข้อมูลประกอบ ไม่คิดคะแนน เพราะความสัมพันธ์กับราคาไม่คงที่ระหว่างช่วงเวลา',
    guide: 'ค่าสูง = กองทุนถือ Long เยอะ (คนแน่น) · ค่าต่ำ = กองทุนถอยออก',
    compute: (c) => cotSeries(c).net,
    extra: (c, i) => {
      const { pct, rows } = cotSeries(c);
      const r = rows[i];
      if (!r) return null;
      return `Long ${r.long.toLocaleString('en-US')} · Short ${r.short.toLocaleString('en-US')} สัญญา (${r.d})${pct[i] == null ? '' : ` · เทียบ 3 ปี: เปอร์เซ็นไทล์ ${Math.round(pct[i])}`}`;
    },
  },
];

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

// ---------- historical evidence (shown on the page so the scores are not taken on faith) ----------

// Score-weighted DCA rule used by the backtest panel and the verdict card.
const BACKTEST_TIERS = [
  { min: 70, mult: 1.5, tone: 'strong-buy', text: 'คะแนน ≥ 70 → ซื้อ 1.5×' },
  { min: 55, mult: 1, tone: 'buy', text: '55–70 → ซื้อ 1×' },
  { min: 40, mult: 0.5, tone: 'neutral', text: '40–55 → ซื้อ 0.5×' },
  { min: 0, mult: 0.25, tone: 'sell', text: '< 40 → ซื้อ 0.25× ที่เหลือเก็บเป็นเงินสด' },
];
const DCA_START_YEARS = [2005, 2008, 2011, 2013, 2016, 2019, 2021, 2023];

function forwardStats(history, key, horizon, test) {
  const { price } = history;
  const scores = history[key];
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

// Monthly deposits into a cash pool; the score decides how much of it to deploy.
// Returns the % difference in final portfolio value versus plain monthly DCA.
function dcaEdge(history, startYear) {
  const { dates, price, lth } = history;
  let plainUnits = 0;
  let units = 0;
  let cash = 0;
  let month = null;
  for (let i = 0; i < dates.length; i++) {
    if (dates[i] < `${startYear}-01-01` || dates[i].slice(0, 7) === month) continue;
    month = dates[i].slice(0, 7);
    plainUnits += 100 / price[i];
    cash += 100;
    const mult = lth[i] == null ? 1 : BACKTEST_TIERS.find((t) => lth[i] >= t.min).mult;
    const buy = Math.min(cash, 100 * mult);
    cash -= buy;
    units += buy / price[i];
  }
  const last = price[price.length - 1];
  return plainUnits ? ((units * last + cash) / (plainUnits * last) - 1) * 100 : null;
}

function buildEvidence(history) {
  const section = (key, horizonDays, horizonText, strongMin, defs) => ({
    horizonDays,
    horizonText,
    strongMin,
    baseline: forwardStats(history, key, horizonDays, () => true),
    strong: forwardStats(history, key, horizonDays, (v) => v >= strongMin),
    buckets: defs.map(([label, lo, hi]) => ({ label, ...forwardStats(history, key, horizonDays, (v) => v >= lo && v < hi) })),
  });
  const firstYear = Number(history.dates[0].slice(0, 4));
  const lastYear = Number(history.dates[history.dates.length - 1].slice(0, 4));
  const years = DCA_START_YEARS.filter((y) => y > firstYear && y <= lastYear - 2).map((year) => ({ year, edge: round(dcaEdge(history, year), 3) }));
  const edges = years.map((y) => y.edge);
  const lth = section('lth', 250, '1 ปี', 70, [['ต่ำกว่า 40', 0, 40], ['40–60', 40, 60], ['60–70', 60, 70], ['70–80', 70, 80], ['80 ขึ้นไป', 80, 101]]);
  const sth = section('sth', 20, '20 วันทำการ', 80, [['ต่ำกว่า 30 (ยืดตัว)', 0, 30], ['30–60', 30, 60], ['60–80 (ย่อตัว)', 60, 80], ['80 ขึ้นไป (ย่อลึก)', 80, 101]]);
  const dca = edges.length
    ? { years, avgEdge: round(edges.reduce((a, b) => a + b, 0) / edges.length, 3), best: Math.max(...edges), worst: Math.min(...edges) }
    : null;
  const up = (s) => (s.n ? `${Math.round(s.upPct)}%` : '–');
  const verdict = [
    ...(dca ? [{
      b: dca.avgEdge < 0 ? 'DCA ปกติชนะการจับจังหวะ' : 'DCA ตามคะแนนเคยได้ผลดีกว่า',
      t: `ซื้อมาก-น้อยตามคะแนนได้มูลค่าพอร์ต${dca.avgEdge < 0 ? 'น้อยกว่า' : 'มากกว่า'} DCA ปกติเฉลี่ย ${Math.abs(dca.avgEdge).toFixed(1)}% (ทดสอบ ${years.length} ปีเริ่มต้น ผลต่างอยู่ระหว่าง ${signed(dca.worst)} ถึง ${signed(dca.best)})`,
    }] : []),
    { b: `คะแนนระยะยาว ${lth.strongMin} ขึ้นไป เชื่อได้`, t: `1 ปีถัดไปทองขึ้น ${up(lth.strong)} ของครั้ง (ค่ากลาง ${signed(lth.strong.median)}) เทียบทุกช่วง ${up(lth.baseline)} (${signed(lth.baseline.median)})` },
    { b: `คะแนนระยะสั้น ${sth.strongMin} ขึ้นไป (ย่อลึก)`, t: `20 วันทำการถัดไปขึ้น ${up(sth.strong)} ของครั้ง (ค่ากลาง ${signed(sth.strong.median)}) เทียบปกติ ${up(sth.baseline)} (${signed(sth.baseline.median)}) — เหมาะกับเงินก้อนที่รอจังหวะ ไม่ใช่เงิน DCA` },
    { b: 'คะแนนต่ำไม่ใช่สัญญาณขาย', t: 'ผลหลังคะแนนต่ำไม่คงที่ระหว่างช่วงเวลา จึงใช้บอกแค่ว่า "ยังไม่มีแรงหนุน"' },
  ];
  return {
    since: firstYear,
    assetName: 'ทอง',
    title: 'ข้อสรุปก่อนใช้คะแนน',
    subtitle: 'ทองคำไม่เหมือน Bitcoin — คะแนนมีความหมายแค่บางช่วง',
    verdict,
    lth,
    sth,
    dca,
  };
}

// ---------- the 24-hour chart: scores if a day had closed at another price ----------

// Gold's long/short scores on trading day `day` had it settled at `price`, by
// the same rules as the history line (data up to that day only).
function goldScoresIfClosedAt(data, day, price) {
  const hist = data['yahoo-gold'];
  if (!hist?.t?.length) return null;
  const k = hist.t.indexOf(day);
  const quote = data['yahoo-gold-quote'];
  let gold;
  if (k >= 0) gold = { t: hist.t.slice(0, k + 1), c: [...hist.c.slice(0, k), price] };
  else if (quote?.date === day && day > hist.t[hist.t.length - 1]) gold = { t: [...hist.t, day], c: [...hist.c, price] };
  else return null;
  const c = buildContext({ ...data, 'yahoo-gold': gold, 'yahoo-gold-quote': null });
  const D = c.n - 1;
  const list = INDICATORS.map((def) => ({ def, scores: { [D]: scoreFrom(def.bp, def.compute(c)[D]) } }));
  const l = composite('lth', list, D);
  const s = composite('sth', list, D);
  return { lth: l.coverage >= 0.6 ? l.score : null, sth: s.coverage >= 0.6 ? s.score : null };
}

function buildGold({ data, status }) {
  const c = buildContext(data);
  const last = c.n - 1;

  const list = INDICATORS.map((def) => {
    const values = def.compute(c);
    return { def, values, scores: values.map((v) => scoreFrom(def.bp, v)) };
  });

  const summary = (horizon, kind) => {
    const { score } = composite(horizon, list, last);
    const members = list.filter((x) => x.def.weights[horizon]);
    const scored = members.filter((x) => x.scores[last] != null);
    return {
      score: round(score, 4),
      label: labelOf(kind, score),
      used: scored.length,
      total: members.length,
      bullish: scored.filter((x) => x.scores[last] >= 60).length,
      bearish: scored.filter((x) => x.scores[last] < 40).length,
    };
  };

  const start = Math.max(0, c.dates.findIndex((d) => d >= HISTORY_START));
  const history = { dates: [], price: [], lth: [], sth: [] };
  for (let i = start; i < c.n; i++) {
    const l = composite('lth', list, i);
    const s = composite('sth', list, i);
    history.dates.push(c.dates[i]);
    history.price.push(round(c.price[i], 6));
    history.lth.push(l.coverage >= 0.6 ? round(l.score, 3) : null);
    history.sth.push(s.coverage >= 0.6 ? round(s.score, 3) : null);
  }

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
      label: scoredHere ? labelOf(def.labels, score) : { text: 'ข้อมูลประกอบ', tone: 'na' },
      asOf: li >= 0 ? c.dates[li] : null,
      history: values.slice(recentStart).map((v) => round(v, 4)),
    };
  });

  const quote = c.quote;
  const fx = data['yahoo-thb']?.price || null;
  const spot = c.price[last];
  return {
    asset: 'gold',
    generatedAt: new Date().toISOString(),
    price: {
      usd: spot,
      changePct: quote?.prevClose ? (quote.price / quote.prevClose - 1) * 100 : null,
      date: c.dates[last],
      source: 'COMEX Gold Futures (Yahoo Finance)',
    },
    thai: fx
      ? { thbPerUsd: round(fx, 5), barPerBaht: Math.round((spot * fx * BAHT_GOLD_GRAMS * THAI_PURITY) / TROY_OUNCE_GRAMS) }
      : null,
    composite: { lth: summary('lth', 'trend'), sth: summary('sth', 'contra') },
    indicators,
    recentDates: c.dates.slice(recentStart),
    history,
    evidence: buildEvidence(history),
    backtest: { unit: 'oz', assetLabel: 'ทองคำ', perLabel: 'ออนซ์', tiers: BACKTEST_TIERS },
    macro: null,
    sources: status,
  };
}

module.exports = { buildGold, goldScoresIfClosedAt, INDICATORS };
