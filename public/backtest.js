'use strict';
// Backtest: plain DCA vs score-weighted DCA with a cash reserve.
// Runs client-side on the daily history from the page's API and reuses the
// chart/format helpers defined in app.js (loaded before this file).
// An API response may carry its own rule as `backtest: { unit, tiers }`.

(() => {
  // BTC default, chosen by backtest: the LTH score averages ~60, so mid scores
  // must buy less than 1× or the cash reserve never builds up for the ≥80 zone.
  const DEFAULT_TIERS = [
    { min: 80, mult: 2.5, tone: 'strong-buy', text: 'คะแนน ≥ 80 → ซื้อ 2.5×' },
    { min: 65, mult: 1.25, tone: 'buy', text: '65–80 → ซื้อ 1.25×' },
    { min: 50, mult: 0.75, tone: 'neutral', text: '50–65 → ซื้อ 0.75×' },
    { min: 35, mult: 0.25, tone: 'sell', text: '35–50 → ซื้อ 0.25×' },
    { min: -Infinity, mult: 0, tone: 'strong-sell', text: '< 35 → ไม่ซื้อ เก็บเป็นเงินสด' },
  ];
  const SELL_BELOW = 20;
  const SELL_FRACTION = { monthly: 0.02, weekly: 0.005 };
  const MACRO_WEIGHT = 0.3;
  const MACRO_PUBLISH_LAG_DAYS = 2; // FRED H.4.1 (Wednesday) is released the next day

  const bt = { start: null, source: 'lth', freq: 'monthly', amount: 100, sell: false };
  let chart = null;
  let lastData = null;
  let tiers = DEFAULT_TIERS;
  let unit = 'BTC';

  const el = (id) => document.getElementById(id);
  const multOf = (s) => tiers.find((t) => s >= t.min).mult;
  const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);
  // Wording for the asset inside Thai sentences. Latin tickers need spaces
  // around them, Thai words do not, so the API supplies ready-made labels.
  let labels = { asset: ' BTC ', per: ' BTC' };
  const assetName = () => labels.asset;
  const perUnit = () => labels.per;
  const fmtBtc = (v) => `${v.toLocaleString('en-US', { maximumFractionDigits: v >= 1000 ? 0 : v >= 1 ? 3 : 4 })} ${unit}`;
  const fmtUsdShort = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${Math.round(v / 1e3)}k` : `$${Math.round(v)}`);
  const arrow = (v, lowerIsBetter = false) => {
    if (v == null || !Number.isFinite(v)) return '–';
    const good = lowerIsBetter ? v <= 0 : v >= 0;
    return `<span class="${good ? 'up' : 'down'}">${v >= 0 ? '▲' : '▼'} ${fmtPct(v)}</span>`;
  };

  // Score used for the buy decision on each day (null = no score → buy 1×).
  function scoreSeries(d) {
    const h = d.history;
    if (bt.source === 'sth') return h.sth;
    const m = d.macro?.chart;
    if (bt.source !== 'lthmacro' || !m) return h.lth;
    const out = new Array(h.dates.length).fill(null);
    let j = -1;
    for (let i = 0; i < h.dates.length; i++) {
      const now = dayMs(h.dates[i]);
      while (j + 1 < m.futureIndex && dayMs(m.dates[j + 1]) + MACRO_PUBLISH_LAG_DAYS * 86400000 <= now) j++;
      const mac = j >= 0 ? m.macro[j] : null;
      const lth = h.lth[i];
      out[i] = lth == null ? null : mac == null ? lth : (1 - MACRO_WEIGHT) * lth + MACRO_WEIGHT * mac;
    }
    return out;
  }

  function schedule(dates) {
    const from = `${bt.start}-01-01`;
    const idx = [];
    let lastMonth = null;
    let nextWeekly = -1;
    for (let i = 0; i < dates.length; i++) {
      if (dates[i] < from) continue;
      if (bt.freq === 'monthly') {
        const month = dates[i].slice(0, 7);
        if (month !== lastMonth) { idx.push(i); lastMonth = month; }
      } else if (i >= nextWeekly) {
        idx.push(i);
        nextWeekly = i + 7;
      }
    }
    return idx;
  }

  function simulate(d) {
    const h = d.history;
    const scores = scoreSeries(d);
    const idx = schedule(h.dates);
    if (!idx.length) return null;

    const A = bt.amount;
    const blank = () => ({ invested: 0, spent: 0, bought: 0, btc: 0, cash: 0, sold: 0 });
    const plain = blank();
    const smart = blank();
    const curve = { dates: [], invested: [], plain: [], smart: [] };
    const sellFraction = SELL_FRACTION[bt.freq];
    const mark = (i) => {
      const p = h.price[i];
      curve.dates.push(h.dates[i]);
      curve.invested.push(plain.invested);
      curve.plain.push(plain.btc * p + plain.cash);
      curve.smart.push(smart.btc * p + smart.cash);
    };

    for (const i of idx) {
      const p = h.price[i];
      const s = scores[i];

      plain.invested += A;
      plain.spent += A;
      plain.bought += A / p;
      plain.btc += A / p;

      // Smart DCA: the same deposit goes into a cash pool; the score decides how much of it to deploy.
      smart.invested += A;
      smart.cash += A;
      const buy = Math.min(smart.cash, A * (s == null ? 1 : multOf(s)));
      if (buy > 0) {
        smart.cash -= buy;
        smart.spent += buy;
        smart.bought += buy / p;
        smart.btc += buy / p;
      }
      if (bt.sell && s != null && s < SELL_BELOW && smart.btc > 0) {
        const qty = smart.btc * sellFraction;
        smart.btc -= qty;
        smart.cash += qty * p;
        smart.sold += qty * p;
      }
      mark(i);
    }
    const last = h.dates.length - 1;
    if (idx[idx.length - 1] !== last) mark(last);

    const price = h.price[last];
    const finish = (x) => {
      const value = x.btc * price + x.cash;
      return { ...x, value, roi: (value / x.invested - 1) * 100, avgCost: x.bought ? x.spent / x.bought : null };
    };
    return { plain: finish(plain), smart: finish(smart), curve, periods: idx.length, from: h.dates[idx[0]], to: h.dates[last] };
  }

  function renderSummary(r) {
    const { plain: a, smart: b } = r;
    const pctDiff = (x, y) => (x != null && y ? (x / y - 1) * 100 : null);
    const tile = (label, value, sub) => `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-sub">${sub}</div></div>`;

    el('bt-period').textContent = `(${fmtDate(r.from)} – ${fmtDate(r.to)} · ${r.periods} งวด)`;
    el('bt-stats').innerHTML = [
      tile('มูลค่าพอร์ต: DCA ตามคะแนน เทียบ DCA ปกติ', arrow(pctDiff(b.value, a.value)), `${fmtUsd(b.value)} vs ${fmtUsd(a.value)}`),
      tile(`ต้นทุนเฉลี่ยต่อ${perUnit()} (ยิ่งต่ำยิ่งดี)`, arrow(pctDiff(b.avgCost, a.avgCost), true), `${fmtUsd(b.avgCost)} vs ${fmtUsd(a.avgCost)}`),
      tile('DCA ตามคะแนนใช้เงินซื้อไป', `${Math.round((100 * b.spent) / b.invested)}%`, `ของเงินที่เติม · เหลือเงินสด ${fmtUsd(b.cash)}`),
    ].join('');

    const row = (label, fa, fb) => `<tr><td>${label}</td><td class="num">${fa}</td><td class="num">${fb}</td></tr>`;
    el('bt-table').innerHTML = `
      <table>
        <thead><tr><th></th><th class="num">DCA ปกติ</th><th class="num">DCA ตามคะแนน</th></tr></thead>
        <tbody>
          ${row('เงินที่เติมเข้าพอร์ตรวม', fmtUsd(a.invested), fmtUsd(b.invested))}
          ${row(`เงินที่ใช้ซื้อ${assetName()}`.trim(), fmtUsd(a.spent), fmtUsd(b.spent))}
          ${row(`${assetName()}ที่ถืออยู่`.trim(), fmtBtc(a.btc), fmtBtc(b.btc))}
          ${row('เงินสดคงเหลือ', fmtUsd(a.cash), fmtUsd(b.cash))}
          ${bt.sell ? row('ขายทำกำไรออกมาได้', '–', fmtUsd(b.sold)) : ''}
          ${row('มูลค่าพอร์ตตอนนี้', `<b>${fmtUsd(a.value)}</b>`, `<b>${fmtUsd(b.value)}</b>`)}
          ${row('กำไร / ขาดทุน', fmtPct(a.roi), fmtPct(b.roi))}
          ${row(`ต้นทุนเฉลี่ยต่อ${perUnit()}`, fmtUsd(a.avgCost), fmtUsd(b.avgCost))}
        </tbody>
      </table>`;
  }

  function renderChart(r) {
    if (!window.Chart) return;
    if (chart) chart.destroy();
    const years = (dayMs(r.to) - dayMs(r.from)) / (365 * 86400000);
    const opts = baseOptions(years > 3 ? 'all' : 'short');
    opts.plugins.tooltip.callbacks.label = (item) => ` ${item.dataset.label}: ${fmtUsd(item.parsed.y)}`;
    opts.scales.y = {
      position: 'right',
      grid: { color: cssVar('--grid') },
      border: { display: false },
      ticks: { color: cssVar('--muted'), maxTicksLimit: 6, callback: (v) => fmtUsdShort(v) },
    };
    chart = new Chart(el('chart-bt'), {
      type: 'line',
      data: {
        labels: r.curve.dates,
        datasets: [
          { label: 'เงินที่เติมเข้าพอร์ต', data: r.curve.invested, ...lineStyle(cssVar('--axis'), 1.5) },
          { label: 'DCA ปกติ', data: r.curve.plain, ...lineStyle(cssVar('--text-2')) },
          { label: 'DCA ตามคะแนน', data: r.curve.smart, ...lineStyle(cssVar('--accent')) },
        ],
      },
      options: opts,
      plugins: [crosshair],
    });
  }

  function initControls(d) {
    const sel = el('bt-start');
    const macroBtn = el('bt-source').querySelector('button[data-v="lthmacro"]');
    if (macroBtn) macroBtn.disabled = !d.macro;
    if (sel.options.length) return;
    el('bt-rules').innerHTML = tiers.map((t) => `<span class="pill tone-${t.tone}"><i></i>${t.text}</span>`).join('');
    const h = d.history;
    const firstScored = h.dates[h.lth.findIndex((v) => v != null)];
    const firstYear = Number(firstScored.slice(0, 4)) + 1;
    const lastYear = Number(h.dates[h.dates.length - 1].slice(0, 4));
    for (let y = firstYear; y < lastYear; y++) sel.add(new Option(String(y), String(y)));
    bt.start = String(Math.min(Math.max(2018, firstYear), lastYear - 1));
    sel.value = bt.start;
  }

  function render(d) {
    if (!d?.history) return;
    lastData = d;
    tiers = d.backtest?.tiers || DEFAULT_TIERS;
    unit = d.backtest?.unit || 'BTC';
    labels = { asset: d.backtest?.assetLabel || ` ${unit} `, per: d.backtest?.perLabel || ` ${unit}` };
    initControls(d);
    const r = simulate(d);
    if (!r) return;
    renderSummary(r);
    renderChart(r);
  }

  // ---------- controls ----------
  const rerender = () => lastData && render(lastData);

  el('bt-start').addEventListener('change', (e) => { bt.start = e.target.value; rerender(); });
  el('bt-amount').addEventListener('change', (e) => {
    const v = Number(e.target.value);
    if (v > 0) { bt.amount = v; rerender(); } else { e.target.value = bt.amount; }
  });
  el('bt-sell').addEventListener('change', (e) => { bt.sell = e.target.checked; rerender(); });
  for (const [id, key] of [['bt-source', 'source'], ['bt-freq', 'freq']]) {
    el(id).addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-v]');
      if (!btn || btn.disabled) return;
      bt[key] = btn.dataset.v;
      for (const b of el(id).querySelectorAll('button')) b.classList.toggle('on', b === btn);
      rerender();
    });
  }

  window.renderBacktest = render;
})();
