'use strict';
// Helpers shared by every page; loaded before app.js / alts-page.js / backtest.js.
// Classic scripts share one global scope, so these names must not be declared again elsewhere.

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
// Whole dollars from $100 up, cents down to $1, 4 significant digits below that (PEPE-sized prices).
const fmtUsd = (v) => {
  if (v == null || !Number.isFinite(v)) return '–';
  if (Math.abs(v) >= 100) return `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (Math.abs(v) >= 1) return `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  return `$${v.toLocaleString('en-US', { maximumSignificantDigits: 4 })}`;
};
const fmtPct = (v, d = 1) => (v == null ? '–' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`);
const fmtTime = (iso) => new Date(iso).toLocaleString('th-TH-u-ca-gregory', { dateStyle: 'medium', timeStyle: 'short' });
const fmtDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('th-TH-u-ca-gregory', { dateStyle: 'medium', timeZone: 'UTC' });
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

// Mirrors the hovered point onto the partner chart (see pair()). Runs after the
// built-in tooltip plugin has processed the event, so the active index is current.
const hoverSync = {
  id: 'hoverSync',
  afterEvent(chart, args) {
    const partner = chart.$partner;
    if (!partner) return;
    const active = chart.tooltip.getActiveElements();
    const idx = args.event.type === 'mouseout' || !active.length ? null : active[0].index;
    if (idx === partner.$syncedIndex) return;
    partner.$syncedIndex = idx;
    const els = idx == null
      ? []
      : partner.data.datasets
        .map((ds, datasetIndex) => ({ datasetIndex, index: idx }))
        .filter((e) => partner.data.datasets[e.datasetIndex].data[idx] != null);
    partner.setActiveElements(els);
    partner.tooltip.setActiveElements(els, { x: 0, y: 0 });
    partner.update('none');
  },
};

function pair(a, b) {
  a.$partner = b;
  b.$partner = a;
}

function tickLabel(label, mode) {
  const d = new Date(`${label}T00:00:00Z`);
  if (mode === 'all') return String(d.getUTCFullYear());
  return d.toLocaleDateString('th-TH-u-ca-gregory', { month: 'short', year: '2-digit', timeZone: 'UTC' });
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
