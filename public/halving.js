'use strict';
// "Halving ทุก ~4 ปี" panel on the BTC page: the countdown and block reward come
// from the API (lib/halving.js); each cycle's top and bottom are found here from
// the page's daily history. Only pages with #halving-panel use it. Shared helpers
// come from common.js.
//
// Checked on 2026-11-07 data: tops came 371–546 days after a halving and the
// lows after them 777–924 days after (−77% to −85%), but there are only three
// finished cycles and each rose far less than the one before (×92, ×30, ×7.9,
// this one ×1.9 so far). The panel states where today falls against that, with
// the caveats, and makes no call. All figures are recomputed on every load.

(() => {
  const el = (id) => document.getElementById(id);
  const DAY_MS = 86400000;
  const PEAK_WITHIN = 730; // a cycle's top = highest close in the 2 years after its halving
  const SPAN = 1460; // days shown on the chart (one cycle is about 4 years)
  const TH_MONTH_YEAR = new Intl.DateTimeFormat('th-TH-u-ca-gregory', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const COLORS = ['--z-neutral', '--macro', '--lth', '--accent']; // oldest → newest cycle

  const ms = (d) => Date.parse(`${d}T00:00:00Z`);
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const daysBetweenIso = (a, b) => Math.round((ms(b) - ms(a)) / DAY_MS);
  const signed = (v, d = 0) => (v == null ? '–' : `<span class="${v >= 0 ? 'up' : 'down'}">${fmtPct(v * 100, d)}</span>`);
  const times = (v) => (v == null ? '–' : `×${v >= 10 ? Math.round(v) : v.toFixed(v >= 2 ? 1 : 2)}`);
  const tile = (label, value, sub) => `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-sub">${sub}</div></div>`;
  const range = (xs, f = (v) => v) => (Math.min(...xs) === Math.max(...xs) ? f(xs[0]) : `${f(Math.min(...xs))}–${f(Math.max(...xs))}`);

  let chart = null;

  // One entry per halving inside the history: its top, the low after the top,
  // and how things stood `nowDay` days in (today's place in the current cycle).
  function cycles(h, past, nowDay) {
    const index = new Map(h.dates.map((x, i) => [x, i]));
    const lastI = h.dates.length - 1;
    const out = [];
    past.forEach((p, k) => {
      const a = index.get(p.date);
      if (a == null) return;
      const next = past[k + 1] && index.get(past[k + 1].date);
      const end = next != null ? next - 1 : lastI;
      const day = (i) => daysBetweenIso(p.date, h.dates[i]);
      const p0 = h.price[a];
      let top = a;
      for (let i = a; i <= end && day(i) <= PEAK_WITHIN; i++) if (h.price[i] > h.price[top]) top = i;
      let low = top;
      for (let i = top; i <= end; i++) if (h.price[i] < h.price[low]) low = i;
      // The same day count as today, with the high reached by then.
      const iN = index.get(iso(ms(p.date) + nowDay * DAY_MS));
      let at = null;
      if (iN != null && iN <= end) {
        let high = a;
        for (let i = a; i <= iN; i++) if (h.price[i] > h.price[high]) high = i;
        const iY = index.get(iso(ms(h.dates[iN]) + 365 * DAY_MS));
        at = { date: h.dates[iN], price: h.price[iN], fromHigh: h.price[iN] / h.price[high] - 1, lth: h.lth[iN], year: iY == null ? null : h.price[iY] / h.price[iN] - 1 };
      }
      const series = [];
      for (let i = a; i <= end && day(i) <= SPAN; i++) series.push({ x: day(i), y: h.price[i] / p0, p: h.price[i], d: h.dates[i] });
      out.push({
        ...p,
        year: p.date.slice(0, 4),
        done: next != null,
        p0,
        top: { date: h.dates[top], day: day(top), price: h.price[top], times: h.price[top] / p0, final: next != null || day(lastI) > PEAK_WITHIN },
        low: { date: h.dates[low], day: day(low), price: h.price[low], fromTop: h.price[low] / h.price[top] - 1 },
        at,
        series,
      });
    });
    return out;
  }

  function render(d) {
    const panel = el('halving-panel');
    if (!panel) return;
    const hv = d?.halving;
    const h = d?.history;
    panel.hidden = !hv || !h?.dates?.length;
    if (panel.hidden) return;
    const lastDay = h.dates[h.dates.length - 1];
    const latest = hv.past[hv.past.length - 1];
    const nowDay = daysBetweenIso(latest.date, lastDay);
    const all = cycles(h, hv.past, nowDay);
    const cur = all.find((c) => !c.done);
    const done = all.filter((c) => c.done);
    const cycleDays = Math.max(nowDay + 1, daysBetweenIso(latest.date, hv.next.date));

    el('halving-asof').textContent = `(บล็อก ${hv.height.toLocaleString('en-US')}${hv.heightSource ? '' : ' โดยประมาณ'})`;
    el('halving-stats').innerHTML = [
      tile(`Halving ล่าสุด (ครั้งที่ ${latest.n})`, fmtDate(latest.date), `ผ่านมา ${nowDay.toLocaleString('en-US')} วัน (≈ ${(nowDay / 365.25).toFixed(1)} ปี) · รางวัล ${latest.from} → ${latest.to} BTC`),
      tile(`Halving ครั้งถัดไป (ครั้งที่ ${hv.next.n}, ประมาณ)`, `≈ ${TH_MONTH_YEAR.format(ms(hv.next.date))}`, `อีกราว ${hv.next.daysLeft.toLocaleString('en-US')} วัน · อีก ${hv.next.blocksLeft.toLocaleString('en-US')} บล็อก (ถึงบล็อก ${hv.next.height.toLocaleString('en-US')})`),
      tile('รางวัลต่อบล็อกตอนนี้', `${hv.reward} BTC`, `ครั้งถัดไปเหลือ ${hv.next.to} BTC · BTC ใหม่ราว ${hv.perDay.toLocaleString('en-US')} เหรียญต่อวัน`),
      tile('ขุดออกมาแล้ว', `${(hv.mined / 1e6).toFixed(2)} ล้าน BTC`, `${hv.minedPct}% ของ 21 ล้าน · เหรียญเพิ่มปีละราว ${hv.inflationPct}%`),
    ].join('');

    // Where today sits in the cycle, against the days past cycles topped and bottomed.
    const pos = (day) => `${Math.min(100, (day / cycleDays) * 100).toFixed(2)}%`;
    const tops = done.map((c) => c.top.day);
    const lows = done.map((c) => c.low.day);
    const nowPct = (nowDay / cycleDays) * 100;
    const zone = (cls, xs, label) => (xs.length ? `<span class="hv-zone ${cls}" style="left:${pos(Math.min(...xs))};width:${pos(Math.max(...xs) - Math.min(...xs) + 6)}" title="${label}"></span>` : '');
    el('halving-clock').innerHTML = `
      <div class="hv-track" role="img" aria-label="วันนี้อยู่วันที่ ${nowDay} จากราว ${cycleDays} วันของรอบ halving">
        <span class="hv-done" style="width:${pos(nowDay)}"></span>
        ${zone('top', tops, `รอบก่อน ๆ ทำยอดวันที่ ${range(tops)}`)}
        ${zone('low', lows, `รอบก่อน ๆ ทำจุดต่ำสุดวันที่ ${range(lows)}`)}
        <span class="hv-now${nowPct > 85 ? ' end' : nowPct < 15 ? ' start' : ''}" style="left:${pos(nowDay)}"><b>วันนี้ · วันที่ ${nowDay.toLocaleString('en-US')}</b></span>
      </div>
      <div class="hv-ends"><span>Halving ครั้งที่ ${latest.n} · ${fmtDate(latest.date)}</span><span>${Math.round(nowPct)}% ของรอบ</span><span>ครั้งที่ ${hv.next.n} · ≈ ${TH_MONTH_YEAR.format(ms(hv.next.date))}</span></div>
      <div class="hv-legend">
        ${tops.length ? `<span><i class="top"></i>ช่วงที่รอบก่อน ๆ ทำยอด (วันที่ ${range(tops)} หลัง halving)</span>` : ''}
        ${lows.length ? `<span><i class="low"></i>ช่วงที่รอบก่อน ๆ ลงไปต่ำสุด (วันที่ ${range(lows)})</span>` : ''}
      </div>`;

    // One-paragraph read of the same facts.
    let where = '';
    if (lows.length && tops.length) {
      if (nowDay > Math.max(...lows)) where = 'เลยช่วงวันที่รอบก่อน ๆ ลงไปต่ำสุดมาแล้ว';
      else if (nowDay >= Math.min(...lows)) where = 'อยู่ในช่วงวันที่รอบก่อน ๆ ลงไปต่ำสุด';
      else if (nowDay > Math.max(...tops)) where = 'อยู่ระหว่างช่วงยอดกับช่วงต่ำสุดของรอบก่อน ๆ';
      else if (nowDay >= Math.min(...tops)) where = 'อยู่ในช่วงที่รอบก่อน ๆ ทำยอด';
      else where = 'ยังไม่ถึงช่วงที่รอบก่อน ๆ ทำยอด';
    }
    const curText = cur
      ? ` · <b>รอบนี้</b> ยอด${cur.top.final ? '' : 'ถึงตอนนี้'} ${fmtUsd(cur.top.price)} (${fmtDate(cur.top.date)}, วันที่ ${cur.top.day}, ${times(cur.top.times)} จากราคาวัน halving)${cur.low.day > cur.top.day ? ` แล้วลงไปต่ำสุด ${fmtUsd(cur.low.price)} (${fmtDate(cur.low.date)}, วันที่ ${cur.low.day}, ${signed(cur.low.fromTop)})` : ''} ตอนนี้ ${fmtUsd(h.price[h.price.length - 1])}`
      : '';
    const falls = done.map((c) => Math.round(-c.low.fromTop * 100));
    el('halving-summary').innerHTML = done.length
      ? `ตอนนี้วันที่ <b>${nowDay.toLocaleString('en-US')}</b> หลัง halving ครั้งที่ ${latest.n} — ${where} · <b>${done.length} รอบที่จบแล้ว</b> ยอดมาวันที่ ${range(tops)} แล้วลงไปต่ำสุดวันที่ ${range(lows)} (ลง ${range(falls)}% จากยอด)${curText}`
      : '';

    renderTable(all, nowDay);
    renderNote(hv, done, cur);
    renderChart(all, nowDay, tops, lows);
  }

  function renderTable(all, nowDay) {
    const rows = [...all].reverse();
    el('halving-table').innerHTML = `<table class="lined hv-table">
      <thead><tr><th>รอบ</th><th class="num">ยอดของรอบ</th><th class="num">ต่ำสุดหลังยอด</th><th class="num" title="วันที่เท่ากับวันนี้ของรอบนั้น: ห่างจากยอดที่ทำไว้ถึงวันนั้น และคะแนน LTH วันนั้น">วันที่ ${nowDay.toLocaleString('en-US')} ของรอบ</th><th class="num" title="ราคาเปลี่ยนไปเท่าไรใน 1 ปีหลังจากวันที่เท่ากับวันนี้">1 ปีต่อมา</th></tr></thead>
      <tbody>${rows.map((c) => `<tr${c.done ? '' : ' class="now"'}>
        <td>ครั้งที่ ${c.n} · ${fmtDate(c.date)}${c.done ? '' : ' <span class="pill tone-neutral"><i></i>รอบนี้</span>'}<div class="coin-name">ราคาวัน halving ${fmtUsd(c.p0)} · รางวัล ${c.from} → ${c.to}</div></td>
        <td class="num">${fmtUsd(c.top.price)}<div class="coin-name">วันที่ ${c.top.day} · ${times(c.top.times)}${c.top.final ? '' : ' (ถึงตอนนี้)'}</div></td>
        <td class="num">${c.low.day > c.top.day ? `${fmtUsd(c.low.price)}<div class="coin-name">วันที่ ${c.low.day} · ${signed(c.low.fromTop)}${c.done ? '' : ' (ถึงตอนนี้)'}</div>` : '–'}</td>
        <td class="num">${c.at ? `${signed(c.at.fromHigh)} จากยอด<div class="coin-name">${fmtUsd(c.at.price)} · LTH ${c.at.lth == null ? '–' : Math.round(c.at.lth)}</div>` : '–'}</td>
        <td class="num">${c.done ? (c.at?.year == null ? '–' : signed(c.at.year)) : '<span class="coin-name">ยังไม่ถึง</span>'}</td>
      </tr>`).join('')}</tbody></table>`;
  }

  function renderNote(hv, done, cur) {
    const growth = [...done, cur].filter(Boolean).map((c) => `${times(c.top.times)}${c.done ? '' : ' (รอบนี้)'}`).join(' → ');
    const height = hv.heightSource
      ? `ความสูงบล็อก ${hv.height.toLocaleString('en-US')} จาก ${esc(hv.heightSource)} (${fmtTime(hv.heightAt)}) เฉลี่ย ${hv.minutesPerBlock} นาทีต่อบล็อกตั้งแต่ halving ล่าสุด`
      : 'ยังดึงความสูงบล็อกล่าสุดไม่ได้ จึงประมาณจากเวลาที่ 10 นาทีต่อบล็อก';
    el('halving-note').innerHTML = `* <b>ยอดของรอบ</b> = ราคาปิดสูงสุดภายใน 2 ปีหลัง halving · <b>ต่ำสุดหลังยอด</b> = ราคาปิดต่ำสุดหลังยอดจนถึง halving ครั้งถัดไป · วัน halving ครั้งถัดไปเป็นค่าประมาณ (${height}) อาจคลาดได้หลายสัปดาห์ ·
      มีแค่ ${done.length} รอบที่จบแล้ว ตัวอย่างน้อยมาก และแต่ละรอบขึ้นน้อยลงเรื่อย ๆ (${growth}) · รอบนี้มีปัจจัยใหม่ เช่น ETF Bitcoin ในสหรัฐ (เริ่ม ม.ค. 2024) รูปแบบเดิมจึงอาจไม่ซ้ำ · Halving เป็นข้อมูลประกอบ ไม่ได้คิดในคะแนน`;
  }

  // Shaded day ranges (past tops / past lows) and a "today" line on the cycle chart.
  const marks = (nowDay, tops, lows) => ({
    id: 'halvingMarks',
    beforeDatasetsDraw(c) {
      const { ctx, chartArea: a, scales: { x } } = c;
      ctx.save();
      for (const [xs, color] of [[tops, '--band-sell'], [lows, '--band-buy']]) {
        if (!xs.length) continue;
        const x0 = x.getPixelForValue(Math.min(...xs));
        const x1 = x.getPixelForValue(Math.max(...xs));
        ctx.fillStyle = cssVar(color);
        ctx.fillRect(x0, a.top, Math.max(2, x1 - x0), a.bottom - a.top);
      }
      ctx.restore();
    },
    afterDatasetsDraw(c) {
      const { ctx, chartArea: a, scales: { x } } = c;
      const px = x.getPixelForValue(nowDay);
      ctx.save();
      ctx.strokeStyle = cssVar('--accent');
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(px, a.top + 14);
      ctx.lineTo(px, a.bottom);
      ctx.stroke();
      ctx.fillStyle = cssVar('--accent');
      ctx.font = `600 11px ${CHART_FONT}`;
      ctx.textAlign = px > a.right - 40 ? 'right' : 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('วันนี้', px, a.top);
      ctx.restore();
    },
  });

  function renderChart(all, nowDay, tops, lows) {
    if (!window.Chart) return;
    if (chart) chart.destroy();
    const colorOf = (k) => cssVar(COLORS[Math.max(0, COLORS.length - all.length + k)]);
    el('halving-legend').innerHTML = all.map((c, k) => `<span class="legend"><span class="key" style="background:${colorOf(k)}"></span>${c.year}${c.done ? '' : ' (รอบนี้)'}</span>`).join('');
    const grid = cssVar('--grid');
    const muted = cssVar('--muted');
    chart = new Chart(el('chart-halving'), {
      type: 'line',
      data: {
        datasets: all.map((c, k) => ({
          label: c.year,
          data: c.series,
          ...lineStyle(colorOf(k), c.done ? 1.5 : 2.5),
          order: c.done ? 1 : 0,
        })),
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
            itemSort: (p, q) => q.datasetIndex - p.datasetIndex,
            callbacks: {
              title: (items) => `วันที่ ${items[0].parsed.x.toLocaleString('en-US')} หลัง halving`,
              label: (item) => ` ${item.dataset.label}: ${times(item.parsed.y)} · ${fmtUsd(item.raw.p)} (${fmtDate(item.raw.d)})`,
            },
          },
        },
        scales: {
          x: {
            type: 'linear',
            min: 0,
            max: SPAN,
            grid: { color: grid },
            border: { color: cssVar('--axis') },
            afterBuildTicks: (axis) => { axis.ticks = [0, 365, 730, 1095, 1460].map((value) => ({ value })); },
            ticks: { color: muted, callback: (v) => (v === 0 ? 'halving' : `${v / 365} ปี`) },
          },
          y: { ...logAxis((v) => `×${Number(v.toPrecision(3))}`), afterFit: (axis) => { axis.width = 56; } },
        },
      },
      plugins: [marks(nowDay, tops, lows)],
    });
  }

  window.renderHalving = render;
})();
