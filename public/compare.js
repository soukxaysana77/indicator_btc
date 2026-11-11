'use strict';
// "เทียบ 2 เหรียญ" on /alts.html: pick coin A and coin B (BTC included) to see
// them side by side — returns over the chosen range, the A/B price ratio, both
// LTH scores — and how often A beat B over a year in the past.
// Data: overview.chart (one shared daily axis). Helpers come from common.js.
//
// Tested 2017–2026 on every pair of the 12 coins here, holding 1 year: the coin
// with the higher LTH score beat the other only 52–57% of days (a 30+ point gap
// flipped: 39% before 2022, 60% after); an A/B ratio near the bottom of its
// past-year range did not help either (A won 52% vs 49% near the top); most alts
// lost to BTC in about 2 of 3 one-year windows (only BNB and TRX won more than
// half). So the panel shows facts and the pair's own record, not a pick. The
// pooled figures in the note are recomputed from the data on every new load.

(() => {
  const el = (id) => document.getElementById(id);
  const H = 365; // holding period for the "who won" record
  const GAP = 20; // LTH points that count as "clearly cheaper"
  const RANGE_DAYS = { '1y': 365, '4y': 1461, all: Infinity };
  const RANGE_TEXT = { '1y': '1 ปี', '4y': '4 ปี', all: 'ทั้งหมด' };
  const Y_AXIS_WIDTH = 72;
  const REL = {
    good: { tone: 'buy', text: 'เคยได้ผล' },
    mixed: { tone: 'neutral', text: 'ได้ผลบางส่วน' },
    poor: { tone: 'sell', text: 'ไม่ได้ผล' },
    unknown: { tone: 'na', text: 'ข้อมูลไม่พอ' },
  };

  // pins = จุด A / จุด B clicked on the charts (ISO dates, kept across refreshes);
  // view = what the last render showed, for redrawing the pin readout alone.
  const st = { a: 'ETH', b: 'BTC', range: '4y', amount: 100, pins: { a: null, b: null }, data: null, view: null };
  const charts = {};
  let pooledMemo = null;
  try {
    const saved = JSON.parse(localStorage.getItem('cmp-pair') || 'null');
    if (saved?.a && saved?.b && saved.a !== saved.b) { st.a = saved.a; st.b = saved.b; }
    if (RANGE_DAYS[saved?.range]) st.range = saved.range;
    if (saved?.amount > 0) st.amount = saved.amount;
  } catch { /* no storage: use the defaults */ }
  const save = () => {
    try { localStorage.setItem('cmp-pair', JSON.stringify({ a: st.a, b: st.b, range: st.range, amount: st.amount })); } catch { /* ignore */ }
  };

  // ---------- numbers ----------

  const signed = (v, d = 0) => (v == null ? '–' : `<span class="${v >= 0 ? 'up' : 'down'}">${fmtPct(v, d)}</span>`);
  const at = (s, i) => (i >= s.start ? s.price[i - s.start] ?? null : null);
  const lthAt = (s, i) => (i >= s.start ? s.lth[i - s.start] ?? null : null);
  function firstIndex(s) {
    for (let k = 0; k < s.price.length; k++) if (s.price[k] != null) return s.start + k;
    return -1;
  }
  function lastIndex(s) {
    for (let k = s.price.length - 1; k >= 0; k--) if (s.price[k] != null) return s.start + k;
    return -1;
  }
  // A's result against B, buying on day i and holding h days: (1 + rA) / (1 + rB) − 1.
  function relAt(sa, sb, i, h = H) {
    const a0 = at(sa, i);
    const b0 = at(sb, i);
    const a1 = at(sa, i + h);
    const b1 = at(sb, i + h);
    return a0 && b0 && a1 && b1 ? a1 / a0 / (b1 / b0) - 1 : null;
  }
  const change = (s, i, back) => {
    const p = at(s, i);
    const q = at(s, i - back);
    return p && q ? (p / q - 1) * 100 : null;
  };
  // Daily log returns over the last `days` days up to index `last`.
  function dailyReturns(s, last, days) {
    const out = new Map();
    for (let i = last - days + 1; i <= last; i++) {
      const p = at(s, i);
      const q = at(s, i - 1);
      if (p && q) out.set(i, Math.log(p / q));
    }
    return out;
  }
  function volatility(s, last) {
    const r = [...dailyReturns(s, last, H).values()];
    if (r.length < 200) return null;
    const mean = r.reduce((a, b) => a + b, 0) / r.length;
    const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1));
    return sd * Math.sqrt(365) * 100;
  }
  function correlation(sa, sb, last) {
    const ra = dailyReturns(sa, last, H);
    const rb = dailyReturns(sb, last, H);
    const xs = [];
    const ys = [];
    for (const [i, x] of ra) if (rb.has(i)) { xs.push(x); ys.push(rb.get(i)); }
    if (xs.length < 200) return null;
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    xs.forEach((x, k) => { sxy += (x - mx) * (ys[k] - my); sxx += (x - mx) ** 2; syy += (ys[k] - my) ** 2; });
    return sxy / Math.sqrt(sxx * syy);
  }
  // Biggest fall from a running high between two indices.
  function maxDrawdown(s, from, to) {
    let peak = 0;
    let worst = 0;
    for (let i = from; i <= to; i++) {
      const p = at(s, i);
      if (p == null) continue;
      peak = Math.max(peak, p);
      worst = Math.min(worst, p / peak - 1);
    }
    return worst * 100;
  }
  // [index, relative result] pairs → share of wins, median, separate episodes (> 30 days apart).
  function summarise(list) {
    if (!list.length) return { n: 0 };
    let episodes = 0;
    let prev = -99;
    for (const [i] of list) { if (i - prev > 30) episodes++; prev = i; }
    const rs = list.map(([, r]) => r).sort((x, y) => x - y);
    return { n: rs.length, episodes, win: (100 * rs.filter((r) => r > 0).length) / rs.length, median: rs[Math.floor(rs.length / 2)] * 100 };
  }

  // The pair's own record: buy on each past day, hold a year, did A beat B?
  function pairRecord(sa, sb, n) {
    const rows = { all: [], aHigh: [], close: [], bHigh: [] };
    for (let i = Math.max(firstIndex(sa), firstIndex(sb)); i + H < n; i++) {
      const r = relAt(sa, sb, i);
      if (r == null) continue;
      rows.all.push([i, r]);
      const la = lthAt(sa, i);
      const lb = lthAt(sb, i);
      if (la == null || lb == null) continue;
      rows[la - lb >= GAP ? 'aHigh' : lb - la >= GAP ? 'bHigh' : 'close'].push([i, r]);
    }
    return Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, summarise(v)]));
  }

  // Every pair on the page: does the higher LTH score win? How often do alts beat BTC?
  function pooled(d, list) {
    const key = `${d.generatedAt}|${list.length}`;
    if (pooledMemo?.key === key) return pooledMemo.value;
    const ch = d.chart;
    const n = ch.dates.length;
    const big = { n: 0, w: 0 };
    const small = { n: 0, w: 0 };
    const vsBtc = {};
    let pairs = 0;
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        const sa = ch.coins[list[x].symbol];
        const sb = ch.coins[list[y].symbol];
        const withBtc = list[x].symbol === 'BTC' ? list[y].symbol : list[y].symbol === 'BTC' ? list[x].symbol : null;
        let used = false;
        for (let i = Math.max(firstIndex(sa), firstIndex(sb)); i + H < n; i++) {
          const r = relAt(sa, sb, i);
          if (r == null) continue;
          if (withBtc) {
            const o = (vsBtc[withBtc] ||= { n: 0, w: 0 });
            o.n++;
            if (list[x].symbol === 'BTC' ? r < 0 : r > 0) o.w++;
          }
          const la = lthAt(sa, i);
          const lb = lthAt(sb, i);
          if (la == null || lb == null || la === lb) continue;
          const o = Math.abs(la - lb) >= GAP ? big : small;
          o.n++;
          if ((la > lb) === (r > 0)) o.w++;
          used = true;
        }
        if (used) pairs++;
      }
    }
    const alts = Object.values(vsBtc);
    const altN = alts.reduce((a, o) => a + o.n, 0);
    const value = {
      pairs,
      big: big.n ? (100 * big.w) / big.n : null,
      small: small.n ? (100 * small.w) / small.n : null,
      altWin: altN ? (100 * alts.reduce((a, o) => a + o.w, 0)) / altN : null,
      beatBtc: Object.entries(vsBtc).filter(([, o]) => o.n >= 365 && o.w / o.n > 0.5).map(([s]) => s),
    };
    pooledMemo = { key, value };
    return value;
  }

  // ---------- formatting ----------

  // A/B prices can be anything from 1e-10 (PEPE/BTC) to 1e5 (BTC/DOGE).
  function fmtRatio(v) {
    if (v >= 100) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (v >= 0.0001) return String(Number(v.toPrecision(3)));
    return v.toExponential(2);
  }
  const scoreHtml = (comp) => (comp?.score == null ? '–' : `<b>${Math.round(comp.score)}</b> <span class="pill tone-${toneOf(comp.score)}"><i></i>${esc(comp.label?.text ?? '')}</span>`);
  const relHtml = (c) => {
    if (c.symbol === 'BTC') return '<a class="coin-name" href="/">ดูหน้า Bitcoin</a>';
    const r = REL[c.reliability?.level] || REL.unknown;
    return `<span class="pill tone-${r.tone}" title="${esc(`${c.reliability?.title ?? ''} — ${c.reliability?.text ?? ''}`)}"><i></i>${r.text}</span>`;
  };
  const corrText = (r) => (r >= 0.8 ? 'สูงมาก' : r >= 0.6 ? 'สูง' : r >= 0.4 ? 'ปานกลาง' : 'ต่ำ');
  const tag = (side, sym) => `<span class="key key-${side}"></span><b>${esc(sym)}</b>`;
  const usdSigned = (v) => `<span class="${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '+' : '−'}${fmtUsd(Math.abs(v))}</span>`;
  // "BTC ได้มากกว่า ETH $279 (ชนะ +137%)" for two end values of the same money.
  function moreText(symA, va, symB, vb) {
    const aWins = va >= vb;
    const [w, l, vw, vl] = aWins ? [symA, symB, va, vb] : [symB, symA, vb, va];
    return `<b>${esc(w)}</b> ได้มากกว่า ${esc(l)} <b>${fmtUsd(vw - vl)}</b> (ชนะ ${fmtPct((vw / vl - 1) * 100, 0)})`;
  }

  // ---------- render ----------

  // Coins that can be picked: BTC first, then the table's coins in market-cap order.
  function options(d) {
    const ch = d.chart;
    const list = [];
    if (ch?.coins?.BTC) list.push({ symbol: 'BTC', name: 'Bitcoin', price: d.btc.price, lth: d.btc.lth, sth: d.btc.sth, drawdown: d.btc.drawdown });
    for (const c of d.coins) if (!c.error && ch?.coins?.[c.symbol]) list.push(c);
    return list;
  }

  function fillSelect(select, list, value) {
    const key = list.map((c) => c.symbol).join(',');
    if (select.dataset.coins !== key) {
      select.innerHTML = list.map((c) => `<option value="${esc(c.symbol)}">${esc(c.symbol)} — ${esc(c.name)}</option>`).join('');
      select.dataset.coins = key;
    }
    select.value = value;
  }

  function render(d) {
    const panel = el('compare-panel');
    if (!panel || !d) return;
    st.data = d;
    const list = options(d);
    panel.hidden = list.length < 2;
    if (list.length < 2) return;
    const syms = list.map((c) => c.symbol);
    if (!syms.includes(st.a)) st.a = syms.includes('ETH') ? 'ETH' : syms[1];
    if (!syms.includes(st.b) || st.b === st.a) st.b = syms.find((s) => s !== st.a);
    fillSelect(el('cmp-a'), list, st.a);
    fillSelect(el('cmp-b'), list, st.b);
    for (const b of el('cmp-range').querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === st.range);

    const ch = d.chart;
    const A = list.find((c) => c.symbol === st.a);
    const B = list.find((c) => c.symbol === st.b);
    const sa = ch.coins[A.symbol];
    const sb = ch.coins[B.symbol];
    const last = Math.min(lastIndex(sa), lastIndex(sb));
    const first = Math.max(firstIndex(sa), firstIndex(sb));
    let s0 = Math.max(first, last - RANGE_DAYS[st.range] + 1);
    while (s0 < last && !(at(sa, s0) && at(sb, s0))) s0++;
    const short = first > last - RANGE_DAYS[st.range] + 1 && st.range !== 'all';

    // ---------- summary ----------
    const ret = (s) => (at(s, s0) && at(s, last) ? (at(s, last) / at(s, s0) - 1) * 100 : null);
    const ra = ret(sa);
    const rb = ret(sb);
    const corr = correlation(sa, sb, last);
    const amount = st.amount;
    const worth = (r) => (r == null ? null : amount * (1 + r / 100));
    const money = (r) => (r == null ? '–' : `<b>${fmtUsd(worth(r))}</b> (${signed(r)})`);
    const lead = ra != null && rb != null ? `→ ${moreText(A.symbol, worth(ra), B.symbol, worth(rb))}` : '';
    const span = st.range === 'all' || short ? 'ช่วงที่มีข้อมูลทั้งคู่' : `ช่วง ${RANGE_TEXT[st.range]}`;
    el('cmp-summary').innerHTML = `
      <b>${span}</b> (${fmtDate(ch.dates[s0])} – ${fmtDate(ch.dates[last])}) ลงทุน ${fmtUsd(amount)}: ${tag('a', A.symbol)} ${money(ra)} · ${tag('b', B.symbol)} ${money(rb)} ${lead}
      <span class="readout-hint">ขึ้นลงไปด้วยกัน (1 ปีล่าสุด): ${corr == null ? '–' : `<b>${corr.toFixed(2)}</b> = ${corrText(corr)}`} · 1 = ขึ้นลงพร้อมกันทุกวัน 0 = ไม่เกี่ยวกัน — ยิ่งสูง ถือทั้งสองเหรียญยิ่งไม่ช่วยกระจายความเสี่ยง</span>`;

    // ---------- side-by-side table ----------
    const row = (label, fa, fb, hint) => `<tr><td>${label}${hint ? `<div class="coin-name">${hint}</div>` : ''}</td><td class="num">${fa}</td><td class="num">${fb}</td></tr>`;
    const both = (f) => [f(A, sa), f(B, sb)];
    const vol = both((c, s) => volatility(s, last));
    el('cmp-table').innerHTML = `
      <table class="alts cmp">
        <thead><tr><th></th><th class="num">${tag('a', A.symbol)}</th><th class="num">${tag('b', B.symbol)}</th></tr></thead>
        <tbody>
          ${row('ราคาตอนนี้', ...both((c) => fmtUsd(c.price)))}
          ${row('คะแนนระยะยาว', ...both((c) => scoreHtml(c.lth)), 'ยิ่งสูง = ยิ่งถูกเทียบวัฏจักรของเหรียญนั้นเอง')}
          ${row('สภาวะระยะสั้น', ...both((c) => scoreHtml(c.sth)), 'ข้อมูลประกอบ ใช้จับจังหวะไม่ได้')}
          ${row('ห่างจากจุดสูงสุด', ...both((c) => fmtPct(c.drawdown, 0)))}
          ${row('ขึ้นลง 30 วัน', ...both((c, s) => signed(change(s, last, 30))))}
          ${row('ขึ้นลง 1 ปี', ...both((c, s) => signed(change(s, last, 365))))}
          ${row('ขึ้นลงในช่วงกราฟ', signed(ra), signed(rb), `ตั้งแต่ ${fmtDate(ch.dates[s0])}`)}
          ${row(`ลงทุน ${fmtUsd(amount)} ตั้งแต่ต้นช่วง → ตอนนี้`, ...[ra, rb].map((r) => (r == null ? '–' : `<b>${fmtUsd(worth(r))}</b><div class="coin-name">${usdSigned(worth(r) - amount)}</div>`)), 'คิดจากราคาอย่างเดียว ไม่รวมค่าธรรมเนียม')}
          ${row('ลงลึกสุดในช่วงกราฟ', ...both((c, s) => signed(maxDrawdown(s, s0, last))), 'จากยอดระหว่างทาง')}
          ${row('ความผันผวนต่อปี', ...vol.map((v) => (v == null ? '–' : `${Math.round(v)}%`)), 'ยิ่งสูง = ยิ่งเหวี่ยงแรง (1 ปีล่าสุด)')}
          ${row('คะแนนเคยได้ผลไหม', ...both((c) => relHtml(c)))}
          ${row('มีข้อมูลตั้งแต่', ...both((c, s) => fmtDate(ch.dates[firstIndex(s)])))}
        </tbody>
      </table>`;

    // ---------- the pair's own record ----------
    const rec = pairRecord(sa, sb, ch.dates.length);
    const la = A.lth?.score;
    const lb = B.lth?.score;
    const nowKey = la == null || lb == null ? null : la - lb >= GAP ? 'aHigh' : lb - la >= GAP ? 'bHigh' : 'close';
    const labels = {
      all: 'ทุกวัน (ไว้เทียบ)',
      aHigh: `คะแนน ${esc(A.symbol)} สูงกว่า ${GAP}+ จุด`,
      close: `คะแนนต่างกันไม่ถึง ${GAP} จุด`,
      bHigh: `คะแนน ${esc(B.symbol)} สูงกว่า ${GAP}+ จุด`,
    };
    el('cmp-record-title').innerHTML = `ในอดีต ซื้อแล้วถือ 1 ปี ${tag('a', A.symbol)} ชนะ ${tag('b', B.symbol)} บ่อยแค่ไหน`;
    el('cmp-record').innerHTML = rec.all.n
      ? `<table class="cmp">
        <thead><tr><th>ซื้อตอนที่</th><th class="num">${esc(A.symbol)} ชนะ</th><th class="num" title="${esc(A.symbol)} ขึ้นมากกว่า (+) หรือน้อยกว่า (−) ${esc(B.symbol)} กี่ % (ค่ากลาง)">ค่ากลาง</th><th class="num">วัน · ช่วง</th></tr></thead>
        <tbody>${Object.keys(labels).map((k) => {
          const o = rec[k];
          const cells = o.n
            ? `<td class="num">${Math.round(o.win)}%</td><td class="num">${signed(o.median)}</td><td class="num">${o.n.toLocaleString('en-US')}${k === 'all' ? '' : ` · ${o.episodes}`}${k !== 'all' && (o.n < 365 || o.episodes < 2) ? '<div class="coin-name">ตัวอย่างน้อย</div>' : ''}</td>`
            : '<td class="num muted-cell" colspan="3">ไม่เคยเกิด</td>';
          return `<tr${k === nowKey ? ' class="now"' : ''}><td>${labels[k]}</td>${cells}</tr>`;
        }).join('')}</tbody></table>`
      : `<p class="muted">ยังไม่มีช่วงที่ทั้งสองเหรียญมีข้อมูลครบ 1 ปีให้วัด</p>`;
    const nowGap = la == null || lb == null ? '' : ` · ตอนนี้คะแนน ${esc(A.symbol)} ${Math.round(la)} / ${esc(B.symbol)} ${Math.round(lb)} (แถวพื้นเข้ม)`;
    const p = pooled(d, list);
    el('cmp-note').innerHTML = `* "ชนะ" = ถ้าซื้อวันนั้นแล้วถือ 1 ปี เหรียญไหนขึ้นมากกว่า (หรือลงน้อยกว่า) · "ค่ากลาง" = ${esc(A.symbol)} ขึ้นมากกว่า (+) หรือน้อยกว่า (−) ${esc(B.symbol)} กี่ % · "ช่วง" = จำนวนครั้งที่เกิดแยกกันเกิน 30 วัน${nowGap}<br>
      ทดสอบรวมทุก ${p.pairs} คู่ในหน้านี้: เมื่อคะแนนระยะยาวต่างกัน ${GAP} จุดขึ้นไป เหรียญที่คะแนนสูงกว่าชนะ <b>${p.big == null ? '–' : Math.round(p.big)}%</b> ของครั้ง · ต่างกันน้อยกว่านั้นชนะ ${p.small == null ? '–' : Math.round(p.small)}% — แทบไม่ต่างจากโยนเหรียญ คะแนนบอกว่าเหรียญไหนถูกเทียบกับตัวเอง แต่ไม่ได้บอกว่าจะชนะอีกเหรียญ ·
      เหรียญอื่นรวมกันชนะ BTC แค่ <b>${p.altWin == null ? '–' : Math.round(p.altWin)}%</b> ของช่วง 1 ปี${p.beatBtc.length ? ` (ที่ชนะเกินครึ่งมีแค่ ${p.beatBtc.map(esc).join(', ')})` : ''} ·
      ราคา A/B ที่อยู่ต่ำในกรอบ 1 ปีก็ไม่ได้บอกว่า A จะกลับมาชนะ (ทดสอบเมื่อ พ.ย. 2026: A ชนะ 52% เทียบ 49% ตอนอยู่สูง) ·
      ตัวเลขส่วนใหญ่มาจากเหรียญที่ยังอยู่ top 10 วันนี้ ผลจริงอาจแย่กว่า`;

    st.view = { ch, A, B, sa, sb };
    drawCharts(ch, A.symbol, B.symbol, sa, sb, s0, last);
    renderPinReadout();
  }

  // ---------- จุด A → จุด B: the same money in both coins between two clicked days ----------

  // A shaded span between the pins, and a line, tag and dot per line at each pin.
  const pinMarks = {
    id: 'cmpPins',
    afterDatasetsDraw(chart) {
      const marks = [['A', st.pins.a], ['B', st.pins.b]]
        .map(([name, day]) => ({ name, i: day ? chart.data.labels.indexOf(day) : -1 }))
        .filter((m) => m.i >= 0);
      if (!marks.length) return;
      const { ctx, chartArea, scales } = chart;
      const accent = cssVar('--accent');
      const xs = marks.map((m) => scales.x.getPixelForValue(m.i));
      ctx.save();
      if (marks.length === 2) {
        ctx.fillStyle = cssVar('--future');
        ctx.fillRect(Math.min(...xs), chartArea.top, Math.abs(xs[1] - xs[0]), chartArea.bottom - chartArea.top);
      }
      marks.forEach((m, k) => {
        const x = xs[k];
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top + 16);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
        chart.data.datasets.forEach((ds) => {
          const v = ds.data[m.i];
          if (v == null) return;
          ctx.fillStyle = ds.borderColor;
          ctx.strokeStyle = cssVar('--surface');
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, scales.y.getPixelForValue(v), 4.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        });
        ctx.fillStyle = accent;
        ctx.fillRect(x - 8, chartArea.top, 16, 16);
        ctx.fillStyle = '#fff';
        ctx.font = `700 11px ${CHART_FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(m.name, x, chartArea.top + 8);
      });
      ctx.restore();
    },
  };

  // A click on any of the three charts: first click = A, second = B (A is always
  // the earlier day), a third starts over.
  function pinAt(evt, els, chart) {
    const day = chart.data.labels[Math.round(chart.scales.x.getValueForPixel(evt.x))];
    if (day == null) return;
    const p = st.pins;
    if (!p.a || p.b) { p.a = day; p.b = null; } else if (day !== p.a) {
      p.b = day;
      if (p.b < p.a) [p.a, p.b] = [p.b, p.a];
    }
    for (const c of Object.values(charts)) c.render();
    renderPinReadout();
  }

  function renderPinReadout() {
    const box = el('cmp-pins');
    const v = st.view;
    if (!box || !v) return;
    const { ch, A, B, sa, sb } = v;
    const amount = st.amount;
    const p = st.pins;
    if (!p.a) {
      box.innerHTML = `<span class="ab-hint">ปักหมุด: คลิกบนกราฟ 2 จุด (A แล้ว B) เพื่อดูว่าถ้าลงทุน ${fmtUsd(amount)} ที่จุด A ในแต่ละเหรียญ พอถึงจุด B จะเป็นกี่ดอลลาร์</span>`;
      return;
    }
    const clear = '<button type="button" class="ab-clear">ล้างหมุด</button>';
    const ia = lastIndexOnOrBefore(ch.dates, p.a);
    const priceAt = (s, i) => (at(s, i) == null ? 'ไม่มีข้อมูล' : fmtUsd(at(s, i)));
    if (!p.b) {
      box.innerHTML = `<div class="cmp-pin-line"><span><b class="ab-tag">A</b> ${fmtDate(p.a)} · ${tag('a', A.symbol)} ${priceAt(sa, ia)} · ${tag('b', B.symbol)} ${priceAt(sb, ia)}</span><span class="ab-hint">คลิกอีกจุดเพื่อเลือก B</span>${clear}</div>`;
    } else {
      const ib = lastIndexOnOrBefore(ch.dates, p.b);
      const result = (s) => {
        const pa = at(s, ia);
        const pb = at(s, ib);
        return pa && pb ? { pa, pb, pct: (pb / pa - 1) * 100, value: (amount * pb) / pa } : null;
      };
      const ra = result(sa);
      const rb = result(sb);
      const line = (side, c, r) => `<tr><td>${tag(side, c.symbol)}</td>${r
        ? `<td class="num">${fmtUsd(r.pa)} → ${fmtUsd(r.pb)}</td><td class="num">${signed(r.pct, 1)}</td><td class="num"><b>${fmtUsd(r.value)}</b><div class="coin-name">${usdSigned(r.value - amount)}</div></td>`
        : '<td class="num muted-cell" colspan="3">ไม่มีข้อมูลวันนั้น</td>'}</tr>`;
      box.innerHTML = `
        <div class="cmp-pin-line"><span><b class="ab-tag">A</b> ${fmtDate(p.a)}</span><span>→</span><span><b class="ab-tag">B</b> ${fmtDate(p.b)}</span><span class="ab-span">${daysBetween(p.a, p.b)}</span>${clear}</div>
        <div class="table-wrap"><table class="cmp">
          <thead><tr><th>เหรียญ</th><th class="num">ราคา A → B</th><th class="num">ขึ้นลง</th><th class="num">ลงทุน ${fmtUsd(amount)} ได้</th></tr></thead>
          <tbody>${line('a', A, ra)}${line('b', B, rb)}</tbody>
        </table></div>
        ${ra && rb ? `<p class="cmp-pin-verdict">ลงทุนเท่ากันที่จุด A → ${moreText(A.symbol, ra.value, B.symbol, rb.value)} ที่จุด B</p>` : ''}`;
    }
    box.querySelector('.ab-clear').addEventListener('click', () => {
      st.pins = { a: null, b: null };
      for (const c of Object.values(charts)) c.render();
      renderPinReadout();
    });
  }

  function drawCharts(ch, symA, symB, sa, sb, s0, last) {
    for (const k of Object.keys(charts)) { charts[k].destroy(); delete charts[k]; }
    el('cmp-perf-label').textContent = `ถ้าลงทุน ${fmtUsd(st.amount)} ในแต่ละเหรียญตั้งแต่ต้นช่วง (สเกล log)`;
    el('cmp-legend-perf').innerHTML = `${tag('a', symA)} ${tag('b', symB)}`;
    el('cmp-legend-lth').innerHTML = `${tag('a', symA)} ${tag('b', symB)}`;
    el('cmp-ratio-title').innerHTML = `ราคา ${esc(symA)} ในหน่วย ${esc(symB)} (${esc(symA)}/${esc(symB)}, สเกล log) — เส้นขึ้น = ${esc(symA)} ชนะ ${esc(symB)}`;
    for (const [side, sym, s] of [['a', symA, sa], ['b', symB, sb]]) {
      el(`cmp-price-${side}-title`).innerHTML = `<span><span class="key key-${side}"></span>ราคา <b>${esc(sym)}</b> (ดอลลาร์, สเกล log)</span> <span class="coin-name">ล่าสุด ${fmtUsd(at(s, last))}</span>`;
      el(`cmp-price-${side}`).setAttribute('aria-label', `กราฟราคา ${sym} (ดอลลาร์)`);
    }
    if (!window.Chart || last <= s0) return;

    const labels = ch.dates.slice(s0, last + 1);
    const idx = labels.map((_, j) => s0 + j);
    const amount = st.amount;
    const a0 = at(sa, s0);
    const b0 = at(sb, s0);
    const perfA = idx.map((i) => { const v = at(sa, i); return v == null ? null : (amount * v) / a0; });
    const perfB = idx.map((i) => { const v = at(sb, i); return v == null ? null : (amount * v) / b0; });
    const ratio = idx.map((i) => { const x = at(sa, i); const y = at(sb, i); return x && y ? x / y : null; });
    const mode = st.range === 'all' ? 'all' : 'short';
    const cA = cssVar('--coin-a');
    const cB = cssVar('--coin-b');
    const fixedWidth = (axis) => { axis.width = Y_AXIS_WIDTH; };
    // Every chart here can be clicked to set จุด A / จุด B.
    const clickable = (opts) => {
      opts.scales.x.ticks.maxTicksLimit = 6;
      opts.onClick = pinAt;
      return opts;
    };

    const perfOpts = clickable(baseOptions(mode));
    perfOpts.scales.y = { ...logPriceAxis(), afterFit: fixedWidth };
    perfOpts.plugins.tooltip.callbacks.label = (item) => ` ${item.dataset.label}: ${fmtUsd(item.parsed.y)} (${fmtPct((item.parsed.y / amount - 1) * 100, 0)})`;
    perfOpts.plugins.tooltip.callbacks.footer = (items) => {
      const j = items[0].dataIndex;
      const x = perfA[j];
      const y = perfB[j];
      if (!x || !y) return '';
      const [w, l, vw, vl] = x >= y ? [symA, symB, x, y] : [symB, symA, y, x];
      return `${w} ได้มากกว่า ${l} ${fmtUsd(vw - vl)}`;
    };
    charts.perf = new Chart(el('cmp-perf'), {
      type: 'line',
      data: { labels, datasets: [{ label: symA, data: perfA, ...lineStyle(cA) }, { label: symB, data: perfB, ...lineStyle(cB) }] },
      options: perfOpts,
      plugins: [baselineAt(amount), crosshair, hoverSync, pinMarks],
    });

    const ratioOpts = clickable(baseOptions(mode));
    ratioOpts.scales.y = { ...logAxis(fmtRatio), afterFit: fixedWidth };
    ratioOpts.plugins.tooltip.callbacks.label = (item) => ` 1 ${symA} = ${fmtRatio(item.parsed.y)} ${symB}`;
    charts.ratio = new Chart(el('cmp-ratio'), {
      type: 'line',
      data: { labels, datasets: [{ label: `${symA}/${symB}`, data: ratio, ...lineStyle(cssVar('--price'), 1.5) }] },
      options: ratioOpts,
      plugins: [crosshair, hoverSync, pinMarks],
    });

    const lthOpts = clickable(baseOptions(mode));
    lthOpts.plugins.tooltip.callbacks.label = (item) => ` ${item.dataset.label}: ${item.parsed.y == null ? '–' : `${Math.round(item.parsed.y)}%`}`;
    lthOpts.scales.y = {
      min: 0,
      max: 100,
      position: 'right',
      afterFit: fixedWidth,
      grid: { color: cssVar('--grid') },
      border: { display: false },
      ticks: { color: cssVar('--muted'), stepSize: 20, callback: (v) => `${v}%` },
    };
    charts.lth = new Chart(el('cmp-lth'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: symA, data: idx.map((i) => lthAt(sa, i)), ...lineStyle(cA) },
          { label: symB, data: idx.map((i) => lthAt(sb, i)), ...lineStyle(cB) },
        ],
      },
      options: lthOpts,
      plugins: [scoreBands(80, 20), crosshair, hoverSync, pinMarks],
    });
    // Each coin's own price, on its own axis (BTC $100k and DOGE $0.2 cannot share one).
    const priceChart = (side, sym, s, color) => {
      const opts = clickable(baseOptions(mode));
      opts.scales.y = { ...logPriceAxis(), afterFit: fixedWidth };
      opts.plugins.tooltip.callbacks.label = (item) => ` ราคา ${sym}: ${fmtUsd(item.parsed.y)}`;
      return new Chart(el(`cmp-price-${side}`), {
        type: 'line',
        data: { labels, datasets: [{ label: sym, data: idx.map((i) => at(s, i)), ...lineStyle(color) }] },
        options: opts,
        plugins: [crosshair, hoverSync, pinMarks],
      });
    };
    charts.priceA = priceChart('a', symA, sa, cA);
    charts.priceB = priceChart('b', symB, sb, cB);
    pair(charts.perf, charts.ratio, charts.lth, charts.priceA, charts.priceB);
    for (const c of Object.values(charts)) c.canvas.style.cursor = 'crosshair';
  }

  // ---------- controls ----------

  function pick(side, value) {
    const other = side === 'a' ? 'b' : 'a';
    if (value === st[other]) st[other] = st[side]; // picking the other coin swaps them
    st[side] = value;
    save();
    if (st.data) render(st.data);
  }

  function bind() {
    const a = el('cmp-a');
    if (!a) return;
    a.addEventListener('change', () => pick('a', a.value));
    el('cmp-b').addEventListener('change', () => pick('b', el('cmp-b').value));
    el('cmp-swap').addEventListener('click', () => {
      [st.a, st.b] = [st.b, st.a];
      save();
      if (st.data) render(st.data);
    });
    // เงินลงทุน: the summary, the table, the chart and the pins all use it.
    const amount = el('cmp-amount');
    amount.value = st.amount;
    amount.addEventListener('input', () => {
      const v = Number(amount.value);
      if (!(v > 0)) return; // keep the last good amount while the box is empty or 0
      st.amount = v;
      save();
      if (st.data) render(st.data);
    });
    el('cmp-range').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-v]');
      if (!btn) return;
      st.range = btn.dataset.v;
      save();
      if (st.data) render(st.data);
    });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (st.data) render(st.data); });
  }

  bind();
  window.renderCompare = render;
})();
