'use strict';
// Net realized profit/loss card on the BTC page (built in lib/realizedpnl.js).
// Only pages with #rpl-panel use it. Shared helpers come from common.js.

(() => {
  const WEEKS = { '1y': 52, '2y': 104, '4y': Infinity };
  const el = (id) => document.getElementById(id);
  const tile = (label, value, sub) => `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-sub">${sub}</div></div>`;
  const bn = (v) => `$${Math.abs(v).toFixed(Math.abs(v) >= 10 ? 1 : 2)} พันล้าน`;
  const net = (v) => (v >= 0 ? `<span class="up">▲ กำไรสุทธิ</span> ${bn(v)}` : `<span class="down">▼ ขาดทุนสุทธิ</span> ${bn(v)}`);
  const arrow = (v) => (v == null ? '–' : `<span class="${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '▲' : '▼'} ${fmtPct(v, 0)}</span>`);

  let range = '2y';
  let chart = null;
  let lastData = null;

  function render(d) {
    const panel = el('rpl-panel');
    if (!panel) return;
    lastData = d;
    const r = d?.realizedPnl;
    panel.hidden = !r;
    if (!r) return;

    const [day, week, two, month] = r.recent;
    const losing = two.netBn < 0;
    el('rpl-asof').textContent = `(ข้อมูล ณ ${fmtDate(r.asOf)})`;
    el('rpl-summary').innerHTML = `<b>สรุปตอนนี้:</b> ${r.window} วันล่าสุดตลาด${losing ? 'ขายขาดทุนมากกว่ากำไร' : 'ขายได้กำไรมากกว่าขาดทุน'} (${losing ? 'ขาดทุน' : 'กำไร'}สุทธิ ${bn(two.netBn)} · ขาดทุน ${r.lossDays} จาก ${r.window} วัน) — ดูหลักฐานด้านล่างว่าสภาวะนี้ในอดีตตามด้วยอะไร`;
    const sub = (x) => `ขายได้กำไร ${bn(x.profitBn)} · ขายขาดทุน ${bn(x.lossBn)}`;
    el('rpl-stats').innerHTML = [
      tile(`วันล่าสุด (${fmtDate(r.asOf)})`, net(day.netBn), sub(day)),
      tile('7 วันล่าสุด', net(week.netBn), sub(week)),
      tile(`${r.window} วันล่าสุด`, net(two.netBn), `${sub(two)} · ขาดทุน ${r.lossDays} จาก ${r.window} วัน`),
      tile('30 วันล่าสุด', net(month.netBn), sub(month)),
    ].join('');

    // ---------- evidence ----------
    const ev = r.evidence;
    const [h1, h2] = ev.horizons; // 90, 365
    const both = (o) => `3 เดือน ${arrow(o[h1].median)} · 1 ปี ${arrow(o[h2].median)}`;
    const detail = (o) => `ค่ากลาง · 3 เดือนต่อมาราคาขึ้น ${Math.round(o[h1].upPct)}% ของครั้ง · 1 ปีต่อมาขึ้น ${Math.round(o[h2].upPct)}% ของครั้ง${o[h2].episodes > 1 ? ` · ${o[h2].episodes} ช่วง` : ''}`;
    const halves = (o) => `ปี 2014–2019: 1 ปี ${fmtPct(o.early[h2].median, 0)} · ปี 2020 ขึ้นไป: 1 ปี ${fmtPct(o.late[h2].median, 0)}`;
    const now = losing && r.lth >= ev.lthMin ? ' (แบบตอนนี้)' : '';
    const nowP = !losing && r.lth >= ev.lthMin ? ' (แบบตอนนี้)' : '';
    el('rpl-since').textContent = `(ตั้งแต่ ${new Date(`${ev.from}T00:00:00Z`).getUTCFullYear()})`;
    el('rpl-evidence').innerHTML = [
      tile('วันทั่วไป (ไว้เทียบ)', both(ev.all), detail(ev.all)),
      tile(`${ev.window} วันขายขาดทุนสุทธิ`, both(ev.loss), detail(ev.loss)),
      tile(`${ev.window} วันขายกำไรสุทธิ`, both(ev.profit), detail(ev.profit)),
      tile(`คะแนน LTH ≥ ${ev.lthMin} + ขาดทุนสุทธิ${now}`, both(ev.cheapLoss), `${detail(ev.cheapLoss)} · ${halves(ev.cheapLoss)}`),
      tile(`คะแนน LTH ≥ ${ev.lthMin} + กำไรสุทธิ${nowP}`, both(ev.cheapProfit), `${detail(ev.cheapProfit)} · ${halves(ev.cheapProfit)}`),
    ].join('');
    const profitWins = ev.cheapProfit.early[h2].median > ev.cheapLoss.early[h2].median && ev.cheapProfit.late[h2].median > ev.cheapLoss.late[h2].median;
    el('rpl-verdict').innerHTML = profitWins
      ? `<b>ข้อสรุป:</b> ช่วงขายขาดทุนต่อเนื่อง<b>ไม่ได้</b>ตามมาด้วยราคาที่ดีกว่าปกติ (3 เดือนต่อมาค่ากลาง ${fmtPct(ev.loss[h1].median, 0)} เทียบวันทั่วไป ${fmtPct(ev.all[h1].median, 0)}) และในโซนราคาถูก ช่วงที่ตลาด<b>กลับมาขายได้กำไร</b>ให้ผลดีกว่าช่วงขายขาดทุนทั้งปี 2014–2019 และ 2020 ขึ้นไป เพราะแปลว่าราคาเริ่มขึ้นพ้นต้นทุนแล้ว — การขายขาดทุนจึงยังไม่ใช่สัญญาณซื้อ ต่างจากที่คลิปบอก`
      : '<b>ข้อสรุป:</b> ผลไม่คงที่ระหว่างปี 2014–2019 กับ 2020 ขึ้นไป ใช้เป็นข้อมูลประกอบเท่านั้น';

    renderChart(r.chart);
  }

  function renderChart(ch) {
    if (!window.Chart) return;
    const n = ch.dates.length;
    const s = Math.max(0, n - WEEKS[range]);
    const opts = baseOptions(range === '4y' ? 'all' : 'short');
    opts.plugins.tooltip.callbacks = {
      title: (items) => `สัปดาห์ที่จบวันที่ ${fmtDate(items[0].label)}`,
      label: (item) => (item.dataset.yAxisID === 'price'
        ? ` ราคา BTC: ${fmtUsd(item.raw)}`
        : ` ${item.raw >= 0 ? 'กำไร' : 'ขาดทุน'}สุทธิ: ${bn(item.raw)}`),
    };
    opts.scales.y = {
      position: 'right',
      grid: { color: cssVar('--grid') },
      border: { display: false },
      ticks: { color: cssVar('--muted'), maxTicksLimit: 6, callback: (v) => `${v < 0 ? '-' : ''}$${Math.abs(v)}` },
    };
    const prices = ch.price.slice(s).filter((v) => v != null);
    opts.scales.price = {
      ...logAxis((v) => `$${Math.round(v / 1000)}k`),
      position: 'left',
      min: Math.min(...prices) * 0.9,
      max: Math.max(...prices) * 1.05,
      grid: { display: false },
    };
    const vals = ch.netBn.slice(s);
    if (chart) chart.destroy();
    chart = new Chart(el('chart-rpl'), {
      type: 'bar',
      data: {
        labels: ch.dates.slice(s),
        datasets: [
          { type: 'line', label: 'ราคา', yAxisID: 'price', data: ch.price.slice(s), order: 0, ...lineStyle(cssVar('--price'), 1.5) },
          { label: 'กำไร/ขาดทุนสุทธิ', yAxisID: 'y', data: vals, order: 1, backgroundColor: vals.map((v) => cssVar(v >= 0 ? '--up' : '--down')), borderRadius: 2, maxBarThickness: 10 },
        ],
      },
      options: opts,
      plugins: [baselineAt(0), crosshair],
    });
  }

  function initRange() {
    const seg = el('rpl-range');
    if (!seg || seg.dataset.bound) return;
    seg.dataset.bound = '1';
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-v]');
      if (!btn) return;
      range = btn.dataset.v;
      for (const b of seg.querySelectorAll('button')) b.classList.toggle('on', b === btn);
      if (lastData?.realizedPnl) renderChart(lastData.realizedPnl.chart);
    });
  }

  window.renderRealized = (d) => { initRange(); render(d); };
})();
