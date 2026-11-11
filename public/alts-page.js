'use strict';
// Overview of all altcoins (/alts.html): summary tiles, snapshot bars, one
// price + score chart pair per coin, and the comparison table.
// Shared helpers ($, esc, fmt*, toneOf, Chart.js plumbing) come from common.js.

const state = { data: null, sort: 'rank', range: '4y' };
const charts = {}; // snapshot bars and the pooled-evidence chart
const coinCharts = {}; // per-coin price and score charts

const RANGE_DAYS = { '1y': 365, '4y': 1461, all: Infinity };
// Fixed y-axis width so each coin's price and score charts share the same plot width.
const Y_AXIS_WIDTH = 72;

const delta = (v, d = 0) => (v == null ? '–' : `<span class="${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '▲' : '▼'} ${Math.abs(v).toFixed(d)}%</span>`);

const RELIABILITY = {
  good: { tone: 'buy', text: 'เคยได้ผล' },
  mixed: { tone: 'neutral', text: 'ได้ผลบางส่วน' },
  poor: { tone: 'sell', text: 'ไม่ได้ผล' },
  unknown: { tone: 'na', text: 'ข้อมูลไม่พอ' },
};

// quiet = the automatic refresh: the page is not dimmed while it loads.
async function load({ quiet = false } = {}) {
  if (!quiet) document.body.classList.add('loading');
  try {
    const res = await fetch('/api/alts', { cache: 'no-store' });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || res.statusText);
    state.data = json;
    $('#error').hidden = true;
    render();
  } catch (err) {
    $('#error').textContent = `โหลดข้อมูลไม่สำเร็จ: ${err.message}`;
    $('#error').hidden = false;
  } finally {
    document.body.classList.remove('loading');
  }
}

const okCoins = () => state.data.coins.filter((c) => !c.error && c.lth.score != null);

function render() {
  const d = state.data;
  $('#updated').textContent = `อัปเดต ${fmtTime(d.generatedAt)}`;
  renderNetStatus(d.network, d.sources);
  renderTiles();
  // One section per browser task (see runSteps in common.js); the coin cards
  // then draw one coin per task themselves.
  runSteps('page', [
    renderSnapshotCharts,
    () => window.renderCompare?.(d),
    renderCoinCharts,
    renderTable,
    renderPooled,
    () => {
      $('#sources').innerHTML = d.sources.map((s) => {
        const status = !s.ok ? `⚠ ดึงไม่ได้: ${esc(s.error)}` : s.stale ? `⚠ ใช้ข้อมูลเก่า (${fmtTime(s.fetchedAt)})` : `✓ ${fmtTime(s.fetchedAt)}`;
        return `<li><span>${esc(s.name)}</span><span class="st">${status}</span></li>`;
      }).join('');
    },
  ]);
}

// ---------- summary tiles ----------

function renderTiles() {
  const d = state.data;
  const byLth = okCoins().sort((a, b) => b.lth.score - a.lth.score);
  const tile = (label, value, sub) => `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-sub">${sub}</div></div>`;
  const cheap = byLth.filter((c) => c.lth.score >= 60);
  const top = byLth[0];
  const bottom = byLth[byLth.length - 1];
  $('#alts-stats').innerHTML = [
    tile('วัฏจักร Bitcoin ตอนนี้', `${Math.round(d.btc.lth.score)}% <span class="pill tone-${toneOf(d.btc.lth.score)}"><i></i>${esc(d.btc.lth.label.text)}</span>`, 'คะแนนระยะยาวของ BTC — เหรียญอื่นขึ้นลงตามรอบนี้'),
    tile('เหรียญที่คะแนนระยะยาว 60 ขึ้นไป', `${cheap.length} / ${byLth.length}`, cheap.length ? cheap.map((c) => c.symbol).join(' · ') : 'ยังไม่มี'),
    top ? tile('คะแนนระยะยาวสูงสุด', `${esc(top.symbol)} ${Math.round(top.lth.score)}%`, `ห่างจากจุดสูงสุด ${fmtPct(top.drawdown, 0)}`) : '',
    bottom ? tile('คะแนนระยะยาวต่ำสุด', `${esc(bottom.symbol)} ${Math.round(bottom.lth.score)}%`, `ห่างจากจุดสูงสุด ${fmtPct(bottom.drawdown, 0)}`) : '',
  ].join('');
}

