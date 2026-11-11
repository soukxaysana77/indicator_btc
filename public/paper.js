'use strict';
// "ระบบทดลอง" card on the BTC page (data: /api/paper, built in lib/papertrade.js).
// Rules: hold BTC while its daily close is above the chosen N-day average,
// else cash; while in cash, a one-day bounce on any asset that closes with
// STH ≥ 99. The start date, the average and the pretend amount are kept in this
// browser; the server replays the rules on the real closes from that date, so
// the record is the same whenever the page is opened. No real money.
// Shared helpers come from common.js.

(() => {
  const el = (id) => document.getElementById(id);
  const KEY = 'paper-setup';
  const store = {
    get() {
      try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; }
    },
    set(v) {
      try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* not remembered: fine */ }
    },
  };
  const tile = (label, value, sub) => `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-sub">${sub}</div></div>`;
  const signed = (v, d = 1) => (v == null ? '–' : `<span class="${v >= 0 ? 'up' : 'down'}">${fmtPct(v, d)}</span>`);
  const symName = (s) => (s === 'GOLD' ? 'ทองคำ' : s);
  const legsText = (legs) => legs.map((l) => `${esc(symName(l.symbol))} ${fmtUsd(l.price)}`).join(', ');
  const KIND = { buy: 'ซื้อ BTC', sell: 'ขาย BTC → ถือเงินสด', 'bounce-buy': 'เด้ง STH 99: ซื้อ', 'bounce-sell': 'เด้ง STH 99: ขาย' };

  let setup = store.get();
  let chart = null;
  let last = null;
  let busy = false;

  function cryptoClose() {
    const now = Date.now();
    const next = Math.ceil(now / 86400000) * 86400000;
    const min = Math.round((next - now) / 60000);
    return `อีก ${Math.floor(min / 60)} ชม. ${min % 60} นาที`;
  }

  async function load() {
    if (busy || !el('paper-panel')) return;
    busy = true;
    try {
      const q = new URLSearchParams();
      if (setup?.ma) q.set('ma', setup.ma);
      if (setup?.from) q.set('from', setup.from);
      if (setup?.capital) q.set('capital', setup.capital);
      const res = await fetch(`/api/paper?${q}`, { cache: 'no-store' });
      if (res.ok) render(await res.json());
    } catch { /* offline or server restarting: keep the last card */ } finally {
      busy = false;
    }
  }

  function render(d) {
    const panel = el('paper-panel');
    if (!panel || !d?.paper) return;
    last = d;
    panel.hidden = false;
    // First visit: the paper record starts today and is remembered.
    if (!setup?.from) {
      setup = { ma: d.ma, from: d.paper.from, capital: d.paper.capital };
      store.set(setup);
    }
    syncControls(d);

    const p = d.paper;
    const ma = d.ma;
    const avgText = `เส้น ${ma} วัน ${fmtUsd(d.avg)}`;
    // What to do at the next close (07:00 Thai time).
    let action;
    if (d.held === 'bounce') {
      action = `กำลังเด้ง STH ${d.level}: ถือ ${legsText(d.heldBounce.legs)} — <b>ขายตอนปิดวัน</b> (07:00 น., ${cryptoClose()})`;
    } else if (d.held === 'btc') {
      action = d.above
        ? `<b>ถือ BTC ต่อ</b> — ราคา ${fmtUsd(d.price)} ยังอยู่เหนือ${avgText}`
        : `<b>ระวัง:</b> ราคา ${fmtUsd(d.price)} หลุด${avgText}แล้ว — ถ้าตอนปิดวัน (07:00 น., ${cryptoClose()}) ยังต่ำกว่าเส้น ระบบจะ<b>ขาย BTC ถือเงินสด</b>`;
    } else {
      action = d.above
        ? `<b>สัญญาณซื้อ:</b> ราคา ${fmtUsd(d.price)} ขึ้นเหนือ${avgText}แล้ว — ถ้าตอนปิดวัน (07:00 น., ${cryptoClose()}) ยังอยู่เหนือเส้น ระบบจะ<b>ซื้อ BTC</b>`
        : `<b>ถือเงินสดต่อ</b> — ราคา ${fmtUsd(d.price)} ยังต่ำกว่า${avgText}`;
      if (d.liveSth.length) action += ` · และตอนนี้ ${d.liveSth.map((x) => `${esc(symName(x.symbol))} STH ${Math.floor(x.sth)}`).join(', ')} — ถ้าปิดวันยังถึง ${d.level} ระบบจะใช้เงินสด<b>เด้งวันเดียว</b>`;
    }
    // Above or below the average, and by how much (live, and at the last close).
    const gap = d.avg ? (d.price / d.avg - 1) * 100 : null;
    const closeGap = d.closeAvg ? (d.closePrice / d.closeAvg - 1) * 100 : null;
    const badge = gap == null ? '' : `<span class="pill tone-${d.above ? 'buy' : 'sell'} paper-badge"><i></i>${d.above ? 'เหนือเส้น' : 'ใต้เส้น'} ${fmtPct(gap, 1)}</span>`;
    el('paper-signal').innerHTML = `${badge} <b>วันนี้:</b> ${action}`;
    el('paper-price-title').textContent = `ราคา BTC เทียบเส้น ${ma} วัน (1 ปีล่าสุด)`;

    const gain = (p.equity / p.capital - 1) * 100;
    const bhGain = (p.bh / p.capital - 1) * 100;
    const heldText = p.held === 'bounce' ? `เด้ง ${p.open.legs.map((l) => esc(symName(l.symbol))).join(', ')}` : p.held === 'btc' ? 'BTC' : 'เงินสด';
    const counts = {
      buy: p.trades.filter((t) => t.kind === 'buy').length,
      sell: p.trades.filter((t) => t.kind === 'sell').length,
      bounce: p.trades.filter((t) => t.kind === 'bounce-buy').length,
    };
    el('paper-stats').innerHTML = [
      tile(`พอร์ตทดลอง (เริ่ม ${fmtDate(p.from)})`, fmtUsd(p.equity), `${signed(gain)} จากเงินสมมติ ${fmtUsd(p.capital)} · รวมค่าธรรมเนียม ${(d.fee * 100).toFixed(1)}% ต่อครั้ง`),
      tile('ถ้าถือ BTC เฉย ๆ ตั้งแต่วันเดียวกัน', fmtUsd(p.bh), `${signed(bhGain)} · ระบบ${p.equity >= p.bh ? 'ได้มากกว่า' : 'ได้น้อยกว่า'} ${fmtUsd(Math.abs(p.equity - p.bh))}`),
      tile('ระบบถืออะไรอยู่ (ณ ปิดวันล่าสุด)', heldText, `ปิดวันล่าสุด ${fmtDate(d.lastClose)} ราคา ${fmtUsd(d.closePrice)} · เส้น ${ma} วัน ${fmtUsd(d.closeAvg)}${closeGap == null ? '' : ` → <b>${closeGap >= 0 ? 'เหนือ' : 'ใต้'}เส้น ${fmtPct(closeGap, 1)}</b>`}`),
      tile('ซื้อขายไปแล้ว', `${p.trades.length} รายการ`, `ซื้อ BTC ${counts.buy} · ขาย ${counts.sell} · เด้ง STH ${d.level} ${counts.bounce} ครั้ง`),
    ].join('');

    const rows = [...p.trades].reverse();
    el('paper-trades').innerHTML = rows.length
      ? `<table class="lined paper-log">
          <thead><tr><th>วันที่ (ปิดวัน)</th><th>ระบบทำอะไร</th><th class="num">ราคา</th><th class="num">พอร์ตหลังทำ</th></tr></thead>
          <tbody>${rows.map((t) => `<tr>
            <td>${fmtDate(t.date)}</td>
            <td>${KIND[t.kind]}${t.kind === 'bounce-sell' && t.ret != null ? ` ${signed(t.ret)}` : ''}</td>
            <td class="num">${t.legs ? t.legs.map((l) => `<div>${esc(symName(l.symbol))} ${fmtUsd(l.price)}</div>`).join('') : `${fmtUsd(t.price)}<div class="coin-name">เส้น ${fmtUsd(t.avg)}</div>`}</td>
            <td class="num">${fmtUsd(t.equity)}</td></tr>`).join('')}</tbody></table>`
      : `<p class="muted">ยังไม่มีการซื้อขายตั้งแต่ ${fmtDate(p.from)} — ระบบจะตัดสินใจทุกครั้งที่ปิดวัน (07:00 น.)</p>`;

    const span = (r) => `<span title="${fmtDate(r.from)} – ${r.to ? fmtDate(r.to) : 'ตอนนี้'}">${r.from.slice(0, 4)}–${r.to ? r.to.slice(0, 4) : 'ตอนนี้'}</span>`;
    const cell = (x) => `${signed(x.cagr, 0)}/ปี<div class="coin-name">ลงลึกสุด ${fmtPct(x.dd, 0)}</div>`;
    el('paper-backtest').innerHTML = `<table class="lined paper-bt">
      <thead><tr><th>ช่วง</th><th class="num">ระบบนี้</th><th class="num" title="เส้น ${ma} วันอย่างเดียว ไม่เล่นเด้ง STH">แค่เส้น ${ma}</th><th class="num">ถือเฉย ๆ</th><th class="num" title="จำนวนครั้งที่ซื้อ BTC · จำนวนครั้งที่เด้ง STH ${d.level}">ซื้อ·เด้ง</th></tr></thead>
      <tbody>${d.backtest.map((r, k) => `<tr${k === d.backtest.length - 1 ? ' class="now"' : ''}>
        <td>${span(r)}${k === d.backtest.length - 1 ? '<div class="coin-name">รวมทั้งหมด</div>' : ''}</td>
        <td class="num">${cell(r.system)}</td><td class="num">${cell(r.trend)}</td><td class="num">${cell(r.hold)}</td>
        <td class="num">${r.trades} · ${r.bounces}</td></tr>`).join('')}</tbody></table>`;

    renderChart(p);
    renderPriceChart(d);
    window.dispatchEvent(new CustomEvent('paper:data', { detail: d }));
  }

  // Price against the average for the last year: the gap is shaded green while
  // the close is above (the system holds BTC) and red while below (cash);
  // ▲ / ▼ mark the closes where it crossed (the system buys / sells there).
  let priceChart = null;
  function renderPriceChart(d) {
    if (!window.Chart || !d.chart?.dates?.length) return;
    if (priceChart) priceChart.destroy();
    const { dates, price, avg } = d.chart;
    const n = dates.length;
    const lastIdx = n - 1; // the live day: not a close yet
    const buys = new Array(n).fill(null);
    const sells = new Array(n).fill(null);
    for (let i = 1; i < lastIdx; i++) {
      if (avg[i] == null || avg[i - 1] == null) continue;
      const now = price[i] > avg[i];
      const before = price[i - 1] > avg[i - 1];
      if (now && !before) buys[i] = price[i];
      if (!now && before) sells[i] = price[i];
    }
    const up = cssVar('--z-strong-buy');
    const down = cssVar('--z-strong-sell');
    const opts = baseOptions('short');
    opts.scales.x.ticks.maxTicksLimit = 7;
    opts.scales.y = {
      position: 'right',
      grid: { color: cssVar('--grid') },
      border: { display: false },
      ticks: { color: cssVar('--muted'), callback: (v) => (v >= 1000 ? `$${(v / 1000).toLocaleString('en-US')}k` : fmtUsd(v)) },
    };
    opts.plugins.tooltip.callbacks.label = (item) => {
      if (item.datasetIndex === 0) return ` ราคา${item.dataIndex === lastIdx ? 'ตอนนี้' : 'ปิด'}: ${fmtUsd(item.parsed.y)}`;
      if (item.datasetIndex === 1) return ` เส้น ${d.ma} วัน: ${fmtUsd(item.parsed.y)}`;
      return item.datasetIndex === 2 ? ' ▲ ปิดเหนือเส้น → ระบบซื้อ BTC' : ' ▼ ปิดใต้เส้น → ระบบขาย ถือเงินสด';
    };
    opts.plugins.tooltip.callbacks.footer = (items) => {
      const i = items[0].dataIndex;
      return avg[i] ? `${price[i] > avg[i] ? 'เหนือ' : 'ใต้'}เส้น ${fmtPct((price[i] / avg[i] - 1) * 100, 1)}${i === lastIdx ? ' (ยังไม่ปิดวัน)' : ''}` : '';
    };
    const marker = (data, color, rotation) => ({ data, showLine: false, pointStyle: 'triangle', rotation, pointRadius: 6, pointHoverRadius: 7, pointBackgroundColor: color, pointBorderColor: cssVar('--surface'), pointBorderWidth: 1, borderColor: color });
    priceChart = new Chart(el('chart-paper-price'), {
      type: 'line',
      data: {
        labels: dates,
        datasets: [
          { label: 'ราคา', data: price, ...lineStyle(cssVar('--price'), 1.5), fill: { target: 1, above: 'rgba(12, 163, 12, 0.18)', below: 'rgba(208, 59, 59, 0.14)' } },
          { label: `เส้น ${d.ma} วัน`, data: avg, ...lineStyle(cssVar('--accent'), 2), borderDash: [5, 4] },
          { label: 'ซื้อ', ...marker(buys, up, 0) },
          { label: 'ขาย', ...marker(sells, down, 180) },
        ],
      },
      options: opts,
      plugins: [crosshair],
    });
  }

  function renderChart(p) {
    const wrap = el('paper-chart-wrap');
    const pts = p.curve;
    wrap.hidden = pts.length < 3;
    if (!window.Chart || pts.length < 3) return;
    if (chart) chart.destroy();
    const opts = baseOptions(pts.length > 900 ? 'all' : 'short');
    opts.scales.y = {
      position: 'right',
      grid: { color: cssVar('--grid') },
      border: { display: false },
      ticks: { color: cssVar('--muted'), callback: (v) => fmtUsd(v) },
    };
    opts.plugins.tooltip.callbacks.label = (item) => ` ${item.dataset.label}: ${fmtUsd(item.parsed.y)}`;
    chart = new Chart(el('chart-paper'), {
      type: 'line',
      data: {
        labels: pts.map((c) => c.d),
        datasets: [
          { label: 'ระบบทดลอง', data: pts.map((c) => c.eq), ...lineStyle(cssVar('--macro'), 2) },
          { label: 'ถือ BTC เฉย ๆ', data: pts.map((c) => c.bh), ...lineStyle(cssVar('--price'), 1.25) },
        ],
      },
      options: opts,
      plugins: [baselineAt(p.capital), crosshair],
    });
  }

  function syncControls(d) {
    for (const b of el('paper-ma').querySelectorAll('button')) b.classList.toggle('on', Number(b.dataset.v) === d.ma);
    const from = el('paper-from');
    from.max = d.today;
    if (document.activeElement !== from) from.value = d.paper.from;
    const cap = el('paper-capital');
    if (document.activeElement !== cap) cap.value = d.paper.capital;
  }

  function change(patch) {
    setup = { ...(setup || {}), ...patch };
    store.set(setup);
    load();
  }

  function bind() {
    if (!el('paper-panel')) return;
    el('paper-ma').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (b) change({ ma: Number(b.dataset.v) });
    });
    el('paper-from').addEventListener('change', (e) => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) change({ from: e.target.value }); });
    el('paper-capital').addEventListener('change', (e) => {
      const v = Number(e.target.value);
      if (v > 0) change({ capital: v });
    });
    el('paper-restart').addEventListener('click', () => {
      if (last && confirm(`เริ่มทดลองใหม่ตั้งแต่วันนี้ (${fmtDate(last.today)})? บันทึกเดิมจะถูกแทนที่ (คำนวณย้อนดูได้ใหม่โดยเลือกวันเริ่มเดิม)`)) change({ from: last.today });
    });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (last) { renderChart(last.paper); renderPriceChart(last); } });
  }

  bind();
  load();
  autoRefresh(load);
})();
