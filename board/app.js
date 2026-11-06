// Replay viewer UI: renders one replay step on the two-mat board, plus hand, log and timeline.
// Also drives live games (board/play.html): window.Board.openLive / extend.
// Moving one step at a time animates the change (FLIP: cards glide from where they were).
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const short = n => String(n || '').split(/ — |: /)[0];   // newer servers write "Name: Subtitle"
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
    // live games (board/play.html): your own face-down Legends are known to you - shown dimmed, not as backs
    if (isLegend && u.faceDown && !u.known) return `<div class="unit${u.exhausted ? ' spent' : ''}" data-uid="${esc(u.id)}" style="--n:0">${back('legend host', '', u.id)}</div>`;
    const gear = u.attachments || [];
    const power = u.attackPower ?? u.power ?? 0, base = u.basePower ?? u.power ?? 0;
    const delta = power - base;
    // power shows only when an effect changed it, like a counter on a real table
    const badge = delta && (!isLegend || u.zone === 'field') ? `<span class="badge ${delta > 0 ? 'up' : 'down'}">${power}</span>` : '';
    // A Legend keeps its full size: its Gear sits tucked just behind it (thin edges) with a count badge;
    // hover shows every Gear card. Units on the Field show the Gear's bottom strip under the card instead.
    if (isLegend && u.zone !== 'field') {
      return `<div class="unit lg${u.exhausted ? ' spent' : ''}" data-uid="${esc(u.id)}" style="--n:0">
        ${gear.map((g, i) => face(g, 'gear tucked', `--i:${i}`)).join('')}${face(u, u.faceDown ? 'host fd' : 'host')}${badge}
        ${gear.length ? `<span class="gear-badge" title="${esc(gear.map(g => short(g.name)).join(', '))}">⚙ ${gear.length}</span>` : ''}</div>`;
    }
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
      <div class="area a-field"><div class="field">${field.map(u => unitHtml(u)).join('')}</div><span class="mat-tab"><b>Field</b></span></div>
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

  // One row per player: name, clock, the Gig race (7 pips; dashed = taken from the Rival), counts.
  function glanceHtml(st, pid) {
    const p = st.players[pid], g = st.game;
    const gigs = p.gigDice || [];
    const stolenN = gigs.filter(d => d.originalOwnerId && d.originalOwnerId !== pid).length;
    const pips = Array.from({ length: 7 }, (_, i) => `<i class="${i < gigs.length ? 'on' : ''}${i >= gigs.length - stolenN && i < gigs.length ? ' st' : ''}"></i>`).join('');
    const c = g.matchClockEnabled ? clockLeft(g, pid) : null;
    const eddies = p.eddies || [];
    const ready = eddies.filter(e => !e.exhausted).length;
    const hand = p.handCount ?? (p.hand || []).length;
    return `<div class="gl ${pid === R.me ? 'mine' : 'theirs'}">
      <span class="nm">${esc(R.labels[pid])}</span>
      ${c ? `<span class="ck${c.running ? ' ticking' : ''}${c.ms < 120000 ? ' low' : ''}">${c.ot ? 'OT ' : ''}${mmss(c.ms)}</span>` : '<span></span>'}
      <span class="pips" title="${gigs.length} of 7 Gigs${stolenN ? `, ${stolenN} taken from the Rival` : ''}">${pips}</span><span class="ck">${gigs.length}/7</span>
      <span class="nums">Hand <b>${hand}</b> · Deck <b>${p.deckCount ?? '?'}</b> · Eddies <b>${ready}/${eddies.length}</b>${p.streetCred != null ? ` · ☆ <b>${p.streetCred}</b>` : ''}</span>
    </div>`;
  }

  // Where each card instance is and how it sits, to tell which copy of a card an action touched.
  function cardSigs(st) {
    const m = new Map();
    for (const [pid, p] of Object.entries(st.players))
      for (const z of ['hand', 'field', 'legends', 'trash'])
        for (const c of p[z] || []) {
          m.set(c.id, `${pid}:${z}:${c.exhausted ? 1 : 0}:${c.faceDown ? 1 : 0}:${(c.attachments || []).map(g => g.id).join(',')}:${c.attackPower ?? ''}`);
          for (const g of c.attachments || []) m.set(g.id, `${pid}:gear:${c.id}`);
        }
    return m;
  }

  // A player's hand, fanned in the left bar: the Rival's as backs, yours face up (hover for the big view).
  function handFanHtml(st, pid) {
    const p = st.players[pid];
    const mine = pid === R.me;
    const cards = mine ? (p.hand || []) : [];
    const n = mine ? cards.length : (p.handCount ?? (p.hand || []).length);
    const shown = Math.min(n, 12);
    const k = i => `--k:${i - (shown - 1) / 2}`;
    const inner = !n ? '<span class="none">No cards</span>'
      : mine ? cards.slice(0, 12).map((c, i) => face(c, '', k(i))).join('')
      : Array.from({ length: shown }, (_, i) => back('', k(i))).join('');
    return `<div class="hfan${mine ? '' : ' backs'}"${mine ? ' id="my-hand"' : ''} data-zone="${pid}-hand" style="--n1:${Math.max(1, shown - 1)}"
      title="${esc(R.labels[pid])}: ${n} card${n === 1 ? '' : 's'} in hand">${inner}</div>`;
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
    let lastTurn = null, html = '', lastLine = '';
    for (const e of R.log) {
      const o = fmt(e.message);
      if (!o) continue;
      if (e.turnNumber !== lastTurn) {
        lastTurn = e.turnNumber; lastLine = '';
        const side = e.turnOwnerPlayerId ? (e.turnOwnerPlayerId === R.me ? 'mine' : 'theirs') : '';
        html += `<li class="turn-h ${side}">${e.turnNumber ? `T${e.turnNumber} · ${esc(e.turnOwnerLabel)}` : 'Setup'}</li>`;
      }
      const who = o.actor || e.turnOwnerPlayerId;
      // name the player only when it isn't the turn's owner (setup, defensive Calls, Blockers…)
      const name = o.actor && o.actor !== e.turnOwnerPlayerId ? `<span class="lp">${esc(R.labels[o.actor])}</span> ` : '';
      const line = name + entryHtml(o);
      if (line === lastLine) continue;               // the sim sometimes logs the same thing twice
      lastLine = line;
      html += `<li class="e ${who ? (who === R.me ? 'mine' : 'theirs') : ''}" data-step="${e.step}" title="${esc(e.message)}">${line}</li>`;
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
      // fanned hand cards keep their tilt: animate back to their own CSS transform
      const rest = el.closest('.hfan') ? getComputedStyle(el).transform : null;
      const rot = el.classList.contains('spent') ? 90 : 0;
      const restT = rest && rest !== 'none' ? rest : `rotate(${rot}deg)`;
      const flip = el.closest('.mat.rival') ? -1 : 1;     // the Rival's mat is turned 180°, so its local axes are too
      if (was) {
        const dx = flip * ((was.r.left + was.r.width / 2) - (now.left + now.width / 2));
        const dy = flip * ((was.r.top + was.r.height / 2) - (now.top + now.height / 2));
        const wasRot = was.spent ? 90 : 0;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || wasRot !== rot)
          el.animate([{ transform: rest ? `translate(${dx}px, ${dy}px) ${restT}` : `translate(${dx}px, ${dy}px) rotate(${wasRot}deg)` }, { transform: restT }], opts);
        if (el.dataset.gid && was.v !== el.dataset.v)
          el.animate([{ transform: 'scale(1.5)', filter: 'brightness(2.2)' }, { transform: 'none', filter: 'none' }], { duration: 520, easing: 'ease-out' });
      } else if (dir > 0) {
        // something new: glide in from its owner's hand (rival) or deck (you), else just fade in
        const pid = el.closest('.mat')?.classList.contains('rival') ? R.rival : R.me;
        const src = before.get(`z${pid}-hand`) || before.get(`z${pid}-deck`);
        const from = src && !el.dataset.gid
          ? `translate(${flip * ((src.r.left + src.r.width / 2) - (now.left + now.width / 2))}px, ${flip * ((src.r.top + src.r.height / 2) - (now.top + now.height / 2))}px) rotate(${rot}deg) scale(.6)`
          : `rotate(${rot}deg) scale(${el.dataset.gid ? 1.8 : .6})`;
        el.animate([{ transform: from, opacity: 0 }, { transform: restT, opacity: 1 }], opts);
      }
    }
  }

  // Field cards as large as the Field allows: one row, every Unit's Gear strips and spent rotation included.
  const CARD_H = 1024 / 733, PEEK = .24, FIELD_GAP = 1.4, MAX_CW = 12;
  function sizeFields() {
    const cq = $('table').clientWidth / 100;                // px per cqw
    if (!cq) return;
    for (const f of document.querySelectorAll('#table .field, #table .legends')) {
      const leg = f.classList.contains('legends');
      const units = [...f.querySelectorAll(':scope > .unit')];
      if (!units.length) { f.style.removeProperty('--cw'); continue; }
      const availW = f.clientWidth / cq - (leg ? 1.6 : 2.4), availH = f.clientHeight / cq - (leg ? 1 : 1.6);   // minus padding
      let sumW = 0, maxH = 0;
      for (const u of units) {
        const len = CARD_H * (1 + PEEK * (+u.style.getPropertyValue('--n') || 0));   // card + Gear strips, in card widths
        const spent = u.classList.contains('spent');
        sumW += spent ? len : 1; maxH = Math.max(maxH, spent ? 1 : len);
      }
      const gap = leg ? 1.2 : FIELD_GAP;
      const cw = Math.min(leg ? 7.5 : MAX_CW, availH / maxH, (availW - gap * (units.length - 1)) / sumW);
      f.style.setProperty('--cw', `${Math.max(3, cw).toFixed(2)}cqw`);
    }
  }

  // Every card that arrives from somewhere hidden or from your hand pops up big in the middle of the board,
  // holds a moment, then flies to where it went: draws to your hand, cards trashed from the deck (V, Judy,
  // River Ward), discards and played Programs to the trash, Gear onto its Unit, recovered cards to hand.
  // Units moving between the Field and the trash keep their normal slide (FLIP).
  const POP_ZONES = new Set(['hand', 'trash', 'gear']);
  function cardLocations(st) {
    const m = new Map();
    for (const [pid, p] of Object.entries(st.players)) {
      for (const z of ['hand', 'field', 'legends', 'trash'])
        for (const c of p[z] || []) {
          if (c.id && c.cardId) m.set(c.id, { pid, zone: z, c });
          for (const g of c.attachments || []) m.set(g.id, { pid, zone: 'gear', c: g });
        }
    }
    return m;
  }
  let pops = [];
  function clearPops() { for (const p of pops) { p.clone.remove(); if (p.dest) p.dest.style.visibility = ''; } pops = []; }
  function popArrivals(prevState, st) {
    clearPops();
    if (reduceMotion) return;
    const was = cardLocations(prevState), now = cardLocations(st);
    const arrivals = [];
    for (const [id, n] of now) {
      if (!POP_ZONES.has(n.zone)) continue;
      if (n.zone === 'hand' && n.pid !== R.me) continue;              // the Rival's hand is hidden
      const w = was.get(id);
      if (w && (w.zone === n.zone || w.zone === 'field' || w.zone === 'gear' || w.zone === 'legends')) continue;
      arrivals.push({ id, ...n });
    }
    if (!arrivals.length) return;
    const shown = arrivals.slice(0, 6);
    const T = $('table').getBoundingClientRect();
    const k = shown.length, gap = 14;
    const W = Math.min(200, (T.width * .9 - gap * (k - 1)) / k), H = W * CARD_H;
    const rowLeft = T.left + T.width / 2 - (k * W + (k - 1) * gap) / 2, top = T.top + T.height / 2 - H / 2;
    shown.forEach((a, i) => {
      // destination: the card itself if it's drawn on screen, else its owner's trash pile
      const side = a.pid === R.me ? 'you' : 'rival';
      let dest = document.querySelector(`#table [data-cid="${CSS.escape(a.id)}"], #my-hand [data-cid="${CSS.escape(a.id)}"]`);
      const exact = !!dest;
      if (!dest) dest = document.querySelector(`#table .mat.${side} .a-trash .pile-wrap`);
      if (!dest) return;
      // this card's normal slide (e.g. hand → trash) would start it back at its old spot: the pop replaces it
      if (exact) dest.getAnimations().forEach(x => x.cancel());
      const d = dest.getBoundingClientRect();
      const x = rowLeft + i * (W + gap), y = top;
      const clone = document.createElement('div');
      clone.className = 'card face pop-card';
      clone.style.cssText = `position:fixed; z-index:40; width:${W}px; height:${H}px; left:${x}px; top:${y}px; background-image:url('${imgUrl(a.c.cardId)}')`;
      document.body.appendChild(clone);
      if (exact) dest.style.visibility = 'hidden';
      pops.push({ clone, dest: exact ? dest : null });
      const dx = (d.left + d.width / 2) - (x + W / 2), dy = (d.top + d.height / 2) - (y + H / 2);
      const flip = dest.closest('.mat.rival') ? 180 : 0;        // lands the way it lies on the Rival's turned mat
      const end = `translate(${dx}px, ${dy}px) scale(${Math.min(d.width, d.height / CARD_H) / W}) rotate(${flip}deg)`;
      const anim = clone.animate([
        { transform: 'scale(.4)', opacity: 0, offset: 0 },
        { transform: 'scale(1.04)', opacity: 1, offset: .14 },
        { transform: 'scale(1)', opacity: 1, offset: .2 },
        { transform: 'scale(1)', opacity: 1, offset: .58 },
        { transform: end, opacity: exact ? 1 : .2, offset: 1 },
      ], { duration: 1250, delay: i * 90, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'both' });
      anim.onfinish = () => { clone.remove(); if (exact) dest.style.visibility = ''; pops = pops.filter(p => p.clone !== clone); };
    });
  }

  // ── render one step ─────────────────────────────────────────────────────
  function render(dir = 0) {
    clearPops();
    const before = Math.abs(dir) === 1 ? snapshot() : null;
    const s = R.steps[cur], st = s.state;
    cardsById = new Map();

    const lines = s.newLog.map(e => fmt(e.message)).filter(Boolean);
    $('table').innerHTML = matHtml(st, R.rival, true) + bannerHtml(s, lines, dir) + matHtml(st, R.me, false);
    $('rival-block').innerHTML = glanceHtml(st, R.rival) + handFanHtml(st, R.rival);
    $('me-block').innerHTML = glanceHtml(st, R.me) + handFanHtml(st, R.me);

    const g = st.game;
    const who = g.activePlayerLabel ? `<span class="${g.activePlayerId === R.me ? 'mine' : 'theirs'}">${esc(g.activePlayerLabel)}</span>` : esc(g.stageLabel || 'Setup');
    $('turn-box').innerHTML = `<div class="t">${g.turnNumber ? `Turn ${g.turnNumber} · ` : ''}${who}</div>
      <div class="act">${lines.length ? lines.map(entryHtml).join('<br>') : esc(s.action?.label || 'Start of the match')}</div>`;

    // Cards named in this step's log glow. With several copies of a name, only the copy that changed
    // this step (moved, spent/readied, flipped, gained Gear) glows; one unchanged copy glows on its own;
    // otherwise none, rather than lighting up the wrong Meredith.
    const named = new Set(lines.flatMap(o => [...(o.a || []), o.via]).filter(p => p && p.card).map(p => short(p.card)));
    if (named.size) {
      const was = cur > 0 ? cardSigs(R.steps[cur - 1].state) : new Map(), now = cardSigs(st);
      const byName = new Map();
      for (const el of document.querySelectorAll('#table .card[data-cid], #my-hand .card[data-cid]')) {
        const c = cardsById.get(el.dataset.cid);
        if (!c || !named.has(short(c.name))) continue;
        const list = byName.get(short(c.name)) || []; list.push({ el, changed: was.get(c.id) !== now.get(c.id) }); byName.set(short(c.name), list);
      }
      for (const list of byName.values()) {
        const changed = list.filter(x => x.changed);
        (changed.length ? changed : list.length === 1 ? list : []).forEach(x => x.el.classList.add('hot'));
      }
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
    sizeFields();
    animate(before, dir);
    if (dir === 1) popArrivals(R.steps[cur - 1].state, st);
    document.dispatchEvent(new CustomEvent('board:step', { detail: { step: cur } }));
  }

  // What just happened: a caption strip in its own gap between the two mats, so it never covers a card.
  // It slides in fresh when you step forward or back (not when you jump).
  function bannerHtml(s, lines, dir) {
    const g = s.state.game;
    const actor = lines.find(o => o.actor)?.actor || g.activePlayerId;
    const side = actor ? (actor === R.me ? 'mine' : 'theirs') : '';
    const head = `<span class="bn-h">${g.turnNumber ? `T${g.turnNumber} · ` : ''}${esc(R.labels[actor] || 'Setup')}</span>`;
    const body = lines.length
      ? lines.map(o => `<span class="bn-l">${o.actor && o.actor !== actor ? `<span class="lp">${esc(R.labels[o.actor])}</span> ` : ''}${entryHtml(o)}</span>`).join('<span class="bn-sep">›</span>')
      : `<span class="bn-l ld">${esc(s.action?.label || 'Start of the match')}</span>`;
    const tip = lines.length ? s.newLog.map(e => e.message).join('\n') : '';
    return `<div class="banner ${side}${Math.abs(dir) === 1 ? ' show' : ''}" aria-live="polite" title="${esc(tip)}">${head}<span class="bn-body">${body}</span></div>`;
  }

  function matchInfo() {
    const m = R.match, res = m.result;
    if (R.live) { document.dispatchEvent(new CustomEvent('board:matchinfo')); return; }
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
    if (on) timer = setInterval(() => { if (cur >= R.steps.length - 1) togglePlay(false); else go(cur + 1); }, 1500);
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
    document.dispatchEvent(new CustomEvent('board:open', { detail: { name, steps: R.steps.length, matchId: R.match.matchId } }));
    cur = R.turnStarts.find(t => t.turn >= 1)?.step ?? 0; render();
  }
  // for board/coach.js: jump to a step
  window.BoardNav = { go: i => go(i) };

  // Live games (board/play.html + live.js): R is built by the page, steps arrive as the game goes on.
  const walkNames = o => {
    if (Array.isArray(o)) o.forEach(walkNames);
    else if (o && typeof o === 'object') {
      if (o.name && o.cardId) { nameToId.set(o.name, o.cardId); nameToId.set(short(o.name), o.cardId); }
      for (const v of Object.values(o)) if (v && typeof v === 'object') walkNames(v);
    }
  };
  function turnStartsOf(steps) {
    const ts = [];
    steps.forEach((s, i) => { if (!ts.length || ts[ts.length - 1].turn !== s.turn) ts.push({ turn: s.turn, step: i }); });
    return ts;
  }
  window.Board = {
    openLive(r) {
      R = { ...r, live: true, turnStarts: turnStartsOf(r.steps) };
      nameToId = new Map();
      R.steps.forEach(s => walkNames(s.state.players));
      fmt = LogFmt.makeFormatter([...nameToId.keys()], R.labels);
      togglePlay(false);
      $('empty').hidden = true; $('table').hidden = false; $('timeline').hidden = false;
      $('scrub').max = R.steps.length - 1;
      matchInfo(); buildLog();
      cur = R.steps.length - 1; render();
    },
    // append steps; follow the game if you were watching the latest step
    extend(steps, log) {
      if (!R || !steps.length) return;
      const follow = cur >= R.steps.length - 1;
      R.steps.push(...steps); R.log.push(...log);
      steps.forEach(s => walkNames(s.state.players));
      fmt = LogFmt.makeFormatter([...nameToId.keys()], R.labels);
      R.turnStarts = turnStartsOf(R.steps);
      $('scrub').max = R.steps.length - 1;
      buildLog();
      if (follow) go(R.steps.length - 1); else render(0);
    },
    current: () => cur, total: () => (R ? R.steps.length : 0), step: i => R?.steps[i],
  };

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
    if (c.attachments?.length) rows.push(`<div class="zi-gear"><span>Gear · ${c.attachments.length}</span><div>${c.attachments.map(g =>
      `<figure><i style="background-image:url('${imgUrl(g.cardId)}')"></i><figcaption>${esc(short(g.name))}</figcaption></figure>`).join('')}</div></div>`);
    return rows.length ? `<div class="zi">${rows.join('')}</div>` : '';
  }
  document.addEventListener('mouseover', e => {
    const el = e.target.closest('.card.face, .ctag[data-img]');
    if (!el || !el.dataset.img) { zoom.hidden = true; return; }
    // hovering a Unit's Gear strip shows the Gear; hovering the Unit shows the Unit with its status
    // no art on this machine (live games carry the card text): show the card as text instead
    const c = cardsById.get(el.dataset.cid);
    const art = el.classList.contains('no-img') && c?.text != null
      ? `<div class="ztext"><b>${esc(c.name)}</b><span>${esc([c.color, c.type, c.cost != null && `cost ${c.cost}`, c.ram != null && `RAM ${c.ram}`, c.power != null && `power ${c.power}`].filter(Boolean).join(' · '))}</span><p>${esc(c.text).replace(/\{([^}]+)\}/g, '<i>$1</i>')}</p></div>`
      : `<div class="zimg" style="background-image:url('${el.dataset.img}')"></div>`;
    zoom.innerHTML = `${art}${infoHtml(c)}`;
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

  // card art that's missing locally: show the name label instead (checked once per image)
  const missingArt = new Set(), checkedArt = new Set();
  new MutationObserver(() => {
    for (const el of document.querySelectorAll('.card.face:not([data-checked])')) {
      el.dataset.checked = '1';
      const url = el.dataset.img;
      if (!url || missingArt.has(url)) { el.classList.add('no-img'); continue; }
      if (checkedArt.has(url)) continue;
      checkedArt.add(url);
      const img = new Image();
      img.onerror = () => { missingArt.add(url); document.querySelectorAll(`.card.face[data-img="${CSS.escape(url)}"]`).forEach(c => c.classList.add('no-img')); };
      img.src = url;
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
  if (!$('replay-pick')) return;   // the live-game page (board/play.html) has no replay loading
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