// ---------- snapshot bars + pooled evidence ----------

// Value at the tip of each bar (text tokens, never the bar's own color).
const valueLabels = {
  id: 'valueLabels',
  afterDatasetsDraw(chart) {
    const fmt = chart.$valueFmt;
    if (!fmt) return;
    const horizontal = chart.options.indexAxis === 'y';
    const { ctx } = chart;
    const data = chart.data.datasets[0].data;
    ctx.save();
    ctx.fillStyle = cssVar('--text-2');
    ctx.font = `600 12px ${CHART_FONT}`;
    chart.getDatasetMeta(0).data.forEach((bar, i) => {
      const v = data[i];
      if (v == null) return;
      if (horizontal) {
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(fmt(v), bar.x + 6, bar.y);
      } else {
        ctx.textAlign = 'center';
        ctx.textBaseline = v >= 0 ? 'bottom' : 'top';
        ctx.fillText(fmt(v), bar.x, bar.y + (v >= 0 ? -5 : 5));
      }
    });
    ctx.restore();
  },
};

function scrollToCoin(symbol) {
  document.getElementById(`coin-${symbol}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Horizontal bars, one per coin (BTC included as the reference).
// Clicking a coin's bar scrolls to that coin's own charts.
function barChart(id, rows, { max, format, colorOf, tooltip }) {
  const labels = rows.map((r) => r.symbol);
  charts[id] = new Chart($(`#${id}`), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: rows.map((r) => r.value),
        backgroundColor: rows.map(colorOf),
        borderRadius: 4,
        borderSkipped: 'start',
        barThickness: 16,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { right: 46 } },
      plugins: {
        legend: { display: false },
        tooltip: { ...tooltipStyle(), displayColors: false, callbacks: { title: (items) => rows[items[0].dataIndex].name, label: (item) => tooltip(rows[item.dataIndex]) } },
      },
      scales: {
        x: { min: 0, max, grid: { color: cssVar('--grid') }, border: { display: false }, ticks: { color: cssVar('--muted'), stepSize: 20, callback: (v) => `${v}%` } },
        y: { grid: { display: false }, border: { color: cssVar('--axis') }, ticks: { color: cssVar('--text-2'), font: { family: CHART_FONT, size: 12 } } },
      },
      onClick: (evt, els) => { if (els.length) scrollToCoin(labels[els[0].index]); },
      onHover: (evt, els) => { evt.native.target.style.cursor = els.length && labels[els[0].index] !== 'BTC' ? 'pointer' : 'default'; },
    },
    plugins: [valueLabels],
  });
  charts[id].$valueFmt = format;
  charts[id].update('none');
}

