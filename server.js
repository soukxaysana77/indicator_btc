'use strict';
// Zero-dependency server: serves ./public and the JSON APIs
// /api/indicators (BTC), /api/gold, /api/alts (overview), /api/coin?symbol=ETH,
// /api/sth-alert (the STH ≥ 99 card, from all three), /api/sth-series?symbol= (one asset's
// price and STH for that card's chart), /api/paper (the paper-trading card),
// /api/predictions (the prediction log: GET, and POST / DELETE from this computer only).
// Run: node server.js   (add --open to launch the browser)

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { loadAll, networkStatus, loadIntraday, INTRADAY_ASSETS } = require('./lib/sources');
const { buildDashboard, scoresIfClosedAt, latestDay, round } = require('./lib/indicators');
const { buildGold, goldScoresIfClosedAt } = require('./lib/gold');
const { buildAlts, coinScoresIfClosedAt } = require('./lib/alts');
const { COINS } = require('./lib/coins');
const { scoreIntraday, utcBarOf, goldBarOf } = require('./lib/intraday');
const { buildSth99, assetsOf } = require('./lib/sth99');
const { buildPaper, WINDOWS: PAPER_WINDOWS, DEFAULT_MA: PAPER_MA } = require('./lib/papertrade');
const { buildPredictions, addPrediction, removePrediction } = require('./lib/predictions');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// One data set per asset group, each rebuilt at most once a minute.
// The altcoin set needs the BTC dashboard (BTC price and cycle score).
// `raw` keeps the sources behind each build: the 24-hour chart re-scores them.
const raw = {};
const BUILDERS = {
  btc: async () => buildDashboard((raw.btc = await loadAll('btc'))),
  gold: async () => buildGold((raw.gold = await loadAll('gold'))),
  alts: async () => buildAlts((raw.alts = await loadAll('alts')), await getData('btc')),
};
// Route → which data set to use and which part of it to send (null = not found).
const ROUTES = {
  '/api/indicators': { kind: 'btc', pick: (d) => d },
  '/api/gold': { kind: 'gold', pick: (d) => d },
  '/api/alts': { kind: 'alts', pick: (d) => d.overview },
  '/api/coin': { kind: 'alts', pick: (d, q) => d.coins[String(q.get('symbol') || '').toUpperCase()] || null },
};
const memo = {};

function getData(kind) {
  const m = memo[kind] || (memo[kind] = { data: null, at: 0, building: null, json: new Map() });
  if (m.data && Date.now() - m.at < 60 * 1000) return Promise.resolve(m.data);
  if (!m.building) {
    m.building = (async () => {
      try {
        m.data = await BUILDERS[kind]();
        m.at = Date.now();
        m.json.clear();
        return m.data;
      } finally {
        m.building = null;
      }
    })();
  }
  return m.building;
}

// JSON for an API path, serialised once per rebuild. Returns null when the item does not exist.
async function getJson(pathname, query) {
  const route = ROUTES[pathname];
  const data = await getData(route.kind);
  const cache = memo[route.kind].json;
  const key = `${pathname}?${String(query.get('symbol') || '').toUpperCase()}`;
  if (cache.has(key)) return cache.get(key);
  const part = route.pick(data, query);
  if (part == null) return null;
  // Every page shows whether the server reached the internet on this rebuild.
  const json = JSON.stringify({ ...part, network: networkStatus() });
  cache.set(key, json);
  return json;
}

// /api/sth-alert — the "เตือน STH 99" card on every page needs all three data
// sets. A set built in the last few minutes is reused, so a page refreshing every
// minute does not rebuild the other pages' data each time.
const STH99_MAX_AGE = 3 * 60 * 1000;
let sth99Memo = null;

function recentData(kind) {
  const m = memo[kind];
  if (m?.data && Date.now() - m.at < STH99_MAX_AGE) return Promise.resolve(m.data);
  return getData(kind);
}

async function sth99Json() {
  const kinds = ['btc', 'gold', 'alts'];
  const got = await Promise.allSettled(kinds.map(recentData));
  const sets = Object.fromEntries(kinds.map((k, i) => [k, got[i].status === 'fulfilled' ? got[i].value : null]));
  if (sth99Memo && kinds.every((k) => sth99Memo.sets[k] === sets[k])) return sth99Memo.json;
  const card = buildSth99(sets, { round });
  const missing = kinds.filter((k) => !sets[k]);
  const json = JSON.stringify({ ...card, missing, generatedAt: new Date().toISOString() });
  sth99Memo = { sets, json };
  return json;
}

// /api/sth-series?symbol=XRP — one asset's daily closes and STH score, for the
// chart in the STH card when a single asset is picked (loaded only then).
const seriesMemo = new Map();

