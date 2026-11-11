'use strict';
// Helpers shared by every page; loaded before app.js / alts-page.js / backtest.js.
// Classic scripts share one global scope, so these names must not be declared again elsewhere.

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
// Number/date formatting is built once here. toLocaleString(locale, options) makes a
// new Intl formatter on every call (≈ 0.08 ms), and a chart axis labels every one
// of its ~1,500 dates on each update — that alone made the charts stutter.
const USD_0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const USD_2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const USD_SIG4 = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 4 });
const TH_DATE = new Intl.DateTimeFormat('th-TH-u-ca-gregory', { dateStyle: 'medium', timeZone: 'UTC' });
const TH_MONTH = new Intl.DateTimeFormat('th-TH-u-ca-gregory', { month: 'short', year: '2-digit', timeZone: 'UTC' });
const TH_TIME = new Intl.DateTimeFormat('th-TH-u-ca-gregory', { dateStyle: 'medium', timeStyle: 'short' });
// Remembers fn(key) — for ISO dates, which repeat on every chart update.
function memo(fn) {
  const seen = new Map();
  return (key) => {
    let v = seen.get(key);
    if (v === undefined) { v = fn(key); seen.set(key, v); }
    return v;
  };
}
// An ISO date (YYYY-MM-DD) through a formatter; '–' if it is not a date.
const isoDay = (fmt) => memo((d) => {
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isNaN(t) ? '–' : fmt.format(t);
});