function renderSnapshotCharts() {
  if (!window.Chart) return;
  for (const c of Object.values(charts)) c.destroy();
  const d = state.data;
  const coins = okCoins();
  const btcRow = { symbol: 'BTC', name: 'Bitcoin (อ้างอิง)', lth: d.btc.lth, sth: d.btc.sth, drawdown: d.btc.drawdown };

  const scoreRows = [btcRow, ...coins].map((c) => ({ ...c, value: Math.round(c.lth.score) })).sort((a, b) => b.value - a.value);
  barChart('chart-bars-lth', scoreRows, {
    max: 100,
    format: (v) => `${v}%`,
    colorOf: (r) => cssVar(`--z-${toneOf(r.lth.score)}`),
    tooltip: (r) => `คะแนนระยะยาว ${r.value}% — ${r.lth.label.text}`,
  });
  const sthRows = [btcRow, ...coins].filter((c) => c.sth?.score != null).map((c) => ({ ...c, value: Math.round(c.sth.score) })).sort((a, b) => b.value - a.value);
  barChart('chart-bars-sth', sthRows, {
    max: 100,
    format: (v) => `${v}%`,
    colorOf: (r) => cssVar(`--z-${toneOf(r.sth.score)}`),
    tooltip: (r) => `สภาวะระยะสั้น ${r.value}% — ${r.value >= 60 ? 'ย่อตัวลงมา' : r.value < 40 ? 'ยืดตัวขึ้นไป' : 'ปกติ'}`,
  });
  const ddRows = [btcRow, ...coins].filter((c) => c.drawdown != null).map((c) => ({ ...c, value: Math.round(-c.drawdown) })).sort((a, b) => b.value - a.value);
  barChart('chart-bars-dd', ddRows, {
    max: 100,
    format: (v) => `${v}%`,
    colorOf: () => cssVar('--muted'),
    tooltip: (r) => `ราคาตอนนี้ต่ำกว่าจุดสูงสุด ${r.value}%`,
  });

  // Pooled evidence: score bucket → median price change a year later.
  const pooled = d.pooled.filter((b) => b.median != null);
  charts['chart-pooled'] = new Chart($('#chart-pooled'), {
    type: 'bar',
    data: {
      labels: pooled.map((b) => b.label),
      datasets: [{
        data: pooled.map((b) => Math.round(b.median)),
        backgroundColor: pooled.map((b) => cssVar(b.median >= 0 ? '--z-strong-buy' : '--z-strong-sell')),
        borderRadius: 4,
        borderSkipped: 'start',
        barThickness: 24,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { ...tooltipStyle(), displayColors: false, callbacks: { title: (items) => `คะแนนระยะยาว ${items[0].label}`, label: (item) => `1 ปีถัดไป ค่ากลาง ${fmtPct(pooled[item.dataIndex].median, 0)} · ราคาขึ้น ${Math.round(pooled[item.dataIndex].upPct)}% ของครั้ง` } },
      },
      scales: {
        x: { grid: { display: false }, border: { display: false }, ticks: { color: cssVar('--text-2'), font: { family: CHART_FONT, size: 12 } } },
        // grace leaves room above/below the tallest bars for their value labels.
        y: { position: 'right', grace: '18%', grid: { color: cssVar('--grid') }, border: { display: false }, ticks: { color: cssVar('--muted'), maxTicksLimit: 6, callback: (v) => (v === 0 ? '0%' : fmtPct(v, 0)) } },
      },
    },
    plugins: [baselineAt(0), valueLabels],
  });
  charts['chart-pooled'].$valueFmt = (v) => fmtPct(v, 0);
  charts['chart-pooled'].update('none');
}

// ---------- one chart pair per coin (price on top, scores below) ----------

const scorePill = (label, comp) => `<span class="pill tone-${toneOf(comp.score)}"><i></i>${label} ${comp.score == null ? '–' : `${Math.round(comp.score)}%`}</span>`;
const coinNowHtml = (c) => `<b>${fmtUsd(c.price)}</b> ${scorePill('ระยะยาว', c.lth)} ${scorePill('ระยะสั้น', c.sth)}`;

// A coin's values on the chosen day: s is its chart series, at a global index into chart.dates.
function coinOnDay(s, at) {
  const k = at - s.start;
  const last = s.price.length - 1;
  const price = k >= 0 ? s.price[k] ?? null : null;
  return { price, lth: price == null ? null : s.lth[k], sth: price == null ? null : s.sth[k], since: price ? (s.price[last] / price - 1) * 100 : null };
}

const coinDayHtml = (s, at) => {
  const v = coinOnDay(s, at);
  if (v.price == null) return `<span class="coin-name">ยังไม่มีข้อมูลวันนั้น (เริ่ม ${fmtDate(state.data.chart.dates[s.start])})</span>`;
  return `<span class="coin-name">${fmtDate(state.data.chart.dates[at])}</span> <b>${fmtUsd(v.price)}</b> ${scorePill('ระยะยาว', { score: v.lth })} ${scorePill('ระยะสั้น', { score: v.sth })}`;
};

// Every coin side by side on the chosen day (hidden outside day mode).
function renderDayTable(win, coins) {
  const box = $('#day-table');
  if (!box) return;
  box.hidden = !win;
  if (!win) return;
  const ch = state.data.chart;
  const score = (v) => (v == null ? '–' : `<span class="meter tone-${toneOf(v)}"><span style="width:${v}%"></span></span><b>${Math.round(v)}</b>`);
  const nearest = ch.dates[win.at] !== state.day ? ` (วันที่ ${fmtDate(state.day)} ไม่มีข้อมูล จึงใช้วันก่อนหน้าที่ใกล้ที่สุด)` : '';
  box.innerHTML = `
    <p class="advice"><b>${fmtDate(ch.dates[win.at])}</b>${nearest} — ค่าของทุกเหรียญในวันนั้น
      <span class="readout-hint">กดที่ราคาเพื่อดูราคา 24 ชั่วโมงของวันนั้นในหน้าเหรียญ · กราฟด้านล่างแสดง 6 เดือนก่อนและหลังวันนั้น (เส้นประสีส้ม = วันที่เลือก) · กด 1 ปี / 4 ปี / ทั้งหมด เพื่อกลับ</span></p>
    <div class="table-wrap">
      <table class="alts">
        <thead><tr><th>เหรียญ</th><th class="num">ราคาวันนั้น</th><th>ระยะยาว</th><th>ระยะสั้น</th><th class="num" title="ราคาวันนี้เทียบกับราคาวันนั้น">ถึงวันนี้</th></tr></thead>
        <tbody>${coins.map((c) => {
          const s = ch.coins[c.symbol];
          const v = coinOnDay(s, win.at);
          const name = `<a class="coin-link" href="#coin-${esc(c.symbol)}"><b>${esc(c.symbol)}</b> <span class="coin-name">${esc(c.name)}</span></a>`;
          if (v.price == null) return `<tr><td>${name}</td><td colspan="4" class="muted-cell">ยังไม่มีข้อมูลวันนั้น (เริ่ม ${fmtDate(ch.dates[s.start])})</td></tr>`;
          const dayLink = `/coin.html?c=${encodeURIComponent(c.symbol)}&day=${state.day}`;
          return `<tr><td>${name}</td><td class="num"><a class="day-link" href="${dayLink}" title="ดูราคา 24 ชั่วโมงของวันนั้น">${fmtUsd(v.price)}</a></td><td>${score(v.lth)}</td><td>${score(v.sth)}</td><td class="num">${delta(v.since)}</td></tr>`;
        }).join('')}</tbody>
      </table>
    </div>`;
}

function coinCardHtml(c) {
  const sym = esc(c.symbol);
  return `
    <article class="coin-card" id="coin-${sym}">
      <div class="coin-card-head">
        <a class="coin-link" href="/coin.html?c=${encodeURIComponent(c.symbol)}" title="ดูรายละเอียดของ ${sym}"><b>${sym}</b> <span class="coin-name">${esc(c.name)} · ดูรายละเอียด →</span></a>
        <span class="coin-card-now">${coinNowHtml(c)}</span>
      </div>
      <div class="chart-title">ราคา ${sym} (สเกล log)</div>
      <div class="chart-wrap chart-coin-price"><canvas id="cp-${sym}" aria-label="กราฟราคา ${sym}"></canvas></div>
      <div class="chart-title">
        คะแนนความน่าลงทุน (%)
        <span class="legend">
          <span class="key key-lth"></span>ระยะยาว
          <span class="key key-sth"></span>ระยะสั้น
        </span>
      </div>
      <div class="chart-wrap chart-coin-score"><canvas id="cs-${sym}" aria-label="กราฟคะแนนระยะยาวและระยะสั้นของ ${sym}"></canvas></div>
    </article>`;
}

function renderCoinCharts() {
  const d = state.data;
  const ch = d.chart;
  const coins = okCoins().filter((c) => ch.coins[c.symbol]);
  const grid = $('#coin-charts');

  for (const key of Object.keys(coinCharts)) {
    coinCharts[key].destroy();
    delete coinCharts[key];
  }
  // Rebuild the cards only when the list of coins changes; a refresh just updates the numbers.
  const listKey = coins.map((c) => c.symbol).join(',');
  if (grid.dataset.coins !== listKey) {
    grid.innerHTML = coins.map(coinCardHtml).join('');
    grid.dataset.coins = listKey;
  }
  // "หรือเลือกวัน": every coin on the same window of global dates, around the chosen day.
  const win = state.range === 'day' && state.day ? dayWindow(ch.dates, state.day) : null;
  syncDayPick('chart-date', ch.dates, !!win);
  renderDayTable(win, coins);
  for (const c of coins) $(`#coin-${c.symbol} .coin-card-now`).innerHTML = win ? coinDayHtml(ch.coins[c.symbol], win.at) : coinNowHtml(c);
  if (!window.Chart) {
    $('#chart-note').textContent = 'โหลดไลบรารีกราฟ (Chart.js) ไม่สำเร็จ — ตรวจสอบว่ามีไฟล์ public/vendor/chart.umd.min.js';
    return;
  }

  const mode = state.range === 'all' ? 'all' : 'short';
  const fixedWidth = (axis) => { axis.width = Y_AXIS_WIDTH; };
  // One coin per browser task, so 22 charts never freeze the page in one block.
  runSteps('coin-charts', coins.map((c) => () => drawCoin(c)));
  function drawCoin(c) {
    const s = ch.coins[c.symbol];
    let labels;
    let slice;
    if (win) {
      labels = ch.dates.slice(win.from, win.to + 1);
      slice = (arr) => labels.map((_, j) => arr[win.from + j - s.start] ?? null);
    } else {
      const from = Math.max(0, s.price.length - RANGE_DAYS[state.range]);
      labels = ch.dates.slice(s.start + from, s.start + s.price.length);
      slice = (arr) => arr.slice(from);
    }
    const prices = slice(s.price);
    // A coin listed after the window has nothing to draw (and a log axis needs data).
    const empty = !prices.some((v) => v != null);
    $(`#coin-${c.symbol}`).classList.toggle('no-day', empty);
    if (empty) return;
    const marker = { index: win ? win.at - win.from : null };

    const priceOpts = baseOptions(mode);
    priceOpts.scales.x.ticks.maxTicksLimit = 6;
    priceOpts.plugins.tooltip.callbacks.label = (item) => ` ราคา: ${fmtUsd(item.parsed.y)}`;
    priceOpts.plugins.dayMarker = marker;
    priceOpts.scales.y = { ...logPriceAxis(), afterFit: fixedWidth };
    const price = new Chart($(`#cp-${c.symbol}`), {
      type: 'line',
      data: { labels, datasets: [{ label: 'ราคา', data: prices, ...lineStyle(cssVar('--price')) }] },
      options: priceOpts,
      plugins: [crosshair, hoverSync, dayMarker],
    });
    attachPins(price, `coin-${c.symbol}`);

    const scoreOpts = baseOptions(mode);
    scoreOpts.scales.x.ticks.maxTicksLimit = 6;
    scoreOpts.plugins.tooltip.callbacks.label = (item) => ` ${item.dataset.label}: ${item.parsed.y == null ? '–' : `${Math.round(item.parsed.y)}%`}`;
    scoreOpts.plugins.dayMarker = marker;
    scoreOpts.scales.y = {
      min: 0,
      max: 100,
      position: 'right',
      afterFit: fixedWidth,
      grid: { color: cssVar('--grid') },
      border: { display: false },
      ticks: { color: cssVar('--muted'), stepSize: 20, callback: (v) => `${v}%` },
    };
    const score = new Chart($(`#cs-${c.symbol}`), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'ระยะยาว', data: slice(s.lth), ...lineStyle(cssVar('--lth')) },
          { label: 'ระยะสั้น', data: slice(s.sth), ...lineStyle(cssVar('--sth'), 1.5) },
        ],
      },
      options: scoreOpts,
      plugins: [scoreBands(80, 20), crosshair, hoverSync, dayMarker],
    });

    pair(price, score);
    coinCharts[`price-${c.symbol}`] = price;
    coinCharts[`score-${c.symbol}`] = score;
  }
}

