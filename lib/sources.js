'use strict';
// Data sources + on-disk cache. Every source has a TTL (fresh window) and a
// retry backoff; when a fetch fails the last cached copy is served as "stale".

const fs = require('fs');
const path = require('path');
const { FRED_SERIES, FRED_OPTIONAL, FRED_HOLDINGS, FRED_RATES } = require('./macro');
const { COINS } = require('./coins');

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

const CACHE_DIR = path.join(__dirname, '..', 'cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const inflight = new Map();
const lastFailure = new Map();

function readCache(key) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${key}.json`), 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(key, data) {
  const entry = { fetchedAt: Date.now(), data };
  fs.writeFileSync(path.join(CACHE_DIR, `${key}.json`), JSON.stringify(entry));
  return entry;
}

// Is the internet reachable? Any HTTP response (even an error status) counts as
// online; a request that gets no response at all (no DNS, refused, timed out)
// counts as offline. loadAll() turns each round of requests into a verdict.
const network = { ok: 0, fail: 0, online: null, checkedAt: 0, error: null };
const PROBE_AFTER = 5 * MIN;

async function request(url, options) {
  try {
    const res = await fetch(url, options);
    network.ok++;
    return res;
  } catch (err) {
    network.fail++;
    network.error = err.cause?.code || err.message;
    throw err;
  }
}

async function getJSON(url, timeoutMs = 30 * SEC, headers = null) {
  const res = await request(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: headers || { Accept: 'application/json', 'User-Agent': 'btc-indicator-dashboard/1.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} จาก ${new URL(url).host}`);
  return res.json();
}

