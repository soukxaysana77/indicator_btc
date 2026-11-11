'use strict';
// Local-bottom checklist card on the BTC page (built in lib/bottomcheck.js).
// Only pages with #bottom-panel use it. Shared helpers come from common.js.

(() => {
  const el = (id) => document.getElementById(id);
  const signed = (v, d = 0) => (v == null ? '–' : `<span class="${v >= 0 ? 'up' : 'down'}">${fmtPct(v, d)}</span>`);
  const item = (ok, title, detail, extra = false) => `
    <li class="${extra ? 'ck-extra' : ''}">
      <span class="ck ${ok ? 'ck-yes' : 'ck-no'}" aria-label="${ok ? 'เข้าเงื่อนไข' : 'ยังไม่เข้าเงื่อนไข'}">${ok ? '✓' : ''}</span>
      <div><b>${title}</b><div class="ck-detail">${detail}</div></div>
    </li>`;

  function render(d) {
    const panel = el('bottom-panel');
    if (!panel) return;
    const b = d?.bottomCheck;
    panel.hidden = !b;
    if (!b) return;
    const { now, rules, evidence: ev } = b;
    const t = now.ticks;

    el('bottom-asof').textContent = `(ข้อมูล ณ ${fmtDate(now.date)})`;
    const all3 = ev.rows.find((r) => r.id === 'all3');
    const past = ev.episodes.filter((e) => e.yearPct != null);
    const verdict = !now.recovery
      ? 'ตอนนี้ยังไม่อยู่ในช่วงฟื้นตัวตามนิยาม เช็คลิสต์นี้จึงยังไม่ใช้'
      : t.count === 3
        ? `ติ๊กครบ <b>3/3</b> ในช่วงฟื้นตัว — ในอดีตเกิดแค่ ${past.length} ครั้ง 1 ปีต่อมาราคา${past.every((e) => e.yearPct > 0) ? 'สูงขึ้นทุกครั้ง' : 'สูงขึ้นบางครั้ง'} (${past.map((e) => fmtPct(e.yearPct, 0)).join(', ')}) แต่ระหว่างทางเคยลงอีกถึง ${fmtPct(all3[365].ddWorst, 0)} และจำนวนครั้งยังน้อยเกินจะเชื่อเต็มที่`
        : `ติ๊ก <b>${t.count}/3</b> ในช่วงฟื้นตัว`;
    el('bottom-summary').innerHTML = `<b>สรุปตอนนี้:</b> ${verdict}`;

    el('bottom-list').innerHTML = [
      item(now.recovery, 'อยู่ในช่วงฟื้นตัว (เงื่อนไขพื้นฐาน)', `ราคาร่วงจากยอด ${fmtUsd(now.ath.price)} (${fmtDate(now.ath.date)}) ไป ${fmtPct(now.fallPct, 0)} ถึง ${fmtUsd(now.low.price)} (${fmtDate(now.low.date)}) แล้วฟื้นมา ${fmtPct(now.bouncePct, 0)} · นิยาม: ร่วงจากยอดเกิน ${rules.fallPct}% แล้วเด้งจากจุดต่ำสุด ${rules.bouncePct}% ขึ้นไป ผ่านไปอย่างน้อย ${rules.settleDays} วัน และยังไม่ทำ New High`),
      item(t.sip, `1. เหรียญที่ยังกำไรต่ำกว่า ${rules.sipMax}% ของทั้งหมด`, `ตอนนี้ ${now.sip == null ? '–' : `${now.sip.toFixed(1)}%`} · ต่ำกว่าครึ่งหนึ่งคือช่วงตลาดหมี ช่วงฟื้นตัวมักอยู่ราว 60–80%`),
      item(t.tmm, '2. ราคาต่ำกว่า True Market Mean', `ราคา ${fmtUsd(now.price)} เทียบ TMM ${fmtUsd(now.tmm)} (${now.tmm ? signed((now.price / now.tmm - 1) * 100, 1) : '–'}) · TMM = ต้นทุนเฉลี่ยของเหรียญที่ยังเคลื่อนไหว`),
      item(t.fear, `3. Fear & Greed ต่ำกว่า ${rules.fearMax} (กลัว)`, `ตอนนี้ ${now.fear ?? '–'} (alternative.me)`),
      item(now.lth != null && now.lth >= rules.lthMin, `เทียบ: คะแนน LTH ของเว็บนี้ ≥ ${rules.lthMin}`, `ตอนนี้ ${now.lth == null ? '–' : Math.round(now.lth)} · ไม่นับในเช็คลิสต์ แต่ผลทดสอบในช่วงฟื้นตัวดีที่สุดจากข้อมูลที่ยาวกว่า`, true),
      item(now.popcorn, 'ป๊อปคอร์น: ต้นทุนผู้ถือระยะสั้นตัดขึ้นเหนือ TMM', now.popcorn
        ? `ตัดแล้ว — ต้นทุน STH ${fmtUsd(now.sth)} อยู่เหนือ TMM ${fmtUsd(now.tmm)}${now.lastPopcorn ? ` (ตัดเมื่อ ${fmtDate(now.lastPopcorn)})` : ''}`
        : `ยังไม่ตัด — ต้นทุน STH ${fmtUsd(now.sth)} ต่ำกว่า TMM ${fmtUsd(now.tmm)}${now.lastPopcorn ? ` · ครั้งล่าสุด ${fmtDate(now.lastPopcorn)}` : ''} · ไม่นับในเช็คลิสต์`, true),
    ].join('');

    // ---------- evidence ----------
    const [h1, h2] = ev.horizons;
    const labels = {
      all: 'วันทั่วไป (ไว้เทียบ)',
      recovery: 'ช่วงฟื้นตัว (ทุกวัน)',
      sip: `+ เหรียญกำไร < ${rules.sipMax}%`,
      tmm: '+ ราคาต่ำกว่า TMM',
      fear: `+ Fear & Greed < ${rules.fearMax}`,
      all3: '+ ครบทั้ง 3 ข้อ*',
      lth: `+ คะแนน LTH ≥ ${rules.lthMin} (เว็บนี้)`,
    };
    const isNow = {
      recovery: now.recovery, sip: now.recovery && t.sip, tmm: now.recovery && t.tmm, fear: now.recovery && t.fear,
      all3: now.recovery && t.count === 3, lth: now.recovery && now.lth >= rules.lthMin,
    };
    const cell = (o) => (o?.n ? `${signed(o.median)}<br><span class="muted-cell">ขึ้น ${Math.round(o.upPct)}%</span>` : '–');
    el('bottom-since').textContent = `(ตั้งแต่ ${new Date(`${ev.from}T00:00:00Z`).getUTCFullYear()} · แถวพื้นเข้ม = ตรงกับตอนนี้)`;
    el('bottom-evidence').innerHTML = `<table>
      <thead><tr><th>สภาวะ</th><th class="num">3 เดือนต่อมา</th><th class="num">1 ปีต่อมา</th><th class="num">ช่วง</th><th class="num">ลงลึกสุด*</th></tr></thead>
      <tbody>${ev.rows.map((r) => `<tr${isNow[r.id] ? ' class="now"' : ''}>
        <td>${labels[r.id]}</td>
        <td class="num">${cell(r[h1])}</td>
        <td class="num">${cell(r[h2])}</td>
        <td class="num">${r.id === 'all' ? '–' : r[h2]?.episodes ?? '–'}</td>
        <td class="num">${r[h2]?.n ? signed(r[h2].ddWorst) : '–'}</td>
      </tr>`).join('')}</tbody></table>`;

    el('bottom-episodes').innerHTML = `<table>
      <thead><tr><th>เริ่มวันที่</th><th class="num">ราคา</th><th class="num">เหรียญกำไร</th><th class="num">Fear</th><th class="num">1 ปีต่อมา</th></tr></thead>
      <tbody>${ev.episodes.map((e) => `<tr${e.yearPct == null ? ' class="now"' : ''}>
        <td>${fmtDate(e.date)}</td><td class="num">${fmtUsd(e.price)}</td><td class="num">${e.sip == null ? '–' : `${e.sip.toFixed(1)}%`}</td><td class="num">${e.fear ?? '–'}</td>
        <td class="num">${e.yearPct == null ? 'ยังไม่ครบ 1 ปี' : signed(e.yearPct)}</td></tr>`).join('')}</tbody></table>`;

    el('bottom-popcorn').innerHTML = `<table>
      <thead><tr><th>ตัดขึ้นวันที่</th><th class="num">ราคา</th><th class="num">ถึง New High</th><th class="num">1 ปีต่อมา</th></tr></thead>
      <tbody>${ev.crosses.map((c) => `<tr>
        <td>${fmtDate(c.date)}</td><td class="num">${fmtUsd(c.price)}</td>
        <td class="num">${c.daysToHigh == null ? 'ยังไม่ถึง' : `${c.daysToHigh} วัน`}</td><td class="num">${c.yearPct == null ? '–' : signed(c.yearPct)}</td></tr>`).join('')}</tbody></table>`;
  }

  window.renderBottomCheck = render;
})();
