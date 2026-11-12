'use strict';
// "สมุดจดคำทำนาย": price calls from videos (who, when, which asset, up to /
// down to what price, by when), checked against the dashboard's daily closes.
//   hit  — a close reached the target on or before the deadline
//   miss — the deadline passed without it
//   open — still waiting (or no deadline given)
// Daily closes only: an intraday spike that did not hold to the close does not
// count, so the record is on the strict side. Entries live in
// userdata/predictions.json on this computer (gitignored, never uploaded).

const fs = require('fs');
const path = require('path');
const { assetsOf } = require('./sth99');

const DIR = path.join(__dirname, '..', 'userdata');
const FILE = path.join(DIR, 'predictions.json');
const MAX_ENTRIES = 500;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Calls from the videos looked at in this project, written in on first run.
const SEED = [
  { source: 'TonHor Palakorn (อ้างกราฟคุณแพนด้า)', link: 'https://www.youtube.com/watch?v=MlJ5yYFbS8g&t=695s', said: '2026-10-28', asset: 'BTC', kind: 'above', target: 90000, by: '2026-11-17', note: 'ภายใน ~20 วันอาจเจอยอดถัดไปที่ $90,000–95,000' },
  { source: 'TonHor Palakorn (อ้างคุณแฟรงค์)', link: 'https://www.youtube.com/watch?v=MlJ5yYFbS8g&t=1848s', said: '2026-10-28', asset: 'BTC', kind: 'above', target: 100000, by: '2026-12-25', note: 'แสนตอนคริสต์มาส' },
  { source: 'TonHor Palakorn (อ้างสถิติของ Adam)', link: 'https://www.youtube.com/watch?v=MlJ5yYFbS8g&t=2003s', said: '2026-10-28', asset: 'BTC', kind: 'above', target: 124824, by: '2027-07-31', note: 'New High (เกินยอดเดิม $124,824) อีก ~256 วัน คือราว ก.ค. 2027' },
  { source: 'TonHor Palakorn', link: 'https://www.youtube.com/watch?v=MlJ5yYFbS8g&t=2174s', said: '2026-10-28', asset: 'BTC', kind: 'above', target: 140000, by: '2027-12-31', note: 'ถ้าเป็นไปตาม Power Law สิ้นปี 2027 ราคาจะเหนือ $140,000' },
  { source: 'TonHor Palakorn', link: 'https://www.youtube.com/watch?v=ZHeTZ9ECl8s', said: '2026-11-04', asset: 'BTC', kind: 'above', target: 124824, by: '2027-08-31', note: 'New High ราว ส.ค. 2027' },
  { source: 'Bitcoin Addict (Behind The Crypto EP.34)', link: 'https://www.youtube.com/watch?v=zAXZa6E-Ml0', said: '2026-11-09', asset: 'BTC', kind: 'above', target: 100000, by: '2026-12-31', note: 'ถ้ายืน $75,000–76,000 ได้ มีโอกาสไป $100,000 ปลายปีนี้ (จากคำอธิบายคลิป)' },
];

let nextId = 1;
const newId = () => `p${Date.now().toString(36)}${(nextId++).toString(36)}`;

function load() {
  try {
    const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(list)) return list;
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`อ่าน ${FILE} ไม่ได้: ${err.message}`);
  }
  // First run: start with the calls from the videos already looked at.
  const seeded = SEED.map((p) => ({ id: newId(), added: new Date().toISOString(), ...p }));
  save(seeded);
  return seeded;
}

function save(list) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, FILE);
}

