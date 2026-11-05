// Replay viewer UI: renders one replay step on the two-mat board, plus hand, log and timeline.
// Moving one step at a time animates the change (FLIP: cards glide from where they were).
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const short = n => String(n || '').split(' — ')[0];
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const DIE = {   // same die outlines as the template's fixer area
    20: '50,3 93,27 93,73 50,97 7,73 7,27', 12: '50,4 96,38 79,94 21,94 4,38', 10: '50,4 94,40 50,96 6,40',
    8: '50,4 96,50 50,96 4,50', 6: '12,12 88,12 88,88 12,88', 4: '50,6 95,90 5,90',
  };
  const TRACE = `<svg class="mat-trace" viewBox="0 0 1000 560" preserveAspectRatio="none" aria-hidden="true">
      <path d="M30 120 L30 40 L70 10 L300 10 M700 10 L930 10 L975 55 L975 200 M975 380 L975 500 L940 545 L620 545 M380 545 L60 545 L30 515 L30 420"/>
      <path class="thin" d="M50 140 L50 60 L80 32 M920 32 L955 70 L955 190 M955 390 L955 490 L925 525"/></svg>`;

  let R = null;               // loaded replay
  let cur = 0;                // current step index
  let timer = null;
  let nameToId = new Map();   // card name (full and short) → cardId, for log tags
  let cardsById = new Map();  // card instance id → card object at the current step (hover panel)
  let fmt = null;

  // ── cards ───────────────────────────────────────────────────────────────
  const imgUrl = cardId => cardId ? `/card/${encodeURIComponent(cardId)}` : '';
  function face(c, cls = '', style = '') {
    cardsById.set(c.id, c);
    return `<div class="card face ${cls}" data-cid="${esc(c.id)}" data-img="${esc(imgUrl(c.cardId))}"
      style="background-image:url('${imgUrl(c.cardId)}');${style}"><span class="cname">${esc(short(c.name))}</span></div>`;
  }
  const back = (cls = '', style = '', cid = '') => `<div class="card back ${cls}"${cid ? ` data-cid="${esc(cid)}"` : ''} style="${style}"></div>`;

  function unitHtml(u, isLegend = false) {
    if (isLegend && u.faceDown) return `<div class="unit${u.exhausted ? ' spent' : ''}" data-uid="${esc(u.id)}" style="--n:0">${back('legend host', '', u.id)}</div>`;
    const gear = u.attachments || [];
    const power = u.attackPower ?? u.power ?? 0, base = u.basePower ?? u.power ?? 0;
    const delta = power - base;
    // power shows only when an effect changed it, like a counter on a real table
    const badge = delta && (!isLegend || u.zone === 'field') ? `<span class="badge ${delta > 0 ? 'up' : 'down'}">${power}</span>` : '';
    return `<div class="unit${u.exhausted ? ' spent' : ''}" data-uid="${esc(u.id)}" style="--n:${gear.length}">
      ${gear.map((g, i) => face(g, 'gear', `--i:${i}`)).join('')}${face(u, 'host')}${badge}</div>`;
  }

  function gigHtml(g, ownerPid) {
    const stolen = g.originalOwnerId && g.originalOwnerId !== ownerPid;
    const mine = (g.originalOwnerId || ownerPid) === R.me;
    const tip = `${g.label} · ${g.value}${stolen ? ` · stolen from ${R.labels[g.originalOwnerId]}` : ''}`;
    return `<span class="gig ${mine ? 'mine' : 'theirs'}${stolen ? ' stolen' : ''}" data-gid="${esc(g.id)}" data-v="${g.value}" title="${esc(tip)}">
      <svg viewBox="0 0 100 100"><polygon points="${DIE[g.sides] || DIE[6]}"/></svg><b>${g.value}</b></span>`;
  }

  function matHtml(st, pid, rival) {
    const p = st.players[pid];
    const fixer = [...(p.dicePool || [])].sort((a, b) => b.sides - a.sides)
      .map(d => `<span class="mat-die${d.available ? '' : ' used'}"><svg viewBox="0 0 100 100"><polygon points="${DIE[d.sides]}"/></svg><i>D${d.sides}</i></span>`).join('');
    const field = p.field || [];
    const legends = [...(p.legends || [])].sort((a, b) => (a.slotIndex ?? 0) - (b.slotIndex ?? 0));
    const eddies = p.eddies || [];
    const spentE = eddies.filter(e => e.exhausted).length;
    const shownE = Math.min(6, eddies.length), shownSpent = Math.min(shownE, spentE);
    const trash = p.trash || [];
    const top = trash[trash.length - 1];
    const handN = p.handCount ?? (p.hand || []).length;
    // Gigs you control: your own dice in Friendly Gigs, dice taken from the Rival in Rival Gigs
    const gigs = p.gigDice || [];
    const own = gigs.filter(g => !g.originalOwnerId || g.originalOwnerId === pid);
    const stolen = gigs.filter(g => g.originalOwnerId && g.originalOwnerId !== pid);
    return `<div class="mat ${rival ? 'rival' : 'you'}${st.game.activePlayerId === pid ? ' active' : ''}">
      ${TRACE}
      <span class="who-tag">${esc(R.labels[pid])}${p.streetCred != null ? ` · ☆${p.streetCred}` : ''}${clockHtml(st.game, pid)}</span>
      <div class="area a-fixer"><div class="mat-dice">${fixer}</div><span class="mat-tab"><b>Fixer</b></span></div>
      <div class="area a-rgig"><div class="gigs" style="--n:${stolen.length}">${stolen.map(g => gigHtml(g, pid)).join('')}</div><span class="mat-tab"><b>Rival Gigs${stolen.length ? ` ${stolen.length}` : ''}</b></span></div>
      <div class="area a-fgig"><div class="gigs" style="--n:${own.length}">${own.map(g => gigHtml(g, pid)).join('')}</div><span class="mat-tab"><b>Gigs ${gigs.length}/7</b></span></div>
      <div class="area a-field"><div class="field${field.length > 5 ? ' crowded' : ''}">${field.map(u => unitHtml(u)).join('')}</div><span class="mat-tab"><b>Field</b></span></div>
      <div class="area a-legends"><div class="legends">${legends.map(l => unitHtml(l, true)).join('')}</div><span class="mat-tab"><b>Legends</b></span></div>
      <div class="area a-eddies">${eddies.length ? `<div class="eddies">${Array.from({ length: shownE }, (_, i) => back(i >= shownE - shownSpent ? 'spent-e' : '', `--i:${i}`)).join('')}<span class="count" title="ready / total">${eddies.length - spentE}/${eddies.length}</span></div>` : ''}<span class="mat-tab"><b>Eddies</b></span></div>
      <div class="area a-deck"><div class="pile-wrap" data-zone="${pid}-deck"><span class="pile">${back()}</span><span class="count">${p.deckCount ?? '?'}</span></div><span class="mat-tab"><b>Deck</b></span></div>
      <div class="area a-trash">${top ? `<div class="pile-wrap" data-trash="${pid}"><span class="pile">${face(top)}</span><span class="count">${trash.length}</span></div>` : '<span class="card slot"></span>'}<span class="mat-tab"><b>Trash</b></span></div>
    </div>`;
  }

  // Chess-style match clock: time left for each player at this step (the running one has ticked since its last update).
  const mmss = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  function clockLeft(g, pid) {
    const ot = g.overtime;
    const by = ot ? g.overtimeClockByPlayerId : g.playerClockByPlayerId;
    if (!by || by[pid] == null) return null;
    const running = (ot ? g.overtimeClockPlayerId : g.playerClockPlayerId) === pid;
    const since = ot ? g.overtimeUpdatedAt : g.playerClockUpdatedAt;
    return { ms: by[pid] - (running && since && g.serverNowMs ? g.serverNowMs - since : 0), running, ot };
  }
  function clockHtml(g, pid) {
    if (!g.matchClockEnabled) return '';
    const c = clockLeft(g, pid);
    if (!c) return '';
    const low = c.ms < 120000;
    return ` · <span class="clock${c.running ? ' ticking' : ''}${low ? ' low' : ''}" title="${c.ot ? 'Overtime clock' : 'Match clock'}: time left">${c.ot ? 'OT ' : ''}⏱ ${mmss(c.ms)}</span>`;
  }

  // The Rival's hand: card backs fanned along the far edge of their mat, as if they're holding them.
  function rivalHandHtml(st) {
    const p = st.players[R.rival];
    const n = p.handCount ?? (p.hand || []).length;
    const shown = Math.min(n, 12);
    const cards = Array.from({ length: shown }, (_, i) => back('', `--k:${i - (shown - 1) / 2}`)).join('');
    return `<div class="rival-fan" data-zone="${R.rival}-hand" title="${esc(R.labels[R.rival])}: ${n} card${n === 1 ? '' : 's'} in hand">
      <div class="fan">${cards}</div>${n ? `<span class="fan-count">${n}</span>` : ''}</div>`;
  }

  // ── log: one fixed format per action ────────────────────────────────────
  function tag(p) {
    if (typeof p === 'string') return `<span class="lt">${esc(p)}</span>`;
    const id = nameToId.get(p.card) || nameToId.get(short(p.card));
    return `<span class="ctag"${id ? ` data-img="${esc(imgUrl(id))}"` : ''}>${esc(short(p.card))}</span>`;
  }
  function entryHtml(o) {
    if (!o.v) return `<span class="lt">${esc(o.raw)}</span>`;
    return `<span class="lv">${esc(o.v)}</span> ${o.a.map(tag).join(' ')}`
      + (o.d ? ` <span class="ld">· ${esc(o.d)}</span>` : '')
      + (o.via ? ` <span class="ld">· via</span> ${tag(o.via)}` : '');
  }
  function buildLog() {
    let lastTurn = null, html = '';
    for (const e of R.log) {
      const o = fmt(e.message);
      if (!o) continue;
      if (e.turnNumber !== lastTurn) {
        lastTurn = e.turnNumber;
        const side = e.turnOwnerPlayerId ? (e.turnOwnerPlayerId === R.me ? 'mine' : 'theirs') : '';
        html += `<li class="turn-h ${side}">${e.turnNumber ? `T${e.turnNumber} · ${esc(e.turnOwnerLabel)}` : 'Setup'}</li>`;
      }
      const who = o.actor || e.turnOwnerPlayerId;
      html += `<li class="e ${who ? (who === R.me ? 'mine' : 'theirs') : ''}" data-step="${e.step}" title="${esc(e.message)}">${entryHtml(o)}</li>`;
    }
    $('log').innerHTML = html;
  }

  // ── animation (FLIP) ────────────────────────────────────────────────────
  function snapshot() {
    const pos = new Map();
    for (const el of document.querySelectorAll('[data-cid], [data-uid], [data-gid], [data-zone]')) {
      const key = el.dataset.uid ? 'u' + el.dataset.uid : el.dataset.cid ? 'c' + el.dataset.cid : el.dataset.gid ? 'g' + el.dataset.gid : 'z' + el.dataset.zone;
      if (!pos.has(key)) pos.set(key, { r: el.getBoundingClientRect(), spent: el.classList.contains('spent'), v: el.dataset.v });
    }
    return pos;
  }
  function animate(before, dir) {
    if (reduceMotion || !before) return;
    const opts = { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' };
    const els = document.querySelectorAll('#table [data-uid], #table .card[data-cid], #my-hand .card[data-cid], #table [data-gid]');
    for (const el of els) {
      if (el.closest('.unit') && !el.dataset.uid) continue;          // a Unit and its Gear move together
      const key = el.dataset.uid ? 'u' + el.dataset.uid : el.dataset.gid ? 'g' + el.dataset.gid : 'c' + el.dataset.cid;
      let was = before.get(key);
      if (!was && el.dataset.uid) was = before.get('c' + el.dataset.uid);   // e.g. hand card → field Unit
      const now = el.getBoundingClientRect();
      const rot = el.classList.contains('spent') ? 90 : 0;
      const flip = el.closest('.mat.rival') ? -1 : 1;     // the Rival's mat is turned 180°, so its local axes are too
      if (was) {
        const dx = flip * ((was.r.left + was.r.width / 2) - (now.left + now.width / 2));
        const dy = flip * ((was.r.top + was.r.height / 2) - (now.top + now.height / 2));
        const wasRot = was.spent ? 90 : 0;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || wasRot !== rot)
          el.animate([{ transform: `translate(${dx}px, ${dy}px) rotate(${wasRot}deg)` }, { transform: `rotate(${rot}deg)` }], opts);
        if (el.dataset.gid && was.v !== el.dataset.v)
          el.animate([{ transform: 'scale(1.5)', filter: 'brightness(2.2)' }, { transform: 'none', filter: 'none' }], { duration: 520, easing: 'ease-out' });
      } else if (dir > 0) {
        // something new: glide in from its owner's hand (rival) or deck (you), else just fade in
        const pid = el.closest('.mat')?.classList.contains('rival') ? R.rival : R.me;
        const src = before.get(`z${pid}-hand`) || before.get(`z${pid}-deck`);
        const from = src && !el.dataset.gid
          ? `translate(${flip * ((src.r.left + src.r.width / 2) - (now.left + now.width / 2))}px, ${flip * ((src.r.top + src.r.height / 2) - (now.top + now.height / 2))}px) rotate(${rot}deg) scale(.6)`
          : `rotate(${rot}deg) scale(${el.dataset.gid ? 1.8 : .6})`;
        el.animate([{ transform: from, opacity: 0 }, { transform: `rotate(${rot}deg)`, opacity: 1 }], opts);
      }
    }
  }

  // ── render one step ─────────────────────────────────────────────────────
  function render(dir = 0) {
    const before = Math.abs(dir) === 1 ? snapshot() : null;
    const s = R.steps[cur], st = s.state;
    cardsById = new Map();

    $('table').innerHTML = rivalHandHtml(st) + matHtml(st, R.rival, true) + matHtml(st, R.me, false);
    const hand = st.players[R.me].hand || [];
    $('my-hand').innerHTML = hand.map(c => face(c)).join('') || '<span class="none">Empty</span>';
    $('hand-count').textContent = hand.length ? `· ${hand.length}` : '';

    const g = st.game;
    const who = g.activePlayerLabel ? `<span class="${g.activePlayerId === R.me ? 'mine' : 'theirs'}">${esc(g.activePlayerLabel)}</span>` : esc(g.stageLabel || 'Setup');
    const lines = s.newLog.map(e => fmt(e.message)).filter(Boolean);
    $('turn-box').innerHTML = `<div class="t">${g.turnNumber ? `Turn ${g.turnNumber} · ` : ''}${who}</div>
      <div class="act">${lines.length ? lines.map(entryHtml).join('<br>') : esc(s.action?.label || 'Start of the match')}</div>`;

    // cards named in this step's log glow on the board
    const named = new Set(lines.flatMap(o => [...(o.a || []), o.via]).filter(p => p && p.card).map(p => short(p.card)));
    for (const el of document.querySelectorAll('#table .card[data-cid]')) {
      const c = cardsById.get(el.dataset.cid);
      if (c && named.has(short(c.name))) el.classList.add('hot');
    }

    for (const li of $('log').querySelectorAll('.e')) {
      const n = +li.dataset.step;
      li.classList.toggle('now', n === cur);
      li.classList.toggle('future', n > cur);
    }
    const nowLi = $('log').querySelector('.e.now') || [...$('log').querySelectorAll('.e')].filter(li => +li.dataset.step <= cur).pop();
    nowLi?.scrollIntoView({ block: 'nearest' });

    $('scrub').value = cur;
    $('counter').textContent = `${cur} / ${R.steps.length - 1}${s.elapsed != null ? ` · ${mmss(s.elapsed)}` : ''}`;
    $('counter').title = 'Action / total · match time';
    animate(before, dir);
  }

  function matchInfo() {
    const m = R.match, res = m.result;
    const won = res?.winnerId === R.me;
    $('match-info').innerHTML = `<span class="who"><b>${esc(R.labels[R.me])}</b> vs ${esc(R.labels[R.rival])}</span>
      <span>${new Date(m.startedAt).toLocaleString()}</span>
      ${res ? `<span class="res ${won ? 'win' : 'loss'}" title="${esc(res.reason)}">${won ? 'Win' : 'Loss'}</span>` : ''}`;
  }

  // ── navigation ──────────────────────────────────────────────────────────
  function go(i) {
    if (!R) return;
    const next = Math.max(0, Math.min(R.steps.length - 1, i));
    const dir = next - cur; cur = next; render(dir);
  }
  function turnJump(d) {
    const ts = R.turnStarts;
    if (d < 0) { const t = [...ts].reverse().find(t => t.step < cur); go(t ? t.step : 0); }
    else { const t = ts.find(t => t.step > cur); go(t ? t.step : R.steps.length - 1); }
  }
  function togglePlay(force) {
    const on = force ?? !timer;
    clearInterval(timer); timer = null;
    if (on) timer = setInterval(() => { if (cur >= R.steps.length - 1) togglePlay(false); else go(cur + 1); }, 1100);
    $('play').classList.toggle('on', on); $('play').textContent = on ? '❚❚' : '▶';
  }

  function open(json, name) {
    try { R = Replay.load(json); }
    catch (e) { alert(`Couldn't open ${name || 'that file'}: ${e.message}`); return; }
    nameToId = new Map();
    const walk = o => {
      if (Array.isArray(o)) o.forEach(walk);
      else if (o && typeof o === 'object') {
        if (o.name && o.cardId) { nameToId.set(o.name, o.cardId); nameToId.set(short(o.name), o.cardId); }
        for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
      }
    };
    R.steps.forEach(s => walk(s.state.players));
    fmt = LogFmt.makeFormatter([...nameToId.keys()], R.labels);
    togglePlay(false);
    $('empty').hidden = true; $('table').hidden = false; $('timeline').hidden = false;
    $('scrub').max = R.steps.length - 1;
    matchInfo(); buildLog();
    cur = R.turnStarts.find(t => t.turn >= 1)?.step ?? 0; render();
  }

  // ── wiring ──────────────────────────────────────────────────────────────
  $('step-prev').onclick = () => go(cur - 1);
  $('step-next').onclick = () => go(cur + 1);
  $('turn-prev').onclick = () => turnJump(-1);
  $('turn-next').onclick = () => turnJump(1);
  $('play').onclick = () => togglePlay();
  $('scrub').oninput = e => go(+e.target.value);
  $('log').onclick = e => { const li = e.target.closest('.e'); if (li) go(+li.dataset.step); };
  document.addEventListener('keydown', e => {
    if (!R || e.target.matches?.('input, select, textarea')) return;
    if (e.key === 'ArrowLeft') { e.shiftKey ? turnJump(-1) : go(cur - 1); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { e.shiftKey ? turnJump(1) : go(cur + 1); e.preventDefault(); }
    else if (e.key === ' ') { togglePlay(); e.preventDefault(); }
    else if (e.key === 'Home') go(0); else if (e.key === 'End') go(R.steps.length - 1);
  });

  // hover: the card upright and large, plus its live status (Lag, Adrenaline, power changes, Gear)
  const zoom = $('zoom');
  function infoHtml(c) {
    if (!c) return '';
    const power = c.attackPower ?? c.power, base = c.basePower ?? c.power;
    const rows = [];
    if (c.zone === 'field' || (c.zone === 'legend' && !c.faceDown && c.attachments?.length)) {
      rows.push(`<div class="zi-row"><span>Power</span><b>${power ?? '–'}${power !== base && base != null ? ` <small>printed ${base}</small>` : ''}</b></div>`);
      rows.push(`<div class="zi-row"><span>State</span><b>${c.exhausted ? 'Spent' : 'Ready'}</b></div>`);
    }
    for (const e of c.currentEffects || [])
      if (!/^(spent|ready|power)$/i.test(e.kind) && !/^(SPENT|READY)$/.test(e.label)) rows.push(`<div class="zi-fx ${e.kind === 'lag' ? 'lag' : esc(e.tone || '')}"><b>${esc(e.label)}</b> ${esc(e.description)}${e.sourceName && e.sourceName !== 'Game rule' ? ` <small>${esc(e.sourceName)}</small>` : ''}</div>`);
    if (c.attachments?.length) rows.push(`<div class="zi-row"><span>Gear</span><b>${c.attachments.map(g => esc(short(g.name))).join(', ')}</b></div>`);
    return rows.length ? `<div class="zi">${rows.join('')}</div>` : '';
  }
  document.addEventListener('mouseover', e => {
    const el = e.target.closest('.card.face, .ctag[data-img]');
    if (!el || !el.dataset.img) { zoom.hidden = true; return; }
    // hovering a Unit's Gear strip shows the Gear; hovering the Unit shows the Unit with its status
    zoom.innerHTML = `<div class="zimg" style="background-image:url('${el.dataset.img}')"></div>${infoHtml(cardsById.get(el.dataset.cid))}`;
    zoom.hidden = false;
  });
  document.addEventListener('mousemove', e => {
    if (zoom.hidden) return;
    const w = zoom.offsetWidth, h = zoom.offsetHeight;
    let x = e.clientX + 24, y = e.clientY - h / 2;
    if (x + w > innerWidth - 8) x = e.clientX - w - 24;
    y = Math.max(8, Math.min(innerHeight - h - 8, y));
    zoom.style.left = x + 'px'; zoom.style.top = y + 'px';
  });

  // card art that's missing locally: fall back to the name label
  new MutationObserver(() => {
    for (const el of document.querySelectorAll('.card.face:not([data-checked])')) {
      el.dataset.checked = '1';
      const url = el.dataset.img; if (!url) continue;
      const img = new Image(); img.onload = () => el.classList.add('has-img'); img.src = url;
    }
  }).observe(document.body, { childList: true, subtree: true });

  // trash viewer
  $('table').addEventListener('click', e => {
    const t = e.target.closest('[data-trash]'); if (!t) return;
    const pid = t.dataset.trash, trash = R.steps[cur].state.players[pid].trash || [];
    $('pile-title').textContent = `${R.labels[pid]}'s trash · ${trash.length}`;
    $('pile-cards').innerHTML = [...trash].reverse().map(c => face(c)).join('');
    $('pile-dialog').showModal();
  });
  $('pile-close').onclick = () => $('pile-dialog').close();

  // loading: list from ~/Downloads (via the dev server), file picker, drag & drop
  fetch('/api/replays').then(r => r.json()).then(list => {
    for (const f of list) {
      const m = f.name.match(/replay-(\d{4}-\d\d-\d\d)-(.+)-[0-9a-f]{8}\.json$/);
      $('replay-pick').insertAdjacentHTML('beforeend', `<option value="${esc(f.name)}">${m ? `${m[1]} · ${esc(m[2].replace(/-vs-/, ' vs '))}` : esc(f.name)}</option>`);
    }
  }).catch(() => {});
  $('replay-pick').onchange = e => {
    const name = e.target.value; if (!name) return;
    fetch(`/api/replays/${encodeURIComponent(name)}`).then(r => r.json()).then(j => open(j, name)).catch(err => alert(err.message));
  };
  const readFile = f => f.text().then(t => open(JSON.parse(t), f.name)).catch(err => alert(`Couldn't read ${f.name}: ${err.message}`));
  $('replay-file').onchange = e => e.target.files[0] && readFile(e.target.files[0]);
  const col = document.querySelector('.board-col');
  col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('drag'); });
  col.addEventListener('dragleave', () => col.classList.remove('drag'));
  col.addEventListener('drop', e => { e.preventDefault(); col.classList.remove('drag'); e.dataTransfer.files[0] && readFile(e.dataTransfer.files[0]); });
})();
