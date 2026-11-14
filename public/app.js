'use strict';

// $, esc, cssVar, fmt*, toneOf and the Chart.js helpers (crosshair, baseOptions,
// lineStyle, logPriceAxis, scoreBands, baselineAt, hoverSync, pair) come from common.js.
// Per-page overrides (gold.html sets window.PAGE before this script loads).
const PAGE = window.PAGE || {};
const state = { data: null, range: '4y', macroRange: '5y', stableRange: '5y', costRange: '1y', horizon: 'all', view: 'cards' };
const charts = {};
const macroCharts = {};
let billsChart = null;
let stableChart = null;
let costChart = null;

const DEFAULT_ADVICE = {
  lth: {
    'strong-buy': 'อยู่ในโซนที่ในอดีตเป็นก้นรอบ — เหมาะทยอยสะสมเพิ่มสำหรับการถือยาว',
    buy: 'ราคายังต่ำกว่ามูลค่าเชิงวัฏจักร — เหมาะ DCA สะสมต่อเนื่อง',
    neutral: 'ราคาอยู่กลางวัฏจักร — DCA ตามปกติ ไม่ต้องเร่งซื้อ',
    sell: 'ราคาเริ่มแพงเชิงวัฏจักร — ลดการซื้อ พิจารณาทยอยทำกำไรบางส่วน',
    'strong-sell': 'สัญญาณคล้ายยอดรอบในอดีต — ความเสี่ยงสูง ระวังการไล่ราคา',
    na: 'ข้อมูลไม่พอสำหรับคำนวณ',
  },
  sth: {
    'strong-buy': 'ตลาดถูกขายมากเกินไปในระยะสั้น — โอกาสเด้งกลับสูง',
    buy: 'ราคาย่อตัวลงมา — น่าหาจังหวะเข้าเก็งกำไร',
    neutral: 'ยังไม่มีความได้เปรียบชัดเจน — รอสัญญาณที่ชัดกว่านี้',
    sell: 'ราคายืดตัวระยะสั้น — ระวังแรงขายทำกำไร',
    'strong-sell': 'ร้อนแรงมากในระยะสั้น — ไม่ควรไล่ซื้อ',
    na: 'ข้อมูลไม่พอสำหรับคำนวณ',
  },
  macro: {
    'strong-buy': 'สภาพคล่องโลกขยายตัวแรง — เป็นลมส่งให้ BTC ในอีก 1–3 เดือนข้างหน้า',
    buy: 'สภาพคล่องโลกเพิ่มขึ้น — สภาพแวดล้อมทางการเงินเป็นบวก',
    neutral: 'สภาพคล่องทรงตัว — ปัจจัย macro ยังไม่ช่วยหรือกดดันชัดเจน',
    sell: 'สภาพคล่องหดตัว — ระวังแรงกดดันต่อราคาในอีก 1–3 เดือน',
    'strong-sell': 'สภาพคล่องหดตัวแรงหรือดอลลาร์แข็งค่ามาก — macro เป็นลมต้าน',
    na: 'ข้อมูลไม่พอสำหรับคำนวณ',
  },
};

const DEFAULT_HERO_META = {
  lth: { eyebrow: 'Long-term Holder', title: 'นักลงทุนระยะยาว (LTH)', hint: 'ถือ 1 ปีขึ้นไป · DCA · มองวัฏจักร 4 ปี', cap: 'ความน่าลงทุน' },
  sth: { eyebrow: 'Short-term Holder', title: 'นักลงทุนระยะสั้น (STH)', hint: 'ถือเป็นวัน–สัปดาห์–ไม่กี่เดือน · หาจังหวะเข้าออก', cap: 'ความน่าลงทุน' },
  macro: { eyebrow: 'Macro · Global Liquidity', title: 'สภาพคล่องโลก (Macro)', hint: 'ลมส่ง/ลมต้านจากปริมาณเงินโลก · นำราคา ~3 เดือน', cap: 'ความเอื้อต่อการลงทุน' },
};

const ADVICE = { ...DEFAULT_ADVICE, ...PAGE.advice };
const HERO_META = { ...DEFAULT_HERO_META, ...PAGE.heroMeta };
const API = PAGE.api || '/api/indicators';

// ---------- data ----------

// quiet = the automatic refresh (see autoRefresh in common.js): the page is not
// dimmed while it loads — only the ↻ button does that.
async function load({ quiet = false } = {}) {
  if (!quiet) document.body.classList.add('loading');
  try {
    const res = await fetch(API, { cache: 'no-store' });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || res.statusText);
    state.data = json;
    $('#error').hidden = true;
    render();
  } catch (err) {
    $('#error').textContent = `โหลดข้อมูลไม่สำเร็จ: ${err.message}`;
    $('#error').hidden = false;
    // coin.html with an unknown ?c= — don't leave the heading stuck on "loading".
    if (!state.data && $('#asset-title')) $('#asset-title').textContent = 'ไม่พบข้อมูลเหรียญนี้';
  } finally {
    document.body.classList.remove('loading');
  }
}

function render() {
  const { composite, indicators, macro } = state.data;
  renderHeader();
  const membersOf = (key, list) => list
    .filter((i) => i.weights[key] > 0)
    .sort((a, b) => b.weights[key] - a.weights[key] || (b.score ?? -1) - (a.score ?? -1));
  renderHero('lth', composite.lth, membersOf('lth', indicators));
  renderHero('sth', composite.sth, membersOf('sth', indicators));
  if (macro) {
    const bills = macro.stats.bills;
    const sc = state.data.stablecoins;
    const context = [
      bills ? `เฟดเติมสุทธิ ≈ ${signedBn(bills.perMonth.net)}/เดือน` : '',
      sc ? `Stablecoin ${usdBn(sc.totalMn / 1e3)} (90 วัน ${fmtPct(sc.changes.find((x) => x.days === 90)?.pct)})` : '',
    ].filter(Boolean).join(' · ');
    renderHero('macro', macro, membersOf('macro', macro.indicators),
      `<p class="macro-level">สภาพคล่องโลก ≈ $${(macro.globalUsdMn / 1e6).toFixed(2)}T · ข้อมูลรายสัปดาห์ ณ ${fmtDate(macro.asOf)}</p>${context ? `<p class="macro-level">${context}</p>` : ''}`);
  } else if ($('#hero-macro')) {
    $('#hero-macro').innerHTML = '<div class="skeleton">ยังดึงข้อมูลสภาพคล่องจาก FRED ไม่ได้ในขณะนี้</div>';
  }
  if (state.data.evidence) renderEvidence(state.data.evidence);
  // The charts and cards below, one per browser task (see runSteps in common.js).
  const d = state.data;
  runSteps('page', [
    renderCharts,
    renderCostBasis,
    () => window.renderBottomCheck?.(d),
    () => window.renderRealized?.(d),
    renderMacro,
    () => window.renderCredit?.(d),
    renderStablecoins,
    () => window.renderEtf?.(d),
    () => window.renderBacktest?.(d),
    () => window.renderHalving?.(d),
    () => window.renderCycles?.(d),
    () => window.renderForecast?.(d),
    () => window.renderSeason?.(d),
    renderIndicators,
    renderSources,
    // the "สรุปวันนี้" card (today.js) reads the same data once the panels are drawn
    () => window.dispatchEvent(new CustomEvent('btc:data', { detail: d })),
  ]);
}

// ---------- header ----------

function renderHeader() {
  const { price, generatedAt, composite, macro, display, siblings, symbol } = state.data;
  // Pages that show one of several assets (coin.html) take their headings from the API.
  if (display) {
    if ($('#asset-title')) $('#asset-title').textContent = display.title;
    if ($('#price-label')) $('#price-label').textContent = display.priceLabel;
    if ($('#asset-logo')) $('#asset-logo').textContent = symbol.slice(0, 4);
  }
  if (siblings && $('#coin-nav')) {
    $('#coin-nav').innerHTML = siblings
      .map((s) => `<a href="/coin.html?c=${encodeURIComponent(s.symbol)}"${s.symbol === symbol ? ' class="on" aria-current="page"' : ''} title="${esc(s.name)}">${esc(s.symbol)}</a>`)
      .join('');
  }
  $('#price').textContent = fmtUsd(price.usd);
  const ch = price.changePct;
  $('#change').innerHTML = ch == null ? '' : `<span class="${ch >= 0 ? 'up' : 'down'}">${ch >= 0 ? '▲' : '▼'} ${Math.abs(ch).toFixed(2)}% (${PAGE.changeLabel || '24 ชม.'})</span>`;
  $('#updated').textContent = `อัปเดต ${fmtTime(generatedAt)}`;
  renderNetStatus(state.data.network, state.data.sources);
  const thai = state.data.thai;
  if ($('#thai')) {
    $('#thai').textContent = thai
      ? `ทองแท่งไทย 96.5% ≈ ${thai.barPerBaht.toLocaleString('en-US')} บาท/บาททอง (ประมาณจากราคาโลก × ${thai.thbPerUsd.toFixed(2)} บาท/ดอลลาร์ ยังไม่รวมส่วนต่างร้านทอง)`
      : '';
  }
  const pct = (s) => `${Math.round(s ?? 0)}%`;
  document.title = `${symbol ? `${symbol} ` : PAGE.titlePrefix || ''}${fmtUsd(price.usd)} · LTH ${pct(composite.lth.score)} · STH ${pct(composite.sth.score)}${macro ? ` · Macro ${pct(macro.score)}` : ''}`;
}

