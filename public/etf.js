'use strict';
// US spot ETF flows: the BTC page and coin pages whose coin has US ETFs (XRP).
// Data comes from the page's API as `etf` (built in lib/etf.js); only pages with
// #etf-panel use it. Shared helpers come from common.js.

(() => {
  const WEEKS = { '6m': 26, '1y': 52, all: Infinity };
  const el = (id) => document.getElementById(id);
  const tile = (label, value, sub) => `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-sub">${sub}</div></div>`;
  // USD millions → "$1.81 พันล้าน" / "$18.1 ล้าน" (no sign; direction is shown by an arrow).
  const money = (m) => {
    const a = Math.abs(m);
    if (a >= 1000) return `$${(a / 1000).toFixed(2)} พันล้าน`;
    return `$${a.toFixed(a >= 100 ? 0 : a >= 1 ? 1 : 2)} ล้าน`;
  };
  const flow = (m) => (m == null ? '–' : m === 0 ? '● ไม่มีเงินเข้าออก' : `<span class="${m > 0 ? 'up' : 'down'}">${m > 0 ? '▲' : '▼'}</span> ${money(m)}`);
  const units = (u, unit) => (u == null ? '' : `≈ ${u >= 0 ? '+' : '−'}${Math.round(Math.abs(u)).toLocaleString('en-US')} ${unit}`);
  const arrow = (v) => (v == null ? '–' : `<span class="${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '▲' : '▼'} ${fmtPct(v)}</span>`);
  const fmtR = (r) => (r == null ? '–' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}`);

  let range = '1y';
  let chart = null;
  let lastData = null;

  function setup(e) {
    el('etf-body').hidden = true;
    el('etf-range').hidden = true;
    el('etf-setup').hidden = false;
    el('etf-asof').textContent = '';
    if (!e.needsKey) {
      el('etf-setup').innerHTML = `<p class="advice">ยังดึงข้อมูล ETF ${esc(e.asset)} ไม่ได้: ${esc(e.error)}</p>
        <p class="note">ถ้าเพิ่งใส่ API key ให้ตรวจว่าคัดลอกมาครบ แล้วรอราว 10 นาทีก่อนกดรีเฟรชอีกครั้ง</p>`;
      return;
    }
    el('etf-setup').innerHTML = `
      <p class="advice"><b>ยังไม่ได้เชื่อมต่อข้อมูล ETF ${esc(e.asset)}</b> — ข้อมูลนี้มาจาก SoSoValue ซึ่งต้องใช้ API key (ฟรี) ทำครั้งเดียว:</p>
      <ol class="etf-steps">
        <li>เปิด <b>sosovalue.com/developer/dashboard</b> สมัครหรือเข้าสู่ระบบ กด <b>Apply your Key</b> กรอกข้อมูล แล้วรอให้อนุมัติ</li>
        <li>เมื่อได้ key แล้ว เปิด Notepad วาง key ลงไป แล้วบันทึกเป็นไฟล์ชื่อ <b>sosovalue-key.txt</b> ในโฟลเดอร์ <b>indicator_btc</b> (โฟลเดอร์เดียวกับ start.bat)</li>
        <li>กดปุ่ม ↻ รีเฟรช ที่หัวเว็บ ไม่ต้องปิดเซิร์ฟเวอร์</li>
      </ol>
      <p class="note">key เก็บอยู่ในเครื่องนี้ และส่งไปที่ SoSoValue เฉพาะตอนขอข้อมูล · ฟรีได้ 100,000 ครั้งต่อเดือน หน้านี้ใช้ไม่ถึงวันละ 10 ครั้ง</p>`;
  }

  function render(d) {
    const panel = el('etf-panel');
    if (!panel) return;
    lastData = d;
    const e = d?.etf;
    panel.hidden = !e;
    if (!e) return;
    for (const node of panel.querySelectorAll('.etf-asset')) node.textContent = e.asset;
    if (!e.recent) { setup(e); return; }
    el('etf-setup').hidden = true;
    el('etf-body').hidden = false;
    el('etf-range').hidden = false;

    const [day, week, month] = e.recent;
    const since = new Date(`${e.cum.since}T00:00:00Z`).getUTCFullYear();
    const rank = month.abovePct >= 50
      ? `มากกว่า ${Math.round(month.abovePct)}% ของทุกช่วง 20 วันตั้งแต่ ETF เปิด`
      : `น้อยกว่า ${Math.round(100 - month.abovePct)}% ของทุกช่วง 20 วันตั้งแต่ ETF เปิด`;
    const dir = month.flowMn > 0 ? 'ไหลเข้าสุทธิ' : month.flowMn < 0 ? 'ไหลออกสุทธิ' : 'ไม่เปลี่ยน';
    el('etf-asof').textContent = `(ข้อมูล ณ ${fmtDate(e.asOf)})`;
    el('etf-summary').innerHTML = `<b>สรุปตอนนี้:</b> 20 วันทำการล่าสุด เงิน ETF ${esc(e.asset)} ${dir} ${money(month.flowMn)} (${rank}) — บอกได้ว่าตอนนี้นักลงทุนในตลาดหุ้นสหรัฐกำลังซื้อหรือขาย แต่ไม่ได้บอกราคาล่วงหน้า`;
    el('etf-stats').innerHTML = [
      tile(`วันล่าสุด (${fmtDate(e.asOf)})`, flow(day.flowMn), units(day.units, e.unit) || 'วันทำการของตลาดหุ้นสหรัฐ'),
      tile('5 วันทำการล่าสุด (≈ 1 สัปดาห์)', flow(week.flowMn), units(week.units, e.unit) || '&nbsp;'),
      tile('20 วันทำการล่าสุด (≈ 1 เดือน)', flow(month.flowMn), `${units(month.units, e.unit)}${e.unit ? ' · ' : ''}${rank}`),
      tile(`สะสมตั้งแต่ ETF เปิด (${fmtDate(e.cum.since)})`, flow(e.cum.flowMn),
        `${e.aumMn != null ? `กองทุนถืออยู่ ${money(e.aumMn)} · ` : e.unit ? `${units(e.cum.units, e.unit)} · ` : ''}ราคา ${esc(e.asset)} ช่วงเดียวกัน ${fmtPct(e.priceSince.pct)} (${fmtUsd(e.priceSince.from)} → ${fmtUsd(e.priceSince.to)})`),
    ].join('');

    // ---------- does it lead the price? ----------
    const ev = e.evidence;
    const outcome = (s) => (s?.n ? `ค่ากลาง · ราคาขึ้น ${Math.round(s.upPct)}% ของครั้ง · ${s.n.toLocaleString('en-US')} วัน` : 'ข้อมูลยังไม่พอ');
    const halves = (x) => `ครึ่งแรกของข้อมูล r = ${fmtR(x.early)} · ครึ่งหลัง r = ${fmtR(x.late)}`;
    const L = ev.lead;
    const flips = L.early != null && L.late != null && Math.sign(L.early) !== Math.sign(L.late);
    const steady = L.all != null && !flips && Math.abs(L.all) >= 0.1;
    const short = ev.months < 24;
    let leadText;
    if (L.all == null) leadText = 'ข้อมูลยังไม่พอ';
    else if (!steady) leadText = `${flips ? 'กลับทิศระหว่างสองช่วง' : 'แทบไม่สัมพันธ์'} ใช้ทำนายราคาไม่ได้`;
    else if (L.all < 0) leadText = `ช่วงที่เงินเข้ามากกลับตามด้วยราคาอ่อนตัว เพราะเงินมักเข้าตอนราคาขึ้นไปแล้ว${short ? ` แต่ข้อมูลมีแค่ราว ${ev.months} เดือน อาจเป็นความบังเอิญ` : ''}`;
    else leadText = `เงินเข้าก่อนราคาขึ้นจริงในอดีต${short ? ` แต่ข้อมูลมีแค่ราว ${ev.months} เดือน ยังเชื่อไม่ได้` : ''}`;
    const S = ev.same.all;
    const together = S == null ? 'ข้อมูลยังไม่พอ' : S >= 0.4 ? 'ไปด้วยกันชัดเจน' : S >= 0.2 ? 'ไปด้วยกันพอสมควร' : 'แทบไม่สัมพันธ์';
    const follows = ev.follow.early > 0.15 && ev.follow.late > 0.15;
    el('etf-since').textContent = `(${fmtDate(ev.from)} – ${fmtDate(ev.to)} · ราว ${ev.months} เดือน)`;
    el('etf-evidence').innerHTML = [
      tile(`หลังช่วง ${ev.window} วันที่เงินเข้ามากสุด 1 ใน 3 → ราคา ${ev.window} วันทำการถัดไป`, arrow(ev.high.median), outcome(ev.high)),
      tile(`หลังช่วง ${ev.window} วันที่เงินเข้าน้อยสุดหรือไหลออก 1 ใน 3 → ราคา ${ev.window} วันทำการถัดไป`, arrow(ev.low.median), outcome(ev.low)),
      tile('เงิน ETF นำราคาไหม', `r = ${fmtR(L.all)}`, `${halves(L)} → ${leadText}`),
      tile('เงิน ETF ไปพร้อมราคา หรือตามหลังราคา', `r = ${fmtR(S)}`, `เงินเข้าออกกับราคาในช่วง ${ev.window} วันเดียวกัน → ${together} · ราคาขึ้นก่อนแล้วเงินเข้าตามใน ${ev.window} วันถัดมา r = ${fmtR(ev.follow.all)} (${halves(ev.follow)}${follows ? '' : ' → ไม่คงที่'})`),
    ].join('');
    el('etf-note').innerHTML = [
      `* เงินเข้าออกสุทธิของ ETF แบบถือเหรียญจริง (spot) ทุกกองในสหรัฐรวมกัน จาก ${esc(e.source)}${e.unit ? ` เป็นหน่วย ${esc(e.unit)} แปลงเป็นดอลลาร์ด้วยราคาปิดของวันนั้น · แหล่งนี้มักอัปเดตช้ากว่าวันทำการล่าสุด 1 วัน` : ''}`,
      'หลักฐานไม่นับ 10 วันทำการแรกหลัง ETF เปิด (เงินตั้งต้นของผู้ออกกองทุน) และวัดแบบช่วงซ้อนกันทุกวัน',
      'r คือค่าความสัมพันธ์เชิงอันดับ: 0 = ไม่สัมพันธ์, +1 = ไปทางเดียวกันทุกครั้ง, −1 = สวนทางกันทุกครั้ง',
      short ? `<b>ข้อมูลมีแค่ราว ${ev.months} เดือน ตัวเลขยังเปลี่ยนได้มากเมื่อมีข้อมูลเพิ่ม</b>` : '',
      'ไม่นำไปคิดคะแนน เพราะทดสอบแล้วเงิน ETF วิ่งตามราคา ไม่ได้นำราคา',
    ].filter(Boolean).join(' · ');

    renderChart(e.chart, e.asset);
  }

  function renderChart(ch, asset) {
    if (!window.Chart) return;
    const n = ch.dates.length;
    const s = Math.max(0, n - WEEKS[range]);
    const opts = baseOptions(range === 'all' && n > 104 ? 'all' : 'short');
    opts.plugins.tooltip.callbacks = {
      title: (items) => `สัปดาห์ที่จบวันที่ ${fmtDate(items[0].label)}`,
      label: (item) => (item.dataset.yAxisID === 'price'
        ? ` ราคา ${asset}: ${fmtUsd(item.raw)}`
        : ` ${item.raw >= 0 ? 'เงินเข้า' : 'เงินออก'}สุทธิ: ${money(item.raw)}`),
    };
    opts.scales.y = {
      position: 'right',
      grid: { color: cssVar('--grid') },
      border: { display: false },
      ticks: { color: cssVar('--muted'), maxTicksLimit: 6, callback: (v) => `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US')}` },
    };
    // Bar charts start value axes at zero; the price line needs its own range.
    opts.scales.price = {
      position: 'left',
      beginAtZero: false,
      grid: { display: false },
      border: { display: false },
      ticks: { color: cssVar('--muted'), maxTicksLimit: 6, callback: (v) => (v >= 1000 ? `$${(v / 1000).toLocaleString('en-US')}k` : fmtUsd(v)) },
    };
    const up = cssVar('--up');
    const down = cssVar('--down');
    const flows = ch.flowMn.slice(s);
    if (chart) chart.destroy();
    chart = new Chart(el('chart-etf'), {
      type: 'bar',
      data: {
        labels: ch.dates.slice(s),
        datasets: [
          { type: 'line', label: 'ราคา', yAxisID: 'price', data: ch.price.slice(s), order: 0, ...lineStyle(cssVar('--price'), 1.5) },
          { label: 'เงินเข้าออกสุทธิ', yAxisID: 'y', data: flows, order: 1, backgroundColor: flows.map((v) => (v >= 0 ? up : down)), borderRadius: 2, maxBarThickness: 14 },
        ],
      },
      options: opts,
      plugins: [baselineAt(0), crosshair],
    });
  }

  function initRange() {
    const seg = el('etf-range');
    if (!seg || seg.dataset.bound) return;
    seg.dataset.bound = '1';
    seg.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-v]');
      if (!btn) return;
      range = btn.dataset.v;
      for (const b of seg.querySelectorAll('button')) b.classList.toggle('on', b === btn);
      if (lastData?.etf?.chart) renderChart(lastData.etf.chart, lastData.etf.asset);
    });
  }

  window.renderEtf = (d) => { initRange(); render(d); };
})();
