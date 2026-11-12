'use strict';
// Turns raw source data into indicator values, 0–100 "attractiveness" scores
// (100 = very cheap / strong accumulation zone, 0 = overheated) and weighted
// composites for long-term (LTH) and short-term (STH) holders.

const { buildMacro } = require('./macro');
const { buildStablecoins } = require('./stablecoins');
const { buildCostBasis } = require('./costbasis');
const { buildEtf } = require('./etf');
const { buildRealizedPnl } = require('./realizedpnl');
const { buildBottomCheck } = require('./bottomcheck');
const { buildHalving } = require('./halving');
const { buildCredit } = require('./credit');

const DAY_MS = 86400000;
const GENESIS_MS = Date.UTC(2009, 0, 3);
const HISTORY_START = '2012-01-01';
const RECENT_DAYS = 1461;

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const toMs = (d) => Date.parse(`${d}T00:00:00Z`);

// ---------- series helpers (arrays aligned to ctx.dates, null = no value) ----------

function sma(a, n) {
  const out = new Array(a.length).fill(null);
  let sum = 0;
  let valid = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] != null) { sum += a[i]; valid++; }
    if (i >= n && a[i - n] != null) { sum -= a[i - n]; valid--; }
    if (valid === n) out[i] = sum / n;
  }
  return out;
}

function rollingStd(a, n) {
  const out = new Array(a.length).fill(null);
  let sum = 0;
  let sumSq = 0;
  let valid = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] != null) { sum += a[i]; sumSq += a[i] * a[i]; valid++; }
    if (i >= n && a[i - n] != null) { sum -= a[i - n]; sumSq -= a[i - n] * a[i - n]; valid--; }
    if (valid === n) {
      const mean = sum / n;
      out[i] = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
    }
  }
  return out;
}

const rsiValue = (gain, loss) => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));

// Wilder RSI; also returns the running average gain/loss so callers can
// evaluate an in-progress bar.
function wilderRsi(a, n = 14) {
  const out = new Array(a.length).fill(null);
  const ag = new Array(a.length).fill(null);
  const al = new Array(a.length).fill(null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < a.length; i++) {
    const ch = a[i] - a[i - 1];
    const g = Math.max(ch, 0);
    const l = Math.max(-ch, 0);
    if (i <= n) {
      gain += g; loss += l;
      if (i === n) { gain /= n; loss /= n; }
      else continue;
    } else {
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
    }
    ag[i] = gain; al[i] = loss; out[i] = rsiValue(gain, loss);
  }
  return { out, ag, al };
}

function ffill(a, maxGap = Infinity) {
  let last = null;
  let gap = 0;
  return a.map((v) => {
    if (v != null && Number.isFinite(v)) { last = v; gap = 0; return v; }
    gap++;
    return gap <= maxGap ? last : null;
  });
}

const div = (a, b, k = 1) => a.map((v, i) => (v != null && b[i] ? v / (b[i] * k) : null));

function scoreFrom(bp, v) {
  if (v == null || !Number.isFinite(v)) return null;
  if (v <= bp[0][0]) return bp[0][1];
  for (let i = 1; i < bp.length; i++) {
    if (v <= bp[i][0]) {
      const [x0, s0] = bp[i - 1];
      const [x1, s1] = bp[i];
      return s0 + ((s1 - s0) * (v - x0)) / (x1 - x0);
    }
  }
  return bp[bp.length - 1][1];
}

function scoreLabel(s) {
  if (s == null) return { text: 'ไม่มีข้อมูล', tone: 'na' };
  if (s >= 80) return { text: 'น่าซื้อสะสมมาก', tone: 'strong-buy' };
  if (s >= 60) return { text: 'น่าสะสม', tone: 'buy' };
  if (s >= 40) return { text: 'เป็นกลาง', tone: 'neutral' };
  if (s >= 20) return { text: 'ค่อนข้างแพง', tone: 'sell' };
  return { text: 'ร้อนแรง / ระวัง', tone: 'strong-sell' };
}

// ---------- context: extend CoinMetrics history with live Binance prices ----------

function buildContext(data) {
  const cm = data.coinmetrics;
  if (!cm) throw new Error('ยังไม่มีข้อมูลราคาย้อนหลังจาก CoinMetrics (ตรวจสอบอินเทอร์เน็ต)');

  const dates = cm.t.slice();
  const price = cm.price.slice();
  const mcap = cm.mcap.slice();
  const mvrv = cm.mvrv.slice();
  const iss = cm.iss.slice();
  const hash = cm.hash.slice();

  const live = new Map();
  for (const k of data['binance-klines'] || []) live.set(k.date, k.close);
  const ticker = data['binance-ticker'];
  if (ticker?.price) live.set(isoDate(Date.now()), ticker.price);

  // Only append contiguous days after the CoinMetrics history (keeps day-based MAs honest).
  let lastMs = toMs(dates[dates.length - 1]);
  for (;;) {
    const next = isoDate(lastMs + DAY_MS);
    if (!live.has(next)) break;
    dates.push(next);
    price.push(live.get(next));
    mcap.push(null); mvrv.push(null); iss.push(null); hash.push(null);
    lastMs += DAY_MS;
  }
  // Freshest print for the latest day.
  const n = dates.length;
  if (ticker?.price && isoDate(Date.now()) === dates[n - 1]) price[n - 1] = ticker.price;

  const supply = ffill(mcap.map((m, i) => (m != null ? m / price[i] : null)));
  const realcap = ffill(mcap.map((m, i) => (m != null && mvrv[i] ? m / mvrv[i] : null)));
  const realPrice = realcap.map((r, i) => (r != null && supply[i] ? r / supply[i] : null));
  const mcapFull = price.map((p, i) => (supply[i] != null ? p * supply[i] : null));

  const index = new Map(dates.map((d, i) => [d, i]));
  const cache = new Map();
  const memo = (key, fn) => {
    if (!cache.has(key)) cache.set(key, fn());
    return cache.get(key);
  };

  return {
    data,
    dates,
    n,
    index,
    price,
    mcap: mcapFull,
    realcap,
    realPrice,
    iss: ffill(iss, 7),
    hash: ffill(hash, 7),
    ticker,
    sma: (n2) => memo(`sma${n2}`, () => sma(price, n2)),
    memo,
  };
}

