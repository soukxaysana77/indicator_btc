'use strict';
// "รอบของ BTC" panel on the BTC page: every 4-year cycle's top and low found
// from the daily closes (top = highest close within 2 years after a halving,
// low = lowest close after it until the next halving), then
//   main chart — the cycles laid over each other, counted from each cycle's
//                low or from each cycle's top
//   ① how much higher each top was than the one before
//   ② how deep and how long each fall was
//   ③ how long it took to get back above the old top, against how long the
//     run from low to top lasted
// Checked 2026-11-14: tops ×17.3 → ×3.4 → ×1.85 the previous one; falls −85%
// → −84% → −77% → −53% (so far); old top → new ATH 1,177 → 1,080 → 847 days;
// yet low → top 1,067 / 1,059 / 1,062 days every time. Only 3–4 cycles: the
// "if this continued" lines are an illustration, not a forecast.
// Shared helpers come from common.js; the halving dates come from d.halving.

(() => {
  const el = (id) => document.getElementById(id);
  const DAY = 86400000;
  const PEAK_WITHIN = 730;
  const COLORS = ['--z-neutral', '--macro', '--lth', '--accent']; // oldest → newest
  const STORE = 'cycles-view';
  const TH_MONTH_YEAR = new Intl.DateTimeFormat('th-TH-u-ca-gregory', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const ms = (d) => Date.parse(`${d}T00:00:00Z`);
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const days = (a, b) => Math.round((ms(b) - ms(a)) / DAY);
  const monthYear = (d) => TH_MONTH_YEAR.format(ms(d));
  const times = (v) => (v == null ? '–' : `×${v >= 10 ? Math.round(v) : v.toFixed(v >= 2 ? 1 : 2)}`);
  const num = (v) => v.toLocaleString('en-US');
  const tile = (label, value, sub) => `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-sub">${sub}</div></div>`;

  let view = 'low';
  try { if (['low', 'top'].includes(localStorage.getItem(STORE))) view = localStorage.getItem(STORE); } catch { /* default */ }
  let lastData = null;
  const charts = {};

  // Each halving's cycle: top, the low after it, and how it compares with the one before.
  function cyclesOf(h, halvings) {
    const idx = new Map(h.dates.map((d, i) => [d, i]));
    const p = h.price;
    const n = p.length;
    const list = [];
    halvings.forEach((hv, k) => {
      const a = idx.get(hv.date);
      if (a == null) return;
      const next = halvings[k + 1] && idx.get(halvings[k + 1].date);
      const end = next != null ? next - 1 : n - 1;
      let top = a;
      for (let i = a; i <= end && days(hv.date, h.dates[i]) <= PEAK_WITHIN; i++) if (p[i] > p[top]) top = i;
      let low = top;
      for (let i = top; i <= end; i++) if (p[i] < p[low]) low = i;
      list.push({ n: hv.n, halving: hv.date, top, low, done: next != null });
    });
    list.forEach((c, k) => {
      c.topDate = h.dates[c.top];
      c.topPrice = p[c.top];
      c.lowDate = h.dates[c.low];
      c.lowPrice = p[c.low];
      c.fall = c.lowPrice / c.topPrice - 1;
      c.bearDays = days(c.topDate, c.lowDate);
      c.halvingToTop = days(c.halving, c.topDate);
      c.topFinal = c.done || days(c.halving, h.dates[n - 1]) > PEAK_WITHIN;
      const prev = list[k - 1];
      if (!prev) return;
      c.prevLowDate = prev.lowDate;
      c.vsPrevTop = c.topPrice / prev.topPrice;
      c.lowToTopX = c.topPrice / prev.lowPrice;
      c.lowToTopDays = days(prev.lowDate, c.topDate);
      c.lowVsPrevLow = c.lowPrice / prev.lowPrice;
      // first close above the previous top
      let j = prev.top + 1;
      while (j < n && p[j] <= prev.topPrice) j++;
      c.athDate = j < n ? h.dates[j] : null;
      c.topToAth = c.athDate ? days(prev.topDate, c.athDate) : null;
      c.lowToAth = c.athDate ? days(prev.lowDate, c.athDate) : null;
    });
    return list;
  }

  function render(d) {
    const panel = el('cycles-panel');
    if (!panel) return;
    const h = d?.history;
    const halvings = d?.halving?.past;
    panel.hidden = !h?.dates?.length || !halvings?.length;
    if (panel.hidden) return;
    lastData = d;
    const all = cyclesOf(h, halvings);
    const full = all.filter((c) => c.vsPrevTop != null);
    const cur = all[all.length - 1];
    const today = h.dates[h.dates.length - 1];
    const now = h.price[h.price.length - 1];
    if (full.length < 2 || !cur) return;
    const sinceTop = days(cur.topDate, today);
    const sinceLow = days(cur.lowDate, today);
    // The newest cycle has not made its next top yet: its "to new ATH" counts are still running.
    const done = full.filter((c) => c.topToAth != null);
    const arrow = (vals, f) => vals.map(f).join(' → ');

    el('cycles-summary').innerHTML = `
      <b>① ยอดเล็กลง:</b> ยอดใหม่สูงกว่ายอดเดิม ${arrow(full, (c) => times(c.vsPrevTop))} ·
      <b>② ร่วงตื้นขึ้น:</b> ${arrow(all, (c) => `${Math.round(c.fall * 100)}%`)}${cur.done ? '' : ' (รอบนี้ถึงตอนนี้)'} ·
      <b>③ กลับไปทำ New High เร็วขึ้น:</b> จากยอดเดิม ${arrow(done, (c) => `${num(c.topToAth)} วัน`)} ·
      <b>แต่ขาขึ้นจากก้นถึงยอดยาวเท่าเดิม:</b> ${full.map((c) => `${num(c.lowToTopDays)}`).join(' / ')} วัน`;

    // Illustration: the next steps if the same shrinking continued.
    const lastAth = done[done.length - 1];
    const prevAth = done[done.length - 2];
    const shrink = lastAth && prevAth ? lastAth.lowToAth / prevAth.lowToAth : null;
    const athFast = shrink ? iso(ms(cur.lowDate) + lastAth.lowToAth * shrink * DAY) : null;
    const athSame = lastAth ? iso(ms(cur.lowDate) + lastAth.lowToAth * DAY) : null;
    const athSlow = done.length ? iso(ms(cur.lowDate) + Math.max(...done.map((c) => c.lowToAth)) * DAY) : null;
    const logGains = full.map((c) => Math.log(c.vsPrevTop));
    const halfStep = logGains.length >= 2 ? logGains[logGains.length - 1] / logGains[logGains.length - 2] : 0.5;
    const nextX = Math.exp(logGains[logGains.length - 1] * halfStep);
    const avgBull = full.reduce((s, c) => s + c.lowToTopDays, 0) / full.length;
    const nextTopDate = iso(ms(cur.lowDate) + avgBull * DAY);
    el('cycles-stats').innerHTML = [
      tile('รอบนี้ตอนนี้', `${Math.round((now / cur.topPrice - 1) * 100)}% จากยอด`, `ยอด ${fmtUsd(cur.topPrice)} (${fmtDate(cur.topDate)}) ผ่านมา ${num(sinceTop)} วัน · ก้นถึงตอนนี้ ${fmtUsd(cur.lowPrice)} (${fmtDate(cur.lowDate)}) ผ่านมา ${num(sinceLow)} วัน · ต้องขึ้นอีก ${Math.round((cur.topPrice / now - 1) * 100)}% ถึงจะ New High`),
      tile('ถ้าเวลากลับไป New High สั้นลงแบบเดิม', athFast ? `≈ ${monthYear(athFast)}` : '–', `นับจากก้น ${fmtDate(cur.lowDate)} · ถ้าเท่ารอบล่าสุด (${num(lastAth.lowToAth)} วัน) ≈ ${monthYear(athSame)} · ถ้าช้าเท่ารอบที่ช้าสุด ≈ ${monthYear(athSlow)}`),
      tile('ถ้ายอดยังเล็กลงแบบเดิม', `≈ ${fmtUsd(Math.round((cur.topPrice * nextX) / 1000) * 1000)}`, `ยอดรอบหน้า ≈ ${times(nextX)} ของยอด ${fmtUsd(cur.topPrice)} (การขึ้นเกินยอดเดิมเล็กลงราวครึ่งหนึ่งทุกรอบ) · ถ้าขาขึ้นยาว ~${num(Math.round(avgBull))} วันเท่าเดิม ยอดจะมาราว ${monthYear(nextTopDate)}`),
    ].join('');

    renderTable(all);
    renderMain(h, all);
    renderBars(all, full, cur, sinceTop, sinceLow);
  }

  function renderTable(all) {
    const row = (c) => `<tr${c.done ? '' : ' class="now"'}>
      <td>${c.topDate.slice(0, 4)}${c.done ? '' : ' <span class="pill tone-neutral"><i></i>รอบนี้</span>'}<div class="coin-name cy-sub">halving ${fmtDate(c.halving)} → ยอด ${num(c.halvingToTop)} วัน</div></td>
      <td class="num">${fmtUsd(c.topPrice)}<div class="coin-name">${fmtDate(c.topDate)}</div></td>
      <td class="num">${c.vsPrevTop ? `<b>${times(c.vsPrevTop)}</b>` : '–'}<div class="coin-name cy-sub">${c.lowToTopX ? `จากก้นก่อนหน้า ${times(c.lowToTopX)} ใน ${num(c.lowToTopDays)} วัน` : ''}</div></td>
      <td class="num">${fmtUsd(c.lowPrice)}<div class="coin-name">${fmtDate(c.lowDate)}${c.done ? '' : ' (ถึงตอนนี้)'}</div></td>
      <td class="num"><b>${Math.round(c.fall * 100)}%</b><div class="coin-name">${num(c.bearDays)} วัน</div></td>
      <td class="num">${c.topToAth != null ? `${num(c.topToAth)} วัน<div class="coin-name cy-sub">จากก้น ${num(c.lowToAth)} วัน · ${fmtDate(c.athDate)}</div>` : '–'}</td>
    </tr>`;
    el('cycles-table').innerHTML = `<table class="lined cycles-table">
      <thead><tr><th>รอบ (ปีที่ทำยอด)</th><th class="num">ยอด</th><th class="num">เทียบยอดเดิม</th><th class="num">ก้นหลังยอด</th><th class="num">ร่วง · กี่วัน</th><th class="num" title="จากยอดของรอบก่อน จนราคาปิดเกินยอดนั้นได้ (New High)">ยอดเดิม → New High</th></tr></thead>
      <tbody>${[...all].reverse().map(row).join('')}</tbody></table>`;
  }

  // ---------- main chart: cycles laid over each other ----------

  function renderMain(h, all) {
    if (!window.Chart) return;
    for (const b of el('cycles-view').querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === view);
    const p = h.price;
    const n = p.length;
    const sets = [];
    if (view === 'low') {
      // from each cycle's low, 1,500 days on (the run up to the next top and its fall)
      all.forEach((c, k) => {
        const start = c.low;
        const series = [];
        for (let i = start; i < n && i - start <= 1500; i++) series.push({ x: i - start, y: p[i] / p[start], p: p[i], d: h.dates[i] });
        sets.push({ label: `ก้น ${c.lowDate.slice(0, 7)}${c.done ? '' : ' (รอบนี้)'}`, data: series, k, current: k === all.length - 1 });
      });
    } else {
      all.forEach((c, k) => {
        const start = c.top;
        const series = [];
        for (let i = start; i < n && i - start <= 1400; i++) series.push({ x: i - start, y: p[i] / p[start], p: p[i], d: h.dates[i] });
        sets.push({ label: `ยอด ${c.topDate.slice(0, 7)}${c.done ? '' : ' (รอบนี้)'}`, data: series, k, current: k === all.length - 1 });
      });
    }
    const colorOf = (k) => cssVar(COLORS[Math.max(0, COLORS.length - all.length + k)]);
    el('cycles-legend').innerHTML = sets.map((s) => `<span class="legend"><span class="key" style="background:${colorOf(s.k)}"></span>${esc(s.label)}</span>`).join('');
    el('cycles-main-title').textContent = view === 'low'
      ? 'แต่ละรอบนับจากก้นของรอบ (เท่าของราคาที่ก้น, สเกล log) — ดูว่าขาขึ้นยาวกี่วันและขึ้นกี่เท่า'
      : 'แต่ละรอบนับจากยอดของรอบ (เท่าของราคาที่ยอด, สเกล log) — ดูว่าร่วงลึกแค่ไหน และกี่วันถึงกลับมาเกินเส้น ×1 (New High)';
    if (charts.main) charts.main.destroy();
    const maxX = view === 'low' ? 1500 : 1400;
    const ticks = [];
    for (let v = 0; v <= maxX; v += 365) ticks.push({ value: v });
    const oneLine = {
      id: 'cyclesOne',
      beforeDatasetsDraw(chart) {
        if (view !== 'top') return;
        const { ctx, chartArea: a, scales: { y } } = chart;
        const py = y.getPixelForValue(1);
        if (!(py >= a.top && py <= a.bottom)) return;
        ctx.save();
        ctx.strokeStyle = cssVar('--accent');
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(a.left, py);
        ctx.lineTo(a.right, py);
        ctx.stroke();
        ctx.fillStyle = cssVar('--accent');
        ctx.font = `600 11px ${CHART_FONT}`;
        ctx.fillText('ยอดเดิม (×1)', a.left + 4, py - 4);
        ctx.restore();
      },
    };
    charts.main = new Chart(el('chart-cycles'), {
      type: 'line',
      data: {
        datasets: sets.map((s) => ({ label: s.label, data: s.data, ...lineStyle(colorOf(s.k), s.current ? 2.5 : 1.5), order: s.current ? 0 : 1 })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        normalized: true,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            ...tooltipStyle(),
            itemSort: (a, b) => b.datasetIndex - a.datasetIndex,
            callbacks: {
              title: (items) => `วันที่ ${num(items[0].parsed.x)} หลัง${view === 'low' ? 'ก้น' : 'ยอด'}`,
              label: (item) => ` ${item.dataset.label}: ${times(item.parsed.y)} · ${fmtUsd(item.raw.p)} (${fmtDate(item.raw.d)})`,
            },
          },
        },
        scales: {
          x: {
            type: 'linear',
            min: 0,
            max: maxX,
            grid: { color: cssVar('--grid') },
            border: { color: cssVar('--axis') },
            afterBuildTicks: (axis) => { axis.ticks = ticks; },
            ticks: { color: cssVar('--muted'), callback: (v) => (v === 0 ? (view === 'low' ? 'ก้น' : 'ยอด') : `${v / 365} ปี`) },
          },
          y: { ...logAxis((v) => `×${Number(v.toPrecision(3))}`), afterFit: (axis) => { axis.width = 56; } },
        },
      },
      plugins: [oneLine],
    });
  }

  // ---------- ① ② ③ ----------

  function barOptions(yAxis, label) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { ...tooltipStyle(), callbacks: { label } },
      },
      scales: {
        x: { grid: { display: false }, border: { color: cssVar('--axis') }, ticks: { color: cssVar('--muted') } },
        y: yAxis,
      },
    };
  }

  function renderBars(all, full, cur, sinceTop, sinceLow) {
    if (!window.Chart) return;
    for (const k of ['b1', 'b2', 'b3']) if (charts[k]) { charts[k].destroy(); delete charts[k]; }
    const grid = cssVar('--grid');
    const muted = cssVar('--muted');
    const c1 = cssVar('--lth');
    const c2 = cssVar('--macro');
    const gray = cssVar('--axis');

    // ① top vs the previous top, and low → top
    charts.b1 = new Chart(el('chart-cycles-1'), {
      type: 'bar',
      data: {
        labels: full.map((c) => c.topDate.slice(0, 4)),
        datasets: [
          { label: 'ยอดใหม่ ÷ ยอดเดิม', data: full.map((c) => c.vsPrevTop), backgroundColor: c1, borderRadius: 3, maxBarThickness: 34 },
          { label: 'ยอด ÷ ก้นก่อนหน้า', data: full.map((c) => c.lowToTopX), backgroundColor: c2, borderRadius: 3, maxBarThickness: 34 },
        ],
      },
      options: barOptions({ ...logAxis((v) => `×${Number(v.toPrecision(3))}`), afterFit: (a) => { a.width = 48; } }, (item) => ` ${item.dataset.label}: ${times(item.parsed.y)}`),
    });

    // ② fall from top to low (%), bars; days of the fall in the tooltip and labels
    charts.b2 = new Chart(el('chart-cycles-2'), {
      type: 'bar',
      data: {
        labels: all.map((c) => `${c.topDate.slice(2, 4)}→${c.lowDate.slice(2, 4)}${c.done ? '' : '*'}`),
        datasets: [{ label: 'ร่วงจากยอดถึงก้น', data: all.map((c) => Math.round(c.fall * 1000) / 10), backgroundColor: all.map((c) => (c.done ? cssVar('--z-strong-sell') : gray)), borderRadius: 3, maxBarThickness: 34 }],
      },
      options: barOptions(
        { position: 'right', min: -100, max: 0, grid: { color: grid }, border: { display: false }, ticks: { color: muted, callback: (v) => `${v}%` } },
        (item) => ` ร่วง ${item.parsed.y}% ใน ${num(all[item.dataIndex].bearDays)} วัน${all[item.dataIndex].done ? '' : ' (รอบนี้ ถึงตอนนี้)'}`,
      ),
    });

    // ③ days: old top → new ATH, low → new ATH, and the low → top run (steady)
    const labels = [...full.map((c) => `${c.prevLowDate.slice(0, 4)}–${c.topDate.slice(2, 4)}`), `${cur.lowDate.slice(0, 4)}–*`];
    const curTopToAth = sinceTop; // still counting
    const curLowToAth = sinceLow;
    charts.b3 = new Chart(el('chart-cycles-3'), {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'ยอดเดิม → New High', data: [...full.map((c) => c.topToAth), curTopToAth], backgroundColor: [...full.map(() => c1), gray], borderRadius: 3, maxBarThickness: 26 },
          { label: 'ก้น → New High', data: [...full.map((c) => c.lowToAth), curLowToAth], backgroundColor: [...full.map(() => c2), gray], borderRadius: 3, maxBarThickness: 26 },
          { label: 'ขาขึ้น: ก้น → ยอด', data: [...full.map((c) => c.lowToTopDays), null], backgroundColor: cssVar('--accent'), borderRadius: 3, maxBarThickness: 26 },
        ],
      },
      options: barOptions(
        { position: 'right', min: 0, grid: { color: grid }, border: { display: false }, ticks: { color: muted, callback: (v) => num(v) } },
        (item) => ` ${item.dataset.label}: ${num(item.parsed.y)} วัน${item.dataIndex === labels.length - 1 ? ' (ยังไม่ถึง นับไปแล้ว)' : ''}`,
      ),
    });
  }

  function bind() {
    const seg = el('cycles-view');
    if (!seg) return;
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b || b.dataset.v === view) return;
      view = b.dataset.v;
      try { localStorage.setItem(STORE, view); } catch { /* not remembered */ }
      if (lastData) renderMain(lastData.history, cyclesOf(lastData.history, lastData.halving.past));
    });
  }

  bind();
  window.renderCycles = render;
  window.btcCyclesOf = cyclesOf; // shared with forecast.js
})();