// ---------- evidence (pages whose API returns `evidence`) ----------

function renderEvidence(ev) {
  const up = (s) => (s?.n ? `${Math.round(s.upPct)}%` : '–');
  const name = esc(ev.assetName || '');
  const hero = $('#hero-verdict');
  if (hero) {
    // Title, subtitle and bullet points come from the API so each asset states its own findings.
    hero.innerHTML = `
      <div class="hero-head">
        <div>
          <div class="eyebrow">ผลทดสอบย้อนหลัง ตั้งแต่ปี ${ev.since}</div>
          <h2>${esc(ev.title)}</h2>
          <p class="muted">${esc(ev.subtitle)}</p>
        </div>
      </div>
      <ul class="verdict">
        ${(ev.verdict || []).map((v) => `<li><b>${esc(v.b)}</b> ${esc(v.t)}</li>`).join('')}
      </ul>`;
  }
  const table = (sec) => `
    <table>
      <thead><tr><th>คะแนน ณ ตอนนั้น</th><th class="num">จำนวนวัน</th><th class="num">${name} ${sec.horizonText}ถัดไป (ค่ากลาง)</th><th class="num">โอกาสราคาขึ้น</th></tr></thead>
      <tbody>
        ${sec.buckets.map((b) => `<tr><td>${esc(b.label)}</td><td class="num">${b.n.toLocaleString('en-US')}</td><td class="num">${fmtPct(b.median)}</td><td class="num">${up(b)}</td></tr>`).join('')}
        <tr><td><b>ทุกช่วงรวมกัน</b></td><td class="num">${sec.baseline.n.toLocaleString('en-US')}</td><td class="num">${fmtPct(sec.baseline.median)}</td><td class="num">${up(sec.baseline)}</td></tr>
      </tbody>
    </table>`;
  if ($('#evidence-lth')) $('#evidence-lth').innerHTML = table(ev.lth);
  if ($('#evidence-sth')) $('#evidence-sth').innerHTML = table(ev.sth);
}

// ---------- hero ----------

function gaugeSvg(score) {
  const cx = 110;
  const cy = 108;
  const r = 90;
  const pt = (s, rad = r) => {
    const a = Math.PI * (1 - s / 100);
    return [cx + rad * Math.cos(a), cy - rad * Math.sin(a)];
  };
  const seg = (s0, s1, tone) => {
    const [x0, y0] = pt(s0 + 0.8);
    const [x1, y1] = pt(s1 - 0.8);
    return `<path class="tone-${tone}" d="M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}" stroke="var(--tone)" stroke-width="16" fill="none"/>`;
  };
  const tones = ['strong-sell', 'sell', 'neutral', 'buy', 'strong-buy'];
  const arcs = tones.map((t, i) => seg(i * 20, (i + 1) * 20, t)).join('');
  const ticks = [0, 50, 100].map((s) => {
    const [x, y] = pt(s, r + 16);
    return `<text class="gauge-tick" x="${x.toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="middle">${s}</text>`;
  }).join('');
  let needle = '';
  if (score != null) {
    const [nx, ny] = pt(score, r - 26);
    needle = `<line class="gauge-needle" x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke-width="3" stroke-linecap="round"/><circle class="gauge-hub" cx="${cx}" cy="${cy}" r="5"/>`;
  }
  return `<svg viewBox="-16 -8 252 124" role="img" aria-label="มาตรวัดคะแนน ${score == null ? 'ไม่มีข้อมูล' : Math.round(score)}%">${arcs}${ticks}${needle}</svg>`;
}

function renderHero(key, comp, members, footer = '') {
  const meta = HERO_META[key];
  const tone = toneOf(comp.score);
  $(`#hero-${key}`).innerHTML = `
    <div class="hero-head">
      <div>
        <div class="eyebrow">${meta.eyebrow}</div>
        <h2>${meta.title}</h2>
        <p class="muted">${meta.hint}</p>
      </div>
      <span class="pill tone-${tone}"><i></i>${esc(comp.label.text)}</span>
    </div>
    <div class="hero-body">
      <div>
        <div class="gauge">
          ${gaugeSvg(comp.score)}
          <div class="gauge-num"><span class="big">${comp.score == null ? '–' : Math.round(comp.score)}</span><span class="pct">%</span></div>
        </div>
        <div class="gauge-cap">${meta.cap}</div>
      </div>
      <div>
        <p class="advice">${ADVICE[key][tone]}</p>
        <div class="counts">
          <span>▲ เป็นบวก <b>${comp.bullish}</b></span>
          <span>● กลาง <b>${comp.used - comp.bullish - comp.bearish}</b></span>
          <span>▼ เป็นลบ <b>${comp.bearish}</b></span>
          <span>ใช้ <b>${comp.used}/${comp.total}</b> ตัว</span>
        </div>
        ${footer}
      </div>
    </div>
    <ul class="members">
      ${members.map((i) => `
        <li title="${esc(i.name)}: ${esc(i.valueText)}">
          <span class="nm">${esc(i.name)} <small>×${i.weights[key]}</small></span>
          <span class="meter tone-${toneOf(i.score)}"><span style="width:${i.score ?? 0}%"></span></span>
          <span class="sc">${i.score == null ? '–' : Math.round(i.score)}</span>
        </li>`).join('')}
    </ul>`;
}

// ---------- chart plumbing ----------

const zoneBands = scoreBands(80, 20);

// Shades the "not yet happened" region to the right of chart.$futureFrom.
const futureShade = {
  id: 'futureShade',
  beforeDatasetsDraw(chart) {
    const from = chart.$futureFrom;
    if (from == null || from >= chart.data.labels.length) return;
    const { ctx, chartArea, scales } = chart;
    const x = Math.max(chartArea.left, scales.x.getPixelForValue(Math.max(0, from - 0.5)));
    ctx.save();
    ctx.fillStyle = cssVar('--future');
    ctx.fillRect(x, chartArea.top, chartArea.right - x, chartArea.bottom - chartArea.top);
    ctx.fillStyle = cssVar('--muted');
    ctx.font = '11px system-ui, "Segoe UI", "Leelawadee UI", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('ล่วงหน้า →', chartArea.right - 6, chartArea.top + 14);
    ctx.restore();
  },
};

const zeroLine = baselineAt(0);

// ---------- LTH / STH history ----------

function renderCharts() {
  if (!window.Chart) {
    $('.chart-price').innerHTML = '<p class="note">โหลดไลบรารีกราฟ (Chart.js) ไม่สำเร็จ — ตรวจสอบว่ามีไฟล์ public/vendor/chart.umd.min.js</p>';
    return;
  }
  const h = state.data.history;
  const n = h.dates.length;
  // "หรือเลือกวัน": about six months either side of the chosen day, marked on both charts.
  const win = state.range === 'day' && state.day ? dayWindow(h.dates, state.day) : null;
  const days = state.range === '1y' ? 365 : state.range === '4y' ? 1461 : n;
  const s = win ? win.from : Math.max(0, n - days);
  const e = win ? win.to + 1 : n;
  const labels = h.dates.slice(s, e);
  const mode = state.range === 'all' ? 'all' : 'short';
  const marker = { index: win ? win.at - s : null };
  syncDayPick('range-date', h.dates, !!win, state.day);
  renderDayReadout(h, win?.at ?? null);
  renderIntraday(win ? state.day : null);
  if (win && state.scrollToDay) {
    state.scrollToDay = false;
    $('#range-readout').scrollIntoView({ block: 'center' });
  }

  Object.values(charts).forEach((c) => c.destroy());

  const priceOpts = baseOptions(mode);
  priceOpts.plugins.tooltip.callbacks.label = (item) => ` ราคา: ${fmtUsd(item.parsed.y)}`;
  priceOpts.plugins.dayMarker = marker;
  priceOpts.scales.y = logPriceAxis();
  charts.price = new Chart($('#chart-price'), {
    type: 'line',
    data: { labels, datasets: [{ label: 'ราคา', data: h.price.slice(s, e), ...lineStyle(cssVar('--price')) }] },
    options: priceOpts,
    plugins: [crosshair, hoverSync, dayMarker],
  });
  attachPins(charts.price, 'main');

  const scoreOpts = baseOptions(mode);
  scoreOpts.plugins.tooltip.callbacks.label = (item) => ` ${item.dataset.label}: ${item.parsed.y == null ? '–' : `${Math.round(item.parsed.y)}%`}`;
  scoreOpts.plugins.dayMarker = marker;
  scoreOpts.scales.y = {
    min: 0,
    max: 100,
    position: 'right',
    grid: { color: cssVar('--grid') },
    border: { display: false },
    ticks: { color: cssVar('--muted'), stepSize: 20, callback: (v) => `${v}%` },
  };
  charts.score = new Chart($('#chart-score'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'ระยะยาว (LTH)', data: h.lth.slice(s, e), ...lineStyle(cssVar('--lth')) },
        { label: 'ระยะสั้น (STH)', data: h.sth.slice(s, e), ...lineStyle(cssVar('--sth'), 1.5) },
      ],
    },
    options: scoreOpts,
    plugins: [zoneBands, crosshair, hoverSync, dayMarker],
  });
  pair(charts.price, charts.score);
}