// Checks and cleans one entry sent from the page; throws a Thai message on bad input.
function clean(input, assets) {
  const s = (v, max) => String(v ?? '').trim().slice(0, max);
  const p = {
    source: s(input.source, 120),
    link: s(input.link, 300),
    said: s(input.said, 10),
    asset: s(input.asset, 10).toUpperCase(),
    kind: input.kind === 'below' ? 'below' : 'above',
    target: Number(input.target),
    by: s(input.by, 10) || null,
    note: s(input.note, 300),
  };
  if (!p.source) throw new Error('ใส่ชื่อคนหรือช่องที่ทำนาย');
  if (!DATE.test(p.said) || Number.isNaN(Date.parse(p.said))) throw new Error('วันที่พูดไม่ถูกต้อง');
  if (p.by && (!DATE.test(p.by) || Number.isNaN(Date.parse(p.by)))) throw new Error('วันครบกำหนดไม่ถูกต้อง');
  if (p.by && p.by < p.said) throw new Error('วันครบกำหนดต้องอยู่หลังวันที่พูด');
  if (!assets.includes(p.asset)) throw new Error('ไม่รู้จักสินทรัพย์นี้');
  if (!(p.target > 0) || p.target > 1e9) throw new Error('ราคาเป้าไม่ถูกต้อง');
  if (p.link && !/^https?:\/\//i.test(p.link)) throw new Error('ลิงก์ต้องขึ้นต้นด้วย http:// หรือ https://');
  return p;
}

// One entry against its asset's closes. The last row of each series is the
// live (unfinished) day.
function evaluate(p, series) {
  if (!series) return { status: 'nodata' };
  const { dates, price } = series;
  const last = dates.length - 1;
  let i0 = -1;
  for (let i = 0; i <= last; i++) { if (dates[i] <= p.said) i0 = i; else break; }
  if (i0 < 0) i0 = 0;
  const startPrice = price[i0];
  const up = p.kind === 'above';
  const reached = (v) => (up ? v >= p.target : v <= p.target);
  let best = startPrice;
  let bestDate = dates[i0];
  for (let i = i0 + 1; i <= last; i++) {
    if (p.by && dates[i] > p.by) break;
    const v = price[i];
    if (v == null) continue;
    if (up ? v > best : v < best) { best = v; bestDate = dates[i]; }
    if (reached(v)) {
      return { status: 'hit', date: dates[i], price: v, live: i === last, days: Math.round((Date.parse(dates[i]) - Date.parse(p.said)) / 86400000), startPrice };
    }
  }
  const today = dates[last];
  const now = price[last];
  const gap = (p.target / now - 1) * 100;
  if (p.by && today > p.by) {
    return { status: 'miss', best, bestDate, short: (p.target / best - 1) * 100, startPrice };
  }
  return {
    status: 'open',
    now,
    gap,
    best,
    bestDate,
    daysLeft: p.by ? Math.round((Date.parse(p.by) - Date.parse(today)) / 86400000) : null,
    startPrice,
  };
}

function buildPredictions(data, { round }) {
  const all = assetsOf(data);
  const series = Object.fromEntries(all.map((a) => [a.symbol, a]));
  const list = load();
  const r = (v) => (typeof v === 'number' ? round(v, 6) : v);
  const rows = list.map((p) => {
    const ev = evaluate(p, series[p.asset]);
    return { ...p, result: Object.fromEntries(Object.entries(ev).map(([k, v]) => [k, r(v)])) };
  });
  // Per source: how many came true, missed, still open.
  const bySource = {};
  for (const p of rows) {
    const o = (bySource[p.source] ||= { source: p.source, hit: 0, miss: 0, open: 0 });
    if (p.result.status === 'hit') o.hit++;
    else if (p.result.status === 'miss') o.miss++;
    else o.open++;
  }
  return {
    assets: all.map((a) => ({ symbol: a.symbol, name: a.name, price: r(a.price[a.price.length - 1]) })),
    today: all.find((a) => a.symbol === 'BTC')?.dates.at(-1) ?? null,
    predictions: rows,
    sources: Object.values(bySource).sort((x, y) => y.hit + y.miss - (x.hit + x.miss) || x.source.localeCompare(y.source)),
  };
}

function addPrediction(input, data) {
  const assets = assetsOf(data).map((a) => a.symbol);
  const p = clean(input, assets);
  const list = load();
  if (list.length >= MAX_ENTRIES) throw new Error(`บันทึกได้สูงสุด ${MAX_ENTRIES} รายการ`);
  const entry = { id: newId(), added: new Date().toISOString(), ...p };
  list.push(entry);
  save(list);
  return entry;
}

function removePrediction(id) {
  const list = load();
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) throw new Error('ไม่พบรายการนี้');
  save(next);
}

module.exports = { buildPredictions, addPrediction, removePrediction };