// Realized price series from a bitcoin-data.com MVRV series, projected onto
// live prices (realized price moves slowly, price does not).
function cohortMvrv(c, key, field) {
  return c.memo(`cohort-${key}`, () => {
    const rows = c.data[key];
    // Source down (e.g. bitcoin-data.com rate-limits the shared IPs of a host
    // like Render): the indicator shows no data instead of breaking the page.
    if (!Array.isArray(rows)) return { mvrv: new Array(c.n).fill(null), realizedPrice: new Array(c.n).fill(null) };
    const realized = new Array(c.n).fill(null);
    for (const r of rows) {
      const i = c.index.get(r.d);
      if (i != null && r[field]) realized[i] = c.price[i] / r[field];
    }
    const rp = ffill(realized, 14);
    return { mvrv: div(c.price, rp), realizedPrice: rp };
  });
}

// Expanding log-log regression: each day's z-score uses only prices up to that
// day, so the history carries no look-ahead. After the loop a/b are the
// full-sample fit, used for today's fair value.
// Long-term-holder supply (BTC) aligned to ctx dates, and how far it sits
// below its trailing 365-day peak. Distance from peak ≈ how much LTHs have
// distributed: historically > 8% below peak preceded weak 1-year returns.
function lthSupply(c) {
  return c.memo('lthsupply', () => {
    const src = c.data['brk-lth-supply'];
    const empty = new Array(c.n).fill(null);
    if (!src?.v?.length) return { supply: empty, dd: empty, peakIdx: empty };
    const byDate = new Map();
    const t0 = toMs(src.start);
    src.v.forEach((v, i) => { if (v > 0) byDate.set(isoDate(t0 + i * DAY_MS), v); });
    const supply = ffill(c.dates.map((d) => (byDate.has(d) ? byDate.get(d) : null)), 3);
    const dd = new Array(c.n).fill(null);
    const peakIdx = new Array(c.n).fill(null);
    for (let i = 365; i < c.n; i++) {
      if (supply[i] == null) continue;
      let best = -1;
      for (let j = i - 365; j <= i; j++) if (supply[j] != null && (best < 0 || supply[j] > supply[best])) best = j;
      dd[i] = (supply[i] / supply[best] - 1) * 100;
      peakIdx[i] = best;
    }
    return { supply, dd, peakIdx };
  });
}

function powerLaw(c) {
  return c.memo('powerlaw', () => {
    const days = c.dates.map((d) => (toMs(d) - GENESIS_MS) / DAY_MS);
    let k = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    let a = 0;
    let b = 0;
    const z = c.price.map((p, i) => {
      if (!(p > 0)) return null;
      const x = Math.log10(days[i]);
      const y = Math.log10(p);
      k++; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
      if (k < 730) return null;
      b = (k * sxy - sx * sy) / (k * sxx - sx * sx);
      a = (sy - b * sx) / k;
      const ss = syy - 2 * a * sy - 2 * b * sxy + k * a * a + 2 * a * b * sx + b * b * sxx;
      return (y - (a + b * x)) / Math.sqrt(Math.max(ss, 1e-12) / k);
    });
    const fair = days.map((d) => 10 ** (a + b * Math.log10(d)));
    return { z, fair };
  });
}

// Cycle peaks get lower each cycle, so fixed thresholds alone stop flagging
// tops. Long-term indicators blend in how cheap today is versus the trailing
// 8 years (weekly samples): 100 = lower than every value in the window.
// 70/30 fixed/trailing was picked by backtesting score-weighted DCA.
const ADAPTIVE_WINDOW_DAYS = 2922;
const ADAPTIVE_WEIGHT = 0.3;

function cheapnessAt(values, i, windowDays = ADAPTIVE_WINDOW_DAYS, step = 7, minSamples = 104) {
  const x = values[i];
  if (x == null) return null;
  let higher = 0;
  let equal = 0;
  let count = 0;
  for (let j = step; j <= windowDays && i - j >= 0; j += step) {
    const y = values[i - j];
    if (y == null) continue;
    count++;
    if (y > x) higher++;
    else if (y === x) equal++;
  }
  return count < minSamples ? null : (100 * (higher + 0.5 * equal)) / count;
}

const trailingCheapness = (values) => values.map((x, i) => cheapnessAt(values, i));

const usd = (v) => (v == null ? '–' : `$${Math.round(v).toLocaleString('en-US')}`);
const fx = (d) => (v) => (v == null ? '–' : v.toFixed(d));

// ---------- indicator catalogue ----------
// weights: contribution to the LTH / STH composite (0 = not used).
// bp: piecewise-linear breakpoints [value, score].