// Values of every line on the chosen day (null = not in day mode).
function renderDayReadout(h, at) {
  const box = $('#range-readout');
  if (!box) return;
  box.hidden = at == null;
  if (at == null) return;
  const last = h.dates.length - 1;
  const pill = (label, v) => `<span class="pill tone-${toneOf(v)}"><i></i>${label} ${v == null ? '–' : `${Math.round(v)}%`}</span>`;
  const since = (h.price[last] / h.price[at] - 1) * 100;
  const moved = at < last && Number.isFinite(since)
    ? ` · ราคาวันนี้เทียบวันนั้น <span class="${since >= 0 ? 'up' : 'down'}">${since >= 0 ? '▲' : '▼'} ${fmtPct(since)}</span>`
    : '';
  const nearest = h.dates[at] !== state.day ? ` (วันที่ ${fmtDate(state.day)} ไม่มีข้อมูล จึงใช้วันก่อนหน้าที่ใกล้ที่สุด)` : '';
  box.innerHTML = `<b>${fmtDate(h.dates[at])}</b>${nearest} — ราคาปิด <b>${fmtUsd(h.price[at])}</b> ${pill('ระยะยาว (LTH)', h.lth[at])} ${pill('ระยะสั้น (STH)', h.sth[at])}${moved}
    <span class="readout-hint">ด้านล่างคือราคา 24 ชั่วโมงของวันนั้น ตามด้วยกราฟ 6 เดือนก่อนและหลังวันนั้น (เส้นประสีส้ม = วันที่เลือก) · กด 1 ปี / 4 ปี / ทั้งหมด เพื่อกลับ</span>`;
}

// ---------- "ราคา 24 ชั่วโมงของวันนั้น": the chosen day in Thai time ----------
// Scores are daily, so only the price has intraday data. Fetched once per day
// and kept by the server in cache/intraday/ (today's refreshes every minute).

const intradayCache = new Map(); // "asset|day" → { data } or { error }, plus when it was fetched
let intradayChart = null;
const TH_CLOCK = new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Bangkok' });
const thaiTime = (ms) => TH_CLOCK.format(ms);
const intradayAsset = () => (state.data.asset === 'gold' ? 'GOLD' : state.data.asset === 'alt' ? state.data.symbol : 'BTC');

// Dots with a label at the day's high and low (options.plugins.hiLoMarks.points).
const hiLoMarks = {
  id: 'hiLoMarks',
  afterDatasetsDraw(chart, args, opts) {
    if (!opts?.points) return;
    const { ctx, scales, chartArea } = chart;
    ctx.save();
    ctx.font = `600 11px ${CHART_FONT}`;
    for (const p of opts.points) {
      const x = scales.x.getPixelForValue(p.i);
      const y = scales.y.getPixelForValue(p.v);
      ctx.fillStyle = cssVar(p.high ? '--up' : '--down');
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      // Beside the dot, never above or below it, so the label stays off the axes.
      const left = x < (chartArea.left + chartArea.right) / 2;
      ctx.textAlign = left ? 'left' : 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.text, x + (left ? 8 : -8), Math.min(Math.max(y, chartArea.top + 6), chartArea.bottom - 6));
    }
    ctx.restore();
  },
};

