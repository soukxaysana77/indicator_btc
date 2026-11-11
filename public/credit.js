'use strict';
// "ความเครียดหุ้นกู้ขยะ" block in the Macro panel (built in lib/credit.js): the
// CCC and all-high-yield spreads, where they sit in their 3-year record, and
// the test of whether they move with BTC or ahead of it. Display only.
// Only pages with #credit-wrap use it. Shared helpers come from common.js.

(() => {
  const el = (id) => document.getElementById(id);
  const TH_MONTH_YEAR = new Intl.DateTimeFormat('th-TH-u-ca-gregory', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const monthYear = (d) => TH_MONTH_YEAR.format(Date.parse(`${d}T00:00:00Z`));
  const tile = (label, value, sub) => `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-sub">${sub}</div></div>`;
  const pctPt = (v) => (v == null ? '–' : `${v.toFixed(2)}%`);
  // A wider spread is worse news, so up is red here.
  const chg = (v) => (v == null ? '–' : `<span class="${v > 0 ? 'down' : v < 0 ? 'up' : ''}">${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)} จุด</span>`);
  const fmtR = (r) => (r == null ? '–' : `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)}`);
  const WINDOW_TEXT = { 182: '6 เดือน', 365: '1 ปี', 730: '2 ปี' };

  let chart = null;

  function render(d) {
    const wrap = el('credit-wrap');
    if (!wrap) return;
    const cr = d?.credit;
    wrap.hidden = !cr;
    if (!cr) return;
    const { ccc, hy } = cr;
    const since = monthYear(cr.since);

    el('credit-asof').textContent = `(ข้อมูล ณ ${fmtDate(cr.asOf)})`;

    // Where today's spreads sit in their record.
    const high = (x) => x && x.pct >= 80;
    let level;
    if (high(ccc) && high(hy)) level = `ตึงเครียดทั้งตลาด — ส่วนต่าง CCC สูงกว่า ${Math.round(ccc.pct)}% ของวันตั้งแต่ ${since} และทั้งตลาดก็สูงกว่า ${Math.round(hy.pct)}%`;
    else if (high(ccc)) level = `ความเครียดกระจุกอยู่ที่บริษัทอ่อนแอที่สุด — ส่วนต่าง CCC สูงกว่า ${Math.round(ccc.pct)}% ของวันตั้งแต่ ${since} แต่ทั้งตลาดยังอยู่กลางกรอบ${hy ? ` (สูงกว่า ${Math.round(hy.pct)}% ของวัน)` : ''}`;
    else if (ccc.pct <= 20) level = `ผ่อนคลาย — ส่วนต่าง CCC ต่ำกว่า ${Math.round(100 - ccc.pct)}% ของวันตั้งแต่ ${since}`;
    else level = `อยู่ในกรอบปกติของช่วงที่มีข้อมูล (ส่วนต่าง CCC สูงกว่า ${Math.round(ccc.pct)}% ของวันตั้งแต่ ${since})`;
    const trend = ccc.ch3m == null ? '' : ccc.ch3m > 0.5 ? ` · CCC กว้างขึ้น ${chg(ccc.ch3m)} ใน 3 เดือน` : ccc.ch3m < -0.5 ? ` · CCC แคบลง ${chg(ccc.ch3m)} ใน 3 เดือน` : ' · CCC แทบไม่เปลี่ยนใน 3 เดือน';
    el('credit-summary').innerHTML = `<b>สรุปตอนนี้:</b> ${level}${trend} · ใช้ดูว่าตลาดกำลังเครียดแค่ไหน แต่ไม่ได้บอกราคา BTC ล่วงหน้า`;

    const spreadTile = (label, x) => tile(label, pctPt(x.last), `3 เดือน ${chg(x.ch3m)} · 1 เดือน ${chg(x.ch1m)} · สูงกว่า ${Math.round(x.pct)}% ของวันตั้งแต่ ${since} · ต่ำสุด ${pctPt(x.min.v)} (${fmtDate(x.min.d)}) สูงสุด ${pctPt(x.max.v)} (${fmtDate(x.max.d)})`);
    const same = ccc.changeCorr.same.r;
    const lead = ccc.changeCorr.next13.r;
    const leadAll = [ccc.changeCorr.next4.r, lead, hy?.changeCorr.next4.r, hy?.changeCorr.next13.r].filter((r) => r != null);
    const leads = leadAll.some((r) => Math.abs(r) >= 0.2);
    el('credit-stats').innerHTML = [
      spreadTile('ส่วนต่าง CCC (บริษัทเครดิตต่ำสุด)', ccc),
      hy ? spreadTile('ส่วนต่าง High Yield ทั้งตลาด', hy) : '',
      tile('ขยับพร้อม BTC ไหม (13 สัปดาห์เดียวกัน)', `r = ${fmtR(same)}`, `CCC ${fmtR(same)}${hy ? ` · ทั้งตลาด ${fmtR(hy.changeCorr.same.r)}` : ''} → ${same != null && same <= -0.25 ? 'ส่วนต่างมักกว้างขึ้นในช่วงเดียวกับที่ BTC ลง (และแคบลงตอน BTC ขึ้น)' : 'ความสัมพันธ์อ่อน'}`),
      tile('บอก BTC ล่วงหน้าไหม', `r = ${fmtR(lead)}`, `เทียบกับ BTC 4 สัปดาห์ถัดไป ${fmtR(ccc.changeCorr.next4.r)} · 13 สัปดาห์ถัดไป ${fmtR(lead)}${hy ? ` (ทั้งตลาด ${fmtR(hy.changeCorr.next4.r)} / ${fmtR(hy.changeCorr.next13.r)})` : ''} → ${leads ? 'มีความสัมพันธ์บ้าง แต่ข้อมูลมีแค่ราว 3 ปี' : 'แทบเป็น 0 ใช้ทำนายราคาไม่ได้'}`),
    ].join('');

    const windows = ccc.levelCorr.map((w) => `${w.days ? WINDOW_TEXT[w.days] : `ทั้งหมด (ตั้งแต่ ${since})`} ${fmtR(w.r)}`).join(' · ');
    const rs = ccc.levelCorr.map((w) => w.r).filter((r) => r != null);
    const flips = rs.some((r) => r > 0.1) && rs.some((r) => r < -0.1);
    el('credit-note').innerHTML = `* <b>ส่วนต่าง</b> = ดอกเบี้ยที่หุ้นกู้ต้องจ่ายเกินพันธบัตรรัฐบาลสหรัฐ (ICE BofA option-adjusted spread จาก FRED) ยิ่งกว้าง = นักลงทุนกลัวบริษัทผิดนัดชำระหนี้มากขึ้น · <b>CCC</b> = กลุ่มเครดิตต่ำสุด มักตึงก่อนและแรงกว่าทั้งตลาด ·
      <b>เรื่อง "สัมพันธ์ 77%"</b>: ค่าสัมพันธ์ระหว่างระดับ CCC กับราคา BTC เปลี่ยนไปตามช่วงที่วัด — ${windows}${flips ? ' เครื่องหมายกลับข้างได้ด้วย' : ''} ตัวเลขแบบนี้จึงขึ้นกับว่าเลือกช่วงไหน ·
      r ในกล่องด้านบนคิดจากการเปลี่ยนแปลง 13 สัปดาห์ เก็บตัวอย่างสัปดาห์ละครั้ง · FRED เก็บข้อมูลนี้ย้อนหลังแค่ราว 3 ปี ผลทดสอบจึงมาจากช่วงสั้น คำนวณใหม่ทุกครั้งที่ข้อมูลอัปเดต · ข้อมูลประกอบ ไม่ได้คิดในคะแนน`;

    renderChart(cr);
  }

  function renderChart(cr) {
    if (!window.Chart) return;
    if (chart) chart.destroy();
    const ch = cr.chart;
    const opts = baseOptions('short');
    opts.scales.x.ticks.maxTicksLimit = 7;
    opts.scales.y = {
      position: 'left',
      grid: { color: cssVar('--grid') },
      border: { display: false },
      ticks: { color: cssVar('--muted'), callback: (v) => `${v}%` },
    };
    opts.scales.y1 = { ...logPriceAxis(), grid: { display: false } };
    opts.plugins.tooltip.callbacks.label = (item) => (item.dataset.yAxisID === 'y1'
      ? ` ราคา BTC: ${fmtUsd(item.parsed.y)}`
      : ` ${item.dataset.label}: ${pctPt(item.parsed.y)}`);
    chart = new Chart(el('chart-credit'), {
      type: 'line',
      data: {
        labels: ch.dates,
        datasets: [
          { label: 'ส่วนต่าง CCC', data: ch.ccc, yAxisID: 'y', ...lineStyle(cssVar('--down')) },
          { label: 'ส่วนต่าง High Yield ทั้งตลาด', data: ch.hy, yAxisID: 'y', ...lineStyle(cssVar('--z-sell')) },
          { label: 'ราคา BTC', data: ch.btc, yAxisID: 'y1', ...lineStyle(cssVar('--price'), 1.25) },
        ],
      },
      options: opts,
      plugins: [crosshair],
    });
  }

  window.renderCredit = render;
})();