async function sthSeriesJson(symbolRaw) {
  const symbol = String(symbolRaw || '').toUpperCase().slice(0, 10);
  const sets = await allSets();
  const hit = seriesMemo.get(symbol);
  if (hit && ['btc', 'gold', 'alts'].every((k) => hit.sets[k] === sets[k])) return hit.json;
  const a = assetsOf(sets).find((x) => x.symbol === symbol);
  if (!a) return null;
  const json = JSON.stringify({
    symbol,
    dates: a.dates,
    price: a.price.map((v) => (v == null ? null : round(v, 6))),
    // cut, not rounded, so 98.96 never shows as 99.0
    sth: a.sth.map((v) => (v == null ? null : Math.floor(v * 10) / 10)),
  });
  seriesMemo.set(symbol, { sets, json });
  return json;
}

// /api/paper?ma=100&from=2026-11-12&capital=1000 — the "ระบบทดลอง" card: the
// rules replayed on real closes from the chosen start date (no real money).
const paperMemo = new Map();

async function paperJson(query) {
  const kinds = ['btc', 'gold', 'alts'];
  const got = await Promise.allSettled(kinds.map(recentData));
  const sets = Object.fromEntries(kinds.map((k, i) => [k, got[i].status === 'fulfilled' ? got[i].value : null]));
  const maRaw = Number(query.get('ma'));
  const ma = PAPER_WINDOWS.includes(maRaw) ? maRaw : PAPER_MA;
  const fromRaw = String(query.get('from') || '');
  const from = /^\d{4}-\d{2}-\d{2}$/.test(fromRaw) ? fromRaw : null;
  const capRaw = Number(query.get('capital'));
  const capital = Number.isFinite(capRaw) && capRaw > 0 && capRaw <= 1e12 ? capRaw : 1000;
  const key = `${ma}|${from}|${capital}`;
  const hit = paperMemo.get(key);
  if (hit && kinds.every((k) => hit.sets[k] === sets[k])) return hit.json;
  const json = JSON.stringify({ ...buildPaper(sets, { ma, from, capital }, { round }), generatedAt: new Date().toISOString() });
  if (paperMemo.size > 20) paperMemo.delete(paperMemo.keys().next().value);
  paperMemo.set(key, { sets, json });
  return json;
}

// /api/predictions — the "สมุดจดคำทำนาย" page. GET lists the calls with their
// results; POST adds one, DELETE ?id= removes one. The file is written only for
// requests from this computer, even if the server is reachable on the network.
async function allSets() {
  const kinds = ['btc', 'gold', 'alts'];
  const got = await Promise.allSettled(kinds.map(recentData));
  return Object.fromEntries(kinds.map((k, i) => [k, got[i].status === 'fulfilled' ? got[i].value : null]));
}
// Behind a host's proxy (e.g. the public copy on Render) every request carries
// X-Forwarded-For, so the log there is read-only for everyone.
const isLocal = (req) => !req.headers['x-forwarded-for'] && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
function readBody(req, limit = 8 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('ข้อมูลยาวเกินไป')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function handlePredictions(req, res, url) {
  const json = (status, body) => send(req, res, status, JSON.stringify(body), MIME['.json']);
  try {
    if (req.method === 'GET') return json(200, buildPredictions(await allSets(), { round }));
    if (!isLocal(req)) return json(403, { error: 'แก้สมุดได้จากเครื่องที่รันเว็บเท่านั้น' });
    if (req.method === 'POST') {
      const entry = addPrediction(JSON.parse(await readBody(req) || '{}'), await allSets());
      return json(200, { ok: true, entry });
    }
    if (req.method === 'DELETE') {
      removePrediction(String(url.searchParams.get('id') || ''));
      return json(200, { ok: true });
    }
    return json(405, { error: 'method not allowed' });
  } catch (err) {
    return json(400, { error: err.message });
  }
}

function send(req, res, status, body, type) {
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache' };
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '') && body.length > 1024) {
    body = zlib.gzipSync(body);
    headers['Content-Encoding'] = 'gzip';
  }
  res.writeHead(status, headers);
  res.end(body);
}

// LTH/STH through the day (see lib/intraday.js), kept 10 minutes per day and price download.
const scoreMemo = new Map();

async function intradayScores(asset, rows) {
  if (asset === 'GOLD') {
    await getData('gold');
    return scoreIntraday(rows, goldBarOf, (day, p) => goldScoresIfClosedAt(raw.gold.data, day, p), round);
  }
  const btc = await getData('btc');
  if (asset === 'BTC') {
    const latest = latestDay(raw.btc.data);
    return scoreIntraday(rows, utcBarOf, (day, p) => scoresIfClosedAt(raw.btc.data, day, p, day === latest), round);
  }
  const alts = await getData('alts');
  const coin = COINS.find((c) => c.symbol === asset);
  const latest = alts.coins[asset]?.history.dates.at(-1);
  return scoreIntraday(rows, utcBarOf, (day, p) => coinScoresIfClosedAt(coin, raw.alts.data, btc, day, p, day === latest), round);
}