async function renderIntraday(day) {
  const box = $('#intraday');
  if (!box) return;
  box.hidden = !day;
  if (!day) return;
  const asset = intradayAsset();
  const key = `${asset}|${day}`;
  let entry = intradayCache.get(key);
  const expired = entry && (entry.error || entry.data.partial) && Date.now() - entry.at > 60 * 1000;
  if (!entry || expired) {
    if (!entry) {
      if (intradayChart) { intradayChart.destroy(); intradayChart = null; }
      $('#intraday-stats').textContent = 'กำลังโหลดราคาระหว่างวัน…';
      $('#intraday-note').textContent = '';
    }
    try {
      const res = await fetch(`/api/intraday?asset=${encodeURIComponent(asset)}&day=${day}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || res.statusText);
      entry = { data: json, at: Date.now() };
    } catch (err) {
      entry = { error: err.message, at: Date.now() };
    }
    intradayCache.set(key, entry);
    if (state.range !== 'day' || state.day !== day) return; // another day was picked meanwhile
  }
  drawIntraday(entry);
}

// Dotted line where the next daily bar starts (07:00 Thai time for crypto): scores can jump there.
const barSplit = {
  id: 'barSplit',
  afterDatasetsDraw(chart, args, opts) {
    if (opts?.index == null) return;
    const { ctx, chartArea, scales } = chart;
    const x = scales.x.getPixelForValue(opts.index);
    ctx.save();
    ctx.strokeStyle = cssVar('--muted');
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    if (opts.text) {
      ctx.fillStyle = cssVar('--muted');
      ctx.font = `11px ${CHART_FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(opts.text, x + 4, chartArea.top + 2);
    }
    ctx.restore();
  },
};

let intradayScoreChart = null;

function drawIntraday(entry) {
  if (intradayChart) { intradayChart.destroy(); intradayChart = null; }
  if (intradayScoreChart) { intradayScoreChart.destroy(); intradayScoreChart = null; }
  const wrap = $('#intraday .chart-intraday');
  wrap.hidden = !!entry.error;
  $('#intraday-score-wrap').hidden = true;
  if (entry.error) {
    $('#intraday-stats').textContent = `ดูราคาระหว่างวันไม่ได้: ${entry.error}`;
    $('#intraday-note').textContent = '';
    return;
  }
  const d = entry.data;
  const rows = d.rows; // [time, open, high, low, close]
  let hi = 0;
  let lo = 0;
  rows.forEach((r, i) => { if (r[2] > rows[hi][2]) hi = i; if (r[3] < rows[lo][3]) lo = i; });
  const open = rows[0][1];
  const close = rows[rows.length - 1][4];
  const high = rows[hi][2];
  const low = rows[lo][3];
  const move = (close / open - 1) * 100;
  const arrow = `<span class="${move >= 0 ? 'up' : 'down'}">${move >= 0 ? '▲' : '▼'} ${fmtPct(move, 2)}</span>`;
  const end = d.partial ? `ล่าสุด ${thaiTime(rows[rows.length - 1][0])}` : 'จบวัน';
  // Scores through the day, when the server could compute them.
  const sc = d.scores && d.scores.lth.some((v) => v != null) ? d.scores : null;
  const range = (arr) => {
    const v = arr.filter((x) => x != null);
    return v.length ? { first: v[0], last: v[v.length - 1], min: Math.min(...v), max: Math.max(...v) } : null;
  };
  const scoreLine = (name, r) => (r ? `${name} <b>${Math.round(r.first)}</b> → <b>${Math.round(r.last)}</b> (ระหว่างวัน ${Math.round(r.min)}–${Math.round(r.max)})` : `${name} –`);
  $('#intraday-stats').innerHTML = `เปิด ${thaiTime(rows[0][0])} <b>${fmtUsd(open)}</b> → ${end} <b>${fmtUsd(close)}</b> ${arrow}
    · สูงสุด <b>${fmtUsd(high)}</b> (${thaiTime(rows[hi][0])}) · ต่ำสุด <b>${fmtUsd(low)}</b> (${thaiTime(rows[lo][0])}) · แกว่งในวัน ${((high / low - 1) * 100).toFixed(1)}%
    ${sc ? `<span class="intraday-scores">คะแนน: ${scoreLine('ระยะยาว (LTH)', range(sc.lth))} · ${scoreLine('ระยะสั้น (STH)', range(sc.sth))}</span>` : ''}`;
  const split = sc?.bars[1]?.from ?? null;
  $('#intraday-note').textContent = [
    `ราคาทุก ${d.interval} จาก ${d.source} · เวลาไทย 00:00–24:00`,
    d.partial ? 'วันนี้ยังไม่จบ อัปเดตทุก 1 นาที' : '',
    'เส้นบางแนวนอน = ราคาเปิด',
    sc ? 'คะแนนเป็นค่ารายวัน กราฟคะแนนระหว่างวันคือ "ถ้าแท่งรายวันปิดที่ราคานั้น คะแนนจะเป็นเท่าไร" แบบเดียวกับคะแนนสดของวันนี้ที่ขยับตามราคา' : '',
    split != null ? `เส้นจุดตอน ${thaiTime(rows[split][0])} = เริ่มแท่งรายวันใหม่ ค่าเฉลี่ยและ RSI ขยับไปหนึ่งวัน คะแนนจึงกระโดดได้ตรงนั้น` : '',
    sc ? 'คะแนนทดสอบย้อนหลังด้วยราคาปิดรายวันเท่านั้น ไม่ได้ทดสอบการซื้อขายระหว่างวัน' : '',
    'ราคาปิดในกล่องด้านบนเป็นราคาปิดรายวันตามเวลาสากล (07:00 เวลาไทยของวันถัดไปสำหรับคริปโต) จึงอาจต่างจากราคาจบวันเวลาไทย',
  ].filter(Boolean).join(' · ');

  const fixedWidth = (axis) => { axis.width = 72; }; // both charts share one plot width, so the hover line lines up
  const labels = rows.map((r) => thaiTime(r[0]));
  const opts = baseOptions('short');
  opts.layout.padding.top = 18;
  opts.scales.x.ticks.callback = function (v) { return this.getLabelForValue(v); };
  opts.plugins.tooltip.callbacks.title = (items) => `${fmtDate(d.day)} เวลา ${items[0].label} น.`;
  opts.plugins.tooltip.callbacks.label = (item) => ` ราคา: ${fmtUsd(item.parsed.y)}`;
  opts.plugins.hiLoMarks = { points: [{ i: hi, v: high, high: true, text: `สูงสุด ${fmtUsd(high)}` }, { i: lo, v: low, high: false, text: `ต่ำสุด ${fmtUsd(low)}` }] };
  opts.plugins.barSplit = { index: split };
  opts.scales.y = {
    position: 'right',
    suggestedMin: low,
    suggestedMax: high,
    afterFit: fixedWidth,
    grid: { color: cssVar('--grid') },
    border: { display: false },
    ticks: { color: cssVar('--muted'), maxTicksLimit: 6, callback: (v) => fmtUsd(v) },
  };
  intradayChart = new Chart($('#chart-intraday'), {
    type: 'line',
    data: { labels, datasets: [{ label: 'ราคา', data: rows.map((r) => r[4]), ...lineStyle(cssVar('--price'), 1.5) }] },
    options: opts,
    plugins: [baselineAt(open), crosshair, hoverSync, hiLoMarks, barSplit],
  });
  attachPins(intradayChart, `intraday-${d.asset}-${d.day}`, { fmtLabel: (t) => `${t} น.`, span: timeBetween });
  if (!sc) return;

  $('#intraday-score-wrap').hidden = false;
  const sOpts = baseOptions('short');
  sOpts.scales.x.ticks.callback = opts.scales.x.ticks.callback;
  sOpts.plugins.tooltip.callbacks.title = opts.plugins.tooltip.callbacks.title;
  sOpts.plugins.tooltip.callbacks.label = (item) => ` ${item.dataset.label}: ${item.parsed.y == null ? '–' : `${item.parsed.y.toFixed(1)}%`}`;
  sOpts.plugins.barSplit = { index: split, text: split != null ? `${thaiTime(rows[split][0])} เริ่มแท่งรายวันใหม่` : null };
  sOpts.scales.y = {
    min: 0,
    max: 100,
    position: 'right',
    afterFit: fixedWidth,
    grid: { color: cssVar('--grid') },
    border: { display: false },
    ticks: { color: cssVar('--muted'), stepSize: 20, callback: (v) => `${v}%` },
  };
  intradayScoreChart = new Chart($('#chart-intraday-score'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'ระยะยาว (LTH)', data: sc.lth, ...lineStyle(cssVar('--lth')) },
        { label: 'ระยะสั้น (STH)', data: sc.sth, ...lineStyle(cssVar('--sth'), 1.5) },
      ],
    },
    options: sOpts,
    plugins: [zoneBands, crosshair, hoverSync, barSplit],
  });
  pair(intradayChart, intradayScoreChart);
}

// ---------- macro ----------