// Whole dollars from $100 up, cents down to $1, 4 significant digits below that (PEPE-sized prices).
const fmtUsd = (v) => {
  if (v == null || !Number.isFinite(v)) return '–';
  if (Math.abs(v) >= 100) return `$${USD_0.format(v)}`;
  if (Math.abs(v) >= 1) return `$${USD_2.format(v)}`;
  return `$${USD_SIG4.format(v)}`;
};
const fmtPct = (v, d = 1) => (v == null ? '–' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`);
const fmtTime = (x) => {
  const t = new Date(x).getTime();
  return Number.isNaN(t) ? '–' : TH_TIME.format(t);
};
const fmtDate = isoDay(TH_DATE);
const fmtMonth = isoDay(TH_MONTH);

// Runs the steps one per browser task, so a full redraw is many short pieces
// instead of one long freeze: the page keeps scrolling and painting in between.
// Calling again with the same name cancels the steps the older call has not run.
// A failing step is reported and the rest still run.
const stepRuns = {};
function runSteps(name, steps) {
  const token = (stepRuns[name] || 0) + 1;
  stepRuns[name] = token;
  const next = (k) => {
    if (stepRuns[name] !== token || k >= steps.length) return;
    try {
      steps[k]();
    } catch (err) {
      console.error(err);
      const box = document.getElementById('error');
      if (box) { box.textContent = `แสดงผลบางส่วนไม่สำเร็จ: ${err.message}`; box.hidden = false; }
    }
    if (k + 1 < steps.length) setTimeout(() => next(k + 1), 0);
  };
  next(0);
}

// Calls fn every minute. A hidden tab skips its turns (no redrawing nobody sees)
// and catches up as soon as it is shown again.
function autoRefresh(fn, ms = 60 * 1000) {
  let last = Date.now();
  const run = () => {
    if (document.hidden) return;
    last = Date.now();
    fn();
  };
  setInterval(run, ms);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - last >= ms) run();
  });
}
const toneOf = (s) => (s == null ? 'na' : s >= 80 ? 'strong-buy' : s >= 60 ? 'buy' : s >= 40 ? 'neutral' : s >= 20 ? 'sell' : 'strong-sell');

// ---------- header: online / offline and what is saved on this computer ----------

// `network` and `sources` come from every page's API response. A source with
// data (ok) has a copy in the server's cache/ folder; `stale` means its latest
// download failed and the saved copy is being shown instead.
function renderNetStatus(network, sources) {
  const box = $('#net-status');
  if (!box || !sources?.length) return;
  const saved = sources.filter((s) => s.ok && s.fetchedAt);
  const stale = saved.filter((s) => s.stale).length;
  const times = saved.map((s) => s.fetchedAt);
  let tone = 'strong-buy';
  let text = 'ออนไลน์ — ข้อมูลล่าสุด';
  if (network?.online === false) {
    tone = 'strong-sell';
    text = 'ออฟไลน์ — กำลังแสดงข้อมูลที่บันทึกไว้ในเครื่อง';
  } else if (stale) {
    tone = 'sell';
    text = `ออนไลน์ — ${stale} แหล่งยังดึงไม่ได้ ใช้ข้อมูลที่บันทึกไว้แทน`;
  }
  const when = times.length
    ? ` · บันทึกล่าสุด ${fmtTime(Math.max(...times))}${saved.length > 1 ? ` · เก่าสุด ${fmtTime(Math.min(...times))}` : ''}`
    : '';
  box.innerHTML = `
    <span class="pill tone-${tone}"><i></i>${text}</span>
    <span>${saved.length === sources.length ? '✓' : '⚠'} บันทึกไว้ในเครื่องแล้ว ${saved.length}/${sources.length} แหล่ง${when}</span>`;
}

// ---------- Chart.js plumbing ----------

const CHART_FONT = 'system-ui, "Segoe UI", "Leelawadee UI", sans-serif';

// Vertical hairline at the hovered point.
const crosshair = {
  id: 'crosshair',
  afterDatasetsDraw(chart) {
    const active = chart.tooltip?.getActiveElements?.() || [];
    if (!active.length) return;
    const { ctx, chartArea } = chart;
    const x = active[0].element.x;
    ctx.save();
    ctx.strokeStyle = cssVar('--axis');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

// Tints the "attractive" (≥ buyFrom) and "overheated" (≤ sellTo) ends of a 0–100 score axis.
const scoreBands = (buyFrom, sellTo, axis = 'y') => ({
  id: 'scoreBands',
  beforeDatasetsDraw(chart) {
    const { ctx, chartArea, scales } = chart;
    const band = (from, to, color) => {
      const a = scales[axis].getPixelForValue(from);
      const b = scales[axis].getPixelForValue(to);
      ctx.fillStyle = color;
      if (axis === 'y') ctx.fillRect(chartArea.left, Math.min(a, b), chartArea.right - chartArea.left, Math.abs(a - b));
      else ctx.fillRect(Math.min(a, b), chartArea.top, Math.abs(a - b), chartArea.bottom - chartArea.top);
    };
    ctx.save();
    band(buyFrom, 100, cssVar('--band-buy'));
    band(0, sellTo, cssVar('--band-sell'));
    ctx.restore();
  },
});

// Hairline across the plot at `value` on the y axis (a zero line, or "no change").
const baselineAt = (value) => ({
  id: 'baselineAt',
  beforeDatasetsDraw(chart) {
    const { ctx, chartArea, scales } = chart;
    const y = scales.y.getPixelForValue(value);
    if (!(y >= chartArea.top && y <= chartArea.bottom)) return;
    ctx.save();
    ctx.strokeStyle = cssVar('--axis');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(chartArea.left, y);
    ctx.lineTo(chartArea.right, y);
    ctx.stroke();
    ctx.restore();
  },
});

// Mirrors the hovered point onto the partner charts (see pair()). Runs after the
// built-in tooltip plugin has processed the event, so the active index is current.
const hoverSync = {
  id: 'hoverSync',
  afterEvent(chart, args) {
    const partners = chart.$partners;
    if (!partners) return;
    const active = chart.tooltip.getActiveElements();
    const idx = args.event.type === 'mouseout' || !active.length ? null : active[0].index;
    for (const partner of partners) {
      if (idx === partner.$syncedIndex) continue;
      partner.$syncedIndex = idx;
      const els = idx == null
        ? []
        : partner.data.datasets
          .map((ds, datasetIndex) => ({ datasetIndex, index: idx }))
          .filter((e) => partner.data.datasets[e.datasetIndex].data[idx] != null);
      partner.setActiveElements(els);
      partner.tooltip.setActiveElements(els, { x: 0, y: 0 });
      // Redraw only: update() would re-measure the whole axis on every mouse move.
      partner.render();
    }
  },
};

// Charts on the same dates that show the hovered day together (two or more).
function pair(...group) {
  for (const c of group) c.$partners = group.filter((x) => x !== c);
}

function tickLabel(label, mode) {
  if (mode === 'all') return String(label).slice(0, 4);
  return fmtMonth(label);
}

const tooltipStyle = () => ({
  backgroundColor: cssVar('--surface'),
  titleColor: cssVar('--text'),
  bodyColor: cssVar('--text-2'),
  borderColor: cssVar('--border'),
  borderWidth: 1,
  padding: 10,
  boxPadding: 4,
  usePointStyle: true,
});

// Options for a time-series line chart whose labels are ISO dates.
// mode: 'all' labels the x axis by year, anything else by month.
function baseOptions(mode) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    normalized: true,
    interaction: { mode: 'index', intersect: false },
    layout: { padding: { right: 4 } },
    plugins: {
      legend: { display: false },
      tooltip: { ...tooltipStyle(), callbacks: { title: (items) => fmtDate(items[0].label) } },
    },
    scales: {
      x: {
        grid: { display: false },
        border: { color: cssVar('--axis') },
        ticks: {
          color: cssVar('--muted'),
          maxRotation: 0,
          autoSkip: true,
          autoSkipPadding: 14, // a gap between month labels on narrow screens
          maxTicksLimit: 9,
          callback(v) { return tickLabel(this.getLabelForValue(v), mode); },
        },
      },
    },
  };
}

// A logarithmic y axis with round ticks. Chart.js' own log ticks are dense and
// then auto-skipped unevenly, which can leave one or two labels (or odd ones
// like $58k $59k). Use 1/2/5 × 10ⁿ, and a finer set when the range is narrow.
const LOG_TICK_STEPS = [[1, 2, 5], [1, 1.5, 2, 3, 4, 5, 6, 8]];

const logAxis = (format) => ({
  type: 'logarithmic',
  position: 'right',
  grid: { color: cssVar('--grid') },
  border: { display: false },
  afterBuildTicks(axis) {
    for (const steps of LOG_TICK_STEPS) {
      const ticks = [];
      for (let e = Math.floor(Math.log10(axis.min)); e <= Math.ceil(Math.log10(axis.max)); e++) {
        for (const m of steps) {
          const value = Number((m * 10 ** e).toPrecision(12));
          if (value >= axis.min && value <= axis.max) ticks.push({ value });
        }
      }
      if (ticks.length >= 3) { axis.ticks = ticks; return; }
    }
  },
  ticks: { color: cssVar('--muted'), maxTicksLimit: 8, callback: (v) => format(v) },
});

const logPriceAxis = () => logAxis((v) => (v >= 1000 ? `$${(v / 1000).toLocaleString('en-US')}k` : fmtUsd(v)));

// ---------- "หรือเลือกวัน": every line on one chosen day ----------

// The charts zoom to about six months either side of the chosen day.
const DAY_WINDOW = 182;
const shiftDay = (d, days) => new Date(Date.parse(`${d}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

// Index of the last date on or before `day` in a sorted ISO date list (−1 if none).
function lastIndexOnOrBefore(dates, day) {
  let lo = 0;
  let hi = dates.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= day) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return at;
}