// Returns { data, fetchedAt, stale, error }
function cached(key, ttlMs, backoffMs, fetcher) {
  const hit = readCache(key);
  if (hit && Date.now() - hit.fetchedAt < ttlMs) return Promise.resolve({ ...hit, stale: false });

  const failedAt = lastFailure.get(key);
  if (failedAt && Date.now() - failedAt.at < backoffMs) {
    return Promise.resolve(hit ? { ...hit, stale: true, error: failedAt.error } : { data: null, fetchedAt: null, stale: true, error: failedAt.error });
  }
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    try {
      const data = await fetcher();
      lastFailure.delete(key);
      return { ...writeCache(key, data), stale: false };
    } catch (err) {
      console.warn(`[${key}] fetch failed: ${err.message}`);
      lastFailure.set(key, { at: Date.now(), error: err.message });
      return hit ? { ...hit, stale: true, error: err.message } : { data: null, fetchedAt: null, stale: true, error: err.message };
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

async function getText(url, timeoutMs = 30 * SEC) {
  const res = await request(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'btc-indicator-dashboard/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} จาก ${new URL(url).host}`);
  return res.text();
}

const num = (v) => (v == null || v === '' ? null : Number(v));
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

// ---------- fetchers ----------

async function fetchCoinMetrics() {
  const metrics = 'PriceUSD,CapMrktCurUSD,CapMVRVCur,IssTotUSD,HashRate';
  let url = `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=${metrics}&frequency=1d&page_size=10000&start_time=2010-07-18`;
  const out = { t: [], price: [], mcap: [], mvrv: [], iss: [], hash: [] };
  while (url) {
    const j = await getJSON(url, 120 * SEC);
    for (const r of j.data) {
      if (r.PriceUSD == null) continue;
      out.t.push(r.time.slice(0, 10));
      out.price.push(num(r.PriceUSD));
      out.mcap.push(num(r.CapMrktCurUSD));
      out.mvrv.push(num(r.CapMVRVCur));
      out.iss.push(num(r.IssTotUSD));
      out.hash.push(num(r.HashRate));
    }
    url = j.next_page_url || null;
  }
  if (out.t.length < 2000) throw new Error('CoinMetrics ส่งข้อมูลกลับมาน้อยผิดปกติ');
  return out;
}

// Binance refuses api.binance.com from some locations (HTTP 451). Its public
// market-data host serves the same spot endpoints without that restriction,
// so it is tried first and api.binance.com is kept as the fallback.
const BINANCE_SPOT_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];

async function binanceSpot(pathAndQuery, timeoutMs = 30 * SEC) {
  let lastError;
  for (const host of BINANCE_SPOT_HOSTS) {
    try {
      return await getJSON(host + pathAndQuery, timeoutMs);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function fetchKlines() {
  const rows = await binanceSpot('/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=30');
  return rows.map((k) => ({ date: isoDate(k[0]), close: Number(k[4]) }));
}

async function fetchTicker() {
  try {
    const t = await binanceSpot('/api/v3/ticker/24hr?symbol=BTCUSDT', 15 * SEC);
    return { price: Number(t.lastPrice), changePct: Number(t.priceChangePercent), source: 'Binance' };
  } catch (err) {
    const g = await getJSON('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true', 15 * SEC);
    return { price: g.bitcoin.usd, changePct: g.bitcoin.usd_24h_change, source: 'CoinGecko' };
  }
}

async function fetchFearGreed() {
  const j = await getJSON('https://api.alternative.me/fng/?limit=0');
  return j.data
    .map((r) => ({ date: isoDate(Number(r.timestamp) * 1000), value: Number(r.value), label: r.value_classification }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Recent perpetual funding rates, oldest first: [{ time, rate }] with rate as a
// fraction per 8 hours. Binance futures has no public mirror, so when it is
// unreachable the same contract on OKX is used instead.
async function fetchFundingRows(binanceSymbol, okxInstId) {
  try {
    const rows = await getJSON(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${binanceSymbol}&limit=30`, 15 * SEC);
    if (!Array.isArray(rows) || !rows.length) throw new Error('empty');
    return rows.map((r) => ({ time: r.fundingTime, rate: Number(r.fundingRate) }));
  } catch {
    const j = await getJSON(`https://www.okx.com/api/v5/public/funding-rate-history?instId=${okxInstId}&limit=30`, 15 * SEC);
    const rows = (j?.data || [])
      .map((r) => ({ time: Number(r.fundingTime), rate: Number(r.realizedRate ?? r.fundingRate) }))
      .filter((r) => Number.isFinite(r.rate))
      .sort((a, b) => a.time - b.time);
    if (!rows.length) throw new Error(`ไม่มีข้อมูล Funding Rate (${okxInstId})`);
    // OKX settles some contracts more often than every 8 hours; express the rate per 8 hours.
    const hours = rows.length > 1 ? (rows[rows.length - 1].time - rows[rows.length - 2].time) / 3600000 : 8;
    const scale = hours > 0 ? 8 / hours : 1;
    return rows.map((r) => ({ time: r.time, rate: r.rate * scale }));
  }
}

const fetchFunding = () => fetchFundingRows('BTCUSDT', 'BTC-USDT-SWAP');

// bitcoin-data.com free tier: 10 requests/hour, 15/day — hence the long TTL.
async function fetchBitcoinData(endpoint) {
  const j = await getJSON(`https://bitcoin-data.com/v1/${endpoint}`, 60 * SEC);
  if (!Array.isArray(j) || j.length < 100) throw new Error(`bitcoin-data.com (${endpoint}): ${j?.message || 'ข้อมูลไม่ถูกต้อง / ติด rate limit'}`);
  return j;
}

// Bitcoin Research Kit (bitview.space): free, no key. Its day1 index 0 is
// 2009-01-01 (verified against BRK's own `date` series).
const BRK_DAY1_EPOCH = Date.UTC(2009, 0, 1);

async function fetchBrkLthSupply() {
  const j = await getJSON('https://bitview.space/api/series/lth_supply/day1', 90 * SEC);
  if (!Array.isArray(j?.data) || j.data.length < 1000) throw new Error('Bitcoin Research Kit: ข้อมูล LTH Supply ไม่ครบ');
  return { start: isoDate(BRK_DAY1_EPOCH + j.start * 86400000), v: j.data };
}

// DefiLlama stablecoin ids: 1 = USDT, 2 = USDC. Circulating supply per day,
// stored in USD millions on USDT's dates (USDC is 0 before its 2018 launch).
async function fetchStablecoins() {
  const [usdt, usdc] = await Promise.all([1, 2].map(async (id) => {
    const rows = await getJSON(`https://stablecoins.llama.fi/stablecoincharts/all?stablecoin=${id}`, 60 * SEC);
    if (!Array.isArray(rows) || rows.length < 1000) throw new Error('DefiLlama: ข้อมูล Stablecoin ไม่ครบ');
    return new Map(rows.map((r) => [isoDate(Number(r.date) * 1000), Math.round((r.totalCirculating?.peggedUSD || 0) / 1e6)]));
  }));
  const t = [...usdt.keys()].sort();
  const out = { t, usdt: t.map((d) => usdt.get(d)), usdc: t.map((d) => usdc.get(d) ?? 0) };
  if (!(out.usdt[t.length - 1] > 1000)) throw new Error('DefiLlama: ยอด USDT ล่าสุดผิดปกติ');
  return out;
}

// SoSoValue's ETF API needs a free key (sosovalue.com/developer/dashboard), read
// from SOSOVALUE_API_KEY or from sosovalue-key.txt next to server.js. It is read
// on every load, so saving the file needs no restart. (Explorer with hidden file
// extensions turns "sosovalue-key.txt" into "sosovalue-key.txt.txt".)
const SOSO_KEY_FILES = ['sosovalue-key.txt', 'sosovalue-key.txt.txt'].map((f) => path.join(__dirname, '..', f));

function sosoKey() {
  if (process.env.SOSOVALUE_API_KEY?.trim()) return process.env.SOSOVALUE_API_KEY.trim();
  for (const file of SOSO_KEY_FILES) {
    try {
      const key = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trim();
      if (key) return key;
    } catch { /* no such file */ }
  }
  return null;
}

// Daily net flow of all US spot ETFs of one coin. One call returns at most the
// latest 300 trading days, so each download is merged into the saved copy.
async function fetchSosoEtf(symbol, cacheKey) {
  const key = sosoKey();
  if (!key) throw new Error('ยังไม่ได้ใส่ API key ของ SoSoValue');
  const res = await request(`https://openapi.sosovalue.com/openapi/v1/etfs/summary-history?symbol=${symbol}&country_code=US&limit=300`, {
    signal: AbortSignal.timeout(30 * SEC),
    headers: { Accept: 'application/json', 'User-Agent': 'btc-indicator-dashboard/1.0', 'x-soso-api-key': key },
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || j?.code !== 0) throw new Error(`SoSoValue: ${j?.message || `HTTP ${res.status}`}`);
  if (!Array.isArray(j.data) || !j.data.length) throw new Error(`SoSoValue: ไม่มีข้อมูล ETF ${symbol}`);
  const days = new Map();
  const old = readCache(cacheKey)?.data;
  old?.t?.forEach((d, i) => days.set(d, [old.flow[i], old.aum[i], old.cum[i]]));
  for (const r of j.data) {
    const flow = num(r.total_net_inflow);
    if (r.date && Number.isFinite(flow)) days.set(r.date.slice(0, 10), [Math.round(flow), Math.round(num(r.total_net_assets)), Math.round(num(r.cum_net_inflow))]);
  }
  const t = [...days.keys()].sort();
  return { t, flow: t.map((d) => days.get(d)[0]), aum: t.map((d) => days.get(d)[1]), cum: t.map((d) => days.get(d)[2]) };
}

// Cost-basis prices from the same kit: STH realized price (average cost of coins
// that moved in the last 155 days) and True Market Mean (average cost of coins
// still active). Whole dollars per day from 2012.
async function fetchBrkCostBasis() {
  const out = {};
  for (const [key, series] of [['sth', 'sth_realized_price'], ['tmm', 'true_market_mean']]) {
    const j = await getJSON(`https://bitview.space/api/series/${series}/day1`, 90 * SEC);
    if (!Array.isArray(j?.data) || j.data.length < 1000) throw new Error(`Bitcoin Research Kit: ข้อมูล ${series} ไม่ครบ`);
    const from = Math.max(0, (Date.UTC(2012, 0, 1) - BRK_DAY1_EPOCH) / 86400000 - j.start);
    out[key] = { start: isoDate(BRK_DAY1_EPOCH + (j.start + from) * 86400000), v: j.data.slice(from).map((v) => (v > 0 ? Math.round(v) : null)) };
  }
  return out;
}

// ---------- gold ----------

// Yahoo's chart endpoint rejects non-browser user agents.
const YAHOO_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};

async function fetchYahoo(symbol, query) {
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`, 60 * SEC, YAHOO_HEADERS);
  const r = j?.chart?.result?.[0];
  if (!r?.timestamp?.length) throw new Error(`Yahoo ${symbol}: ไม่มีข้อมูล`);
  return r;
}

// Full daily close history → { t: [dates], c: [closes] } (one row per trading day).
async function fetchYahooHistory(symbol) {
  const r = await fetchYahoo(symbol, 'period1=0&period2=9999999999&interval=1d');
  const close = r.indicators.quote[0].close;
  const t = [];
  const c = [];
  r.timestamp.forEach((ts, i) => {
    if (close[i] == null) return;
    const d = isoDate(ts * 1000);
    if (t[t.length - 1] === d) c[c.length - 1] = close[i];
    else { t.push(d); c.push(close[i]); }
  });
  if (t.length < 1000) throw new Error(`Yahoo ${symbol}: ประวัติราคาไม่ครบ`);
  return { t, c };
}

async function fetchYahooQuote(symbol) {
  const r = await fetchYahoo(symbol, 'range=5d&interval=1d');
  const closes = r.indicators.quote[0].close.filter((v) => v != null);
  const m = r.meta;
  if (!(m?.regularMarketPrice > 0)) throw new Error(`Yahoo ${symbol}: ไม่มีราคาล่าสุด`);
  return {
    price: m.regularMarketPrice,
    prevClose: closes.length >= 2 ? closes[closes.length - 2] : null,
    date: isoDate(m.regularMarketTime * 1000),
    time: m.regularMarketTime * 1000,
  };
}

// CFTC Commitments of Traders (disaggregated, futures only) for COMEX gold.
async function fetchCotGold() {
  const q = new URLSearchParams({
    $where: "cftc_contract_market_code='088691'",
    $select: 'report_date_as_yyyy_mm_dd,open_interest_all,m_money_positions_long_all,m_money_positions_short_all',
    $order: 'report_date_as_yyyy_mm_dd',
    $limit: '5000',
  });
  const rows = await getJSON(`https://publicreporting.cftc.gov/resource/72hh-3qpy.json?${q}`, 60 * SEC);
  if (!Array.isArray(rows) || rows.length < 100) throw new Error('CFTC: ข้อมูล COT ไม่ครบ');
  return rows.map((r) => ({
    d: r.report_date_as_yyyy_mm_dd.slice(0, 10),
    long: Number(r.m_money_positions_long_all),
    short: Number(r.m_money_positions_short_all),
    oi: Number(r.open_interest_all),
  }));
}

// ---------- altcoins ----------

// Full daily close history of a Binance spot pair (1000 candles per request).
async function fetchBinanceHistory(pair) {
  const t = [];
  const c = [];
  let start = 0;
  for (let page = 0; page < 12; page++) {
    const rows = await binanceSpot(`/api/v3/klines?symbol=${pair}&interval=1d&startTime=${start}&limit=1000`);
    if (!Array.isArray(rows) || !rows.length) break;
    for (const k of rows) { t.push(isoDate(k[0])); c.push(Number(k[4])); }
    if (rows.length < 1000) break;
    start = rows[rows.length - 1][0] + 86400000;
  }
  if (t.length < 200) throw new Error(`Binance ${pair}: ประวัติราคาไม่ครบ`);
  return { t, c };
}

async function fetchAltTickers() {
  const pairs = COINS.map((x) => `${x.symbol}USDT`);
  const rows = await binanceSpot(`/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(pairs))}`, 20 * SEC);
  const out = {};
  for (const r of rows) out[r.symbol.replace(/USDT$/, '')] = { price: Number(r.lastPrice), changePct: Number(r.priceChangePercent) };
  return out;
}

async function fetchCoinMetricsMvrv(asset) {
  let url = `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=${asset}&metrics=CapMVRVCur&frequency=1d&page_size=10000&start_time=2014-01-01`;
  const d = [];
  const v = [];
  while (url) {
    const j = await getJSON(url, 90 * SEC);
    for (const r of j.data || []) {
      if (r.CapMVRVCur != null) { d.push(r.time.slice(0, 10)); v.push(Number(r.CapMVRVCur)); }
    }
    url = j.next_page_url || null;
  }
  if (d.length < 200) throw new Error(`CoinMetrics ${asset}: ไม่มี MVRV`);
  return { d, v };
}

// Mean funding of the last 9 periods (about 3 days), in % per 8h.
async function fetchFundingAvg(coin) {
  const rows = await fetchFundingRows(coin.futures, `${coin.symbol}-USDT-SWAP`);
  const last = rows.slice(-9);
  return { rate: (last.reduce((s, r) => s + r.rate, 0) / last.length) * 100, time: last[last.length - 1].time };
}

const ALT_SOURCES = [
  { group: 'alts', key: 'alt-tickers', name: 'ราคาล่าสุดทุกเหรียญ (Binance)', ttl: 1 * MIN, backoff: 1 * MIN, fetch: fetchAltTickers },
  ...COINS.flatMap((coin) => [
    { group: 'alts', coin: coin.symbol, key: `alt-hist-${coin.symbol}`, name: `Binance Spot — ${coin.symbol}/USDT รายวัน`, ttl: 1 * HOUR, backoff: 10 * MIN, fetch: () => fetchBinanceHistory(`${coin.symbol}USDT`) },
    ...(coin.cm ? [{ group: 'alts', coin: coin.symbol, key: `alt-mvrv-${coin.symbol}`, name: `CoinMetrics Community — MVRV ของ ${coin.symbol}`, ttl: 12 * HOUR, backoff: 30 * MIN, fetch: () => fetchCoinMetricsMvrv(coin.cm) }] : []),
    { group: 'alts', coin: coin.symbol, key: `alt-fund-${coin.symbol}`, name: `Funding Rate ของ ${coin.symbol} Perpetual (Binance / OKX)`, ttl: 30 * MIN, backoff: 10 * MIN, fetch: () => fetchFundingAvg(coin) },
    // `needs`: left out of loadAll() entirely until the key exists (the page then shows how to add one).
    ...(coin.etf ? [{ group: 'alts', coin: coin.symbol, key: `etf-${coin.symbol}`, name: `SoSoValue — เงินเข้าออก ETF ${coin.symbol} สหรัฐ`, ttl: 3 * HOUR, backoff: 10 * MIN, needs: sosoKey, fetch: () => fetchSosoEtf(coin.symbol, `etf-${coin.symbol}`) }] : []),
  ]),
];

const FRED_GOLD = ['DFII10', 'CPIAUCSL'];

// FRED CSV downloads need no API key.
async function fetchFred(ids = FRED_SERIES, optional = FRED_OPTIONAL) {
  const out = {};
  await Promise.all(ids.map(async (id) => {
    try {
      const text = await getText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, 60 * SEC);
      const d = [];
      const v = [];
      for (const line of text.trim().split(/\r?\n/).slice(1)) {
        const [date, val] = line.split(',');
        const x = Number(val);
        if (val && val !== '.' && Number.isFinite(x)) { d.push(date); v.push(x); }
      }
      if (d.length < 100) throw new Error(`FRED ${id}: ข้อมูลไม่ครบ`);
      out[id] = { d, v };
    } catch (err) {
      if (!optional.includes(id)) throw err;
      console.warn(`FRED ${id} (optional) skipped: ${err.message}`);
    }
  }));
  return out;
}

const SOURCES = [
  { key: 'coinmetrics', name: 'CoinMetrics Community (ราคา, MVRV, Issuance, Hashrate)', ttl: 6 * HOUR, backoff: 10 * MIN, fetch: fetchCoinMetrics },
  { key: 'binance-klines', name: 'Binance Spot (แท่งเทียนรายวัน)', ttl: 10 * MIN, backoff: 5 * MIN, fetch: fetchKlines },
  { key: 'binance-ticker', name: 'ราคาล่าสุด (Binance / CoinGecko)', ttl: 30 * SEC, backoff: 1 * MIN, fetch: fetchTicker },
  { key: 'fear-greed', name: 'alternative.me Fear & Greed', ttl: 1 * HOUR, backoff: 10 * MIN, fetch: fetchFearGreed },
  { key: 'binance-funding', name: 'Funding Rate ของ BTC Perpetual (Binance / OKX)', ttl: 30 * MIN, backoff: 10 * MIN, fetch: fetchFunding },
  { key: 'bitcoin-data-sth-mvrv', name: 'bitcoin-data.com STH-MVRV', ttl: 12 * HOUR, backoff: 1 * HOUR, fetch: () => fetchBitcoinData('sth-mvrv') },
  { key: 'bitcoin-data-lth-mvrv', name: 'bitcoin-data.com LTH-MVRV', ttl: 12 * HOUR, backoff: 1 * HOUR, fetch: () => fetchBitcoinData('lth-mvrv') },
  { key: 'bitcoin-data-etf-flow', name: 'bitcoin-data.com เงินเข้าออก ETF Bitcoin สหรัฐ (หน่วย BTC)', ttl: 12 * HOUR, backoff: 1 * HOUR, fetch: () => fetchBitcoinData('etf-flow-btc') },
  { key: 'brk-lth-supply', name: 'Bitcoin Research Kit (LTH Supply)', ttl: 12 * HOUR, backoff: 1 * HOUR, fetch: fetchBrkLthSupply },
  { key: 'brk-cost-basis', name: 'Bitcoin Research Kit (ต้นทุน STH, True Market Mean)', ttl: 6 * HOUR, backoff: 1 * HOUR, fetch: fetchBrkCostBasis },
  { key: 'fred', name: 'FRED (งบดุล Fed/ECB/BoJ, TGA, Reverse Repo, ค่าเงิน, Broad USD, SOFR/IORB)', ttl: 12 * HOUR, backoff: 30 * MIN, fetch: () => fetchFred() },
  { key: 'fred-holdings', name: 'FRED (ตั๋วเงินคลังและ MBS ที่เฟดถือ)', ttl: 12 * HOUR, backoff: 30 * MIN, fetch: () => fetchFred(FRED_HOLDINGS, []) },
  { key: 'fred-rates', name: 'FRED (ยีลด์พันธบัตร 2 ปี, Fed Funds)', ttl: 12 * HOUR, backoff: 30 * MIN, fetch: () => fetchFred(FRED_RATES, []) },
  { key: 'yahoo-move', name: 'Yahoo Finance — ดัชนี MOVE (ความผันผวนพันธบัตรสหรัฐ)', ttl: 6 * HOUR, backoff: 30 * MIN, fetch: () => fetchYahooHistory('^MOVE') },
  { key: 'stablecoins', name: 'DefiLlama (ยอด Stablecoin: USDT, USDC)', ttl: 6 * HOUR, backoff: 30 * MIN, fetch: fetchStablecoins },

  { group: ['gold', 'btc'], key: 'yahoo-gold', name: 'Yahoo Finance — ทองคำ COMEX (GC=F) รายวัน', ttl: 6 * HOUR, backoff: 10 * MIN, fetch: () => fetchYahooHistory('GC=F') },
  { group: 'gold', key: 'yahoo-gold-quote', name: 'ราคาทองล่าสุด (Yahoo Finance)', ttl: 5 * MIN, backoff: 2 * MIN, fetch: () => fetchYahooQuote('GC=F') },
  { group: 'gold', key: 'yahoo-silver', name: 'Yahoo Finance — เงิน COMEX (SI=F) รายวัน', ttl: 6 * HOUR, backoff: 10 * MIN, fetch: () => fetchYahooHistory('SI=F') },
  { group: 'gold', key: 'yahoo-thb', name: 'อัตราแลกเปลี่ยน USD/THB (Yahoo Finance)', ttl: 1 * HOUR, backoff: 10 * MIN, fetch: () => fetchYahooQuote('THB=X') },
  { group: 'gold', key: 'fred-gold', name: 'FRED (Real Yield 10 ปี, ดัชนีเงินเฟ้อ CPI)', ttl: 12 * HOUR, backoff: 30 * MIN, fetch: () => fetchFred(FRED_GOLD, []) },
  { group: 'gold', key: 'cftc-cot-gold', name: 'CFTC COT — สถานะกองทุนในตลาดทองคำล่วงหน้า', ttl: 12 * HOUR, backoff: 1 * HOUR, fetch: fetchCotGold },

  ...ALT_SOURCES,
];

// ---------- one day every 5 minutes ("ราคา 24 ชั่วโมงของวันนั้น") ----------

// A Thai calendar day (UTC+7), fetched when a page asks for it and kept in
// cache/intraday/ so it opens offline later. Rows are [time, open, high, low, close].
const INTRADAY_DIR = 'intraday';
fs.mkdirSync(path.join(CACHE_DIR, INTRADAY_DIR), { recursive: true });
const THAI_OFFSET = 7 * HOUR;
const BINANCE_BTC_FROM = Date.UTC(2017, 7, 18); // BTCUSDT opened on 2017-08-17

async function intradayBinance(pair, from, to) {
  const rows = await binanceSpot(`/api/v3/klines?symbol=${pair}&interval=5m&startTime=${from}&endTime=${to - 1}&limit=1000`);
  return { source: `Binance (${pair.replace(/USDT$/, '/USDT')})`, interval: '5 นาที', rows: rows.map((k) => [k[0], +k[1], +k[2], +k[3], +k[4]]) };
}

// Bitstamp has BTC/USD every 5 minutes back to 2011, before Binance existed.
async function intradayBitstamp(from, to) {
  const j = await getJSON(`https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=300&limit=288&start=${from / 1000}`);
  const rows = (j?.data?.ohlc || [])
    .map((r) => [Number(r.timestamp) * 1000, +r.open, +r.high, +r.low, +r.close])
    .filter((r) => r[0] >= from && r[0] < to);
  return { source: 'Bitstamp (BTC/USD)', interval: '5 นาที', rows };
}

// Yahoo keeps gold futures every 5 minutes for about 60 days and hourly for about 2 years.
async function intradayYahoo(symbol, from, to) {
  const age = Date.now() - from;
  const interval = age < 55 * 24 * HOUR ? '5m' : age < 700 * 24 * HOUR ? '60m' : null;
  if (!interval) throw new Error('Yahoo Finance เก็บราคาทองระหว่างวันย้อนหลังได้แค่ราว 2 ปี');
  const r = await fetchYahoo(symbol, `period1=${from / 1000}&period2=${to / 1000}&interval=${interval}`).catch((err) => {
    if (/ไม่มีข้อมูล/.test(err.message)) return null; // a weekend or holiday
    throw err;
  });
  const q = r?.indicators?.quote?.[0];
  const rows = (r?.timestamp || [])
    .map((ts, i) => [ts * 1000, q.open[i], q.high[i], q.low[i], q.close[i]])
    .filter((x) => x[4] != null && x[0] >= from && x[0] < to);
  return { source: 'Yahoo Finance (ทองคำ COMEX GC=F)', interval: interval === '5m' ? '5 นาที' : '1 ชั่วโมง', rows };
}

// asset: 'BTC', 'GOLD' or a symbol from coins.js; day: 'YYYY-MM-DD' in Thai time.
function loadIntraday(asset, day) {
  const from = Date.parse(`${day}T00:00:00Z`) - THAI_OFFSET;
  const to = from + 24 * HOUR;
  const done = to <= Date.now();
  const key = `${INTRADAY_DIR}/${asset}-${day}`;
  // A finished day never changes, but one saved while it was still running must be fetched again.
  const ttl = done && !readCache(key)?.data?.partial ? Infinity : 1 * MIN;
  return cached(key, ttl, 1 * MIN, async () => {
    let out;
    if (asset === 'GOLD') out = await intradayYahoo('GC=F', from, to);
    else if (asset === 'BTC' && from < BINANCE_BTC_FROM) out = await intradayBitstamp(from, to);
    else out = await intradayBinance(`${asset}USDT`, from, to);
    if (!out.rows.length) throw new Error(asset === 'GOLD' ? 'ไม่มีการซื้อขายทองในวันนั้น (วันหยุด)' : 'ยังไม่มีข้อมูลราคาระหว่างวันของวันนั้น');
    return { ...out, from, to, partial: !done };
  });
}

const INTRADAY_ASSETS = new Set(['BTC', 'GOLD', ...COINS.map((c) => c.symbol)]);

// Updates network.online from the requests made since `before`. When every
// source was still fresh (nothing requested) and the last verdict is old, a
// tiny request to a host the dashboard already uses settles it.
async function checkNetwork(before) {
  if (network.ok === before.ok && network.fail === before.fail) {
    if (Date.now() - network.checkedAt < PROBE_AFTER) return;
    await request('https://data-api.binance.vision/api/v3/ping', { signal: AbortSignal.timeout(10 * SEC) }).catch(() => {});
  }
  const wasOffline = network.online === false;
  network.online = network.ok > before.ok;
  network.checkedAt = Date.now();
  // Sources that failed while offline would otherwise wait out their full
  // backoff (up to an hour) before refreshing; let them retry right away.
  if (wasOffline && network.online) lastFailure.clear();
}

function networkStatus() {
  return { online: network.online, checkedAt: network.checkedAt || null, error: network.online === false ? network.error : null };
}

// group: 'btc' (default for sources without a group), 'gold' or 'alts'; a source
// used by several pages lists them all (gold history also feeds the BTC macro panel).
// A source whose `needs()` is false (no API key yet) is not loaded and has no entry in `data`.
async function loadAll(group = 'btc') {
  const sources = SOURCES.filter((s) => [].concat(s.group || 'btc').includes(group) && (!s.needs || s.needs()));
  const before = { ok: network.ok, fail: network.fail };
  const results = await Promise.all(sources.map((s) => cached(s.key, s.ttl, s.backoff, s.fetch)));
  await checkNetwork(before);
  const data = {};
  const status = [];
  sources.forEach((s, i) => {
    const r = results[i];
    data[s.key] = r.data;
    status.push({ key: s.key, name: s.name, coin: s.coin || null, fetchedAt: r.fetchedAt, stale: r.stale, error: r.error || null, ok: r.data != null });
  });
  return { data, status };
}

module.exports = { loadAll, networkStatus, loadIntraday, INTRADAY_ASSETS };
