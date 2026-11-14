'use strict';
// "สรุปวันนี้" at the top of the BTC page: one box per thing that matters today,
// each a link to its panel, plus a jump menu to every panel that has a
// data-nav name. It fetches nothing itself: app.js (btc:data), sth99.js
// (sth99:data) and paper.js (paper:data) send what they already loaded.
// Shared helpers come from common.js.

(() => {
  const el = (id) => document.getElementById(id);
  const got = { btc: null, sth: null, paper: null, liq: null };
  const TH_MONTH_YEAR = new Intl.DateTimeFormat('th-TH-u-ca-gregory', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const TH_CLOCK = new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit' });
  const symName = (s) => (s === 'GOLD' ? 'ทองคำ' : s);
  const item = (href, label, value, note, tone = 'na') => `
    <a class="today-item" href="${href}">
      <span class="today-label"><i class="dot tone-${tone}"></i>${label}</span>
      <span class="today-value">${value}</span>
      <span class="today-note">${note}</span>
    </a>`;
  const scoreItem = (href, label, comp, note) => (comp?.score == null ? '' : item(href, label, `${Math.round(comp.score)}% <small>${esc(comp.label?.text ?? '')}</small>`, note, comp.label?.tone || toneOf(comp.score)));

  function render() {
    const panel = el('today-panel');
    if (!panel || !got.btc) return;
    panel.hidden = false;
    const d = got.btc;
    const items = [];

    items.push(scoreItem('#hero-lth', 'คะแนนระยะยาว (LTH)', d.composite?.lth, 'ใช้ตัดสินใจสะสมระยะยาว'));

    // The paper system: what it holds and how far price is from its average.
    const p = got.paper;
    if (p) {
      const gap = p.avg ? (p.price / p.avg - 1) * 100 : null;
      const held = p.held === 'bounce' ? `เด้ง ${p.heldBounce.legs.map((l) => esc(symName(l.symbol))).join(', ')}` : p.held === 'btc' ? 'ถือ BTC' : 'ถือเงินสด';
      const flip = p.held === 'btc' && !p.above ? ' · ⚠ หลุดเส้นแล้ว ถ้าปิดวันยังต่ำกว่าจะขาย' : p.held === 'cash' && p.above ? ' · ⚠ ขึ้นเหนือเส้นแล้ว ถ้าปิดวันยังเหนือจะซื้อ' : '';
      items.push(item('#paper-panel', `ระบบทดลอง (เส้น ${p.ma} วัน)`, held, `${gap == null ? '' : `${gap >= 0 ? 'เหนือ' : 'ใต้'}เส้น ${fmtPct(gap, 1)}`}${flip}`, p.held === 'cash' ? 'neutral' : 'buy'));
    }

    // The STH alert at the level chosen on its card.
    const s = got.sth;
    if (s) {
      const { d: a, level, asset } = s;
      const one = asset && asset !== 'ALL' ? a.now.find((x) => x.symbol === asset) : null;
      const scope = one ? [one] : a.now;
      const hits = scope.filter((x) => x.sth != null && x.sth >= level);
      const label = `เตือน STH ${level}${one ? ` · ${esc(symName(one.symbol))}` : ''}`;
      if (hits.length) {
        items.push(item('#sth99-panel', label, `⚠ ${hits.map((x) => `${esc(symName(x.symbol))} ${Math.floor(x.sth)}`).join(', ')}`, 'ยังไม่ปิดวัน รอดูตอนใกล้ 07:00 น.', 'strong-buy'));
      } else if (one) {
        const wait = a.byLevel[level]?.perAsset?.[one.symbol]?.waitDays;
        items.push(item('#sth99-panel', label, 'ยังไม่ถึง', `ตอนนี้ ${one.sth == null ? '–' : Math.round(one.sth)} ห่างอีก ${one.sth == null ? '–' : (level - one.sth).toFixed(1)} จุด${wait != null ? ` · รอมาแล้ว ${wait} วัน` : ''}`, 'na'));
      } else {
        const top = a.now.filter((x) => x.sth != null && x.sth < level).slice(0, 2);
        const wait = a.byLevel[level]?.wait?.days;
        items.push(item('#sth99-panel', label, 'ยังไม่มี', `ใกล้สุด ${top.map((x) => `${esc(symName(x.symbol))} ${Math.round(x.sth)}`).join(', ')}${wait != null ? ` · รอมาแล้ว ${wait} วัน` : ''}`, 'na'));
      }
    }

    items.push(scoreItem('#hero-sth', 'สภาวะระยะสั้น (STH)', d.composite?.sth, 'ข้อมูลประกอบ ใช้จับจังหวะไม่ได้'));
    if (d.macro) items.push(scoreItem('#macro-panel', 'สภาพคล่องโลก (Macro)', d.macro, 'ข้อมูลรายสัปดาห์ เคยนำราคาราว 3 เดือน'));

    // Price against the short-term holders' cost.
    const sthLine = d.costBasis?.lines?.find((l) => l.id === 'sth');
    if (sthLine) items.push(item('#cost-panel', 'ราคาเทียบต้นทุนผู้ถือระยะสั้น', fmtPct(sthLine.gapPct, 1), `ต้นทุน ${fmtUsd(sthLine.value)} · ${sthLine.gapPct >= 0 ? 'ราคาอยู่เหนือ' : 'ราคาอยู่ใต้'}ต้นทุน`, sthLine.gapPct >= 0 ? 'neutral' : 'buy'));

    const bc = d.bottomCheck?.now;
    if (bc) items.push(item('#bottom-panel', 'เช็คลิสต์จุดต่ำสุด', bc.recovery ? `ติ๊ก ${bc.ticks.count}/3` : 'ไม่อยู่ในช่วงฟื้นตัว', bc.recovery ? 'อยู่ในช่วงฟื้นตัวหลังร่วงหนัก' : 'เช็คลิสต์ยังไม่ใช้', bc.recovery && bc.ticks.count === 3 ? 'strong-buy' : 'na'));

    // Has global liquidity turned up since the cycle low? (forecast.js)
    const lq = got.liq;
    if (lq) items.push(item('#forecast-panel', 'สภาพคล่องยืนยันก้น', `${lq.icon} ${lq.confirmed ? 'ยืนยันแล้ว' : lq.cls === 'near' ? 'ใกล้ยืนยัน' : 'ยังไม่ยืนยัน'}`, lq.confirmed ? `เมื่อ ${fmtDate(lq.confirmed)}` : `สภาพคล่อง 13 สัปดาห์ ${fmtPct(lq.latest, 1)} · ผ่านก้นมา ${lq.since} วัน`, lq.confirmed ? 'strong-buy' : lq.cls === 'near' ? 'neutral' : 'strong-sell'));

    const hv = d.halving;
    const hDates = d.history?.dates;
    if (hv && hDates?.length) {
      const lastH = hv.past[hv.past.length - 1];
      const day = Math.round((Date.parse(hDates[hDates.length - 1]) - Date.parse(lastH.date)) / 86400000);
      const cycle = Math.round((Date.parse(hv.next.date) - Date.parse(lastH.date)) / 86400000);
      items.push(item('#halving-panel', 'Halving', `วันที่ ${day.toLocaleString('en-US')}`, `${Math.round((100 * day) / cycle)}% ของรอบ · ครั้งถัดไป ≈ ${TH_MONTH_YEAR.format(Date.parse(`${hv.next.date}T00:00:00Z`))}`, 'na'));
    }

    el('today-grid').innerHTML = items.filter(Boolean).join('');
    el('today-asof').textContent = `BTC ${fmtUsd(d.price?.usd)} · อัปเดต ${TH_CLOCK.format(new Date())} น.`;
    renderNav();
  }

  // Jump menu: every panel with a data-nav name that is showing.
  function renderNav() {
    const links = [...document.querySelectorAll('main section[data-nav]')]
      .filter((s) => !s.hidden && s.id)
      .map((s) => `<a href="#${s.id}">${esc(s.dataset.nav)}</a>`);
    el('today-nav').innerHTML = links.length ? `<span class="today-nav-title">ไปที่:</span>${links.join('')}` : '';
  }

  // A "back to the summary" button once the page has been scrolled down a way.
  if (el('today-panel')) {
    const back = document.createElement('a');
    back.className = 'to-top';
    back.href = '#today-panel';
    back.textContent = '↑ สรุปวันนี้';
    back.hidden = true;
    document.body.appendChild(back);
    let ticking = false;
    window.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => { back.hidden = window.scrollY < 900; ticking = false; });
    }, { passive: true });
  }

  window.addEventListener('btc:data', (e) => { got.btc = e.detail; render(); });
  window.addEventListener('sth99:data', (e) => { got.sth = e.detail; render(); });
  window.addEventListener('paper:data', (e) => { got.paper = e.detail; render(); });
  window.addEventListener('liq:data', (e) => { got.liq = e.detail; render(); });
})();
