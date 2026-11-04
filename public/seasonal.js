'use strict';
// Same window, every year: the user picks a start and an end day (month + day),
// and the page lists how BTC moved over that window in each year, with the
// window's typical result set against every other window of the same length.
// Runs client-side on the daily history from the page's API; only pages with
// #season-panel use it. Shared helpers come from common.js.

(() => {
  const DAY_MS = 86400000;
  const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  const DEFAULT = { m1: 12, d1: 15, m2: 12, d2: 31 };
  const STORE_KEY = 'season-window';

  const el = (id) => document.getElementById(id);
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const pct = (v, d = 1) => (v == null ? '–' : fmtPct(v * 100, d));
  const signed = (v) => (v == null ? '–' : `<span class="${v > 0 ? 'up' : v < 0 ? 'down' : ''}">${pct(v)}</span>`);
  const median = (v) => {
    const s = [...v].sort((a, b) => a - b);
    return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const tile = (label, value, sub) => `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-sub">${sub}</div></div>`;
  const dayLabel = (m, d) => `${d} ${MONTHS[m - 1]}`;

  let win = { ...DEFAULT };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved && [saved.m1, saved.d1, saved.m2, saved.d2].every(Number.isInteger)) win = saved;
  } catch { /* nothing saved, or storage blocked: use the default */ }

  let chart = null;
  let lastData = null;

  // Day d of month m in year y; days past the month's end (31 Feb) become its last day.
  const dateOf = (y, m, d) => Date.UTC(y, m - 1, Math.min(d, new Date(Date.UTC(y, m, 0)).getUTCDate()));
  const wraps = () => win.m2 < win.m1 || (win.m2 === win.m1 && win.d2 < win.d1);

  // One row per year whose window has started: change from the close before the
  // first day to the close of the last day (or the latest close, if unfinished).
  function windows(h, index) {
    const out = [];
    const firstYear = Number(h.dates[0].slice(0, 4));
    const lastDate = h.dates[h.dates.length - 1];
    for (let y = firstYear; y <= Number(lastDate.slice(0, 4)); y++) {
      const start = dateOf(y, win.m1, win.d1);
      const end = dateOf(y + (wraps() ? 1 : 0), win.m2, win.d2);
      const a = index.get(iso(start - DAY_MS));
      if (a == null) continue;
      const done = iso(end) <= lastDate;
      const b = done ? index.get(iso(end)) : h.dates.length - 1;
      if (b == null || b <= a) continue;
      let low = 0;
      for (let i = a + 1; i <= b; i++) low = Math.min(low, h.price[i] / h.price[a] - 1);
      out.push({ year: y, start, end, from: h.price[a], to: h.price[b], change: h.price[b] / h.price[a] - 1, low, lth: h.lth[a + 1], done });
    }
    return out;
  }

  // Every window of the same length, starting on each day of the year: their
  // medians across years show what "normal" looks like for this length.
  function sameLength(h, index, len) {
    const medians = [];
    const upShares = [];
    const firstYear = Number(h.dates[0].slice(0, 4));
    const lastYear = Number(h.dates[h.dates.length - 1].slice(0, 4));
    for (let k = 0; k < 365; k++) {
      const v = [];
      for (let y = firstYear; y <= lastYear; y++) {
        const s = Date.UTC(y, 0, 1) + k * DAY_MS;
        const a = index.get(iso(s - DAY_MS));
        const b = index.get(iso(s + (len - 1) * DAY_MS));
        if (a != null && b != null) v.push(h.price[b] / h.price[a] - 1);
      }
      if (v.length >= 5) {
        medians.push(median(v));
        upShares.push(v.filter((x) => x > 0).length / v.length);
      }
    }
    return { medians, upShare: median(upShares), median: median(medians) };
  }

  function initControls() {
    if (el('season-m1').options.length) return;
    for (const id of ['season-d1', 'season-d2']) {
      for (let d = 1; d <= 31; d++) el(id).add(new Option(String(d), String(d)));
    }
    for (const id of ['season-m1', 'season-m2']) {
      MONTHS.forEach((m, i) => el(id).add(new Option(m, String(i + 1))));
    }
    syncControls();
    for (const id of ['season-d1', 'season-m1', 'season-d2', 'season-m2']) {
      el(id).addEventListener('change', () => {
        win = { m1: +el('season-m1').value, d1: +el('season-d1').value, m2: +el('season-m2').value, d2: +el('season-d2').value };
        save();
        rerender();
      });
    }
    el('season-preset').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-v]');
      if (!btn) return;
      const [m1, d1, m2, d2] = btn.dataset.v.split(/[-_]/).map(Number);
      win = { m1, d1, m2, d2 };
      save();
      syncControls();
      rerender();
    });
  }

  function syncControls() {
    el('season-m1').value = win.m1;
    el('season-d1').value = win.d1;
    el('season-m2').value = win.m2;
    el('season-d2').value = win.d2;
    const key = `${win.m1}-${win.d1}_${win.m2}-${win.d2}`;
    for (const b of el('season-preset').querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === key);
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(win)); } catch { /* not remembered: fine */ }
    syncControls();
  }

  function render(d) {
    if (!el('season-panel') || !d?.history) return;
    lastData = d;
    initControls();
    const h = d.history;
    const index = new Map(h.dates.map((x, i) => [x, i]));
    const rows = windows(h, index);
    const done = rows.filter((r) => r.done);
    const running = rows.find((r) => !r.done);
    if (!done.length) {
      el('season-stats').innerHTML = '';
      el('season-table').innerHTML = '<p class="skeleton">ยังไม่มีปีไหนที่ช่วงนี้จบครบ</p>';
      return;
    }
    const len = Math.round((done[0].end - done[0].start) / DAY_MS) + 1;
    const changes = done.map((r) => r.change);
    const up = changes.filter((v) => v > 0).length;
    const best = done.reduce((a, b) => (b.change > a.change ? b : a));
    const worst = done.reduce((a, b) => (b.change < a.change ? b : a));
    const mid = median(changes);
    const mean = changes.reduce((a, b) => a + b, 0) / changes.length;

    el('season-period').textContent = `(${dayLabel(win.m1, win.d1)} → ${dayLabel(win.m2, win.d2)}${wraps() ? ' ปีถัดไป' : ''} · ${len} วัน · ${done.length} ปี)`;
    // The window under way right now, or else the latest finished one and when the next starts.
    const latest = done[done.length - 1];
    const now = running
      ? tile(`ตอนนี้อยู่ในช่วงนี้ (${running.year})`, signed(running.change), `ผ่านมา ${Math.round((Date.parse(h.dates[h.dates.length - 1]) - running.start) / DAY_MS) + 1} จาก ${len} วัน · ราคาเริ่ม ${fmtUsd(running.from)}`)
      : tile(`ครั้งล่าสุด (${latest.year})`, signed(latest.change), `ครั้งถัดไปเริ่ม ${dayLabel(win.m1, win.d1)} ${latest.year + 1}`);
    el('season-stats').innerHTML = [
      tile('ขึ้นกี่ปี', `${up} / ${done.length} ปี`, `ลง ${done.length - up} ปี`),
      tile('ค่ากลาง', signed(mid), 'ครึ่งหนึ่งของปีดีกว่านี้ อีกครึ่งแย่กว่า'),
      tile('ค่าเฉลี่ย', signed(mean), 'ปีที่ขึ้นหรือลงแรงดึงค่าเฉลี่ยได้มาก'),
      tile('ดีสุด / แย่สุด', `${signed(best.change)} / ${signed(worst.change)}`, `ปี ${best.year} / ปี ${worst.year}`),
      now,
    ].join('');

    // Is this window unusual, or would a window of the same length starting on
    // any other day look about the same?
    const base = sameLength(h, index, len);
    const worse = base.medians.filter((m) => m > mid).length / base.medians.length;
    const rank = mid < base.median
      ? `ค่ากลางของช่วงที่เลือก<b>แย่กว่า ${Math.round(worse * 100)}%</b> ของช่วงอื่น`
      : `ค่ากลางของช่วงที่เลือก<b>ดีกว่า ${Math.round((1 - worse) * 100)}%</b> ของช่วงอื่น`;
    el('season-compare').innerHTML = `เทียบช่วงยาว ${len} วันเท่ากันที่เริ่มวันอื่นของปี: ปกติค่ากลาง ${signed(base.median)} และขึ้นราว ${Math.round(base.upShare * 100)}% ของปี — ${rank} · ข้อมูลมีแค่ ${done.length} ปี ถ้าลองหาหลายช่วงจะเจอช่วงที่ดูขึ้นหรือลงเกือบทุกปีได้เองโดยบังเอิญ`;

    const sorted = [...rows].sort((a, b) => b.year - a.year);
    el('season-table').innerHTML = `<table class="lined">
      <thead><tr><th>ปี</th><th class="num">ราคาเริ่ม</th><th class="num">ราคาสิ้นสุด</th><th class="num">เปลี่ยนแปลง</th><th class="num">ลงลึกสุดระหว่างช่วง</th><th class="num">คะแนน LTH ตอนเริ่ม</th></tr></thead>
      <tbody>${sorted.map((r) => `<tr${r.done ? '' : ' class="now"'}>
        <td>${r.year}${wraps() ? `–${String(r.year + 1).slice(2)}` : ''}${r.done ? '' : ' <span class="pill tone-neutral"><i></i>ยังไม่จบ</span>'}</td>
        <td class="num">${fmtUsd(r.from)}</td>
        <td class="num">${fmtUsd(r.to)}</td>
        <td class="num">${signed(r.change)}</td>
        <td class="num">${r.low < 0 ? signed(r.low) : '–'}</td>
        <td class="num">${r.lth == null ? '–' : Math.round(r.lth)}</td>
      </tr>`).join('')}</tbody></table>`;

    renderChart(rows);
  }

  function renderChart(rows) {
    if (!window.Chart) return;
    if (chart) chart.destroy();
    const up = cssVar('--up');
    const down = cssVar('--down');
    const opts = {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltipStyle(),
          callbacks: {
            title: (items) => `ปี ${items[0].label}${rows[items[0].dataIndex].done ? '' : ' (ยังไม่จบ)'}`,
            label: (item) => ` ${pct(item.raw / 100)}`,
          },
        },
      },
      scales: {
        x: { grid: { display: false }, border: { color: cssVar('--axis') }, ticks: { color: cssVar('--muted') } },
        y: {
          position: 'right',
          grid: { color: cssVar('--grid') },
          border: { display: false },
          ticks: { color: cssVar('--muted'), callback: (v) => `${v}%` },
        },
      },
    };
    chart = new Chart(el('chart-season'), {
      type: 'bar',
      data: {
        labels: rows.map((r) => String(r.year)),
        datasets: [{
          data: rows.map((r) => Math.round(r.change * 1000) / 10),
          backgroundColor: rows.map((r) => (r.done ? (r.change >= 0 ? up : down) : cssVar('--axis'))),
          borderRadius: 3,
          maxBarThickness: 36,
        }],
      },
      options: opts,
      plugins: [baselineAt(0)],
    });
  }

  const rerender = () => lastData && render(lastData);
  window.renderSeason = render;
})();
