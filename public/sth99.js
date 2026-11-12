'use strict';
// "เตือน STH" card on the BTC, gold and altcoin pages (data: /api/sth-alert,
// built in lib/sth99.js). The alert level can be set from 90 to 100 (default
// 99) and the card can watch every asset or just one; both are remembered in
// this browser. A one-line strip while nothing has reached the level; the card
// opens by itself when one does. Optional browser notifications while a page
// stays open. Shared helpers come from common.js.

(() => {
  const el = (id) => document.getElementById(id);
  const NOTIFY_KEY = 'sth99-notify';
  const SEEN_KEY = 'sth99-notified';
  const LEVEL_KEY = 'sth99-level';
  const ASSET_KEY = 'sth99-asset';
  const ALL = 'ALL';
  const store = {
    get(key, fallback) {
      try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not remembered: fine */ }
    },
  };
  const canNotify = 'Notification' in window;
  const tile = (label, value, sub) => `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-sub">${sub}</div></div>`;
  const signed = (v, d = 1) => (v == null ? '–' : `<span class="${v >= 0 ? 'up' : 'down'}">${fmtPct(v, d)}</span>`);
  const share = (o, key = 'over') => (o?.n ? `${o[key]} / ${o.n}` : '–');
  const pctOf = (o, key = 'over') => (o?.n ? Math.round((100 * o[key]) / o.n) : null);
  const score = (v) => (v == null ? '–' : (Math.floor(v * 10) / 10).toFixed(1));
  const symName = (s) => (s === 'GOLD' ? 'ทองคำ' : s);
  const assetName = (a) => symName(a.symbol);
  // 156 → "156 วัน"; 1,676 → "1,676 วัน (4.6 ปี)"
  const dur = (d) => (d == null ? '–' : d >= 365 ? `${d.toLocaleString('en-US')} วัน (${(d / 365.25).toFixed(1)} ปี)` : `${d} วัน`);
  const durShort = (d) => (d == null ? '–' : d >= 365 ? `${(d / 365.25).toFixed(1)} ปี` : `${d} วัน`);
  const yearOf = (d) => new Date(`${d}T00:00:00Z`).getUTCFullYear();

  const RANGE_KEY = 'sth99-range';
  const RANGE_DAYS = { '1y': 366, '4y': 1462, all: Infinity };
  let last = null;
  let level = store.get(LEVEL_KEY, null);
  let asset = store.get(ASSET_KEY, ALL);
  let range = RANGE_DAYS[store.get(RANGE_KEY, 'all')] ? store.get(RANGE_KEY, 'all') : 'all';
  const seriesCache = {}; // symbol → { at, data } from /api/sth-series
  let priceChart = null;
  let scoreChart = null;
  let hitsOpen = false; // "ดูทุกครั้ง" list stays open across the 1-minute refresh
  const seenAlerts = new Set(); // alerts shown in this visit (opens the card once each)

  // Time left before the crypto day closes (00:00 UTC = 07:00 in Thailand).
  function cryptoClose() {
    const now = Date.now();
    const next = Math.ceil(now / 86400000) * 86400000;
    const min = Math.round((next - now) / 60000);
    return `อีก ${Math.floor(min / 60)} ชม. ${min % 60} นาที`;
  }

  function render(d) {
    const panel = el('sth99-panel');
    if (!panel || !d?.now?.length || !d.byLevel) return;
    last = d;
    panel.hidden = false;
    if (!d.levels.includes(level)) level = d.defaultLevel;
    const one = asset !== ALL ? d.now.find((a) => a.symbol === asset) : null;
    if (!one) asset = ALL;
    const L = level;
    const lv = d.byLevel[L];
    const near = (a) => a.sth != null && a.sth >= L - d.watchGap && a.sth < L;
    const scope = one ? [one] : d.now;
    const alerts = scope.filter((a) => a.sth != null && a.sth >= L);
    const closed = scope.filter((a) => a.prevSth != null && a.prevSth >= L && !(a.sth >= L));
    const watch = scope.filter(near);
    panel.classList.toggle('sth99-on', alerts.length > 0);

    // The record being shown: one asset's, or every asset's pooled.
    const own = one ? lv.perAsset[one.symbol] : null;
    const next = one ? own : lv.next;
    const day3 = one ? own.day3 : lv.day3;
    const day7 = one ? own.day7 : lv.day7;
    const events = one ? own.events : lv.events;
    const base = one ? d.baseBy?.[one.symbol] : d.base;
    const who = one ? assetName(one) : 'ทุกสินทรัพย์';
    const hits = d.hits.filter((h) => h.sth >= L && (!one || h.symbol === one.symbol));

    const record = next?.n ? `${one ? `${esc(who)}: ` : ''}ในอดีตซื้อตอนปิดวันที่ถึง ${L} แล้วขายตอนปิดวันถัดไป ได้เกิน 1% <b>${share(next)}</b> ครั้ง` : `${esc(who)} ยังไม่เคยปิดวันที่ ${L} ขึ้นไป`;
    let head;
    if (alerts.length) {
      head = `<b>⚠ STH ถึง ${L}: ${alerts.map((a) => `${esc(assetName(a))} ${score(a.sth)}`).join(' · ')}</b> — คะแนนวันนี้ยังไม่ปิด รอดูตอนใกล้ปิดวัน`;
    } else if (closed.length) {
      head = `<b>${closed.map((a) => `${esc(assetName(a))} ปิดวัน ${fmtDate(a.prevDate)} ที่ ${score(a.prevSth)}`).join(' · ')}</b> — ถ้าซื้อตอนปิดวันนั้น ตามผลทดสอบจะขายตอนปิดวันนี้`;
    } else if (one) {
      const gap = one.sth == null ? null : L - one.sth;
      head = `${esc(who)} STH ตอนนี้ <b>${score(one.sth)}</b>${gap == null ? '' : ` (ต้องถึง ${L} ห่างอีก ${gap.toFixed(1)} จุด)`}${own?.waitDays != null ? ` · รอมาแล้ว ${dur(own.waitDays)}` : ''}`;
    } else {
      const top = d.now.filter((a) => a.sth != null).slice(0, 3);
      const waited = lv.wait.days != null ? ` (รอมาแล้ว ${dur(lv.wait.days)})` : '';
      head = `ยังไม่มีสินทรัพย์ไหนถึง ${L}${waited} · ${watch.length ? 'ใกล้สุด' : 'สูงสุดตอนนี้'} ${top.map((a) => `${esc(assetName(a))} ${Math.round(a.sth)}`).join(', ')}`;
    }
    el('sth99-summary').innerHTML = `<span class="sth99-title">เตือน STH ${L}${one ? ` · ${esc(who)}` : ''}</span> <span>${head}</span> <span class="sth99-record">${record}</span>`;

    // Open the card by itself once for each new alert in this visit.
    const details = el('sth99-details');
    for (const a of [...alerts, ...closed]) {
      const key = `${a.symbol}|${a.date}|${L}|${a.sth >= L ? 'live' : 'closed'}`;
      if (!seenAlerts.has(key)) { seenAlerts.add(key); details.open = true; }
    }

    // Days since this asset last closed at the level, against its own usual wait.
    function waitCell(a) {
      if (a.sth != null && a.sth >= L) return '<b>ถึงแล้ววันนี้</b>';
      const o = lv.perAsset[a.symbol];
      if (o?.waitDays == null) {
        const years = a.scoredSince ? ((Date.parse(d.today) - Date.parse(a.scoredSince)) / 31557600000).toFixed(1) : null;
        return `<span class="coin-name">ยังไม่เคยถึง${years ? ` (ข้อมูล ${years} ปี)` : ''}</span>`;
      }
      const t = o.typicalWait;
      return `${durShort(o.waitDays)}<div class="coin-name">${t?.n ? `ปกติ ~${durShort(t.avg)}` : 'เคยถึงช่วงเดียว'}</div>`;
    }
    const row = (a) => {
      const o = lv.perAsset[a.symbol];
      const cls = [a.sth >= L ? 'sth99-hit' : near(a) ? 'sth99-near' : '', one && a.symbol === one.symbol ? 'sth99-sel' : ''].join(' ');
      const tag = a.sth >= L ? '<span class="pill tone-strong-buy"><i></i>ถึงแล้ว</span>' : near(a) ? '<span class="pill tone-buy"><i></i>ใกล้</span>' : '';
      return `<tr class="${cls}" data-asset="${esc(a.symbol)}">
        <td><button type="button" class="linklike sth99-pick" data-asset="${esc(a.symbol)}" title="ดูเฉพาะ ${esc(assetName(a))}"><b>${esc(assetName(a))}</b></button> ${tag}</td>
        <td class="num"><b>${score(a.sth)}</b><div class="coin-name sth99-sub">${fmtUsd(a.price)}</div></td>
        <td class="num">${score(a.prevSth)}<div class="coin-name sth99-sub">${a.prevDate ? fmtDate(a.prevDate) : ''}</div></td>
        <td class="num">${o?.n ? `${o.over} / ${o.n}` : '<span class="coin-name">ไม่เคยถึง</span>'}</td>
        <td class="num">${waitCell(a)}</td>
      </tr>`;
    };

    let waitTile;
    if (one) {
      const t = own.typicalWait;
      waitTile = own.waitDays != null
        ? tile(`รอมาแล้วกี่วัน (${esc(who)})`, dur(own.waitDays), `ครั้งล่าสุดปิดที่ ${L} ขึ้นไปเมื่อ ${fmtDate(own.lastHit)} · ปกติรอระหว่างครั้ง: ${t.n ? `ค่ากลาง ${dur(t.median)} · เฉลี่ย ${dur(t.avg)} (สั้นสุด ${dur(t.min)} นานสุด ${dur(t.max)})` : 'เคยถึงช่วงเดียว ยังคิดไม่ได้'} · เกิดราวปีละ ${own.perYear.toFixed(1)} ครั้ง`)
        : tile(`รอมาแล้วกี่วัน (${esc(who)})`, '–', `ยังไม่เคยปิดวันที่ ${L} ขึ้นไป ตั้งแต่มีข้อมูล ${one.scoredSince ? yearOf(one.scoredSince) : ''}`);
    } else {
      const w = lv.wait;
      waitTile = w.days != null
        ? tile('รอมาแล้วกี่วัน (ทุกสินทรัพย์ในเว็บ)', dur(w.days), `ครั้งล่าสุด ${esc((w.lastSymbols || []).map(symName).join(', '))} ปิดที่ ${L} ขึ้นไปเมื่อ ${fmtDate(w.last)} ·
            ปกติรอระหว่างครั้ง: ${w.typical.n ? `ค่ากลาง ${dur(w.typical.median)} · เฉลี่ย ${dur(w.typical.avg)} (สั้นสุด ${dur(w.typical.min)} นานสุด ${dur(w.typical.max)})` : 'ยังไม่พอคิด'} ·
            ตั้งแต่ ${yearOf(w.from)} เกิดราวปีละ ${w.perYear.toFixed(1)} ครั้ง ไม่สม่ำเสมอ มักมากระจุกตอนตลาดถล่ม`)
        : tile('รอมาแล้วกี่วัน', '–', `ยังไม่เคยมีวันที่ถึง ${L}`);
    }
    const hitRow = (h) => `<tr>
      <td>${fmtDate(h.date)}</td><td><b>${esc(symName(h.symbol))}</b></td><td class="num">${score(h.sth)}</td>
      <td class="num">${fmtUsd(h.price)} → ${fmtUsd(h.next)}</td><td class="num">${signed(h.r1, 2)}</td><td class="num">${signed(h.r3)}</td><td class="num">${signed(h.r7)}</td></tr>`;
    // Every level side by side for the same scope: lower levels come more often and win less often.
    const levelRow = (l) => {
      const z = d.byLevel[l];
      const x = one ? z.perAsset[one.symbol] : z.next;
      const x3 = one ? x.day3 : z.day3;
      const ev = one ? x.events : z.events;
      const perYear = one ? x.perYear : z.wait.perYear;
      const tw = one ? x.typicalWait : z.wait.typical;
      return `<tr class="${l === L ? 'now' : ''}" data-level="${l}">
        <td><b>${l}</b>${l === d.defaultLevel ? ' <span class="coin-name">(เริ่มต้น)</span>' : ''}</td>
        <td class="num">${x?.n ? `${pctOf(x)}%<div class="coin-name sth99-sub">${share(x)}</div>` : '–'}</td>
        <td class="num">${x3?.n ? `${pctOf(x3)}%<div class="coin-name sth99-sub">ลงเกิน 1% ${pctOf(x3, 'downOver')}%</div>` : '–'}</td>
        <td class="num">${ev}<div class="coin-name sth99-sub">ปีละ ~${perYear.toFixed(1)}</div></td>
        <td class="num">${tw?.n ? durShort(tw.median) : '–'}</td>
      </tr>`;
    };
    const notifyOn = store.get(NOTIFY_KEY, false) && canNotify && Notification.permission === 'granted';
    const baseShare = base?.n ? Math.round((100 * base.over) / base.n) : null;
    const options = [`<option value="${ALL}">ทุกสินทรัพย์ (${d.assets})</option>`, ...d.now.map((a) => `<option value="${esc(a.symbol)}">${esc(assetName(a))} — STH ${Math.round(a.sth ?? 0)}</option>`)].join('');

    el('sth99-body').innerHTML = `
      <div class="sth99-levels">
        <span class="field">ระดับเตือน</span>
        <div class="seg sth99-seg" role="group" aria-label="ระดับคะแนน STH ที่ให้เตือน">
          ${d.levels.map((l) => `<button type="button" data-level="${l}" class="${l === L ? 'on' : ''}">${l}</button>`).join('')}
        </div>
        <label class="field">ดู <select id="sth99-asset" aria-label="เลือกสินทรัพย์ที่จะดู">${options}</select></label>
        <span class="coin-name">ระดับต่ำลง = เกิดบ่อยขึ้น แต่ได้ผลน้อยลง (ดูตารางเทียบด้านล่าง) · เว็บจำค่าที่เลือกไว้</span>
      </div>
      <p class="advice"><b>วิธีที่ทดสอบ:</b> ซื้อตอนราคาปิดของวันที่คะแนนระยะสั้น (STH) ${one ? `ของ ${esc(who)} ` : ''}ถึง ${L} ขึ้นไป แล้ว<b>ขายตอนราคาปิดวันถัดไป</b> ·
        คริปโตปิดวันเวลา <b>07:00 น.</b> (${cryptoClose()}) · ทองปิดราว 04:00–05:00 น. · ระหว่างวันคะแนนขยับตามราคาสด อาจแตะ ${L} แล้วหลุดก่อนปิดได้</p>
      <div class="stats">
        ${waitTile}
        ${tile(`วันถัดไปขึ้นเกิน 1%${one ? ` (${esc(who)})` : ''}`, next?.n ? `${share(next)} วัน (${pctOf(next)}%)` : '–', next?.n ? `ขึ้นเลย ${share(next, 'up')} วัน · ค่ากลาง ${signed(next.median)} · แย่สุด ${signed(next.worst, 2)}${baseShare == null ? '' : ` · วันธรรมดา${one ? `ของ ${esc(who)}` : ''}ขึ้นเกิน 1% แค่ ${baseShare}%`}` : `ยังไม่เคยมีวันที่ถึง ${L}`)}
        ${tile('ถ้าถือ 3 วัน', day3?.n ? `${share(day3)} (${pctOf(day3)}%)` : '–', day3?.n ? `ลงเกิน 1% ${share(day3, 'downOver')} วัน · ค่ากลาง ${signed(day3.median)} → ${pctOf(day3) < pctOf(next) - 10 ? 'เป็นการเด้งระยะสั้น ถือนานกว่านี้ผลแย่ลง' : 'ที่ระดับนี้ถือ 3 วันไม่ได้แย่กว่าขายวันถัดไป'}` : '')}
        ${tile('ถ้าถือ 7 วัน', day7?.n ? `${share(day7)} (${pctOf(day7)}%)` : '–', day7?.n ? `ค่ากลาง ${signed(day7.median)} · แย่สุด ${signed(day7.worst)}` : '')}
        ${tile('จำนวนครั้ง', `${next?.n ?? 0} วัน · ${events} เหตุการณ์`, one ? `${esc(who)} ตั้งแต่ ${one.scoredSince ? yearOf(one.scoredSince) : '–'} · ตัวอย่างของเหรียญเดียวมีน้อย ดูแบบ "ทุกสินทรัพย์" ประกอบด้วย` : `จาก ${d.assets} สินทรัพย์ในเว็บ ตั้งแต่ ${yearOf(d.since)} · หลายเหรียญมักถึงพร้อมกันในวันตลาดถล่ม ยิ่งระดับสูงตัวอย่างยิ่งน้อย`)}
      </div>
      ${one ? `<div class="sth99-chart">
        <div class="chart-title">
          <span>ราคา ${esc(who)} · จุด = วันที่ STH ปิดที่ ${L} ขึ้นไป</span>
          <span class="legend sth99-legend">
            <span><i class="sth99-dot win"></i>วันถัดไปขึ้นเกิน 1%</span>
            <span><i class="sth99-dot lose"></i>ไม่ถึง 1%</span>
            <span><i class="sth99-dot wait"></i>รอผล</span>
          </span>
          <div class="seg sth99-range" role="group" aria-label="ช่วงเวลาของกราฟ">
            ${[['1y', '1 ปี'], ['4y', '4 ปี'], ['all', 'ทั้งหมด']].map(([v, t]) => `<button type="button" data-range="${v}" class="${v === range ? 'on' : ''}">${t}</button>`).join('')}
          </div>
        </div>
        <div class="chart-wrap chart-sth99-price"><canvas id="sth99-price" aria-label="กราฟราคา ${esc(who)} พร้อมจุดวันที่คะแนน STH ถึง ${L}"></canvas></div>
        <div class="chart-title">คะแนน STH ของ ${esc(who)} · เส้นประ = ระดับ ${L} (พื้นเขียว = ถึงระดับ)</div>
        <div class="chart-wrap chart-sth99-score"><canvas id="sth99-score" aria-label="กราฟคะแนน STH ของ ${esc(who)} เทียบเส้นระดับ ${L}"></canvas></div>
        <p class="coin-name" id="sth99-chart-msg"></p>
      </div>` : ''}
      <div class="sth99-grid">
        <div class="table-wrap">
          <table class="sth99-now">
            <thead><tr><th>ตอนนี้ <span class="coin-name sth99-sub">(กดชื่อเพื่อดูเฉพาะตัว)</span></th><th class="num">STH วันนี้</th><th class="num">ปิดวันล่าสุด</th><th class="num" title="ในอดีต ซื้อตอนปิดวันที่ถึง ${L} ขึ้นไป ขายตอนปิดวันถัดไป ได้เกิน 1% กี่ครั้ง">เคยได้เกิน 1%</th><th class="num" title="นับจากวันขาย (วันถัดจากวันที่ปิดที่ ${L} ขึ้นไปครั้งล่าสุด) · ปกติ = เฉลี่ยที่สินทรัพย์นั้นเคยรอระหว่างครั้ง">รอมาแล้ว</th></tr></thead>
            <tbody>${d.now.map(row).join('')}</tbody>
          </table>
        </div>
        <div>
          <h3 class="subhead">เทียบทุกระดับ${one ? ` (${esc(who)})` : ''} <span class="count">(กดแถวเพื่อเลือก)</span></h3>
          <div class="table-wrap">
            <table class="sth99-levels-table">
              <thead><tr><th>ระดับ</th><th class="num" title="ซื้อตอนปิดวันที่ถึงระดับนี้ ขายตอนปิดวันถัดไป ได้เกิน 1% กี่ % ของครั้ง">วันถัดไป &gt;1%</th><th class="num" title="ถ้าถือ 3 วันแทน ได้เกิน 1% กี่ % ของครั้ง">ถือ 3 วัน &gt;1%</th><th class="num" title="วันที่ถึงระดับนี้ที่ห่างกันเกิน 7 วัน">เหตุการณ์</th><th class="num" title="${one ? 'ของสินทรัพย์นี้ (ค่ากลาง)' : 'ทุกสินทรัพย์ในเว็บ ตั้งแต่ ก.ย. 2017 (ค่ากลาง)'}">รอ (ค่ากลาง)</th></tr></thead>
              <tbody>${d.levels.map(levelRow).join('')}</tbody>
            </table>
          </div>
          <p class="sth99-notify">
            <button type="button" class="btn" id="sth99-notify-btn" ${canNotify && Notification.permission !== 'denied' ? '' : 'disabled'}>${notifyOn ? '🔕 ปิดแจ้งเตือน' : '🔔 เปิดแจ้งเตือนในเบราว์เซอร์'}</button>
            <span class="coin-name">${!canNotify ? 'เบราว์เซอร์นี้แจ้งเตือนไม่ได้' : Notification.permission === 'denied' ? 'เบราว์เซอร์บล็อกการแจ้งเตือนของเว็บนี้ไว้ ต้องเปิดอนุญาตในตั้งค่าเบราว์เซอร์' : `แจ้งเมื่อ${one ? esc(who) : 'สินทรัพย์ไหน'}ถึง ${L} (ครั้งเดียวต่อวัน) · ทำงานเฉพาะตอนเปิดหน้าเว็บนี้ค้างไว้ เว็บเช็คใหม่ทุก 1 นาที`}</span>
          </p>
          ${hits.length ? `<details class="sth99-hits" id="sth99-hits"${hitsOpen ? ' open' : ''}><summary>ดูทุกครั้งที่${one ? `${esc(who)} ` : ''}เคยถึง ${L} ขึ้นไป (${hits.length} วัน)</summary>
            <div class="table-wrap"><table class="sth99-past">
              <thead><tr><th>วันที่</th><th>สินทรัพย์</th><th class="num">STH</th><th class="num">ราคาปิด → วันถัดไป</th><th class="num">วันถัดไป</th><th class="num">3 วัน</th><th class="num">7 วัน</th></tr></thead>
              <tbody>${hits.map(hitRow).join('')}</tbody>
            </table></div></details>` : ''}
        </div>
      </div>
      <p class="note">* STH ของเหรียญอื่นและทองคำนวณจาก RSI, ระยะห่างจากเส้น 50 วัน, Bollinger %B ฯลฯ ใช้แต่ข้อมูลถึงวันนั้น สถิตินี้จึงไม่ได้แอบใช้ข้อมูลอนาคต · ผลคิดจากราคาปิดถึงราคาปิด ไม่รู้ว่าระหว่าง 24 ชั่วโมงนั้นลงลึกแค่ไหน และยังไม่หักค่าธรรมเนียม (ซื้อ + ขายราว 0.2%) · เหตุการณ์ = วันที่ถึงระดับนั้นที่ห่างกันเกิน 7 วัน · "ใกล้" = ต่ำกว่าระดับเตือนไม่เกิน ${d.watchGap} จุด · วันที่ราคายังไม่ปิดไม่นับในสถิติ · คำนวณใหม่ทุกครั้งที่ข้อมูลอัปเดต${d.missing?.length ? ` · ตอนนี้ยังโหลดข้อมูล ${d.missing.join(', ')} ไม่ได้` : ''} · ข้อมูลประกอบ ไม่ได้คิดในคะแนน</p>`;

    el('sth99-asset').value = one ? one.symbol : ALL;
    if (one) drawSeries(one.symbol, L);
    else destroyCharts();
    el('sth99-notify-btn')?.addEventListener('click', toggleNotify);
    el('sth99-hits')?.addEventListener('toggle', (e) => { hitsOpen = e.target.open; });
    notify(alerts);
    window.dispatchEvent(new CustomEvent('sth99:data', { detail: { d, level: L, asset: one ? one.symbol : ALL } }));
  }

  // ---------- chart for one asset: price with the level days pinned, and its STH ----------

  function destroyCharts() {
    if (priceChart) { priceChart.destroy(); priceChart = null; }
    if (scoreChart) { scoreChart.destroy(); scoreChart = null; }
  }

  async function seriesOf(symbol) {
    const c = seriesCache[symbol];
    if (c && Date.now() - c.at < 5 * 60 * 1000) return c.data;
    const res = await fetch(`/api/sth-series?symbol=${encodeURIComponent(symbol)}`, { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    seriesCache[symbol] = { at: Date.now(), data };
    return data;
  }

  // Shaded band from the level up to 100 and a dashed line at the level.
  const levelBand = (L) => ({
    id: 'sth99Level',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea: a, scales: { y } } = chart;
      const top = y.getPixelForValue(100);
      const at = y.getPixelForValue(L);
      ctx.save();
      ctx.fillStyle = cssVar('--band-buy');
      ctx.fillRect(a.left, top, a.right - a.left, at - top);
      ctx.strokeStyle = cssVar('--accent');
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(a.left, at);
      ctx.lineTo(a.right, at);
      ctx.stroke();
      ctx.restore();
    },
  });

  async function drawSeries(symbol, L) {
    if (!window.Chart || !el('sth99-price')) return;
    const msg = el('sth99-chart-msg');
    let s;
    try {
      s = await seriesOf(symbol);
    } catch (err) {
      if (msg) msg.textContent = `โหลดกราฟไม่ได้: ${err.message}`;
      return;
    }
    // The selection may have changed while loading.
    if (asset !== symbol || level !== L || !el('sth99-price')) return;
    destroyCharts();
    const n = s.dates.length;
    const lastIdx = n - 1; // the live day: its close is not final yet
    const i0 = Math.max(0, n - RANGE_DAYS[range]);
    const dates = s.dates.slice(i0);
    const price = s.price.slice(i0);
    const sth = s.sth.slice(i0);
    // Pins: closes at or above the level, coloured by the next day's result.
    const win = new Array(dates.length).fill(null);
    const lose = new Array(dates.length).fill(null);
    const wait = new Array(dates.length).fill(null);
    const result = new Array(dates.length).fill(null);
    let count = 0;
    for (let k = 0; k < dates.length; k++) {
      const i = i0 + k;
      if (s.sth[i] == null || s.sth[i] < L || s.price[i] == null) continue;
      count++;
      if (i + 1 >= lastIdx || s.price[i + 1] == null) {
        // today (not closed yet), or the next day's close is not final yet
        wait[k] = s.price[i];
        continue;
      }
      const r = (s.price[i + 1] / s.price[i] - 1) * 100;
      result[k] = r;
      (r > 1 ? win : lose)[k] = s.price[i];
    }
    if (msg) msg.textContent = count ? `ในช่วงที่แสดงมี ${count} วันที่ STH ถึง ${L} ขึ้นไป · ราคาและคะแนนของวันล่าสุดยังไม่ปิดวัน` : `ในช่วงที่แสดงยังไม่เคยมีวันที่ STH ถึง ${L}`;

    const mode = range === 'all' ? 'all' : 'short';
    const fixed = (axis) => { axis.width = 64; };
    const pin = (data, color, label) => ({ label, data, showLine: false, pointRadius: 4.5, pointHoverRadius: 6, pointBackgroundColor: color, pointBorderColor: cssVar('--surface'), pointBorderWidth: 1, borderColor: color });

    const pOpts = baseOptions(mode);
    pOpts.scales.x.ticks.maxTicksLimit = 7;
    pOpts.scales.y = { ...logPriceAxis(), afterFit: fixed };
    pOpts.plugins.tooltip.callbacks.label = (item) => {
      if (item.datasetIndex === 0) return ` ราคาปิด: ${fmtUsd(item.parsed.y)} · STH ${sth[item.dataIndex] == null ? '–' : sth[item.dataIndex].toFixed(1)}`;
      const r = result[item.dataIndex];
      return r == null ? ` 📍 STH ถึง ${L} — รอผลวันถัดไป` : ` 📍 STH ถึง ${L} → วันถัดไป ${fmtPct(r, 1)}`;
    };
    priceChart = new Chart(el('sth99-price'), {
      type: 'line',
      data: {
        labels: dates,
        datasets: [
          { label: 'ราคา', data: price, ...lineStyle(cssVar('--price'), 1.25) },
          pin(win, cssVar('--z-strong-buy'), 'ขึ้นเกิน 1%'),
          pin(lose, cssVar('--z-strong-sell'), 'ไม่ถึง 1%'),
          pin(wait, cssVar('--muted'), 'รอผล'),
        ],
      },
      options: pOpts,
      plugins: [crosshair, hoverSync],
    });

    const sOpts = baseOptions(mode);
    sOpts.scales.x.ticks.maxTicksLimit = 7;
    sOpts.scales.y = {
      min: 0,
      max: 100,
      position: 'right',
      afterFit: fixed,
      grid: { color: cssVar('--grid') },
      border: { display: false },
      ticks: { color: cssVar('--muted'), stepSize: 25 },
    };
    sOpts.plugins.tooltip.callbacks.label = (item) => ` STH: ${item.parsed.y.toFixed(1)}${item.parsed.y >= L ? ` ≥ ${L}` : ''}`;
    scoreChart = new Chart(el('sth99-score'), {
      type: 'line',
      data: { labels: dates, datasets: [{ label: 'STH', data: sth, ...lineStyle(cssVar('--sth'), 1.25) }] },
      options: sOpts,
      plugins: [levelBand(L), crosshair, hoverSync],
    });
    pair(priceChart, scoreChart);
  }

  // Level buttons, level-table rows, asset names and the asset picker (the
  // body is redrawn each minute, so listeners sit on its container).
  function bindControls() {
    const body = el('sth99-body');
    if (!body) return;
    body.addEventListener('click', (e) => {
      if (!last) return;
      const pick = e.target.closest('.sth99-pick');
      if (pick) { setAsset(pick.dataset.asset === asset ? ALL : pick.dataset.asset); return; }
      const rb = e.target.closest('[data-range]');
      if (rb) {
        if (!RANGE_DAYS[rb.dataset.range] || rb.dataset.range === range) return;
        range = rb.dataset.range;
        store.set(RANGE_KEY, range);
        for (const b of body.querySelectorAll('[data-range]')) b.classList.toggle('on', b === rb);
        if (asset !== ALL) drawSeries(asset, level);
        return;
      }
      const target = e.target.closest('[data-level]');
      if (!target) return;
      const l = Number(target.dataset.level);
      if (!last.levels.includes(l) || l === level) return;
      level = l;
      store.set(LEVEL_KEY, l);
      render(last);
    });
    body.addEventListener('change', (e) => {
      if (e.target.id === 'sth99-asset') setAsset(e.target.value);
    });
  }
  function setAsset(sym) {
    asset = sym || ALL;
    store.set(ASSET_KEY, asset);
    if (last) render(last);
  }

  async function toggleNotify() {
    if (!canNotify) return;
    if (store.get(NOTIFY_KEY, false) && Notification.permission === 'granted') {
      store.set(NOTIFY_KEY, false);
    } else {
      const p = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
      store.set(NOTIFY_KEY, p === 'granted');
    }
    if (last) render(last);
  }

  // One notification per asset, day and level, remembered across visits.
  function notify(alerts) {
    if (!alerts.length || !canNotify || Notification.permission !== 'granted' || !store.get(NOTIFY_KEY, false)) return;
    const seen = store.get(SEEN_KEY, []);
    for (const a of alerts) {
      const key = `${a.symbol}|${a.date}|${level}`;
      if (seen.includes(key)) continue;
      seen.push(key);
      const rec = last.byLevel[level].perAsset[a.symbol];
      try {
        new Notification(`STH ถึง ${level}: ${assetName(a)} ${score(a.sth)}`, {
          body: `ราคา ${fmtUsd(a.price)} · คะแนนยังไม่ปิดวัน (คริปโตปิด 07:00 น.) · ในอดีต${assetName(a)}วันถัดไปได้เกิน 1% ${share(rec)} ครั้ง`,
          tag: `sth99-${a.symbol}`,
        });
      } catch { /* some browsers only allow notifications from a service worker */ }
    }
    store.set(SEEN_KEY, seen.slice(-50));
  }

  async function load() {
    try {
      const res = await fetch('/api/sth-alert', { cache: 'no-store' });
      if (res.ok) render(await res.json());
    } catch { /* offline or server restarting: keep the last card */ }
  }

  window.renderSth99 = render; // lets the card be checked with made-up data
  if (!el('sth99-panel')) return;
  bindControls();
  load();
  // With notifications on, keep checking while the tab is in the background too.
  setInterval(() => {
    if (!document.hidden || store.get(NOTIFY_KEY, false)) load();
  }, 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
})();