const tile = (label, value, sub) => `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-sub">${sub}</div></div>`;
// USD billions without a sign (direction is shown by an arrow or by signedBn).
const usdBn = (v, digits = 0) => `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })} พันล้าน`;
const signedBn = (v, digits = 0) => `${v < 0 ? '-' : '+'}${usdBn(v, digits)}`;
const TH_MONTH_YEAR = new Intl.DateTimeFormat('th-TH-u-ca-gregory', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const monthName = (ym) => TH_MONTH_YEAR.format(Date.parse(`${ym}-01T00:00:00Z`));
const usdAxis = () => ({
  position: 'right',
  grid: { color: cssVar('--grid') },
  border: { display: false },
  ticks: { color: cssVar('--muted'), maxTicksLimit: 6, callback: (v) => `${v < 0 ? '-' : ''}$${Math.abs(v)}` },
});

function renderMacro() {
  const m = state.data.macro;
  if (!$('#macro-panel')) return;
  $('#macro-panel').hidden = !m;
  if (!m) return;

  if (window.Chart) {
    const ch = m.chart;
    const lead = m.stats.leadWeeks;
    const n = ch.dates.length;
    const weeks = state.macroRange === '2y' ? 104 + lead : state.macroRange === '5y' ? 261 + lead : n;
    const s = Math.max(0, n - weeks);
    const labels = ch.dates.slice(s);
    const mode = state.macroRange === 'all' ? 'all' : 'short';

    Object.values(macroCharts).forEach((c) => c.destroy());

    const btcOpts = baseOptions(mode);
    btcOpts.plugins.tooltip.callbacks.label = (item) => ` ราคา BTC: ${fmtUsd(item.parsed.y)}`;
    btcOpts.scales.y = logPriceAxis();
    macroCharts.btc = new Chart($('#chart-btc-weekly'), {
      type: 'line',
      data: { labels, datasets: [{ label: 'ราคา BTC', data: ch.btc.slice(s), ...lineStyle(cssVar('--price')) }] },
      options: btcOpts,
      plugins: [futureShade, crosshair, hoverSync],
    });

    const liqOpts = baseOptions(mode);
    liqOpts.plugins.tooltip.callbacks.label = (item) => ` สภาพคล่อง (ของ ${lead} สัปดาห์ก่อน): ${fmtPct(item.parsed.y, 2)}`;
    liqOpts.scales.y = {
      position: 'right',
      grid: { color: cssVar('--grid') },
      border: { display: false },
      ticks: { color: cssVar('--muted'), maxTicksLimit: 6, callback: (v) => `${v}%` },
    };
    macroCharts.liq = new Chart($('#chart-liq'), {
      type: 'line',
      data: { labels, datasets: [{ label: 'สภาพคล่องโลก 13 สัปดาห์', data: ch.liqLead.slice(s), ...lineStyle(cssVar('--macro')) }] },
      options: liqOpts,
      plugins: [futureShade, zeroLine, crosshair, hoverSync],
    });

    macroCharts.btc.$futureFrom = ch.futureIndex - s;
    macroCharts.liq.$futureFrom = ch.futureIndex - s;
    pair(macroCharts.btc, macroCharts.liq);
    macroCharts.btc.update('none');
    macroCharts.liq.update('none');
  }

  renderMacroStats(m.stats, m.score);
  $('#macro-cards').innerHTML = m.indicators.map(cardHtml).join('');
}

function renderMacroStats(st, score) {
  const lead = st.leadWeeks;
  const arrow = (v) => (v == null ? '–' : `<span class="${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '▲' : '▼'} ${fmtPct(v)}</span>`);
  const bestOf = (list) => (list || []).filter((c) => c.r != null).reduce((a, b) => (b.r > a.r ? b : a), { lag: 0, r: -Infinity });
  const fmtR = (c) => (Number.isFinite(c.r) ? c.r.toFixed(2) : '–');
  const best = bestOf(st.corr);
  const etf = st.etf;
  const bestEtf = bestOf(etf?.corr);
  const outcome = (s) => (s?.n ? `ค่ากลาง · ราคาขึ้น ${Math.round(s.upPct)}% ของครั้ง · ${s.n} สัปดาห์` : 'ข้อมูลยังไม่พอ');

  renderMacroOutlook(st);
  renderFedBills(st.bills);
  renderVsGold(st.vsGold);

  $('#macro-since').textContent = st.since ? `(ตั้งแต่ ${new Date(`${st.since}T00:00:00Z`).getUTCFullYear()})` : '';
  $('#macro-stats').innerHTML = [
    tile(`สภาพคล่องเพิ่มขึ้น → BTC ใน ${lead} สัปดาห์ถัดไป`, arrow(st.rising.median), outcome(st.rising)),
    tile(`สภาพคล่องลดลง → BTC ใน ${lead} สัปดาห์ถัดไป`, arrow(st.falling.median), outcome(st.falling)),
    etf
      ? tile('ความสัมพันธ์ยุค ETF (2024+)', `r = ${fmtR(bestEtf)}`, `ดีที่สุดเมื่อสภาพคล่องนำราคา ${bestEtf.lag} สัปดาห์ · ทั้งประวัติตั้งแต่ 2012 r = ${fmtR(best)} (นำ ${best.lag} สัปดาห์) · 0 = ไม่สัมพันธ์, 1 = ไปทางเดียวกันทุกครั้ง`)
      : tile('ความสัมพันธ์สูงสุด (r)', fmtR(best), `เมื่อสภาพคล่องนำราคา ${best.lag} สัปดาห์ · 0 = ไม่สัมพันธ์, 1 = ไปทางเดียวกันทุกครั้ง`),
    etf ? tile(`ยุค ETF: สภาพคล่องเพิ่ม → BTC ${lead} สัปดาห์ถัดไป`, arrow(etf.rising.median), `${outcome(etf.rising)} · ตอนสภาพคล่องลด: ${etf.falling.n ? fmtPct(etf.falling.median) : '–'}`) : '',
  ].join('');

  $('#macro-buckets').innerHTML = `
    <table class="lined">
      <thead><tr><th>คะแนน Macro ณ ตอนนั้น</th><th class="num">จำนวนสัปดาห์</th><th class="num">BTC ${lead} สัปดาห์ถัดไป (ค่ากลาง)</th><th class="num">ค่าเฉลี่ย</th><th class="num">โอกาสราคาขึ้น</th></tr></thead>
      <tbody>
        ${st.buckets.map((b) => `
          <tr${b.current ? ' class="now"' : ''}>
            <td>${esc(b.label)}${b.current ? ` <span class="pill tone-${toneOf(score)}"><i></i>ตอนนี้ ${Math.round(score)}%</span>` : ''}</td>
            <td class="num">${b.n}</td>
            <td class="num">${fmtPct(b.median)}</td>
            <td class="num">${fmtPct(b.mean)}</td>
            <td class="num">${b.upPct == null ? '–' : `${Math.round(b.upPct)}%`}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

// What is already in the pipe for the next ~13 weeks, and which US "pipe"
// added or drained money over the last 13.
function renderMacroOutlook(st) {
  const p = st.pipeline;
  const b = st.beta;
  if ($('#macro-pipeline')) {
    const wind = !p ? '' : p.avg >= 1 ? '<span class="up">▲ ลมส่ง</span>' : p.avg <= -1 ? '<span class="down">▼ ลมต้าน</span>' : '● กลาง ๆ';
    $('#macro-pipeline').innerHTML = [
      p ? tile('สภาพคล่องที่กำลังจะส่งผลถึงราคา', `${wind} ${fmtPct(p.avg)}`, `ค่าเฉลี่ยการเปลี่ยนแปลงของ ${p.weeks} สัปดาห์ล่าสุด · เป็นบวก ${p.positive} จาก ${p.weeks} สัปดาห์ · เกิดขึ้นแล้ว แต่ราคามักตอบสนองช้า จะทยอยส่งผลถึงราว ${fmtDate(p.until)}`) : '',
      b?.etf ? tile('BTC ไวต่อสภาพคล่องแค่ไหน', `×${b.etf.beta.toFixed(1)}`, `สภาพคล่องเปลี่ยน 1% BTC เปลี่ยนตามราว ${b.etf.beta.toFixed(1)}% ใน ${st.leadWeeks} สัปดาห์ถัดมา (ยุค ETF, r = ${b.etf.r.toFixed(2)})${b.all ? ` · ทั้งประวัติ ×${b.all.beta.toFixed(1)}` : ''} — ตัวเลขนี้ขึ้นกับช่วงเวลาที่วัด`) : '',
    ].join('');
  }
  const pipes = st.pipes;
  if ($('#macro-pipes') && pipes) {
    const flow = (v) => (Math.abs(v) < 0.5 ? '● แทบไม่เปลี่ยน' : `<span class="${v > 0 ? 'up' : 'down'}">${v > 0 ? '▲ เติม' : '▼ ดูดออก'}</span> ${usdBn(v)}`);
    const level = (v) => (v >= 100 ? `$${(v / 1000).toFixed(2)}T` : usdBn(v));
    $('#macro-pipes-range').textContent = `(${fmtDate(pipes.from)} – ${fmtDate(pipes.to)})`;
    $('#macro-pipes').innerHTML = [
      tile('เฟด (ขนาดงบดุล)', flow(pipes.fed), `งบดุลโตขึ้น = เฟดเติมเงินเข้าระบบ แม้ไม่ได้เรียกว่า QE · ตอนนี้ ${level(pipes.levels.fed)}`),
      tile('บัญชีกระทรวงการคลัง (TGA)', flow(pipes.tga), `คลังเก็บเงินเข้าบัญชี = ดูดเงินออกจากตลาด เบิกจ่าย = เติมกลับ · ยอดในบัญชี ${level(pipes.levels.tga)}`),
      tile('Reverse Repo', flow(pipes.rrp), `เงินที่กองทุนตลาดเงินนำไปจอดไว้กับเฟด ยอดลดลง = เงินไหลกลับเข้าตลาด · ตอนนี้ ${level(pipes.levels.rrp)}`),
      tile('รวมสามท่อ (US Net Liquidity)', flow(pipes.net), 'เฟด − บัญชีคลัง − Reverse Repo = เงินที่หมุนอยู่ในตลาดสหรัฐฯ จริง'),
    ].join('');
  }
}

// The Fed's T-bill purchases against what it really adds once maturing MBS are netted off.
function renderFedBills(b) {
  if (!$('#fed-bills')) return;
  $('#fed-bills').hidden = !b;
  if (!b) return;
  const rate = (v) => (Math.abs(v) < 0.5 ? '● แทบเป็นศูนย์' : `<span class="${v > 0 ? 'up' : 'down'}">${v > 0 ? '▲' : '▼'}</span> ${usdBn(v)}/เดือน`);
  const s = b.since;
  const net = b.perMonth.net;
  const verdict = net >= 20 ? 'เฟดกำลังเติมเงินเข้าระบบอย่างจริงจัง' : net >= 5 ? 'เฟดเติมเงินเข้าระบบเล็กน้อย' : net > -5 ? 'เฟดแทบไม่ได้เติมเงินใหม่เข้าระบบ' : 'เฟดกำลังดึงเงินออกจากระบบ';
  $('#fed-bills-summary').innerHTML = `<b>สรุปตอนนี้:</b> ${verdict} — ซื้อตั๋วเงินคลังเดือนละราว ${usdBn(b.perMonth.bills)} แต่หัก MBS ที่ครบกำหนดแล้ว เงินใหม่ที่เข้าระบบจริงคือ ${signedBn(net)} ต่อเดือน`;
  $('#fed-bills-asof').textContent = `(ข้อมูล ณ ${fmtDate(b.asOf)})`;
  $('#fed-bills-stats').innerHTML = [
    tile('เฟดซื้อตั๋วเงินคลัง (เฉลี่ย 13 สัปดาห์ล่าสุด)', rate(b.perMonth.bills), `4 สัปดาห์ล่าสุดซื้อ ${usdBn(b.last4.bills)}${b.peak ? ` · เดือนที่ซื้อมากสุด ${monthName(b.peak.month)} ${usdBn(b.peak.bills)}` : ''} · ตอนนี้ถืออยู่ ${usdBn(b.levelBn)}`),
    tile('หัก MBS ที่ครบกำหนด', rate(b.perMonth.mbs), 'เงินต้นที่ได้คืนจาก MBS เฟดนำไปซื้อตั๋วเงินคลังต่อ ส่วนนี้จึงเป็นแค่การสลับสินทรัพย์ ไม่ใช่เงินใหม่'),
    tile('เติมเงินสุทธิจริง', rate(b.perMonth.net), `การเปลี่ยนแปลงของหลักทรัพย์ทั้งหมดที่เฟดถือ = เงินใหม่ที่เข้าระบบจริง · 4 สัปดาห์ล่าสุด ${signedBn(b.last4.net)}`),
    s ? tile(`เติมสุทธิสะสมตั้งแต่เริ่มซื้อ (${fmtDate(b.start)})`, `<span class="${s.net >= 0 ? 'up' : 'down'}">${s.net >= 0 ? '▲' : '▼'}</span> ${usdBn(s.net)}`, `ซื้อตั๋วเงินคลังรวม ${usdBn(s.bills)} · MBS ครบกำหนด ${usdBn(s.mbs)}${s.reserves == null ? '' : ` · เงินสำรองธนาคาร${s.reserves >= 0 ? 'เพิ่มขึ้น' : 'ลดลง'} ${usdBn(s.reserves)}`}`) : '',
  ].join('');

  // Monthly bars: T-bills bought; line: what the Fed really added.
  if (!window.Chart) return;
  const months = b.months;
  const opts = baseOptions('short');
  opts.plugins.tooltip.callbacks.title = (items) => `${monthName(months[items[0].dataIndex].month)}${months[items[0].dataIndex].partial ? ' (ยังไม่ครบเดือน)' : ''}`;
  opts.plugins.tooltip.callbacks.label = (item) => ` ${item.dataset.label}: ${item.parsed.y == null ? '–' : signedBn(item.parsed.y, 1)}`;
  opts.plugins.tooltip.callbacks.afterBody = (items) => `MBS ครบกำหนดในเดือนนั้น: ${usdBn(months[items[0].dataIndex].mbs, 1)}`;
  opts.scales.y = usdAxis();
  if (billsChart) billsChart.destroy();
  billsChart = new Chart($('#chart-fed-bills'), {
    type: 'bar',
    data: {
      labels: months.map((x) => `${x.month}-01`),
      datasets: [
        { type: 'line', label: 'เติมสุทธิจริง (เฉลี่ย 3 เดือน)', data: months.map((x) => x.netAvg), ...lineStyle(cssVar('--macro')), order: 0 },
        { label: 'ซื้อตั๋วเงินคลัง', data: months.map((x) => x.bills), backgroundColor: months.map((x) => cssVar(x.partial ? '--axis' : '--muted')), borderRadius: 3, maxBarThickness: 30, order: 1 },
      ],
    },
    options: opts,
    plugins: [zeroLine, crosshair],
  });
}

// Does global liquidity lead BTC better than gold? One row per lead time.
function renderVsGold(v) {
  if (!$('#macro-vsgold-wrap')) return;
  $('#macro-vsgold-wrap').hidden = !v;
  if (!v) return;
  const fmtR = (r) => (r == null ? '–' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}`);
  const cell = (r) => `<td class="num">${r != null && r >= 0.3 ? `<b>${fmtR(r)}</b>` : fmtR(r)}</td>`;
  const lead = v.lags.find((x) => x.lag === 13);
  const same = v.lags.find((x) => x.lag === 0);
  const btcLeads = lead?.btcEtf >= 0.3;
  const goldLeads = lead?.goldEtf >= 0.3;
  const etfYear = new Date(`${v.etfSince}T00:00:00Z`).getUTCFullYear();
  $('#macro-vsgold-summary').innerHTML = lead
    ? `<b>สรุป:</b> ${btcLeads && !goldLeads ? 'จริงตามที่คลิปพูด — ' : ''}เมื่อสภาพคล่องโลกเปลี่ยน ราคา BTC ${btcLeads ? 'ขยับตาม' : 'ไม่ได้ขยับตามชัดเจน'}ในราว 13 สัปดาห์ต่อมา (ยุค ETF r = ${fmtR(lead.btcEtf)}) ส่วนทอง${goldLeads ? 'ก็ขยับตาม' : 'ไม่ตาม'} (r = ${fmtR(lead.goldEtf)}) · ทองขยับพร้อมสภาพคล่องในสัปดาห์เดียวกันมากกว่า (r = ${fmtR(same?.goldEtf)})`
    : '';
  const label = (lag) => (lag === 0 ? 'สัปดาห์เดียวกัน (ไม่นำ)' : `สภาพคล่องนำ ${lag} สัปดาห์${lag === 13 ? ' (ที่ใช้ในคะแนน Macro)' : ''}`);
  $('#macro-vsgold').innerHTML = `
    <table class="lined">
      <thead><tr><th>ช่วงเวลา</th><th class="num">BTC ตั้งแต่ ${v.since.slice(0, 4)}</th><th class="num">ทอง ตั้งแต่ ${v.since.slice(0, 4)}</th><th class="num">BTC ยุค ETF (${etfYear}+)</th><th class="num">ทอง ยุค ETF (${etfYear}+)</th></tr></thead>
      <tbody>
        ${v.lags.map((x) => `<tr${x.lag === 13 ? ' class="now"' : ''}><td>${label(x.lag)}</td>${cell(x.btc)}${cell(x.gold)}${cell(x.btcEtf)}${cell(x.goldEtf)}</tr>`).join('')}
      </tbody>
    </table>`;
}

// ---------- cost lines ----------

const COST_LINES = {
  sth: { name: 'ต้นทุนผู้ถือระยะสั้น (STH)', color: '--sth', what: 'ต้นทุนเฉลี่ยของเหรียญที่เพิ่งเปลี่ยนมือในราว 5 เดือน ราคาต่ำกว่าเส้นนี้ = คนซื้อช่วงหลังส่วนใหญ่ขาดทุน' },
  tmm: { name: 'True Market Mean', color: '--lth', what: 'ต้นทุนเฉลี่ยของเหรียญที่ยังเคลื่อนไหวในตลาด (ไม่นับเหรียญที่นิ่งหรือหายไปนาน) นักวิเคราะห์ on-chain ใช้เป็นเส้นแบ่งตลาดขาขึ้น/ขาลงแบบหยาบ ๆ' },
  howell: { name: 'เส้นเช็คของ Howell', color: '--muted', what: 'Howell บอกว่าถ้า BTC ยืนเหนือเส้นนี้ได้ แปลว่าเงินยังไม่ตึงจริงตามที่เขาอ่าน ถ้าหลุดแปลว่าเขาอ่านผิด' },
};

function renderCostBasis() {
  if (!$('#cost-panel')) return;
  const cb = state.data.costBasis;
  $('#cost-panel').hidden = !cb;
  if (!cb) return;

  const where = (l) => `<span class="${l.gapPct >= 0 ? 'up' : 'down'}">${l.gapPct >= 0 ? '▲ เหนือ' : '▼ ใต้'}</span> ${Math.abs(l.gapPct).toFixed(1)}%`;
  const below = cb.lines.filter((l) => l.gapPct < 0);
  const list = (ls) => ls.map((l) => `${COST_LINES[l.id].name} ${Math.abs(l.gapPct).toFixed(1)}%`).join(', ');
  $('#cost-asof').textContent = `(ราคา ณ ${fmtDate(cb.date)})`;
  $('#cost-summary').innerHTML = `<b>สรุปตอนนี้:</b> ราคา ${fmtUsd(cb.price)} ${below.length === 0
    ? `อยู่เหนือทั้ง 3 เส้น — เหนือ${list(cb.lines)}`
    : below.length === cb.lines.length
      ? `หลุดลงไปใต้ทั้ง 3 เส้น — ใต้${list(cb.lines)}`
      : `อยู่ใต้${list(below)} แต่ยังเหนือ${list(cb.lines.filter((l) => l.gapPct >= 0))}`}`;
  $('#cost-stats').innerHTML = cb.lines.map((l) => tile(
    `${COST_LINES[l.id].name}: ${fmtUsd(l.value)}`,
    where(l),
    `${COST_LINES[l.id].what}${l.id === 'howell' ? ` (Capital Wars ${fmtDate(l.asOf)})` : ` · ข้อมูล ณ ${fmtDate(l.asOf)}`}`,
  )).join('');
  renderCostEvidence(cb);

  if (!window.Chart) return;
  const ch = cb.chart;
  const n = ch.dates.length;
  const days = state.costRange === '1y' ? 365 : state.costRange === '2y' ? 730 : n;
  const s = Math.max(0, n - days);
  const opts = baseOptions(state.costRange === '4y' ? 'all' : 'short');
  opts.plugins.tooltip.callbacks.label = (item) => ` ${item.dataset.label}: ${fmtUsd(item.parsed.y)}`;
  opts.scales.y = logPriceAxis();
  const howell = cb.lines.find((l) => l.id === 'howell').value;
  if (costChart) costChart.destroy();
  costChart = new Chart($('#chart-cost'), {
    type: 'line',
    data: {
      labels: ch.dates.slice(s),
      datasets: [
        { label: 'ราคา', data: ch.price.slice(s), ...lineStyle(cssVar('--price')) },
        { label: COST_LINES.sth.name, data: ch.sth.slice(s), ...lineStyle(cssVar('--sth'), 1.5) },
        { label: COST_LINES.tmm.name, data: ch.tmm.slice(s), ...lineStyle(cssVar('--lth'), 1.5) },
        { label: COST_LINES.howell.name, data: ch.dates.slice(s).map(() => howell), ...lineStyle(cssVar('--muted'), 1.5), borderDash: [5, 4], pointHoverRadius: 0 },
      ],
    },
    options: opts,
    plugins: [crosshair],
  });
}

// Price near the STH cost basis in a cheap market (LTH ≥ 70): what followed, since 2014.
function renderCostEvidence(cb) {
  const ev = cb.evidence;
  if (!ev || !$('#cost-evidence')) return;
  const [h1, h2] = ev.horizons; // 90, 365
  const row = (id) => ev.rows.find((r) => r.id === id);
  const arrow = (v) => (v == null ? '–' : `<span class="${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '▲' : '▼'} ${fmtPct(v, 0)}</span>`);
  const sub = (r, showEpisodes) => {
    const a = r[h2];
    const b = r[h1];
    if (!a?.n) return 'ข้อมูลยังไม่พอ';
    const ep = showEpisodes ? ` (${a.episodes} ครั้ง)` : '';
    return `1 ปีต่อมาราคาขึ้น ${Math.round(a.upPct)}% ของครั้ง${ep} · ระหว่างทางลงลึกสุด ค่ากลาง ${fmtPct(a.ddMedian, 0)} แย่สุด ${fmtPct(a.ddWorst, 0)} · 3 เดือนต่อมา ค่ากลาง ${fmtPct(b.median, 0)} ขึ้น ${Math.round(b.upPct)}% ของครั้ง`;
  };
  const strong = row('nearCheap');
  $('#cost-ev-since').textContent = `(ตั้งแต่ ${new Date(`${ev.from}T00:00:00Z`).getUTCFullYear()})`;
  $('#cost-evidence').innerHTML = [
    tile('วันทั่วไป (ไว้เทียบ) → ราคา 1 ปีต่อมา', arrow(row('all')[h2].median), sub(row('all'), false)),
    tile(`ราคาห่างต้นทุน STH ไม่เกิน ±${ev.nearPct}% → ราคา 1 ปีต่อมา`, arrow(row('near')[h2].median), sub(row('near'), true)),
    tile(`ห่างต้นทุน STH ±${ev.nearPct}% <b>และ</b> คะแนน LTH ≥ ${ev.lthMin} → ราคา 1 ปีต่อมา`, arrow(strong[h2].median), sub(strong, true)),
  ].join('');
  const now = cb.now;
  const pending = strong.episodes - (strong[h2]?.episodes || 0);
  const gap = `ราคาห่างต้นทุน STH ${fmtPct(now.sthGapPct, 1)} และคะแนน LTH ${now.lth == null ? '–' : Math.round(now.lth)}`;
  $('#cost-now').innerHTML = now.near && now.cheap
    ? `<b>ตอนนี้เข้าเงื่อนไข:</b> ${gap} — ในอดีตครบ 1 ปีแล้ว ${strong[h2].episodes} ครั้ง ${strong[h2].upPct >= 100 ? 'ราคาสูงขึ้นทุกครั้ง' : `ราคาสูงขึ้น ${Math.round(strong[h2].upPct)}% ของวัน`}${pending > 0 ? ` (อีก ${pending} ครั้งรวมรอบนี้ยังไม่ครบ 1 ปี)` : ''} แต่ระหว่างทางเคยลงต่ออีกถึง ${fmtPct(strong[h2].ddWorst, 0)}`
    : `<b>ตอนนี้ยังไม่เข้าเงื่อนไข:</b> ${gap} (ต้องห่างไม่เกิน ±${ev.nearPct}% และคะแนน ≥ ${ev.lthMin})`;
}

// ---------- stablecoins ----------

function renderStablecoins() {
  if (!$('#stable-panel')) return;
  const sc = state.data.stablecoins;
  $('#stable-panel').hidden = !sc;
  if (!sc) return;

  const bn = (usdMn, digits = 1) => usdBn(usdMn / 1e3, digits);
  const change = (days) => sc.changes.find((x) => x.days === days);
  const flow = (x) => (x?.usdMn == null ? '–' : Math.abs(x.pct) < 0.05 ? '● ไม่เปลี่ยน' : `<span class="${x.usdMn > 0 ? 'up' : 'down'}">${x.usdMn > 0 ? '▲' : '▼'}</span> ${bn(x.usdMn)}`);
  const mark = { up: '<span class="up">▲</span>', down: '<span class="down">▼</span>', flat: '●' }[sc.state.tone];
  const [d30, d90, d180, d365] = [30, 90, 180, 365].map(change);
  const verdict = { up: 'มีเงินใหม่ไหลเข้าตลาดคริปโต', flat: 'ยังไม่มีเงินใหม่ไหลเข้าตลาดคริปโต', down: 'เงินกำลังไหลออกจากตลาดคริปโต' }[sc.state.tone];
  $('#stable-summary').innerHTML = `<b>สรุปตอนนี้:</b> ${verdict} — ยอดรวม ${bn(sc.totalMn)} เปลี่ยนไป ${fmtPct(d90.pct)} ใน 90 วัน (${esc(sc.state.text)})`;
  $('#stable-asof').textContent = `(ข้อมูล ณ ${fmtDate(sc.asOf)})`;
  $('#stable-stats').innerHTML = [
    tile('ยอดรวม USDT + USDC', bn(sc.totalMn), `USDT ${bn(sc.usdtMn)} · USDC ${bn(sc.usdcMn)} · สูงสุดที่เคยมี ${bn(sc.peak.totalMn)} (${fmtDate(sc.peak.date)})`),
    tile('สถานะตอนนี้ (ดูจากรอบ 90 วัน)', `${mark} ${esc(sc.state.text)}`, `90 วันเปลี่ยนไป ${fmtPct(d90.pct)} (${d90.usdMn == null ? '–' : signedBn(d90.usdMn / 1e3, 1)}) · เกณฑ์: มากกว่า +1% มีเงินใหม่เข้า · ±1% ทรงตัว · ต่ำกว่า −1% เงินไหลออก`),
    tile('รอบ 30 วัน', flow(d30), `${fmtPct(d30.pct)} ของยอดรวม`),
    tile('รอบ 180 วัน', flow(d180), `${fmtPct(d180.pct)} ของยอดรวม · รอบ 1 ปี ${fmtPct(d365.pct)} (${d365.usdMn == null ? '–' : signedBn(d365.usdMn / 1e3, 1)})`),
  ].join('');

  const ev = sc.evidence;
  const fmtR = (r) => (r == null ? '–' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}`);
  const arrow = (v) => (v == null ? '–' : `<span class="${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '▲' : '▼'} ${fmtPct(v)}</span>`);
  const outcome = (s) => (s?.n ? `ค่ากลาง · ราคาขึ้น ${Math.round(s.upPct)}% ของครั้ง · ${s.n.toLocaleString('en-US')} วัน` : 'ข้อมูลยังไม่พอ');
  const splitYear = new Date(`${ev.split}T00:00:00Z`).getUTCFullYear();
  const halves = (x) => `ก่อนกลางปี ${splitYear} r = ${fmtR(x.early)} · หลังจากนั้น r = ${fmtR(x.late)}`;
  const unstable = Math.sign(ev.leads.early) !== Math.sign(ev.leads.late) || Math.abs(ev.leads.all) < 0.1;
  const followsBoth = ev.follows.early > 0.2 && ev.follows.late > 0.2;
  $('#stable-since').textContent = ev.since ? `(ตั้งแต่ ${new Date(`${ev.since}T00:00:00Z`).getUTCFullYear()})` : '';
  $('#stable-evidence').innerHTML = [
    tile(`ตอนยอด Stablecoin โต (เกิน +1% ใน 90 วัน) → BTC ${ev.horizon} วันถัดไป`, arrow(ev.growing.median), outcome(ev.growing)),
    tile(`ตอนยอด Stablecoin ทรงตัวหรือลด → BTC ${ev.horizon} วันถัดไป`, arrow(ev.flat.median), outcome(ev.flat)),
    tile('Stablecoin นำราคา BTC ไหม', `r = ${fmtR(ev.leads.all)}`, `${halves(ev.leads)} → ${unstable ? 'แทบไม่สัมพันธ์และกลับทิศได้ ใช้ทำนายราคาไม่ได้' : 'ทิศทางเดียวกันทั้งสองช่วง'}`),
    tile('ราคา BTC นำ Stablecoin ไหม', `r = ${fmtR(ev.follows.all)}`, `${halves(ev.follows)} → ${followsBoth ? `ราคาขึ้นก่อน แล้วยอด Stablecoin โตตามใน ${ev.horizon} วันถัดมา จึงเป็นตัวยืนยัน ไม่ใช่ตัวนำ` : 'ความสัมพันธ์ไม่คงที่'}`),
  ].join('');

  if (!window.Chart) return;
  const ch = sc.chart;
  const n = ch.dates.length;
  const weeks = state.stableRange === '2y' ? 104 : state.stableRange === '5y' ? 261 : n;
  const s = Math.max(0, n - weeks);
  const opts = baseOptions(state.stableRange === 'all' ? 'all' : 'short');
  opts.plugins.tooltip.callbacks.label = (item) => ` เข้า/ออกสุทธิ 90 วัน: ${signedBn(item.parsed.y, 1)}`;
  opts.plugins.tooltip.callbacks.afterBody = (items) => `ยอดรวม ${usdBn(ch.total[s + items[0].dataIndex], 1)}`;
  opts.scales.y = usdAxis();
  if (stableChart) stableChart.destroy();
  stableChart = new Chart($('#chart-stable'), {
    type: 'line',
    data: { labels: ch.dates.slice(s), datasets: [{ label: 'เข้า/ออกสุทธิ 90 วัน', data: ch.flow90.slice(s), ...lineStyle(cssVar('--macro')) }] },
    options: opts,
    plugins: [zeroLine, crosshair],
  });
}

// ---------- indicator cards ----------

const fmtNum =(v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

function sparkline(values, refLines = null) {
  if (!values) return '';
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null);
  if (pts.length < 2) return '';
  const W = 300;
  const H = 48;
  let min = Infinity;
  let max = -Infinity;
  for (const [, v] of pts) { if (v < min) min = v; if (v > max) max = v; }
  const dataMin = min;
  const dataMax = max;
  for (const r of refLines || []) { if (r < min) min = r; if (r > max) max = r; }
  const span = max - min || 1;
  const x = (i) => (i / (values.length - 1)) * W;
  const y = (v) => H - 4 - ((v - min) / span) * (H - 8);
  const d = pts.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('');
  const [li, lv] = pts[pts.length - 1];
  const refs = (refLines || []).map((r) => `<line class="spark-ref" x1="0" x2="${W}" y1="${y(r).toFixed(1)}" y2="${y(r).toFixed(1)}"/>`).join('');
  const refNote = refLines?.length ? ` · เส้นประ ${refLines.join(' / ')}` : '';
  return `
    <svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      ${refs}
      <path d="${d}"/>
      <circle cx="${x(li).toFixed(1)}" cy="${y(lv).toFixed(1)}" r="3"/>
    </svg>
    <div class="spark-cap"><span>4 ปีก่อน</span><span>ต่ำสุด ${fmtNum(dataMin)} · สูงสุด ${fmtNum(dataMax)}${refNote}</span><span>ล่าสุด</span></div>`;
}

function weightChips(i) {
  const chips = ['lth', 'sth', 'macro']
    .filter((k) => i.weights[k])
    .map((k) => `<span class="chip chip-${k}">${k === 'macro' ? 'Macro' : k.toUpperCase()} ×${i.weights[k]}</span>`);
  if (!chips.length) chips.push('<span class="chip">แสดงผลอย่างเดียว ไม่คิดคะแนนรวม</span>');
  return chips.join('');
}

function cardHtml(i) {
  const tone = toneOf(i.score);
  return `
    <article class="card">
      <div class="card-head">
        <div>
          <h3>${esc(i.name)}</h3>
          <div class="chips"><span class="chip">${esc(i.category)}</span>${weightChips(i)}${i.adaptive ? '<span class="chip" title="คะแนน 70% จากเกณฑ์ + 30% เทียบกับ 8 ปีที่ผ่านมา">ปรับตามรอบ</span>' : ''}</div>
        </div>
        <span class="pill tone-${tone}"><i></i>${esc(i.label.text)}</span>
      </div>
      <div class="card-main">
        <div class="value">${esc(i.valueText)}</div>
        <div class="score"><b>${i.score == null ? '–' : Math.round(i.score)}</b> / 100</div>
      </div>
      <div class="meter tone-${tone}"><span style="width:${i.score ?? 0}%"></span></div>
      ${sparkline(i.history, i.refLines)}
      ${i.extra ? `<div class="extra">${esc(i.extra)}</div>` : ''}
      <p class="desc">${esc(i.desc)}</p>
      <p class="guide">เกณฑ์: ${esc(i.guide)}</p>
      <div class="asof">ข้อมูล ณ ${esc(i.asOf || '–')}</div>
    </article>`;
}

function filteredIndicators() {
  const list = state.data.indicators.slice();
  const h = state.horizon;
  if (h === 'all') return list;
  return list.filter((i) => i.weights[h] > 0 || i.showIn?.includes(h)).sort((a, b) => b.weights[h] - a.weights[h]);
}

function renderIndicators() {
  const list = filteredIndicators();
  $('#ind-count').textContent = `(${list.length})`;
  $('#cards').innerHTML = list.map(cardHtml).join('');

  $('#table').innerHTML = `
    <table>
      <thead><tr><th>Indicator</th><th>หมวด</th><th class="num">ค่าปัจจุบัน</th><th>คะแนน</th><th>สถานะ</th><th class="num">น้ำหนัก LTH</th><th class="num">น้ำหนัก STH</th><th>ข้อมูล ณ</th></tr></thead>
      <tbody>
        ${list.map((i) => `
          <tr>
            <td>${esc(i.name)}</td>
            <td>${esc(i.category)}</td>
            <td class="num">${esc(i.valueText)}</td>
            <td><span class="meter tone-${toneOf(i.score)}"><span style="width:${i.score ?? 0}%"></span></span>${i.score == null ? '–' : Math.round(i.score)}</td>
            <td><span class="pill tone-${toneOf(i.score)}"><i></i>${esc(i.label.text)}</span></td>
            <td class="num">${i.weights.lth || '–'}</td>
            <td class="num">${i.weights.sth || '–'}</td>
            <td>${esc(i.asOf || '–')}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;

  $('#cards').hidden = state.view !== 'cards';
  $('#table').hidden = state.view !== 'table';
}

function renderSources() {
  $('#sources').innerHTML = state.data.sources.map((s) => {
    const status = !s.ok ? `⚠ ดึงไม่ได้: ${esc(s.error)}` : s.stale ? `⚠ ใช้ข้อมูลเก่า (${fmtTime(s.fetchedAt)})` : `✓ ${fmtTime(s.fetchedAt)}`;
    return `<li><span>${esc(s.name)}</span><span class="st">${status}</span></li>`;
  }).join('');
}

// ---------- controls ----------

function bindSeg(id, key, onChange) {
  $(`#${id}`).addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-v]');
    if (!btn) return;
    state[key] = btn.dataset.v;
    for (const b of $(`#${id}`).querySelectorAll('button')) b.classList.toggle('on', b === btn);
    if (state.data) onChange();
  });
}