// Chart window around `day` as indices into dates. `at` is the chosen day, or the
// nearest earlier date when that day has no data (gold does not trade on weekends).
function dayWindow(dates, day) {
  const at = Math.max(0, lastIndexOnOrBefore(dates, day));
  const from = Math.min(at, lastIndexOnOrBefore(dates, shiftDay(day, -DAY_WINDOW)) + 1);
  const to = Math.max(at, lastIndexOnOrBefore(dates, shiftDay(day, DAY_WINDOW)));
  return { from, to, at };
}

// The date box beside a range selector. Picking a day un-highlights the range
// buttons and calls onPick(day); clicking a range button again leaves day mode.
function bindDayPick(inputId, segId, onPick) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.addEventListener('change', () => {
    if (!input.value) return;
    for (const b of document.querySelectorAll(`#${segId} button`)) b.classList.remove('on');
    onPick(input.value);
  });
}

function syncDayPick(inputId, dates, active, day) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.min = dates[0];
  input.max = dates[dates.length - 1];
  if (active && day) input.value = day;
  input.closest('.field')?.classList.toggle('on', active);
}

// Dashed line at options.plugins.dayMarker.index (the chosen day) with a dot on each line.
const dayMarker = {
  id: 'dayMarker',
  afterDatasetsDraw(chart, args, opts) {
    const i = opts?.index;
    if (i == null) return;
    const { ctx, chartArea, scales } = chart;
    const x = scales.x.getPixelForValue(i);
    if (!(x >= chartArea.left && x <= chartArea.right)) return;
    ctx.save();
    ctx.strokeStyle = cssVar('--accent');
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    chart.data.datasets.forEach((ds, k) => {
      const pt = chart.getDatasetMeta(k).data[i];
      if (!pt || ds.data[i] == null) return;
      ctx.fillStyle = ds.borderColor;
      ctx.strokeStyle = cssVar('--surface');
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
    ctx.restore();
  },
};

// ---------- ปักหมุด A → B: % change between two clicked points on a price chart ----------
// Click once for A, again for B (a third click starts over). Pins are kept by
// label (date or time) so they survive the charts being rebuilt every minute.

const abPins = {}; // key → { a, b, amount }, a/b = { label, price }

const daysBetween = (a, b) => {
  const days = Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
  const about = days >= 365 ? ` (≈ ${(days / 365.25).toFixed(1)} ปี)` : days >= 60 ? ` (≈ ${(days / 30.44).toFixed(1)} เดือน)` : '';
  return `ใช้เวลา <b>${days.toLocaleString('en-US')} วัน</b>${about}`;
};
const timeBetween = (a, b) => {
  const m = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const mins = m(b) - m(a);
  return `ใช้เวลา <b>${mins >= 60 ? `${Math.floor(mins / 60)} ชม. ${mins % 60} นาที` : `${mins} นาที`}</b>`;
};

const abPinPlugin = {
  id: 'abPins',
  afterDatasetsDraw(chart) {
    const st = chart.$pinKey && abPins[chart.$pinKey];
    if (!st?.a) return;
    const { ctx, chartArea, scales } = chart;
    const pts = [['A', st.a], ['B', st.b]].flatMap(([name, p]) => {
      const i = p ? chart.data.labels.indexOf(p.label) : -1;
      return i < 0 ? [] : [{ name, x: scales.x.getPixelForValue(i), y: scales.y.getPixelForValue(p.price) }];
    });
    ctx.save();
    if (st.b && pts.length === 2) {
      ctx.fillStyle = cssVar(st.b.price >= st.a.price ? '--band-buy' : '--band-sell');
      ctx.fillRect(Math.min(pts[0].x, pts[1].x), chartArea.top, Math.abs(pts[1].x - pts[0].x), chartArea.bottom - chartArea.top);
    }
    for (const p of pts) {
      ctx.strokeStyle = cssVar('--accent');
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(p.x, chartArea.top + 16);
      ctx.lineTo(p.x, chartArea.bottom);
      ctx.stroke();
      ctx.fillStyle = cssVar('--accent');
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(p.x - 8, chartArea.top, 16, 16);
      ctx.fillStyle = '#fff';
      ctx.font = `700 11px ${CHART_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.name, p.x, chartArea.top + 8);
    }
    ctx.restore();
  },
};
if (window.Chart) Chart.register(abPinPlugin);

// Makes a price chart pinnable; the result line goes right under its chart.
// cfg.fmtLabel shows a label (default: date), cfg.span the time between two labels.
// The key sits on the chart itself (not in its options), so showing the pins
// needs only a redraw, never a full chart update.
function attachPins(chart, key, cfg = {}) {
  chart.$pinKey = key;
  chart.canvas.style.cursor = 'crosshair';
  chart.options.onClick = (evt) => {
    const i = Math.round(chart.scales.x.getValueForPixel(evt.x));
    const label = chart.data.labels[i];
    const price = chart.data.datasets[0].data[i];
    if (label == null || price == null) return;
    const st = abPins[key] || (abPins[key] = { amount: 100 });
    const p = { label, price };
    if (!st.a || st.b) { st.a = p; st.b = null; } else if (label !== st.a.label) {
      st.b = p;
      if (st.b.label < st.a.label) [st.a, st.b] = [st.b, st.a]; // A is always the earlier point
    }
    chart.render();
    renderPins(chart, key, cfg);
  };
  if (abPins[key]?.a) chart.render();
  renderPins(chart, key, cfg);
}

function renderPins(chart, key, { fmtLabel = fmtDate, span = daysBetween } = {}) {
  const wrap = chart.canvas.closest('.chart-wrap');
  let box = wrap.nextElementSibling;
  if (!box?.classList.contains('ab-readout')) {
    box = document.createElement('div');
    box.className = 'ab-readout';
    wrap.after(box);
  }
  const st = abPins[key];
  const clear = '<button type="button" class="ab-clear">ล้างหมุด</button>';
  if (!st?.a) {
    box.innerHTML = '<span class="ab-hint">ปักหมุด: คลิกบนกราฟราคา 2 จุด (A แล้ว B) เพื่อดูว่าขึ้นลงกี่ % และเงินลงทุนจะกลายเป็นเท่าไร</span>';
    return;
  }
  const point = (name, p) => `<span><b class="ab-tag">${name}</b> ${fmtLabel(p.label)} <b>${fmtUsd(p.price)}</b></span>`;
  if (!st.b) {
    box.innerHTML = `${point('A', st.a)}<span class="ab-hint">คลิกอีกจุดเพื่อเลือก B</span>${clear}`;
  } else {
    const ratio = st.b.price / st.a.price;
    const pct = (ratio - 1) * 100;
    box.innerHTML = `${point('A', st.a)}<span>→</span>${point('B', st.b)}
      <span class="${pct >= 0 ? 'up' : 'down'}"><b>${pct >= 0 ? '▲' : '▼'} ${fmtPct(pct, 2)}</b></span>
      <span class="ab-span">${span(st.a.label, st.b.label)}</span>
      <label class="ab-calc">ลงทุนที่ A <input type="number" class="ab-amount" min="0" step="any" value="${st.amount}"> → ที่ B ได้ <b class="ab-value"></b> <span class="ab-profit"></span></label>
      ${clear}`;
    const input = box.querySelector('.ab-amount');
    const show = () => {
      const amount = Number(input.value) || 0;
      st.amount = amount;
      const value = amount * ratio;
      const fmt = (v) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      box.querySelector('.ab-value').textContent = fmt(value);
      box.querySelector('.ab-profit').innerHTML = `(<span class="${value >= amount ? 'up' : 'down'}">${value >= amount ? 'กำไร +' : 'ขาดทุน −'}${fmt(Math.abs(value - amount))}</span>)`;
    };
    input.addEventListener('input', show);
    show();
  }
  box.querySelector('.ab-clear').addEventListener('click', () => {
    delete abPins[key];
    chart.render();
    renderPins(chart, key, { fmtLabel, span });
  });
}

const lineStyle = (color, width = 2) => ({
  borderColor: color,
  backgroundColor: color,
  borderWidth: width,
  pointRadius: 0,
  pointHoverRadius: 4,
  pointHoverBorderWidth: 2,
  pointHoverBorderColor: cssVar('--surface'),
  tension: 0,
});
