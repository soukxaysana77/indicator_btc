'use strict';
// "สมุดจดคำทำนาย" page (data: /api/predictions, built in lib/predictions.js).
// Lists each price call with its result against the daily closes, a per-source
// tally, and a form to add new calls. Shared helpers come from common.js.

(() => {
  const el = (id) => document.getElementById(id);
  const TH_DATE_TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }); // YYYY-MM-DD
  const tile = (label, value, sub) => `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-sub">${sub}</div></div>`;
  const nameOf = (sym) => (sym === 'GOLD' ? 'ทองคำ' : sym);
  const STATUS = {
    hit: { text: '✅ ถูก', tone: 'strong-buy' },
    miss: { text: '❌ ผิด', tone: 'strong-sell' },
    open: { text: '⏳ รอผล', tone: 'neutral' },
    nodata: { text: 'ไม่มีข้อมูลราคา', tone: 'na' },
  };
  let data = null;
  let filter = 'all';

  async function load() {
    try {
      const res = await fetch('/api/predictions', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || res.statusText);
      data = json;
      el('error').hidden = true;
      render();
    } catch (err) {
      el('error').textContent = `โหลดสมุดไม่สำเร็จ: ${err.message}`;
      el('error').hidden = false;
    }
  }

  function claimText(p) {
    return `${esc(nameOf(p.asset))} ${p.kind === 'above' ? 'ขึ้นไปถึง' : 'ลงไปถึง'} <b>${fmtUsd(p.target)}</b> ${p.by ? `ภายใน ${fmtDate(p.by)}` : '(ไม่ระบุวัน)'}`;
  }

  function resultText(p) {
    const r = p.result;
    const move = r.startPrice ? ` · วันที่พูดราคา ${fmtUsd(r.startPrice)}` : '';
    if (r.status === 'hit') return `ถึงเป้าวันที่ ${fmtDate(r.date)} (${r.days} วันหลังพูด) ราคาปิด ${fmtUsd(r.price)}${r.live ? ' — วันนี้ยังไม่ปิด ผลอาจเปลี่ยน' : ''}${move}`;
    if (r.status === 'miss') return `ครบกำหนดแล้วไม่ถึง · ใกล้สุด ${fmtUsd(r.best)} (${fmtDate(r.bestDate)}) ขาดอีก ${fmtPct(Math.abs(r.short), 1)}${move}`;
    if (r.status === 'open') {
      const need = p.kind === 'above' ? (r.gap > 0 ? `ต้องขึ้นอีก ${fmtPct(r.gap, 1)}` : 'เกินเป้าแล้ว รอปิดวัน') : (r.gap < 0 ? `ต้องลงอีก ${fmtPct(Math.abs(r.gap), 1)}` : 'ต่ำกว่าเป้าแล้ว รอปิดวัน');
      const left = r.daysLeft == null ? 'ไม่มีกำหนด' : `เหลือ ${r.daysLeft.toLocaleString('en-US')} วัน`;
      return `ตอนนี้ ${fmtUsd(r.now)} · ${need} · ${left} · ใกล้สุดตั้งแต่พูด ${fmtUsd(r.best)}${move}`;
    }
    return 'ไม่มีราคาของสินทรัพย์นี้ในเว็บ';
  }

  // Waiting calls first (nearest deadline first), then results, newest first.
  function order(list) {
    const open = list.filter((p) => p.result.status === 'open').sort((a, b) => (a.by || '9999') < (b.by || '9999') ? -1 : 1);
    const done = list.filter((p) => p.result.status !== 'open').sort((a, b) => ((a.result.date || a.by || '') < (b.result.date || b.by || '') ? 1 : -1));
    return [...open, ...done];
  }

  function render() {
    const list = data.predictions;
    const count = (s) => list.filter((p) => p.result.status === s).length;
    const [hit, miss, open] = ['hit', 'miss', 'open'].map(count);
    el('pred-stats').innerHTML = [
      tile('คำทำนายทั้งหมด', list.length, `จาก ${data.sources.length} คน/ช่อง`),
      tile('ถูก', hit, hit + miss ? `${Math.round((100 * hit) / (hit + miss))}% ของที่รู้ผลแล้ว` : 'ยังไม่มีที่รู้ผล'),
      tile('ผิด', miss, 'เลยวันครบกำหนดแล้วยังไม่ถึงเป้า'),
      tile('รอผล', open, 'ยังไม่ครบกำหนด'),
    ].join('');
    el('pred-count').textContent = `(${list.length})`;

    const shown = order(list).filter((p) => filter === 'all' || p.result.status === filter);
    el('pred-list').innerHTML = shown.length ? shown.map((p) => {
      const st = STATUS[p.result.status] || STATUS.nodata;
      return `<article class="pred-item pred-${p.result.status}">
        <div class="pred-top">
          <span class="pill tone-${st.tone}"><i></i>${st.text}</span>
          <span class="pred-claim">${claimText(p)}</span>
          <button type="button" class="pred-del" data-id="${esc(p.id)}" title="ลบรายการนี้" aria-label="ลบรายการนี้">✕</button>
        </div>
        <div class="pred-who">${esc(p.source)} · พูดเมื่อ ${fmtDate(p.said)}${p.link ? ` · <a href="${esc(p.link)}" target="_blank" rel="noopener noreferrer">ดูคลิป ↗</a>` : ''}</div>
        ${p.note ? `<div class="pred-note-text">“${esc(p.note)}”</div>` : ''}
        <div class="pred-result">${resultText(p)}</div>
      </article>`;
    }).join('') : '<p class="muted">ไม่มีรายการในหมวดนี้</p>';

    el('pred-sources').innerHTML = data.sources.length
      ? `<table class="lined pred-table"><thead><tr><th>ใคร / ช่อง</th><th class="num">ถูก</th><th class="num">ผิด</th><th class="num">รอผล</th><th class="num">แม่น</th></tr></thead>
        <tbody>${data.sources.map((s) => `<tr><td>${esc(s.source)}</td><td class="num">${s.hit}</td><td class="num">${s.miss}</td><td class="num">${s.open}</td>
          <td class="num">${s.hit + s.miss ? `<b>${Math.round((100 * s.hit) / (s.hit + s.miss))}%</b> <span class="coin-name">(${s.hit}/${s.hit + s.miss})</span>` : '<span class="coin-name">ยังไม่รู้ผล</span>'}</td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">ยังไม่มีคำทำนาย</p>';

    // Form helpers: assets with their current price, and the names already used.
    const sel = el('pred-asset');
    if (!sel.options.length) {
      sel.innerHTML = data.assets.map((a) => `<option value="${esc(a.symbol)}">${esc(nameOf(a.symbol))} (ตอนนี้ ${fmtUsd(a.price)})</option>`).join('');
    }
    el('pred-source-list').innerHTML = data.sources.map((s) => `<option value="${esc(s.source)}"></option>`).join('');
  }

  async function submit(e) {
    e.preventDefault();
    const form = e.target;
    const msg = el('pred-form-msg');
    const body = Object.fromEntries(new FormData(form).entries());
    msg.textContent = 'กำลังบันทึก…';
    try {
      const res = await fetch('/api/predictions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || res.statusText);
      msg.textContent = '✓ บันทึกแล้ว';
      for (const name of ['link', 'target', 'by', 'note']) form.elements[name].value = '';
      await load();
    } catch (err) {
      msg.textContent = `บันทึกไม่ได้: ${err.message}`;
    }
  }

  async function remove(id) {
    const p = data?.predictions.find((x) => x.id === id);
    if (!p || !confirm(`ลบคำทำนายนี้?\n${p.source}: ${nameOf(p.asset)} ${p.kind === 'above' ? 'ขึ้นไปถึง' : 'ลงไปถึง'} $${p.target}`)) return;
    try {
      const res = await fetch(`/api/predictions?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || res.statusText);
      await load();
    } catch (err) {
      alert(`ลบไม่ได้: ${err.message}`);
    }
  }

  function bind() {
    el('pred-form').addEventListener('submit', submit);
    el('pred-form').elements.said.value = TH_DATE_TODAY.format(new Date());
    el('pred-list').addEventListener('click', (e) => {
      const b = e.target.closest('.pred-del');
      if (b) remove(b.dataset.id);
    });
    el('pred-filter').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      filter = b.dataset.v;
      for (const x of el('pred-filter').querySelectorAll('button')) x.classList.toggle('on', x === b);
      if (data) render();
    });
  }

  bind();
  load();
  autoRefresh(load, 5 * 60 * 1000);
})();
