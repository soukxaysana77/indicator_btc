'use strict';
// "คาดการณ์รอบหน้า" panel on the BTC page: carries the cycle trends forward
// to estimate (1) when price first closes above the current ATH again, (2) the
// next cycle top — price and date, and (3) the low after it, each with a ±10%
// box, drawn the way a Matplotlib study would: log price over time, every
// past top and low, dashed trend lines and error boxes.
//
// Method (each value from two independent views, then the middle in log terms):
//   top price  — A: each top's rise over the previous top shrinks by a steady
//                   factor (log gains ×0.43, ×0.50 so far)
//                B: each top's rise over the previous low shrinks the same way
//   top date   — A: last low + the average low→top run (~1,060 days)
//                B: next halving + the average halving→top time (last 3 cycles)
//   new high   — last low + the shrinking low→new-ATH time (771, 716, 481 days)
//   next low   — A: the fall from the top keeps shrinking (in log terms)
//                B: each low's rise over the previous low shrinks
//                date: the next top + the average fall length of finished cycles
// Uses only 3–4 cycles, and the current low (2026-06-30) is provisional:
// an illustration of "if the pattern held", recomputed on every data update.
// Needs cycles.js (window.btcCyclesOf). Shared helpers come from common.js.

(() => {
  const el = (id) => document.getElementById(id);
  const DAY = 86400000;
  const BAND = 0.1; // ±10%
  const TH_MONTH_YEAR = new Intl.DateTimeFormat('th-TH-u-ca-gregory', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const ms = (d) => Date.parse(`${d}T00:00:00Z`);
  const monthYear = (t) => TH_MONTH_YEAR.format(t);
  const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
  const ratios = (v) => v.slice(1).map((x, i) => x / v[i]);
  const k = (v) => `$${Math.round(v / 1000).toLocaleString('en-US')}k`;
  const tile = (label, value, sub) => `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-sub">${sub}</div></div>`;
  let chart = null;
  let lastRender = null; // { h, f } for redrawing when the range changes
  let range = 'near';
  try { if (localStorage.getItem('forecast-range') === 'all') range = 'all'; } catch { /* default */ }

  function project(h, halving, cyclesOf) {
    const all = cyclesOf(h, halving.past);
    const full = all.filter((c) => c.vsPrevTop != null);
    const cur = all[all.length - 1];
    if (full.length < 3 || !cur) return null;
    const T = all.map((c) => c.topPrice);
    const L = all.map((c) => c.lowPrice);
    const lastTop = T[T.length - 1];
    const lastLow = L[L.length - 1];

    // ---- next cycle top: price ----
    const gTop = full.map((c) => Math.log(c.vsPrevTop)); // rise over the previous top
    const gLow = full.map((c) => Math.log(c.lowToTopX)); // rise over the previous low
    const rTop = mean(ratios(gTop));
    const rLow = mean(ratios(gLow));
    const topA = lastTop * Math.exp(gTop[gTop.length - 1] * rTop);
    const topB = lastLow * Math.exp(gLow[gLow.length - 1] * rLow);
    const top = Math.exp((Math.log(topA) + Math.log(topB)) / 2);

    // ---- next cycle top: date ----
    const bull = mean(full.map((c) => c.lowToTopDays));
    const halvingToTop = mean(full.map((c) => c.halvingToTop));
    const topDateA = ms(cur.lowDate) + bull * DAY;
    const topDateB = ms(halving.next.date) + halvingToTop * DAY;
    const topDate = (topDateA + topDateB) / 2;
    const topSpan = (topDate - ms(cur.lowDate)) * BAND;

    // ---- first close above the current ATH ----
    const toAth = full.filter((c) => c.lowToAth != null).map((c) => c.lowToAth);
    const athDays = toAth[toAth.length - 1] * mean(ratios(toAth));
    const athDate = ms(cur.lowDate) + athDays * DAY;
    const athSpan = athDays * BAND * DAY;

    // ---- the low after the next top ----
    const falls = all.map((c) => Math.log(c.lowPrice / c.topPrice)); // negative
    const rFall = mean(ratios(falls));
    const lowA = top * Math.exp(falls[falls.length - 1] * rFall);
    const lowSteps = full.map((c) => Math.log(c.lowVsPrevLow));
    const lowB = lastLow * Math.exp(lowSteps[lowSteps.length - 1] * mean(ratios(lowSteps)));
    const low = Math.exp((Math.log(lowA) + Math.log(lowB)) / 2);
    const bear = mean(all.filter((c) => c.done).map((c) => c.bearDays));
    const lowDate = topDate + bear * DAY;
    const lowSpan = bear * BAND * DAY;

    return {
      all, cur, lastTop, lastLow,
      top, topA, topB, topDate, topDateA, topDateB, topSpan, bull, halvingToTop,
      athDate, athDays, athSpan, toAth,
      low, lowA, lowB, lowDate, lowSpan, bear,
      gTop, gLow, falls,
    };
  }

  function render(d) {
    const panel = el('forecast-panel');
    if (!panel) return;
    const h = d?.history;
    const ok = h?.dates?.length && d?.halving?.past?.length && window.btcCyclesOf;
    const f = ok ? project(h, d.halving, window.btcCyclesOf) : null;
    panel.hidden = !f;
    if (!f) return;
    const now = h.price[h.price.length - 1];
    const lowFinal = f.cur.done;
    const dateRange = (t, span) => `${monthYear(t - span)} – ${monthYear(t + span)}`;

    el('forecast-stats').innerHTML = [
      tile(`① เกินยอดเดิม ${k(f.lastTop)} ครั้งแรก`, `≈ ${monthYear(f.athDate)}`, `±10%: ${dateRange(f.athDate, f.athSpan)} · นับจากก้น ${fmtDate(f.cur.lowDate)} ราว ${Math.round(f.athDays)} วัน (รอบก่อน ${f.toAth.join(' → ')} วัน) · ตอนนี้ต้องขึ้นอีก ${Math.round((f.lastTop / now - 1) * 100)}%`),
      tile('② ยอดของรอบหน้า (ATH)', `≈ ${k(f.top)}`, `±10%: ${k(f.top * (1 - BAND))} – ${k(f.top * (1 + BAND))} · เมื่อไร ≈ <b>${monthYear(f.topDate)}</b> (±10%: ${dateRange(f.topDate, f.topSpan)}) · สูงกว่ายอดเดิม ${Math.round((f.top / f.lastTop - 1) * 100)}%`),
      tile('③ ก้นครั้งหน้า (หลังยอดนั้น)', `≈ ${k(f.low)}`, `±10%: ${k(f.low * (1 - BAND))} – ${k(f.low * (1 + BAND))} · เมื่อไร ≈ <b>${monthYear(f.lowDate)}</b> (±10%: ${dateRange(f.lowDate, f.lowSpan)}) · ร่วงจากยอดนั้น ${Math.round((f.low / f.top - 1) * 100)}%`),
    ].join('');

    const pct = (a, b) => `${a >= b ? '+' : ''}${Math.round((a / b - 1) * 100)}%`;
    el('forecast-methods').innerHTML = `<table class="lined forecast-table">
      <thead><tr><th>คาดอะไร</th><th>วิธีที่ 1</th><th>วิธีที่ 2</th><th class="num">ใช้ค่ากลาง</th><th class="num">±10%</th></tr></thead>
      <tbody>
        <tr><td>ราคายอดรอบหน้า</td>
          <td>${k(f.topA)}<div class="coin-name">ยอดใหม่สูงกว่ายอดเดิมน้อยลงเรื่อย ๆ (×${f.all.filter((c) => c.vsPrevTop).map((c) => c.vsPrevTop.toFixed(c.vsPrevTop >= 10 ? 0 : 2)).join(' → ×')} → ×${(f.topA / f.lastTop).toFixed(2)})</div></td>
          <td>${k(f.topB)}<div class="coin-name">ยอดสูงกว่าก้นก่อนหน้าน้อยลงเรื่อย ๆ (×${f.all.filter((c) => c.lowToTopX).map((c) => Math.round(c.lowToTopX)).join(' → ×')} → ×${(f.topB / f.lastLow).toFixed(1)})</div></td>
          <td class="num"><b>${k(f.top)}</b></td><td class="num">${k(f.top * 0.9)} – ${k(f.top * 1.1)}</td></tr>
        <tr><td>เมื่อไรถึงยอด</td>
          <td>${monthYear(f.topDateA)}<div class="coin-name">ก้น + ขาขึ้นเฉลี่ย ${Math.round(f.bull)} วัน</div></td>
          <td>${monthYear(f.topDateB)}<div class="coin-name">halving ครั้งหน้า (≈ ${monthYear(ms(d.halving.next.date))}) + ${Math.round(f.halvingToTop)} วัน</div></td>
          <td class="num"><b>${monthYear(f.topDate)}</b></td><td class="num">${dateRange(f.topDate, f.topSpan)}</td></tr>
        <tr><td>เกินยอดเดิมครั้งแรก</td>
          <td colspan="2">${monthYear(f.athDate)}<div class="coin-name">ก้น → New High ใช้เวลาสั้นลง (${f.toAth.join(' → ')} → ~${Math.round(f.athDays)} วัน)</div></td>
          <td class="num"><b>${monthYear(f.athDate)}</b></td><td class="num">${dateRange(f.athDate, f.athSpan)}</td></tr>
        <tr><td>ราคาก้นครั้งหน้า</td>
          <td>${k(f.lowA)}<div class="coin-name">ร่วงจากยอดน้อยลงเรื่อย ๆ (${f.all.map((c) => `${Math.round((c.lowPrice / c.topPrice - 1) * 100)}%`).join(' → ')} → ${pct(f.lowA, f.top)})</div></td>
          <td>${k(f.lowB)}<div class="coin-name">ก้นใหม่สูงกว่าก้นเดิมน้อยลง (×${f.all.filter((c) => c.lowVsPrevLow).map((c) => c.lowVsPrevLow.toFixed(1)).join(' → ×')} → ×${(f.lowB / f.lastLow).toFixed(1)})</div></td>
          <td class="num"><b>${k(f.low)}</b></td><td class="num">${k(f.low * 0.9)} – ${k(f.low * 1.1)}</td></tr>
        <tr><td>เมื่อไรถึงก้น</td>
          <td colspan="2">${monthYear(f.lowDate)}<div class="coin-name">ยอด + ขาลงเฉลี่ยของรอบที่จบแล้ว ${Math.round(f.bear)} วัน</div></td>
          <td class="num"><b>${monthYear(f.lowDate)}</b></td><td class="num">${dateRange(f.lowDate, f.lowSpan)}</td></tr>
      </tbody></table>`;

    el('forecast-note').innerHTML = `* <b>ทุกค่าเป็นภาพประกอบว่า "ถ้ารูปแบบของรอบเดิมยังเหมือนเดิม" ไม่ใช่คำทำนาย</b> · คิดจากแค่ ${f.all.length} รอบ (ปี 2013–ตอนนี้) · ±10% เป็นกรอบตามที่ขอ แต่ความไม่แน่นอนจริงกว้างกว่านั้นมาก — สองวิธีในตารางยังห่างกันถึง ${k(Math.min(f.topA, f.topB))}–${k(Math.max(f.topA, f.topB))} ·
      ${lowFinal ? '' : `ก้นรอบนี้ (${fmtUsd(f.lastLow)} เมื่อ ${fmtDate(f.cur.lowDate)}) ยังไม่ยืนยัน ถ้าราคาลงต่ำกว่านั้น ทุกตัวเลขจะเลื่อนตาม · `}
      ยอด = ราคาปิดสูงสุดภายใน 2 ปีหลัง halving · ก้น = ราคาปิดต่ำสุดหลังยอด · คำนวณใหม่ทุกครั้งที่ข้อมูลอัปเดต`;

    renderChart(h, f);
  }

  // ---------- the chart ----------

  function renderChart(h, f) {
    if (!window.Chart) return;
    lastRender = { h, f };
    for (const b of el('forecast-range').querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === range);
    if (chart) chart.destroy();
    const up = cssVar('--z-strong-sell'); // tops in red, lows in green, as on a study chart
    const down = cssVar('--z-strong-buy');
    const proj = cssVar('--accent');
    // "near" starts in 2022 so the projected boxes have room; "all" shows every cycle.
    const minX = range === 'all' ? ms('2012-06-01') : ms('2022-01-01');
    const price = [];
    let visibleMin = Infinity;
    for (let i = 0; i < h.dates.length; i++) {
      const x = ms(h.dates[i]);
      if (x < minX) continue;
      price.push({ x, y: h.price[i] });
      visibleMin = Math.min(visibleMin, h.price[i]);
    }
    const tops = f.all.map((c) => ({ x: ms(c.topDate), y: c.topPrice, label: `ยอด ${c.topDate.slice(0, 4)} ${k(c.topPrice)}` }));
    const lows = f.all.map((c) => ({ x: ms(c.lowDate), y: c.lowPrice, label: `ก้น ${c.lowDate.slice(0, 4)} ${k(c.lowPrice)}${c.done ? '' : ' (ยังไม่ยืนยัน)'}` }));
    const nextTop = { x: f.topDate, y: f.top };
    const nextLow = { x: f.lowDate, y: f.low };
    const ath = { x: f.athDate, y: f.lastTop };
    const boxes = [
      { ...nextTop, span: f.topSpan, color: up, text: `ยอดหน้า ≈ ${k(f.top)} · ${monthYear(f.topDate)}`, above: true },
      { ...nextLow, span: f.lowSpan, color: down, text: `ก้นหน้า ≈ ${k(f.low)} · ${monthYear(f.lowDate)}`, above: false },
      { ...ath, span: f.athSpan, color: proj, text: `เกินยอดเดิม ≈ ${monthYear(f.athDate)}`, above: true, noPriceBand: true },
    ];
    const maxX = Math.max(f.lowDate + f.lowSpan, ms('2031-01-01'));

    // ±10% error boxes, whiskers and labels for the projected points
    const errorBoxes = {
      id: 'forecastBoxes',
      afterDatasetsDraw(c) {
        const { ctx, scales: { x, y } } = c;
        ctx.save();
        for (const b of boxes) {
          const x0 = x.getPixelForValue(b.x - b.span);
          const x1 = x.getPixelForValue(b.x + b.span);
          const yHi = y.getPixelForValue(b.noPriceBand ? b.y : b.y * (1 + BAND));
          const yLo = y.getPixelForValue(b.noPriceBand ? b.y : b.y * (1 - BAND));
          const px = x.getPixelForValue(b.x);
          const py = y.getPixelForValue(b.y);
          ctx.globalAlpha = 0.18;
          ctx.fillStyle = b.color;
          if (!b.noPriceBand) ctx.fillRect(x0, yHi, x1 - x0, yLo - yHi);
          ctx.globalAlpha = 1;
          ctx.strokeStyle = b.color;
          ctx.lineWidth = 1.5;
          ctx.beginPath(); // horizontal whisker = ±10% time
          ctx.moveTo(x0, py); ctx.lineTo(x1, py);
          ctx.moveTo(x0, py - 4); ctx.lineTo(x0, py + 4);
          ctx.moveTo(x1, py - 4); ctx.lineTo(x1, py + 4);
          if (!b.noPriceBand) { // vertical whisker = ±10% price
            ctx.moveTo(px, yHi); ctx.lineTo(px, yLo);
            ctx.moveTo(px - 4, yHi); ctx.lineTo(px + 4, yHi);
            ctx.moveTo(px - 4, yLo); ctx.lineTo(px + 4, yLo);
          }
          ctx.stroke();
          ctx.fillStyle = cssVar('--surface');
          ctx.beginPath();
          ctx.arc(px, py, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.fillStyle = b.color;
          ctx.font = `600 11px ${CHART_FONT}`;
          ctx.textAlign = px > c.chartArea.right - 110 ? 'right' : 'center';
          ctx.textBaseline = b.above ? 'bottom' : 'top';
          ctx.fillText(b.text, px, b.above ? yHi - 6 : yLo + 8);
        }
        // "today" line
        const tx = x.getPixelForValue(ms(h.dates[h.dates.length - 1]));
        ctx.strokeStyle = cssVar('--muted');
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(tx, c.chartArea.top);
        ctx.lineTo(tx, c.chartArea.bottom);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = cssVar('--muted');
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        ctx.fillText('วันนี้', tx - 4, c.chartArea.top + 2);
        ctx.restore();
      },
    };

    chart = new Chart(el('chart-forecast'), {
      type: 'line',
      data: {
        datasets: [
          { label: 'ราคา BTC', data: price, ...lineStyle(cssVar('--price'), 1), order: 3 },
          { label: 'แนวยอด', data: [...tops, nextTop], borderColor: up, borderWidth: 1.25, borderDash: [6, 4], pointRadius: 0, fill: false, tension: 0, order: 2 },
          { label: 'แนวก้น', data: [...lows, nextLow], borderColor: down, borderWidth: 1.25, borderDash: [6, 4], pointRadius: 0, fill: false, tension: 0, order: 2 },
          { label: 'ยอดของรอบ', data: tops, showLine: false, pointStyle: 'triangle', pointRadius: 6, pointBackgroundColor: up, pointBorderColor: up, order: 1 },
          { label: 'ก้นของรอบ', data: lows, showLine: false, pointStyle: 'triangle', rotation: 180, pointRadius: 6, pointBackgroundColor: down, pointBorderColor: down, order: 1 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: { xAxisKey: 'x', yAxisKey: 'y' },
        interaction: { mode: 'nearest', intersect: false, axis: 'x' },
        plugins: {
          legend: { display: false },
          tooltip: {
            ...tooltipStyle(),
            filter: (item) => item.datasetIndex === 0 || item.datasetIndex >= 3,
            callbacks: {
              title: (items) => fmtDate(new Date(items[0].parsed.x).toISOString().slice(0, 10)),
              label: (item) => (item.raw.label ? ` ${item.raw.label}` : ` ราคาปิด: ${fmtUsd(item.parsed.y)}`),
            },
          },
        },
        scales: {
          x: {
            type: 'linear',
            min: minX,
            max: maxX,
            grid: { color: cssVar('--grid') },
            border: { color: cssVar('--axis') },
            afterBuildTicks: (axis) => {
              const ticks = [];
              for (let y = new Date(minX).getUTCFullYear() + 1; y <= new Date(maxX).getUTCFullYear(); y++) ticks.push({ value: Date.UTC(y, 0, 1) });
              axis.ticks = ticks;
            },
            ticks: { color: cssVar('--muted'), maxRotation: 0, autoSkip: true, autoSkipPadding: 8, callback: (v) => new Date(v).getUTCFullYear() },
          },
          // room above the projected top for its ±10% box and label
          // Fixed range: older tops and lows outside the window must not stretch the axis.
          y: { ...logPriceAxis(), min: visibleMin * 0.7, max: f.top * 2, afterFit: (axis) => { axis.width = 60; } },
        },
      },
      plugins: [errorBoxes],
    });
  }

  el('forecast-range')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b || b.dataset.v === range) return;
    range = b.dataset.v;
    try { localStorage.setItem('forecast-range', range); } catch { /* not remembered */ }
    if (lastRender) renderChart(lastRender.h, lastRender.f);
  });

  window.renderForecast = render;
})();
