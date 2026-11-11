'use strict';
// "เตือน STH" card on the BTC, gold and altcoin pages (data: /api/sth-alert,
// built in lib/sth99.js). The alert level can be set from 95 to 100 (default
// 99, remembered in this browser). A one-line strip while nothing has reached
// it; the card opens by itself when an asset's short-term score does.
// Optional browser notifications while a page stays open. Shared helpers come
// from common.js.

(() => {
  const el = (id) => document.getElementById(id);
  const NOTIFY_KEY = 'sth99-notify';
  const SEEN_KEY = 'sth99-notified';
  const LEVEL_KEY = 'sth99-level';
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
  const assetName = (a) => (a.symbol === 'GOLD' ? 'ทองคำ' : a.symbol);
  const symName = (s) => (s === 'GOLD' ? 'ทองคำ' : s);
  // 156 → "156 วัน"; 1,676 → "1,676 วัน (4.6 ปี)"
  const dur = (d) => (d == null ? '–' : d >= 365 ? `${d.toLocaleString('en-US')} วัน (${(d / 365.25).toFixed(1)} ปี)` : `${d} วัน`);
  const durShort = (d) => (d == null ? '–' : d >= 365 ? `${(d / 365.25).toFixed(1)} ปี` : `${d} วัน`);

  let last = null;
  let level = store.get(LEVEL_KEY, null);
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
    const L = level;
    const ev = d.byLevel[L];
    const hits = d.hits.filter((h) => h.sth >= L);
    const alerts = d.now.filter((a) => a.sth != null && a.sth >= L);
    const closed = d.now.filter((a) => a.prevSth != null && a.prevSth >= L && !(a.sth >= L));
    const watch = d.now.filter((a) => a.sth != null && a.sth >= Math.min(d.watch, L - 1) && a.sth < L);
    panel.classList.toggle('sth99-on', alerts.length > 0);

    const record = ev.next.n ? `ในอดีตซื้อตอนปิดวันที่ถึง ${L} แล้วขายตอนปิดวันถัดไป ได้เกิน 1% <b>${share(ev.next)}</b> ครั้ง` : `ยังไม่เคยมีวันที่ถึง ${L}`;
    let head;
    if (alerts.length) {
      head = `<b>⚠ STH ถึง ${L}: ${alerts.map((a) => `${esc(assetName(a))} ${score(a.sth)}`).join(' · ')}</b> — คะแนนวันนี้ยังไม่ปิด รอดูตอนใกล้ปิดวัน`;
    } else if (closed.length) {
      head = `<b>${closed.map((a) => `${esc(assetName(a))} ปิดวัน ${fmtDate(a.prevDate)} ที่ ${score(a.prevSth)}`).join(' · ')}</b> — ถ้าซื้อตอนปิดวันนั้น ตามผลทดสอบจะขายตอนปิดวันนี้`;
    } else {
      const top = d.now.filter((a) => a.sth != null).slice(0, 3);
      const waited = ev.wait.days != null ? ` (รอมาแล้ว ${dur(ev.wait.days)})` : '';
      head = `ยังไม่มีสินทรัพย์ไหนถึง ${L}${waited} · ${watch.length ? 'ใกล้สุด' : 'สูงสุดตอนนี้'} ${top.map((a) => `${esc(assetName(a))} ${Math.round(a.sth)}`).join(', ')}`;
    }
    el('sth99-summary').innerHTML = `<span class="sth99-title">เตือน STH ${L}</span> <span>${head}</span> <span class="sth99-record">${record}</span>`;

    // Open the card by itself once for each new alert in this visit.
    const details = el('sth99-details');
    for (const a of [...alerts, ...closed]) {
      const key = `${a.symbol}|${a.date}|${L}|${a.sth >= L ? 'live' : 'closed'}`;
      if (!seenAlerts.has(key)) { seenAlerts.add(key); details.open = true; }
    }

    // Days since this asset last closed at the level, against its own usual wait.
    function waitCell(a) {
      if (a.sth != null && a.sth >= L) return '<b>ถึงแล้ววันนี้</b>';
      const own = ev.perAsset[a.symbol];
      if (own?.waitDays == null) {
        const years = a.scoredSince ? ((Date.parse(d.today) - Date.parse(a.scoredSince)) / 31557600000).toFixed(1) : null;
        return `<span class="coin-name">ยังไม่เคยถึง${years ? ` (ข้อมูล ${years} ปี)` : ''}</span>`;
      }
      const t = own.typicalWait;
      return `${durShort(own.waitDays)}<div class="coin-name">${t?.n ? `ปกติ ~${durShort(t.avg)}` : 'เคยถึงช่วงเดียว'}</div>`;
    }
    const row = (a) => {
      const own = ev.perAsset[a.symbol];
      const near = a.sth != null && a.sth >= Math.min(d.watch, L - 1);
      const cls = a.sth >= L ? 'sth99-hit' : near ? 'sth99-near' : '';
      const tag = a.sth >= L ? '<span class="pill tone-strong-buy"><i></i>ถึงแล้ว</span>' : near ? '<span class="pill tone-buy"><i></i>ใกล้</span>' : '';
      return `<tr class="${cls}">
        <td><a class="coin-link" href="${esc(a.page)}"><b>${esc(assetName(a))}</b></a> ${tag}</td>
        <td class="num"><b>${score(a.sth)}</b><div class="coin-name sth99-sub">${fmtUsd(a.price)}</div></td>
        <td class="num">${score(a.prevSth)}<div class="coin-name sth99-sub">${a.prevDate ? fmtDate(a.prevDate) : ''}</div></td>
        <td class="num">${own?.n ? `${own.over} / ${own.n}` : '<span class="coin-name">ไม่เคยถึง</span>'}</td>
        <td class="num">${waitCell(a)}</td>
      </tr>`;
    };
    const w = ev.wait;
    const lastNames = (w.lastSymbols || []).map(symName).join(', ');
    const waitTile = w.days != null
      ? tile('รอมาแล้วกี่วัน (ทุกสินทรัพย์ในเว็บ)', dur(w.days), `ครั้งล่าสุด ${esc(lastNames)} ปิดที่ ${L} ขึ้นไปเมื่อ ${fmtDate(w.last)} ·
          ปกติรอระหว่างครั้ง: ${w.typical.n ? `ค่ากลาง ${dur(w.typical.median)} · เฉลี่ย ${dur(w.typical.avg)} (สั้นสุด ${dur(w.typical.min)} นานสุด ${dur(w.typical.max)})` : 'ยังไม่พอคิด'} ·
          ตั้งแต่ ${new Date(`${w.from}T00:00:00Z`).getUTCFullYear()} เกิดราวปีละ ${w.perYear.toFixed(1)} ครั้ง ไม่สม่ำเสมอ มักมากระจุกตอนตลาดถล่ม`)
      : tile('รอมาแล้วกี่วัน', '–', `ยังไม่เคยมีวันที่ถึง ${L}`);
    const hitRow = (h) => `<tr>
      <td>${fmtDate(h.date)}</td><td><b>${esc(symName(h.symbol))}</b></td><td class="num">${score(h.sth)}</td>
      <td class="num">${fmtUsd(h.price)} → ${fmtUsd(h.next)}</td><td class="num">${signed(h.r1, 2)}</td><td class="num">${signed(h.r3)}</td><td class="num">${signed(h.r7)}</td></tr>`;
    // Every level side by side: lower levels come more often and win less often.
    const levelRow = (l) => {
      const x = d.byLevel[l];
      return `<tr class="${l === L ? 'now' : ''}" data-level="${l}">
        <td><b>${l}</b>${l === d.defaultLevel ? ' <span class="coin-name">(เริ่มต้น)</span>' : ''}</td>
        <td class="num">${x.next.n ? `${pctOf(x.next)}%<div class="coin-name sth99-sub">${share(x.next)}</div>` : '–'}</td>
        <td class="num">${x.day3.n ? `${pctOf(x.day3)}%<div class="coin-name sth99-sub">ลงเกิน 1% ${pctOf(x.day3, 'downOver')}%</div>` : '–'}</td>
        <td class="num">${x.events}<div class="coin-name sth99-sub">ปีละ ~${x.wait.perYear.toFixed(1)}</div></td>
        <td class="num">${x.wait.typical.n ? durShort(x.wait.typical.median) : '–'}</td>
      </tr>`;
    };
    const notifyOn = store.get(NOTIFY_KEY, false) && canNotify && Notification.permission === 'granted';
    const baseShare = d.base.n ? Math.round((100 * d.base.over) / d.base.n) : null;

    el('sth99-body').innerHTML = `
      <div class="sth99-levels">
        <span class="field">ระดับเตือน</span>
        <div class="seg" role="group" aria-label="ระดับคะแนน STH ที่ให้เตือน">
          ${d.levels.map((l) => `<button type="button" data-level="${l}" class="${l === L ? 'on' : ''}">${l}</button>`).join('')}
        </div>
        <span class="coin-name">ต่ำลง = เกิดบ่อยขึ้น แต่ได้ผลน้อยลง (ดูตารางเทียบด้านล่าง) · เว็บจำระดับที่เลือกไว้</span>
      </div>
      <p class="advice"><b>วิธีที่ทดสอบ:</b> ซื้อตอนราคาปิดของวันที่คะแนนระยะสั้น (STH) ถึง ${L} ขึ้นไป แล้ว<b>ขายตอนราคาปิดวันถัดไป</b> ·
        คริปโตปิดวันเวลา <b>07:00 น.</b> (${cryptoClose()}) · ทองปิดราว 04:00–05:00 น. · ระหว่างวันคะแนนขยับตามราคาสด อาจแตะ ${L} แล้วหลุดก่อนปิดได้</p>
      <div class="stats">
        ${waitTile}
        ${tile('วันถัดไปขึ้นเกิน 1%', ev.next.n ? `${share(ev.next)} วัน (${pctOf(ev.next)}%)` : '–', ev.next.n ? `ขึ้นเลย ${share(ev.next, 'up')} วัน · ค่ากลาง ${signed(ev.next.median)} · แย่สุด ${signed(ev.next.worst, 2)}${baseShare == null ? '' : ` · วันธรรมดาขึ้นเกิน 1% แค่ ${baseShare}%`}` : `ยังไม่เคยมีวันที่ถึง ${L}`)}
        ${tile('ถ้าถือ 3 วัน', ev.day3.n ? `${share(ev.day3)} (${pctOf(ev.day3)}%)` : '–', ev.day3.n ? `ลงเกิน 1% ${share(ev.day3, 'downOver')} วัน · ค่ากลาง ${signed(ev.day3.median)} → ${pctOf(ev.day3) < pctOf(ev.next) - 10 ? 'เป็นการเด้งระยะสั้น ถือนานกว่านี้ผลแย่ลง' : 'ที่ระดับนี้ถือ 3 วันไม่ได้แย่กว่าขายวันถัดไป'}` : '')}
        ${tile('ถ้าถือ 7 วัน', ev.day7.n ? `${share(ev.day7)} (${pctOf(ev.day7)}%)` : '–', ev.day7.n ? `ค่ากลาง ${signed(ev.day7.median)} · แย่สุด ${signed(ev.day7.worst)}` : '')}
        ${tile('จำนวนครั้ง', `${ev.next.n ?? 0} วัน · ${ev.events} เหตุการณ์`, `จาก ${d.assets} สินทรัพย์ในเว็บ ตั้งแต่ ${new Date(`${d.since}T00:00:00Z`).getUTCFullYear()} · หลายเหรียญมักถึงพร้อมกันในวันตลาดถล่ม ยิ่งระดับสูงตัวอย่างยิ่งน้อย`)}
      </div>
      <div class="sth99-grid">
        <div class="table-wrap">
          <table class="sth99-now">
            <thead><tr><th>ตอนนี้</th><th class="num">STH วันนี้</th><th class="num">ปิดวันล่าสุด</th><th class="num" title="ในอดีต ซื้อตอนปิดวันที่ถึง ${L} ขึ้นไป ขายตอนปิดวันถัดไป ได้เกิน 1% กี่ครั้ง">เคยได้เกิน 1%</th><th class="num" title="นับจากวันขาย (วันถัดจากวันที่ปิดที่ ${L} ขึ้นไปครั้งล่าสุด) · ปกติ = เฉลี่ยที่สินทรัพย์นั้นเคยรอระหว่างครั้ง">รอมาแล้ว</th></tr></thead>
            <tbody>${d.now.map(row).join('')}</tbody>
          </table>
        </div>
        <div>
          <h3 class="subhead">เทียบทุกระดับ <span class="count">(กดแถวเพื่อเลือก)</span></h3>
          <div class="table-wrap">
            <table class="sth99-levels-table">
              <thead><tr><th>ระดับ</th><th class="num" title="ซื้อตอนปิดวันที่ถึงระดับนี้ ขายตอนปิดวันถัดไป ได้เกิน 1% กี่ % ของครั้ง">วันถัดไป &gt;1%</th><th class="num" title="ถ้าถือ 3 วันแทน ได้เกิน 1% กี่ % ของครั้ง">ถือ 3 วัน &gt;1%</th><th class="num" title="วันที่ถึงระดับนี้ที่ห่างกันเกิน 7 วัน (สินทรัพย์ไหนก็ได้)">เหตุการณ์</th><th class="num" title="ทุกสินทรัพย์ในเว็บ ตั้งแต่ ก.ย. 2017 (ค่ากลาง)">รอ (ค่ากลาง)</th></tr></thead>
              <tbody>${d.levels.map(levelRow).join('')}</tbody>
            </table>
          </div>
          <p class="sth99-notify">
            <button type="button" class="btn" id="sth99-notify-btn" ${canNotify && Notification.permission !== 'denied' ? '' : 'disabled'}>${notifyOn ? '🔕 ปิดแจ้งเตือน' : '🔔 เปิดแจ้งเตือนในเบราว์เซอร์'}</button>
            <span class="coin-name">${!canNotify ? 'เบราว์เซอร์นี้แจ้งเตือนไม่ได้' : Notification.permission === 'denied' ? 'เบราว์เซอร์บล็อกการแจ้งเตือนของเว็บนี้ไว้ ต้องเปิดอนุญาตในตั้งค่าเบราว์เซอร์' : `แจ้งเมื่อสินทรัพย์ไหนถึง ${L} (ครั้งเดียวต่อวัน) · ทำงานเฉพาะตอนเปิดหน้าเว็บนี้ค้างไว้ เว็บเช็คใหม่ทุก 1 นาที`}</span>
          </p>
          ${hits.length ? `<details class="sth99-hits" id="sth99-hits"${hitsOpen ? ' open' : ''}><summary>ดูทุกครั้งที่เคยถึง ${L} ขึ้นไป (${hits.length} วัน)</summary>
            <div class="table-wrap"><table class="sth99-past">
              <thead><tr><th>วันที่</th><th>สินทรัพย์</th><th class="num">STH</th><th class="num">ราคาปิด → วันถัดไป</th><th class="num">วันถัดไป</th><th class="num">3 วัน</th><th class="num">7 วัน</th></tr></thead>
              <tbody>${hits.map(hitRow).join('')}</tbody>
            </table></div></details>` : ''}
        </div>
      </div>
      <p class="note">* STH ของเหรียญอื่นและทองคำนวณจาก RSI, ระยะห่างจากเส้น 50 วัน, Bollinger %B ฯลฯ ใช้แต่ข้อมูลถึงวันนั้น สถิตินี้จึงไม่ได้แอบใช้ข้อมูลอนาคต · ผลคิดจากราคาปิดถึงราคาปิด ไม่รู้ว่าระหว่าง 24 ชั่วโมงนั้นลงลึกแค่ไหน และยังไม่หักค่าธรรมเนียม (ซื้อ + ขายราว 0.2%) · เหตุการณ์ = วันที่ถึงระดับนั้นที่ห่างกันเกิน 7 วัน (สินทรัพย์ไหนก็ได้) · วันที่ราคายังไม่ปิดไม่นับในสถิติ · คำนวณใหม่ทุกครั้งที่ข้อมูลอัปเดต${d.missing?.length ? ` · ตอนนี้ยังโหลดข้อมูล ${d.missing.join(', ')} ไม่ได้` : ''} · ข้อมูลประกอบ ไม่ได้คิดในคะแนน</p>`;

    el('sth99-notify-btn')?.addEventListener('click', toggleNotify);
    el('sth99-hits')?.addEventListener('toggle', (e) => { hitsOpen = e.target.open; });
    notify(alerts);
    window.dispatchEvent(new CustomEvent('sth99:data', { detail: { d, level: L } }));
  }

  // Level buttons and level-table rows (the body is redrawn each minute, so
  // one listener on its container handles them).
  function bindLevels() {
    el('sth99-body')?.addEventListener('click', (e) => {
      const target = e.target.closest('[data-level]');
      if (!target || !last) return;
      const l = Number(target.dataset.level);
      if (!last.levels.includes(l) || l === level) return;
      level = l;
      store.set(LEVEL_KEY, l);
      render(last);
    });
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
    const ev = last.byLevel[level];
    for (const a of alerts) {
      const key = `${a.symbol}|${a.date}|${level}`;
      if (seen.includes(key)) continue;
      seen.push(key);
      try {
        new Notification(`STH ถึง ${level}: ${assetName(a)} ${score(a.sth)}`, {
          body: `ราคา ${fmtUsd(a.price)} · คะแนนยังไม่ปิดวัน (คริปโตปิด 07:00 น.) · ในอดีตวันถัดไปได้เกิน 1% ${share(ev.next)} ครั้ง`,
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
  bindLevels();
  load();
  // With notifications on, keep checking while the tab is in the background too.
  setInterval(() => {
    if (!document.hidden || store.get(NOTIFY_KEY, false)) load();
  }, 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
})();