async function memoScores(asset, day, r) {
  const key = `${asset}|${day}|${r.fetchedAt}`;
  const hit = scoreMemo.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
  const value = await intradayScores(asset, r.data.rows);
  if (scoreMemo.size > 40) scoreMemo.delete(scoreMemo.keys().next().value);
  scoreMemo.set(key, { at: Date.now(), value });
  return value;
}

// /api/intraday?asset=BTC&day=2025-12-15 — one Thai calendar day every 5 minutes.
async function sendIntraday(req, res, query) {
  const asset = String(query.get('asset') || '').toUpperCase();
  const day = String(query.get('day') || '');
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const fail = (status, error) => send(req, res, status, JSON.stringify({ error }), MIME['.json']);
  if (!INTRADAY_ASSETS.has(asset)) return fail(404, 'ไม่รู้จักสินทรัพย์นี้');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day)) || day < '2011-09-01' || day > today) return fail(400, 'วันที่ไม่ถูกต้อง');
  const r = await loadIntraday(asset, day);
  if (!r.data) return fail(502, r.error || 'ดึงข้อมูลไม่ได้');
  // Scores are a bonus: the price chart still shows if they cannot be computed.
  let scores = null;
  try {
    scores = await memoScores(asset, day, r);
  } catch (err) {
    console.warn('intraday scores failed:', err.message);
  }
  send(req, res, 200, JSON.stringify({ ...r.data, scores, asset, day, fetchedAt: r.fetchedAt, stale: r.stale }), MIME['.json']);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/intraday') {
    sendIntraday(req, res, url.searchParams).catch((err) => {
      console.error(err);
      send(req, res, 500, JSON.stringify({ error: err.message }), MIME['.json']);
    });
    return;
  }

  if (url.pathname === '/api/sth-series') {
    try {
      const json = await sthSeriesJson(url.searchParams.get('symbol'));
      if (json == null) send(req, res, 404, JSON.stringify({ error: 'ไม่รู้จักสินทรัพย์นี้' }), MIME['.json']);
      else send(req, res, 200, json, MIME['.json']);
    } catch (err) {
      console.error(err);
      send(req, res, 500, JSON.stringify({ error: err.message }), MIME['.json']);
    }
    return;
  }

  if (url.pathname === '/api/predictions') {
    handlePredictions(req, res, url);
    return;
  }

  if (url.pathname === '/api/paper') {
    try {
      send(req, res, 200, await paperJson(url.searchParams), MIME['.json']);
    } catch (err) {
      console.error(err);
      send(req, res, 500, JSON.stringify({ error: err.message }), MIME['.json']);
    }
    return;
  }

  if (url.pathname === '/api/sth-alert') {
    try {
      send(req, res, 200, await sth99Json(), MIME['.json']);
    } catch (err) {
      console.error(err);
      send(req, res, 500, JSON.stringify({ error: err.message }), MIME['.json']);
    }
    return;
  }

  if (ROUTES[url.pathname]) {
    try {
      const json = await getJson(url.pathname, url.searchParams);
      if (json == null) send(req, res, 404, JSON.stringify({ error: 'ไม่พบเหรียญนี้ในระบบ' }), MIME['.json']);
      else send(req, res, 200, json, MIME['.json']);
    } catch (err) {
      console.error(err);
      send(req, res, 500, JSON.stringify({ error: err.message }), MIME['.json']);
    }
    return;
  }

  let rel;
  try {
    rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  } catch {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    send(req, res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
});

// If the default port is busy (another app on 3000), try the next ones.
// An explicit PORT env var is honoured as-is.
function onStarted() {
  const address = `http://localhost:${server.address().port}`;
  console.log(`BTC Indicator Dashboard → ${address}`);
  if (process.argv.includes('--open')) {
    const cmd = process.platform === 'win32' ? `start "" "${address}"` : process.platform === 'darwin' ? `open ${address}` : `xdg-open ${address}`;
    require('child_process').exec(cmd);
  }
  getData('btc').catch((err) => console.error('Warm-up failed:', err.message));
}

// Listeners are attached per attempt and the losing one removed, so a failed
// attempt's handler never fires when a later port succeeds.
function listen(port, attemptsLeft = 10) {
  const onListening = () => {
    server.off('error', onError);
    onStarted();
  };
  const onError = (err) => {
    server.off('listening', onListening);
    if (err.code === 'EADDRINUSE' && !process.env.PORT && attemptsLeft > 0) {
      console.warn(`พอร์ต ${port} ถูกใช้อยู่ ลองพอร์ต ${port + 1}`);
      listen(port + 1, attemptsLeft - 1);
    } else {
      throw err;
    }
  };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port);
}

listen(PORT);