const INDICATORS = [
  {
    id: 'mvrvz',
    name: 'MVRV Z-Score',
    category: 'On-chain',
    weights: { lth: 3, sth: 0 },
    bp: [[-0.5, 100], [0, 95], [1, 80], [2, 62], [3.5, 38], [5.5, 12], [7, 0]],
    format: fx(2),
    desc: 'วัดว่ามูลค่าตลาด (Market Cap) สูงกว่ามูลค่าต้นทุนรวมของผู้ถือทุกคน (Realized Cap) กี่เท่าของส่วนเบี่ยงเบนมาตรฐาน',
    guide: '< 0 ก้นรอบ · 0–2 สะสม · 2–5 เริ่มแพง · > 7 ฟองสบู่',
    compute: (c) => {
      let k = 0; let s = 0; let s2 = 0;
      return c.mcap.map((m, i) => {
        if (m == null) return null;
        k++; s += m; s2 += m * m;
        const sd = Math.sqrt(Math.max(0, s2 / k - (s / k) ** 2));
        return k > 30 && sd > 0 && c.realcap[i] != null ? (m - c.realcap[i]) / sd : null;
      });
    },
  },
  {
    id: 'nupl',
    name: 'NUPL (Net Unrealized Profit/Loss)',
    category: 'On-chain',
    weights: { lth: 2, sth: 0 },
    bp: [[-0.1, 100], [0, 95], [0.25, 72], [0.45, 45], [0.6, 20], [0.75, 0]],
    format: fx(3),
    desc: 'สัดส่วนกำไร/ขาดทุนที่ยังไม่ได้ขายของทั้งตลาด บอกอารมณ์ของผู้ถือเหรียญ',
    guide: '< 0 ยอมแพ้ · 0–0.25 ความหวัง · 0.25–0.5 มองบวก · 0.5–0.75 โลภ · > 0.75 ยูโฟเรีย',
    compute: (c) => c.mcap.map((m, i) => (m && c.realcap[i] != null ? 1 - c.realcap[i] / m : null)),
  },
  {
    // Display-only: MVRV is the same information as NUPL (NUPL = 1 − 1/MVRV),
    // so it is shown for the "stop accumulating above 2–2.5" rule without being scored twice.
    id: 'mvrv',
    name: 'MVRV (ราคาตลาด ÷ ต้นทุนเฉลี่ย)',
    category: 'On-chain',
    weights: { lth: 0, sth: 0 },
    showIn: ['lth'],
    refLines: [2, 2.5],
    bp: [[0.8, 100], [1, 92], [1.5, 72], [2, 45], [2.5, 20], [3.5, 0]],
    format: (v) => (v == null ? '–' : `${v.toFixed(2)}×`),
    desc: 'ราคา BTC เทียบต้นทุนเฉลี่ยของทุกเหรียญในระบบ (Realized Price) — 1.0 = ราคาเท่าต้นทุนตลาด ใช้กับกฎ "หยุดสะสมเมื่อ MVRV เกิน 2–2.5" · แสดงอย่างเดียว ไม่นำไปคิดคะแนนรวมเพราะซ้ำกับ NUPL',
    guide: '< 1 ก้นรอบ · 1–2 โซนสะสม · 2–2.5 เริ่มหยุดสะสม · > 3 ยูโฟเรีย',
    compute: (c) => c.mcap.map((m, i) => (m && c.realcap[i] ? m / c.realcap[i] : null)),
    extra: (c, i) => `ต้นทุนเฉลี่ยตลาด ${usd(c.realPrice[i])} · MVRV 2.0 ที่ราคา ${usd(c.realPrice[i] * 2)} · 2.5 ที่ ${usd(c.realPrice[i] * 2.5)}`,
  },
  {
    id: 'puell',
    name: 'Puell Multiple',
    category: 'On-chain',
    weights: { lth: 1.5, sth: 0 },
    bp: [[0.45, 100], [0.6, 90], [0.9, 65], [1.3, 45], [2, 25], [3.5, 0]],
    format: fx(2),
    desc: 'มูลค่าเหรียญที่นักขุดได้รับต่อวัน เทียบค่าเฉลี่ย 365 วัน — ต่ำ = นักขุดถูกกดดัน มักเป็นโซนสะสม',
    guide: '< 0.5 โซนซื้อ · 0.5–1.5 ปกติ · > 3.5 นักขุดทำกำไรสูงสุด (ใกล้ยอด)',
    compute: (c) => div(c.iss, c.memo('iss365', () => sma(c.iss, 365))),
  },
  {
    id: 'wma200',
    name: '200-Week Moving Average',
    category: 'วัฏจักรราคา',
    weights: { lth: 2, sth: 0 },
    bp: [[0.9, 100], [1.1, 90], [1.6, 65], [2.5, 40], [4, 15], [6, 0]],
    format: (v) => (v == null ? '–' : `${v.toFixed(2)}×`),
    desc: 'ราคาเทียบเส้นค่าเฉลี่ย 200 สัปดาห์ ซึ่งในอดีตเป็นแนวรับของก้นตลาดหมีเกือบทุกรอบ',
    guide: '≤ 1× ก้นรอบ · 1–2× สะสม · > 4× ร้อนแรง',
    compute: (c) => div(c.price, c.sma(1400)),
    extra: (c, i) => `เส้น 200W MA: ${usd(c.sma(1400)[i])}`,
  },
  {
    id: 'ma2y',
    name: '2-Year MA Multiplier',
    category: 'วัฏจักรราคา',
    weights: { lth: 1.5, sth: 0 },
    bp: [[0.8, 100], [1, 90], [1.6, 65], [2.5, 40], [3.5, 15], [5, 0]],
    format: (v) => (v == null ? '–' : `${v.toFixed(2)}×`),
    desc: 'ราคาเทียบเส้นค่าเฉลี่ย 2 ปี: ต่ำกว่าเส้น = โซนซื้อ, เกิน 5 เท่าของเส้น = โซนขายในอดีต',
    guide: '< 1× ซื้อ · 1–3× ปกติ · ≥ 5× ขาย',
    compute: (c) => div(c.price, c.sma(730)),
    extra: (c, i) => `2Y MA: ${usd(c.sma(730)[i])} · 2Y MA×5: ${usd(c.sma(730)[i] * 5)}`,
  },
  {
    id: 'mayer',
    name: 'Mayer Multiple',
    category: 'วัฏจักรราคา',
    weights: { lth: 1.5, sth: 1 },
    bp: [[0.6, 100], [0.8, 90], [1, 70], [1.3, 50], [1.8, 25], [2.4, 0]],
    format: fx(2),
    desc: 'ราคาหารด้วยเส้นค่าเฉลี่ย 200 วัน — วัดว่าราคายืดห่างจากแนวโน้มหลักแค่ไหน',
    guide: '< 0.8 ถูกมาก · 0.8–1.3 ปกติ · > 2.4 ฟองสบู่',
    compute: (c) => div(c.price, c.sma(200)),
    extra: (c, i) => `200D MA: ${usd(c.sma(200)[i])}`,
  },
  {
    id: 'pi',
    name: 'Pi Cycle Top Indicator',
    category: 'วัฏจักรราคา',
    weights: { lth: 1, sth: 0 },
    bp: [[0.45, 100], [0.6, 80], [0.75, 55], [0.88, 25], [1, 0]],
    format: fx(3),
    desc: 'อัตราส่วน MA 111 วัน ต่อ 2×MA 350 วัน — เมื่อแตะ 1.0 ในอดีตตรงกับยอดรอบใหญ่ภายในไม่กี่วัน',
    guide: 'ยิ่งเข้าใกล้ 1.0 ยิ่งเสี่ยงเป็นยอด',
    compute: (c) => div(c.sma(111), c.sma(350), 2),
    extra: (c, i) => `111D MA: ${usd(c.sma(111)[i])} · 350D MA×2: ${usd(c.sma(350)[i] * 2)}`,
  },
  {
    id: 'powerlaw',
    name: 'Power Law / Rainbow Band',
    category: 'วัฏจักรราคา',
    weights: { lth: 2, sth: 0 },
    bp: [[-1.5, 100], [-0.8, 85], [0, 60], [0.8, 35], [1.5, 12], [2.2, 0]],
    format: (v) => (v == null ? '–' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}σ`),
    desc: 'ระยะห่างของราคาจากเส้นแนวโน้ม Power Law (log-log regression ของราคาทั้งประวัติ) คล้าย Rainbow Chart',
    guide: '< −1σ ถูกมาก · ใกล้ 0 ราคายุติธรรม · > +1.5σ แพงมาก',
    compute: (c) => powerLaw(c).z,
    extra: (c, i) => `ราคายุติธรรมตามโมเดล: ${usd(powerLaw(c).fair[i])}`,
  },
  {
    id: 'ahr999',
    name: 'AHR999 Index',
    category: 'วัฏจักรราคา',
    weights: { lth: 1.5, sth: 0 },
    bp: [[0.45, 100], [0.8, 80], [1.2, 60], [2, 40], [3.5, 15], [5, 0]],
    format: fx(2),
    desc: '(ราคา ÷ ต้นทุน DCA 200 วัน) × (ราคา ÷ ราคาประเมินตามอายุ Bitcoin) — ดัชนียอดนิยมสำหรับสาย DCA',
    guide: '< 0.45 ช้อนก้น · 0.45–1.2 เหมาะ DCA · > 1.2 รอ/ถือ',
    compute: (c) => {
      const lnSma = sma(c.price.map((p) => Math.log(p)), 200);
      return c.price.map((p, i) => {
        if (lnSma[i] == null) return null;
        const days = (toMs(c.dates[i]) - GENESIS_MS) / DAY_MS;
        const fitted = 10 ** (5.84 * Math.log10(days) - 17.01);
        return (p / Math.exp(lnSma[i])) * (p / fitted);
      });
    },
  },
  {
    id: 'lthmvrv',
    name: 'LTH-MVRV (ผู้ถือระยะยาว)',
    category: 'On-chain',
    weights: { lth: 1.5, sth: 0 },
    bp: [[0.9, 100], [1.2, 85], [1.6, 65], [2.5, 45], [3.5, 25], [5, 8], [6, 0]],
    format: fx(2),
    desc: 'ราคาเทียบต้นทุนเฉลี่ยของผู้ถือระยะยาว (ถือเกิน ~155 วัน) — ใกล้ 1 แปลว่า LTH แทบไม่มีกำไร มักเป็นก้นรอบ',
    guide: '< 1 ก้นรอบ · 1–2 สะสม · > 3.5 LTH เริ่มขายทำกำไรหนัก',
    compute: (c) => cohortMvrv(c, 'bitcoin-data-lth-mvrv', 'lthMvrv').mvrv,
    extra: (c, i) => `ต้นทุนเฉลี่ย LTH: ${usd(cohortMvrv(c, 'bitcoin-data-lth-mvrv', 'lthMvrv').realizedPrice[i])}`,
  },
  {
    // Display-only: adding it to the LTH composite did not improve the DCA
    // backtest (its signal overlaps MVRV/NUPL and plays out over ~1 year).
    id: 'lthsupply',
    name: 'LTH Supply (ผู้ถือระยะยาวสะสม/ขายออก)',
    category: 'On-chain',
    weights: { lth: 0, sth: 0 },
    showIn: ['lth'],
    adaptive: false,
    refLines: [-8],
    bp: [[-25, 0], [-18, 5], [-12, 20], [-8, 40], [-6, 55], [-3, 68], [-1, 78], [0, 85]],
    format: (v) => (v == null ? '–' : v > -0.05 ? 'ที่ยอด 1 ปี' : `${v.toFixed(1)}% จากยอด`),
    desc: 'จำนวน BTC ที่ผู้ถือระยะยาว (ถือเกิน ~155 วัน) ถืออยู่ เทียบกับยอดสูงสุดใน 1 ปี — ลดลงจากยอด = มือแข็งเริ่มขายออกให้มือใหม่ ในอดีตยอดราคามักมาตอนขายออกไปมากแล้ว · แสดงอย่างเดียว ไม่คิดคะแนนรวม',
    guide: 'ใกล้ยอด = ยังสะสม · −1% ถึง −8% เริ่มขายออก (ราคามักยังไปต่อ) · ต่ำกว่า −8% ขายออกหนัก (ในอดีต BTC 1 ปีถัดไปค่ากลาง −16%)',
    compute: (c) => lthSupply(c).dd,
    extra: (c, i) => {
      const { supply, dd, peakIdx } = lthSupply(c);
      const m = (v) => `${(v / 1e6).toFixed(2)}M`;
      const p = peakIdx[i];
      const d30 = i >= 30 && supply[i - 30] != null ? supply[i] - supply[i - 30] : null;
      const status = dd[i] > -1 ? 'สะสม / ใกล้ยอด' : dd[i] > -8 ? 'เริ่มขายออก' : 'ขายออกหนัก';
      return `ถืออยู่ ${m(supply[i])} BTC · ยอด 1 ปี ${m(supply[p])} (${c.dates[p]}) · เปลี่ยนจากยอด ${m(supply[i] - supply[p])}${d30 == null ? '' : ` · 30 วัน ${d30 >= 0 ? '+' : ''}${m(d30)}`} · สถานะ: ${status}`;
    },
  },
  {
    id: 'wrsi',
    name: 'RSI รายสัปดาห์ (14W)',
    category: 'โมเมนตัม',
    weights: { lth: 1.5, sth: 0.5 },
    bp: [[30, 100], [40, 85], [50, 65], [60, 50], [70, 30], [80, 12], [90, 0]],
    format: fx(1),
    desc: 'RSI 14 สัปดาห์ — ต่ำกว่า 30 เกิดเฉพาะก้นตลาดหมี, เกิน 85 มักอยู่ใกล้ยอดตลาดกระทิง',
    guide: '< 35 ก้นรอบ · 50–70 ปกติ · > 85 ร้อนแรงสุด',
    compute: (c) => {
      // Weekly bars close on Sunday (UTC); days mid-week use the in-progress bar.
      const closeIdx = [];
      c.dates.forEach((d, i) => { if (new Date(toMs(d)).getUTCDay() === 0) closeIdx.push(i); });
      const { out, ag, al } = wilderRsi(closeIdx.map((i) => c.price[i]), 14);
      const res = new Array(c.n).fill(null);
      let k = -1; // last completed weekly close strictly before day i
      for (let i = 0; i < c.n; i++) {
        while (k + 1 < closeIdx.length && closeIdx[k + 1] < i) k++;
        if (closeIdx[k + 1] === i) { res[i] = out[k + 1]; continue; }
        if (k < 0 || ag[k] == null) continue;
        const ch = c.price[i] - c.price[closeIdx[k]];
        res[i] = rsiValue((ag[k] * 13 + Math.max(ch, 0)) / 14, (al[k] * 13 + Math.max(-ch, 0)) / 14);
      }
      return res;
    },
  },
  {
    id: 'hashribbon',
    name: 'Hash Ribbons (30D/60D)',
    category: 'On-chain',
    weights: { lth: 0.5, sth: 0 },
    bp: [[0.93, 95], [1, 70], [1.05, 50], [1.15, 40]],
    format: fx(3),
    desc: 'MA30 ของ Hashrate เทียบ MA60 — ต่ำกว่า 1 = นักขุดยอมแพ้ (capitulation) ซึ่งช่วงฟื้นตัวหลังจากนั้นมักเป็นจุดซื้อที่ดี',
    guide: '< 1 นักขุดยอมแพ้ (โอกาสสะสม) · > 1 ปกติ',
    compute: (c) => c.memo('hr', () => div(sma(c.hash, 30), sma(c.hash, 60))),
    extra: (c, i) => {
      const v = c.memo('hr', () => div(sma(c.hash, 30), sma(c.hash, 60)));
      const recent = v.slice(Math.max(0, i - 30), i + 1);
      if (v[i] != null && v[i] < 1) return 'สถานะ: นักขุดกำลังยอมแพ้ (Capitulation)';
      if (recent.some((x) => x != null && x < 1)) return 'สถานะ: เพิ่งฟื้นจาก Capitulation — สัญญาณซื้อ';
      return 'สถานะ: ปกติ';
    },
  },
  {
    id: 'fng',
    name: 'Crypto Fear & Greed Index',
    category: 'Sentiment',
    weights: { lth: 0.5, sth: 2 },
    bp: [[10, 100], [25, 85], [45, 60], [55, 45], [75, 15], [90, 0]],
    format: fx(0),
    desc: 'ดัชนีความกลัว/ความโลภของตลาด (alternative.me) — ใช้แบบสวนทาง: กลัวสุดขีด = โอกาส, โลภสุดขีด = ระวัง',
    guide: '0–25 กลัวสุดขีด · 25–45 กลัว · 45–55 กลาง · 55–75 โลภ · 75–100 โลภสุดขีด',
    compute: (c) => {
      const rows = c.data['fear-greed'];
      if (!rows) return new Array(c.n).fill(null);
      const m = new Map(rows.map((r) => [r.date, r.value]));
      return ffill(c.dates.map((d) => (m.has(d) ? m.get(d) : null)), 2);
    },
  },
  {
    id: 'sthmvrv',
    name: 'STH-MVRV (ผู้ถือระยะสั้น)',
    category: 'On-chain',
    weights: { lth: 0, sth: 3 },
    bp: [[0.8, 100], [0.9, 88], [1, 70], [1.1, 52], [1.25, 30], [1.4, 10], [1.5, 0]],
    format: fx(3),
    desc: 'ราคาเทียบต้นทุนเฉลี่ยของผู้ถือระยะสั้น (ถือไม่ถึง ~155 วัน) — ต่ำกว่า 1 = คนเพิ่งเข้าติดดอย มักเป็นจุดเด้ง',
    guide: '< 0.9 ถูกมาก · ~1.0 แนวรับ/ต้าน · > 1.35 ร้อนแรงระยะสั้น',
    compute: (c) => cohortMvrv(c, 'bitcoin-data-sth-mvrv', 'sthMvrv').mvrv,
    extra: (c, i) => `ต้นทุนเฉลี่ย STH: ${usd(cohortMvrv(c, 'bitcoin-data-sth-mvrv', 'sthMvrv').realizedPrice[i])}`,
  },
  {
    id: 'rsi14',
    name: 'RSI รายวัน (14D)',
    category: 'โมเมนตัม',
    weights: { lth: 0, sth: 2 },
    bp: [[20, 100], [30, 88], [40, 70], [50, 52], [60, 38], [70, 15], [80, 0]],
    format: fx(1),
    desc: 'Relative Strength Index 14 วัน — วัดแรงซื้อ/แรงขายระยะสั้น',
    guide: '< 30 ขายมากเกินไป (Oversold) · > 70 ซื้อมากเกินไป (Overbought)',
    compute: (c) => wilderRsi(c.price, 14).out,
  },
  {
    id: 'funding',
    name: 'Funding Rate (เฉลี่ย 3 วัน)',
    category: 'Derivatives',
    weights: { lth: 0, sth: 1.5 },
    bp: [[-0.03, 100], [-0.005, 85], [0.005, 65], [0.01, 50], [0.03, 25], [0.06, 5], [0.1, 0]],
    format: (v) => (v == null ? '–' : `${v >= 0 ? '+' : ''}${v.toFixed(4)}%`),
    desc: 'ค่า Funding ของสัญญา BTC Perpetual จาก Binance หรือ OKX (ต่อ 8 ชม.) — ติดลบ = คน Short เยอะ มักเกิด Short Squeeze',
    guide: '< 0% ตลาดกลัว (น่าซื้อ) · 0.01% ปกติ · > 0.05% Long ล้นตลาด',
    currentOnly: true,
    compute: (c) => {
      const rows = c.data['binance-funding'];
      const out = new Array(c.n).fill(null);
      if (rows?.length) {
        const last = rows.slice(-9);
        out[c.n - 1] = (last.reduce((s, r) => s + r.rate, 0) / last.length) * 100;
      }
      return out;
    },
  },
  {
    id: 'bbpb',
    name: 'Bollinger Bands %B (20D)',
    category: 'โมเมนตัม',
    weights: { lth: 0, sth: 1.5 },
    bp: [[-0.1, 100], [0, 92], [0.2, 78], [0.5, 50], [0.8, 22], [1, 8], [1.1, 0]],
    format: fx(2),
    desc: 'ตำแหน่งราคาในกรอบ Bollinger Bands (20 วัน, 2σ): 0 = ขอบล่าง, 1 = ขอบบน',
    guide: '< 0.2 ใกล้ขอบล่าง · 0.5 กลางกรอบ · > 0.8 ใกล้ขอบบน',
    compute: (c) => {
      const mid = c.sma(20);
      const sd = rollingStd(c.price, 20);
      return c.price.map((p, i) => (mid[i] != null && sd[i] ? (p - (mid[i] - 2 * sd[i])) / (4 * sd[i]) : null));
    },
  },
  {
    id: 'sma20w',
    name: 'Bull Market Support Band (20W SMA)',
    category: 'วัฏจักรราคา',
    weights: { lth: 0, sth: 1.5 },
    bp: [[0.8, 100], [0.9, 85], [1, 65], [1.1, 45], [1.25, 22], [1.45, 0]],
    format: (v) => (v == null ? '–' : `${v.toFixed(3)}×`),
    desc: 'ราคาเทียบ SMA 20 สัปดาห์ — ยืนเหนือเส้น = แนวโน้มกระทิง แต่ถ้าห่างมากคือยืดตัวเกินไป',
    guide: '< 1× หลุดแนวรับ (ราคาถูกลง) · 1–1.1× ใกล้แนวรับ · > 1.3× ยืดเกิน',
    compute: (c) => div(c.price, c.sma(140)),
    extra: (c, i) => `20W SMA: ${usd(c.sma(140)[i])}`,
  },
  {
    id: 'sma50',
    name: 'ระยะห่างจาก 50D MA',
    category: 'โมเมนตัม',
    weights: { lth: 0, sth: 1.5 },
    bp: [[0.8, 100], [0.9, 85], [1, 58], [1.1, 32], [1.2, 12], [1.3, 0]],
    format: (v) => (v == null ? '–' : `${v >= 1 ? '+' : ''}${((v - 1) * 100).toFixed(1)}%`),
    desc: 'ราคาห่างจากเส้นค่าเฉลี่ย 50 วันกี่เปอร์เซ็นต์ — ใช้ดูการยืดตัว/ย่อตัวระยะสั้น',
    guide: '< −10% ย่อลึก · ±5% ปกติ · > +20% ยืดเกิน',
    compute: (c) => div(c.price, c.sma(50)),
    extra: (c, i) => `50D MA: ${usd(c.sma(50)[i])}`,
  },
];

const round = (v, sig = 5) => (v == null || !Number.isFinite(v) ? null : Number(v.toPrecision(sig)));

function composite(horizon, list, i) {
  let sum = 0;
  let w = 0;
  let total = 0;
  let used = 0;
  for (const ind of list) {
    const wt = ind.weights[horizon];
    if (!wt) continue;
    if (ind.currentOnly && i !== list.lastIndex) continue;
    total += wt;
    const s = ind.scores[i];
    if (s == null) continue;
    sum += s * wt; w += wt; used++;
  }
  return { score: w ? sum / w : null, coverage: total ? w / total : 0, used };
}

// ---------- the 24-hour chart: scores if a day had closed at another price ----------

// The raw sources as they would have stood if the daily bar `day` (UTC) had
// closed at `price`: later days dropped, that close replaced, and the fields
// that move with the price (market cap, issuance in USD, the MVRVs) scaled with it.
function closedAt(data, day, price) {
  const cm = data.coinmetrics;
  const out = { ...data, 'binance-ticker': null };
  let close;
  const k = cm.t.indexOf(day);
  if (k >= 0) {
    close = cm.price[k];
    const cut = (a) => a.slice(0, k + 1);
    out.coinmetrics = { t: cut(cm.t), price: cut(cm.price), mcap: cut(cm.mcap), mvrv: cut(cm.mvrv), iss: cut(cm.iss), hash: cut(cm.hash) };
    out.coinmetrics.price[k] = price;
    for (const f of ['mcap', 'mvrv', 'iss']) if (out.coinmetrics[f][k] != null) out.coinmetrics[f][k] *= price / close;
    out['binance-klines'] = [];
  } else {
    // Days after CoinMetrics' latest come from the Binance daily candles.
    const kl = (data['binance-klines'] || []).filter((x) => x.date <= day);
    if (kl[kl.length - 1]?.date !== day) return null;
    close = kl[kl.length - 1].close;
    out['binance-klines'] = [...kl.slice(0, -1), { date: day, close: price }];
  }
  for (const [key, field] of [['bitcoin-data-sth-mvrv', 'sthMvrv'], ['bitcoin-data-lth-mvrv', 'lthMvrv']]) {
    if (Array.isArray(data[key])) out[key] = data[key].map((r) => (r.d === day && r[field] ? { ...r, [field]: r[field] * (price / close) } : r));
  }
  return out;
}

// LTH/STH on `day` had it closed at `price`, by the same rules as the history
// line (data up to that day only; current-only gauges count on the latest day).
// This is what the live page shows for today as the price moves.
function scoresIfClosedAt(data, day, price, isLatest) {
  const d = closedAt(data, day, price);
  if (!d) return null;
  const c = buildContext(d);
  const D = c.n - 1;
  if (c.dates[D] !== day) return null;
  const list = INDICATORS.map((def) => {
    const values = def.compute(c);
    let s = scoreFrom(def.bp, values[D]);
    if (s != null && def.adaptive !== false && def.weights.lth > 0 && !def.currentOnly) {
      const cheap = cheapnessAt(values, D);
      if (cheap != null) s = (1 - ADAPTIVE_WEIGHT) * s + ADAPTIVE_WEIGHT * cheap;
    }
    return { weights: def.weights, currentOnly: def.currentOnly, scores: { [D]: s } };
  });
  list.lastIndex = isLatest ? D : -1;
  const l = composite('lth', list, D);
  const s = composite('sth', list, D);
  return { lth: l.coverage >= 0.6 ? l.score : null, sth: s.coverage >= 0.6 ? s.score : null };
}

const latestDay = (data) => buildContext(data).dates.at(-1);

function buildDashboard({ data, status }) {
  const c = buildContext(data);
  const last = c.n - 1;

  const list = INDICATORS.map((def) => {
    const values = def.compute(c);
    const fixed = values.map((v) => scoreFrom(def.bp, v));
    // trailingCheapness assumes higher value = more expensive; indicators where
    // that is reversed opt out with `adaptive: false`.
    const adaptive = def.adaptive !== false && def.weights.lth > 0 && !def.currentOnly;
    let scores = fixed;
    if (adaptive) {
      const cheap = trailingCheapness(values);
      scores = fixed.map((s, i) => (s == null || cheap[i] == null ? s : (1 - ADAPTIVE_WEIGHT) * s + ADAPTIVE_WEIGHT * cheap[i]));
    }
    return { def, values, scores, adaptive, weights: def.weights, currentOnly: def.currentOnly };
  });
  list.lastIndex = last;

  const summary = (horizon) => {
    const { score, coverage, used } = composite(horizon, list, last);
    const members = list.filter((x) => x.weights[horizon]);
    return {
      score: round(score, 4),
      label: scoreLabel(score),
      used,
      total: members.length,
      coverage: round(coverage, 3),
      bullish: members.filter((x) => x.scores[last] != null && x.scores[last] >= 60).length,
      bearish: members.filter((x) => x.scores[last] != null && x.scores[last] < 40).length,
    };
  };

  // Composite history (needs at least 60% of the weight to be available that day).
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
  const findLastIdx = (arr) => {
    for (let i = arr.length - 1; i >= Math.max(0, arr.length - 15); i--) if (arr[i] != null) return i;
    return -1;
  };

  const indicators = list.map(({ def, values, scores, adaptive }) => {
    const li = findLastIdx(values);
    const value = li >= 0 ? values[li] : null;
    const score = li >= 0 ? scores[li] : null;
    return {
      id: def.id,
      name: def.name,
      category: def.category,
      weights: def.weights,
      adaptive,
      showIn: def.showIn || null,
      refLines: def.refLines || null,
      desc: def.desc,
      guide: def.guide,
      value: round(value),
      valueText: def.format(value),
      extra: li >= 0 && def.extra ? def.extra(c, li) : null,
      score: round(score, 3),
      label: scoreLabel(score),
      asOf: li >= 0 ? c.dates[li] : null,
      history: def.currentOnly ? null : values.slice(recentStart).map((v) => round(v, 4)),
    };
  });

  // Macro gauge is separate from the LTH/STH composites; a FRED outage must not break the page.
  let macro = null;
  if (data.fred) {
    try {
      // The 2-year yield series come from their own source; missing ones just leave that indicator empty.
      macro = buildMacro({ ...data['fred-rates'], ...data.fred }, c, {
        scoreFrom, scoreLabel, round, holdings: data['fred-holdings'], move: data['yahoo-move'], gold: data['yahoo-gold'],
      });
    } catch (err) {
      console.warn('macro build failed:', err.message);
    }
  }

  // Price against the cost lines (STH cost basis, True Market Mean, Howell's $70k) — context only.
  let costBasis = null;
  if (data['brk-cost-basis']) {
    try {
      costBasis = buildCostBasis(data['brk-cost-basis'], c, { round, history });
    } catch (err) {
      console.warn('cost basis build failed:', err.message);
    }
  }

  // Stablecoin supply is context only (not scored) and has its own source.
  let stablecoins = null;
  if (data.stablecoins) {
    try {
      stablecoins = buildStablecoins(data.stablecoins, c, { round });
    } catch (err) {
      console.warn('stablecoin build failed:', err.message);
    }
  }

  // Net realized profit/loss is context only (tested: it does not lead the price).
  let realizedPnl = null;
  if (data['brk-realized-pnl']) {
    try {
      realizedPnl = buildRealizedPnl(data['brk-realized-pnl'], history, { round });
    } catch (err) {
      console.warn('realized P/L build failed:', err.message);
    }
  }

  // Local-bottom checklist (context only, see bottomcheck.js).
  let bottomCheck = null;
  if (data['brk-supply-profit'] && data['brk-cost-basis']) {
    try {
      bottomCheck = buildBottomCheck({ sip: data['brk-supply-profit'], cost: data['brk-cost-basis'], fearGreed: data['fear-greed'] }, history, { round });
    } catch (err) {
      console.warn('bottom checklist build failed:', err.message);
    }
  }

  // US spot ETF flows are context only; the source counts BTC, priced at that day's close.
  let etf = null;
  if (Array.isArray(data['bitcoin-data-etf-flow'])) {
    try {
      const rows = data['bitcoin-data-etf-flow'].flatMap((r) => {
        const i = c.index.get(r.d);
        const units = Number(r.etfFlow);
        return i == null || !Number.isFinite(units) ? [] : [{ d: r.d, units, flow: units * c.price[i], price: c.price[i] }];
      });
      etf = buildEtf(rows, { round, asset: 'Bitcoin', source: 'bitcoin-data.com', unit: 'BTC' });
    } catch (err) {
      console.warn('ETF build failed:', err.message);
    }
  }

  // Halving countdown and block reward (context only; works offline from the clock).
  let halving = null;
  try {
    halving = buildHalving(data['block-height']);
  } catch (err) {
    console.warn('halving build failed:', err.message);
  }

  // Junk-bond spreads (CCC, all high yield) are context only: they move with BTC, not ahead of it.
  let credit = null;
  if (data['fred-credit']) {
    try {
      credit = buildCredit(data['fred-credit'], c, { round });
    } catch (err) {
      console.warn('credit build failed:', err.message);
    }
  }

  const ticker = c.ticker;
  return {
    halving,
    credit,
    macro,
    stablecoins,
    etf,
    realizedPnl,
    bottomCheck,
    costBasis,
    generatedAt: new Date().toISOString(),
    price: {
      usd: c.price[last],
      changePct: ticker?.changePct ?? null,
      date: c.dates[last],
      source: ticker?.source || 'CoinMetrics',
    },
    composite: { lth: summary('lth'), sth: summary('sth') },
    indicators,
    recentDates: c.dates.slice(recentStart),
    history,
    sources: status,
  };
}

module.exports = { buildDashboard, scoresIfClosedAt, latestDay, INDICATORS, scoreFrom, scoreLabel, sma, rollingStd, wilderRsi, round };