// ---------- comparison table ----------

function scoreCell(comp) {
  if (!comp || comp.score == null) return '–';
  const tone = toneOf(comp.score);
  return `<span class="meter tone-${tone}"><span style="width:${comp.score}%"></span></span><b>${Math.round(comp.score)}</b> <span class="pill tone-${tone}"><i></i>${esc(comp.label.text)}</span>`;
}

function renderTable() {
  const d = state.data;
  const rows = state.sort === 'lth'
    ? d.coins.slice().sort((a, b) => (b.lth?.score ?? -1) - (a.lth?.score ?? -1))
    : d.coins;
  const row = (c) => {
    if (c.error) return `<tr><td><b>${esc(c.symbol)}</b> <span class="coin-name">${esc(c.name)}</span></td><td colspan="9" class="muted-cell">ดึงข้อมูลไม่ได้: ${esc(c.error)}</td></tr>`;
    const rel = RELIABILITY[c.reliability.level] || RELIABILITY.unknown;
    return `
      <tr>
        <td><a class="coin-link" href="/coin.html?c=${encodeURIComponent(c.symbol)}"><b>${esc(c.symbol)}</b> <span class="coin-name">${esc(c.name)}</span></a></td>
        <td class="num">${fmtUsd(c.price)}</td>
        <td class="num">${delta(c.changePct, 1)}</td>
        <td>${scoreCell(c.lth)}</td>
        <td>${scoreCell(c.sth)}</td>
        <td class="num">${fmtPct(c.drawdown, 0)}</td>
        <td class="num">${c.mvrv == null ? '–' : `${c.mvrv.toFixed(2)}×`}</td>
        <td><span class="pill tone-${rel.tone}" title="${esc(`${c.reliability.title} — ${c.reliability.text}`)}"><i></i>${rel.text}</span></td>
        <td class="num">${delta(c.dcaEdge)}</td>
        <td class="num">${c.plainDca ? `${delta(c.plainDca.roi)} <span class="coin-name">ตั้งแต่ ${esc(c.plainDca.from)}</span>` : '–'}</td>
      </tr>`;
  };
  $('#alts-table').innerHTML = `
    <table class="alts">
      <thead>
        <tr>
          <th>เหรียญ</th><th class="num">ราคา</th><th class="num">24 ชม.</th><th>คะแนนระยะยาว</th><th>สภาวะระยะสั้น</th>
          <th class="num">ห่างจากจุดสูงสุด</th><th class="num">MVRV</th><th>คะแนนเคยได้ผลไหม</th><th class="num">DCA ตามคะแนน vs ปกติ</th><th class="num">DCA ปกติ</th>
        </tr>
      </thead>
      <tbody>
        <tr class="ref-row">
          <td><a class="coin-link" href="/"><b>BTC</b> <span class="coin-name">Bitcoin (อ้างอิง)</span></a></td>
          <td class="num">${fmtUsd(d.btc.price)}</td><td class="num">–</td>
          <td>${scoreCell(d.btc.lth)}</td><td>${scoreCell(d.btc.sth)}</td>
          <td class="num">${fmtPct(d.btc.drawdown, 0)}</td><td class="num">–</td><td>–</td><td class="num">–</td><td class="num">–</td>
        </tr>
        ${rows.map(row).join('')}
      </tbody>
    </table>`;
}

function renderPooled() {
  $('#alts-pooled').innerHTML = `
    <table>
      <thead><tr><th>คะแนนระยะยาว ณ ตอนนั้น</th><th class="num">จำนวนวัน (รวมทุกเหรียญ)</th><th class="num">ราคา 1 ปีถัดไป (ค่ากลาง)</th><th class="num">โอกาสราคาขึ้น</th></tr></thead>
      <tbody>
        ${state.data.pooled.map((b) => `<tr><td>${esc(b.label)}</td><td class="num">${b.n.toLocaleString('en-US')}</td><td class="num">${fmtPct(b.median, 0)}</td><td class="num">${b.upPct == null ? '–' : `${Math.round(b.upPct)}%`}</td></tr>`).join('')}
      </tbody>
    </table>`;
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

bindSeg('sort', 'sort', renderTable);
bindSeg('chart-range', 'range', renderCoinCharts);
bindDayPick('chart-date', 'chart-range', (day) => {
  state.range = 'day';
  state.day = day;
  if (state.data) renderCoinCharts();
});
$('#refresh').addEventListener('click', () => load());
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (state.data) { renderSnapshotCharts(); renderCoinCharts(); }
});

load();
autoRefresh(() => load({ quiet: true }));