bindSeg('range', 'range', renderCharts);
// ?day=2025-12-15 (the price links in the overview page's day table) opens in day mode.
const startDay = new URLSearchParams(location.search).get('day') || '';
if ($('#range-date') && /^\d{4}-\d{2}-\d{2}$/.test(startDay)) {
  state.range = 'day';
  state.day = startDay;
  state.scrollToDay = true;
  for (const b of document.querySelectorAll('#range button')) b.classList.remove('on');
}
bindDayPick('range-date', 'range', (day) => {
  state.range = 'day';
  state.day = day;
  if (state.data) renderCharts();
});
if ($('#macro-range')) bindSeg('macro-range', 'macroRange', renderMacro);
if ($('#stable-range')) bindSeg('stable-range', 'stableRange', renderStablecoins);
if ($('#cost-range')) bindSeg('cost-range', 'costRange', renderCostBasis);
bindSeg('horizon', 'horizon', renderIndicators);
bindSeg('view', 'view', renderIndicators);
$('#refresh').addEventListener('click', () => load());
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (state.data) { renderCharts(); renderCostBasis(); renderMacro(); window.renderCredit?.(state.data); renderStablecoins(); window.renderBacktest?.(state.data); window.renderHalving?.(state.data); window.renderCycles?.(state.data); window.renderForecast?.(state.data); window.renderSeason?.(state.data); window.renderEtf?.(state.data); window.renderRealized?.(state.data); }
});

load();
autoRefresh(() => load({ quiet: true }));
