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
  // Polyhedral dice: silhouette (body), the front face the number sits on, and facet edges from the front
  // face's corners out to the silhouette - read as real d4..d20 rather than flat outlines. `n` = where the
  // number sits (y, in the 0-100 box).
  const DIE3D = {
    4:  { body: '50,4 96,92 4,92', face: '50,34 74,80 26,80', edges: [[50, 34, 50, 4], [74, 80, 96, 92], [26, 80, 4, 92]], n: 64 },
    6:  { body: '10,10 90,10 90,90 10,90', face: '24,24 76,24 76,76 24,76', edges: [[24, 24, 10, 10], [76, 24, 90, 10], [76, 76, 90, 90], [24, 76, 10, 90]], n: 50 },
    8:  { body: '50,3 97,50 50,97 3,50', face: '50,24 79,68 21,68', edges: [[50, 24, 50, 3], [79, 68, 97, 50], [79, 68, 50, 97], [21, 68, 50, 97], [21, 68, 3, 50]], n: 55 },
    10: { body: '50,3 95,42 50,97 5,42', face: '50,26 74,46 50,78 26,46', edges: [[50, 26, 50, 3], [74, 46, 95, 42], [50, 78, 50, 97], [26, 46, 5, 42]], n: 50 },
    12: { body: '50,4 96,38 79,94 21,94 4,38', face: '50,28 73,45 64,73 36,73 27,45', edges: [[50, 28, 50, 4], [73, 45, 96, 38], [64, 73, 79, 94], [36, 73, 21, 94], [27, 45, 4, 38]], n: 54 },
    20: { body: '50,3 93,27 93,73 50,97 7,73 7,27', face: '50,24 76,69 24,69', edges: [[50, 24, 50, 3], [50, 24, 93, 27], [50, 24, 7, 27], [76, 69, 93, 27], [76, 69, 93, 73], [76, 69, 50, 97], [24, 69, 50, 97], [24, 69, 7, 73], [24, 69, 7, 27]], n: 55 },
  };
  const dieSvg = sides => {
    const d = DIE3D[sides] || DIE3D[6];
    return `<svg viewBox="0 0 100 100" aria-hidden="true"><polygon class="d-body" points="${d.body}"/>`
      + d.edges.map(([a, b, c, e]) => `<line class="d-edge" x1="${a}" y1="${b}" x2="${c}" y2="${e}"/>`).join('')
      + `<polygon class="d-face" points="${d.face}"/><polygon class="d-gloss" points="${d.body}"/></svg>`;
  };
  const TRACE = `<svg class="mat-trace\" viewBox="0 0 1000 560" preserveAspectRatio="none" aria-hidden="true">
      <path d="M30 120 L30 40 L70 10 L300 10 M700 10 L930 10 L975 55 L975 200 M975 380 L975 500 L940 545 L620 545 M380 545 L60 545 L30 515 L30 420"/>
      <path class="thin" d="M50 140 L50 60 L80 32 M920 32 L955 70 L955 190 M955 390 L955 490 L925 525"/></svg>`;

  let R = null;               // loaded replay
  let cur = 0;                // current step index
  let timer = null;
  let nameToId = new Map();   // card name (full and short) → cardId, for log tags
  let cardsById = new Map();  // card instance id → card object at the current step (hover panel)
  let fmt = null;
  let SPD = 1;                // animation length multiplier (live games: set from the bot pace)
  let animUntil = 0;          // live games: the next step waits until the long animations (deal, mulligan, pops, rolls) end
  const busyFor = ms => { animUntil = Math.max(animUntil, performance.now() + ms); };

  // ── cards ───────────────────────────────────────────────────────────────
  const imgUrl = cardId => cardId ? `/card/${encodeURIComponent(cardId)}` : '';
  function face(c, cls = '', style = '') {
    cardsById.set(c.id, c);
    return `<div class="card face ${cls}" data-cid="${esc(c.id)}" data-img="${esc(imgUrl(c.cardId))}"
      style="background-image:url('${imgUrl(c.cardId)}');${style}"><span class="cname">${esc(short(c.name))}</span></div>`;
  }
  const back = (cls = '', style = '', cid = '') => `<div class="card back ${cls}"${cid ? ` data-cid="${esc(cid)}"` : ''} style="${style}"></div>`;

  // statuses as small icons in a row along the card's top-left edge (lag, Adrenaline, can't attack / ready,
  // must attack...), each with a short hover text. Live games and replays use different kind names, so they
  // are mapped onto one icon set. Power changes stay on the power badge; spent is the card's rotation.
  const ICON = (() => {
    const sv = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
    const sword = '<path d="M14.5 3.5h6v6L10 20l-6-6Z"/><path d="M6.5 15.5 3 19l2 2 3.5-3.5"/>';
    const shield = '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8 7.5 9.5 4.3-1.5 7.5-4.9 7.5-9.5V6Z"/>';
    const bolt = '<path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12Z"/>';
    const slash = '<path d="M3 3 21 21" stroke-width="2.8"/>';
    return {
      lag: sv('<path d="M6 3h12M6 21h12M7 3c0 5 10 5 10 9s-10 4-10 9M17 3c0 5-10 5-10 9s10 4 10 9"/>'),
      bolt: sv(bolt), noBolt: sv(bolt + slash),
      noSword: sv(sword + slash),
      mustSword: sv(sword + '<path d="M20 15v3M20 21v.01" stroke-width="2.6"/>'),
      targetSword: sv(sword + '<circle cx="18.5" cy="18.5" r="2.5"/>'),
      noReady: sv('<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4.5h-4.5"/>' + slash),
      shield: sv(shield), noShield: sv(shield + slash), shieldPlus: sv(shield + '<path d="M12 9v6M9 12h6"/>'),
    };
  })();
  const STATUS = {
    LAG: ['lag', 'warn'], ADRENALINE: ['bolt', 'good'], HASTE_VS_GIGS: ['bolt', 'good'], HASTE_VS_SPENT: ['bolt', 'good'],
    NO_HASTE: ['noBolt', 'bad'], CANNOT_ATTACK: ['noSword', 'bad'], ATTACK_LOCK: ['noSword', 'bad'], CANNOT_ATTACK_GIGS: ['noSword', 'bad'],
    CANNOT_READY: ['noReady', 'bad'], READY_LOCK: ['noReady', 'bad'], MUST_ATTACK: ['mustSword', 'bad'],
    UNBLOCKABLE: ['noShield', 'good'], FIGHT_IMMUNE: ['shieldPlus', 'good'], BLOCKER: ['shield', 'good'],
    ATTACK_READY_BLOCKERS: ['targetSword', 'good'], ATTACK_READY_UNITS: ['targetSword', 'good'],
  };
  const SHORT = { LAG: "Arrived this turn - can't attack yet", ADRENALINE: 'Can attack the turn it arrived', READY_LOCK: "Won't ready",
    CANNOT_READY: "Won't ready", ATTACK_LOCK: "Can't attack", CANNOT_ATTACK: "Can't attack", MUST_ATTACK: 'Must attack if able' };
  function statusIconsHtml(u) {
    const out = [], seen = new Set();
    for (const e of u.currentEffects || []) {
      const k = String(e.kind || '').toUpperCase().replace(/-/g, '_'), st = STATUS[k];
      if (!st || seen.has(st[0] + e.label)) continue;
      seen.add(st[0] + e.label);
      const label = /^[A-Z ]+$/.test(e.label || '') ? e.label[0] + e.label.slice(1).toLowerCase() : (e.label || k);
      // replays carry the simulator's long rules text; keep the hover short
      const d = e.description && e.description.length <= 48 ? e.description : SHORT[k] || '';
      const tip = d ? `${label} - ${d}` : label;
      out.push(`<span class="st ${st[1]}" title="${esc(tip)}">${ICON[st[0]]}</span>`);
    }
    return out.length ? `<span class="sticons">${out.join('')}</span>` : '';
  }
  function unitHtml(u, isLegend = false) {
    // live games (board/play.html): your own face-down Legends are known to you - shown dimmed, not as backs
    if (isLegend && u.faceDown && !u.known) return `<div class="unit${u.exhausted ? ' spent' : ''}" data-uid="${esc(u.id)}" style="--n:0">${back('legend host', '', u.id)}</div>`;
    const gear = u.attachments || [];
    const power = u.attackPower ?? u.power ?? 0, base = u.basePower ?? u.power ?? 0;
    const delta = power - base;
    // power shows only when an effect changed it, like a counter on a real table
    const badge = (delta && (!isLegend || u.zone === 'field') ? `<span class="badge ${delta > 0 ? 'up' : 'down'}">${power}</span>` : '') + statusIconsHtml(u);
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
      ${dieSvg(g.sides)}<b style="--ny:${(DIE3D[g.sides] || DIE3D[6]).n}%">${g.value}</b></span>`;
  }

  function matHtml(st, pid, rival) {
    const p = st.players[pid];
    const fixer = [...(p.dicePool || [])].sort((a, b) => b.sides - a.sides)
      .map(d => `<span class="mat-die${d.available ? '' : ' used'}">${dieSvg(d.sides)}<i>D${d.sides}</i></span>`).join('');
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
      <div class="area a-eddies">${eddies.length ? `<div class="eddies" data-eddies="${pid}">${Array.from({ length: shownE }, (_, i) => back(i >= shownE - shownSpent ? 'spent-e' : '', `--i:${i}`)).join('')}<span class="count" title="ready / total">${eddies.length - spentE}/${eddies.length}</span></div>` : ''}<span class="mat-tab"><b>Eddies</b></span></div>
      <div class="area a-deck"><div class="pile-wrap" data-zone="${pid}-deck"><span class="pile">${back()}</span><span class="count">${p.deckCount ?? '?'}</span></div><span class="mat-tab"><b>Deck</b></span></div>
      <div class="area a-trash">${top ? `<div class="pile-wrap" data-trash="${pid}"><span class="pile">${face(top)}</span><span class="count">${trash.length}</span></div>` : '<span class="card slot"></span>'}<span class="mat-tab"><b>Trash</b></span></div>
    </div>`;
  }

  // ── the table (one shared play area, like the simulator's own board) ──────
  // left column: Rival hand, fixer dice, Gigs | status + caption | your Gigs, dice, hand
  // centre: Rival Legends + Eddies, both Fields, your Legends + Eddies; right strip: trash and deck piles
  const sideOf = pid => (pid === R.me ? 'you' : 'rival');
  function diceRowHtml(p) {
    return [...(p.dicePool || [])].sort((a, b) => a.sides - b.sides)
      .map(d => `<span class="mat-die${d.available ? '' : ' used'}">${dieSvg(d.sides)}<i>D${d.sides}</i></span>`).join('');
  }
  function gigRowHtml(st, pid) {
    const gigs = st.players[pid].gigDice || [];
    const own = gigs.filter(g => !g.originalOwnerId || g.originalOwnerId === pid);
    const stolen = gigs.filter(g => g.originalOwnerId && g.originalOwnerId !== pid);
    const total = gigs.reduce((a, g) => a + (+g.value || 0), 0);
    return `<div class="gigs" style="--n:${Math.max(1, gigs.length)}">${own.map(g => gigHtml(g, pid)).join('')}${stolen.map(g => gigHtml(g, pid)).join('')}</div>
      <div class="gig-count" title="Gigs (7 wins) · total value"><b>${gigs.length}/7</b><span>${total}</span></div>`;
  }
  function handRowHtml(st, pid) {
    const p = st.players[pid], mine = pid === R.me;
    const cards = p.hand || [];
    const n = cards.length ? cards.length : (p.handCount ?? 0);
    // replays list the Rival's hand as hidden entries (no card): show those as backs
    const inner = cards.length ? cards.map((c, i) => c.cardId ? face(c, '', `--i:${i}`) : back('', `--i:${i}`, c.id)).join('')
      : Array.from({ length: n }, (_, i) => back('', `--i:${i}`)).join('');
    return `<div class="handrow${cards.length ? '' : ' backs'}"${mine ? ' id="my-hand"' : ''} data-zone="${pid}-hand" data-n="${n}" title="${esc(R.labels[pid])}: ${n} card${n === 1 ? '' : 's'} in hand">${inner || '<span class="none">No cards</span>'}</div>`;
  }
  function eddiesHtml(st, pid) {
    const eddies = st.players[pid].eddies || [];
    const spentE = eddies.filter(e => e.exhausted).length;
    const shownE = Math.min(6, eddies.length), shownSpent = Math.min(shownE, spentE);
    return `${eddies.length ? `<div class="eddies" data-eddies="${pid}">${Array.from({ length: shownE }, (_, i) => back(i >= shownE - shownSpent ? 'spent-e' : '', `--i:${i}`)).join('')}</div>` : ''}
      <span class="zone-tag" title="ready / total">Eddies ${eddies.length - spentE}/${eddies.length}</span>`;
  }
  function pileHtml(st, pid, kind) {
    const p = st.players[pid];
    if (kind === 'deck') return `<div class="pile-wrap" data-zone="${pid}-deck"><span class="pile">${back()}</span><span class="count">${p.deckCount ?? '?'}</span></div><span class="zone-tag">Deck</span>`;
    const trash = p.trash || [], top = trash[trash.length - 1];
    return `${top ? `<div class="pile-wrap" data-trash="${pid}"><span class="pile">${face(top)}</span><span class="count">${trash.length}</span></div>` : '<span class="card slot"></span>'}<span class="zone-tag">Trash</span>`;
  }
  function statusHtml(st, s, lines, dir) {
    const g = st.game, act = g.activePlayerId;
    const who = !g.turnNumber ? 'Setup' : act === R.me ? (R.labels[R.me] === 'You' ? 'Your turn' : `${R.labels[R.me]}'s turn`) : `${R.labels[act] || ''}'s turn`;
    const phase = String(g.stageLabel || g.phase || '').replace(/_/g, ' ');
    return `<div class="turn-pill ${act ? sideOf(act) : ''}">${esc(who)}</div>
      <div class="turn-sub">${g.turnNumber ? `Turn ${g.turnNumber}` : 'Mulligan'}${phase && g.turnNumber ? ` | ${esc(phase)}` : ''}${clockHtml(g, act)}</div>
`;   // what just happened is in the log on the right
  }
  function tableHtml(st, s, lines, dir) {
    const r = R.rival, m = R.me, g = st.game;
    const zone = (pid, cls, html) => `<div class="pz ${sideOf(pid)} ${cls}${g.activePlayerId === pid ? ' active' : ''}">${html}</div>`;
    const legends = pid => [...(st.players[pid].legends || [])].sort((a, b) => (a.slotIndex ?? 0) - (b.slotIndex ?? 0)).map(l => unitHtml(l, true)).join('');
    const row = pid => zone(pid, 'row-z', `<div class="area a-legends"><div class="legends">${legends(pid)}</div><span class="zone-tag">Legends</span></div>
      <div class="area a-eddies">${eddiesHtml(st, pid)}</div>`);
    const field = pid => zone(pid, 'area a-field', `<div class="field">${(st.players[pid].field || []).map(u => unitHtml(u)).join('')}</div>`);
    return `<div class="tb-left">
        ${zone(r, 'hand-z', `<span class="who-tag">${esc(R.labels[r])}${st.players[r].streetCred != null ? ` · ☆${st.players[r].streetCred}` : ''}</span>${handRowHtml(st, r)}`)}
        ${zone(r, 'dice-z', diceRowHtml(st.players[r]))}
        ${zone(r, 'gig-z', gigRowHtml(st, r))}
        <div class="status">${statusHtml(st, s, lines, dir)}</div>
        ${zone(m, 'gig-z', gigRowHtml(st, m))}
        ${zone(m, 'dice-z', diceRowHtml(st.players[m]))}
        ${zone(m, 'hand-z', `${handRowHtml(st, m)}<span class="who-tag">${esc(R.labels[m])}${st.players[m].streetCred != null ? ` · ☆${st.players[m].streetCred}` : ''}</span>`)}
      </div>
      <div class="tb-play">${row(r)}${field(r)}<div class="midline"></div>${field(m)}${row(m)}</div>
      <div class="tb-piles">${zone(r, 'pile-z', pileHtml(st, r, 'trash'))}${zone(r, 'pile-z', pileHtml(st, r, 'deck'))}${zone(m, 'pile-z', pileHtml(st, m, 'deck'))}${zone(m, 'pile-z', pileHtml(st, m, 'trash'))}</div>`;
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
  function entryHtml(o, who) {
    const html = !o.v ? `<span class="lt">${esc(o.raw)}</span>`
      : `<span class="lv">${esc(o.v)}</span> ${o.a.map(tag).join(' ')}`
        + (o.d ? ` <span class="ld">· ${esc(o.d)}</span>` : '')
        + (o.via ? ` <span class="ld">· via</span> ${tag(o.via)}` : '');
    return tone(html, who || o.actor);
  }
  // Who owns what, by colour: player names in their side's colour (yours yellow, the Rival's red, like the
  // mats) and dice / "friendly"/"rival" Gigs in the Gig dice colours (green yours, red the Rival's).
  // "own d6" / a bare "d6" belong to the line's player, "opponent's d6" / "rival Gig" to the other one.
  const sideCls = p => (p === R.me ? 'mine' : 'theirs');
  let toneRe = null, toneKey = '';
  function tone(html, who) {
    const pids = Object.keys(R.labels || {});
    if (!pids.length) return html;
    const key = JSON.stringify(R.labels) + R.me;
    if (key !== toneKey) {
      toneKey = key;
      const rx = s => esc(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const names = pids.map(p => R.labels[p]).filter(l => l && l !== 'You').sort((a, b) => b.length - a.length).map(rx);
      const L = names.length ? names.join('|') : '(?!)';
      const you = R.labels[R.me] === 'You' ? '|\\b([Yy]our?)\\b' : '|(?!)()';
      toneRe = new RegExp(`(?:(${L})'s |\\b(your|own|opponent's) )?\\bd(4|6|8|10|12|20)\\b(?: \\((\\d+)\\))?`
        + `|\\b(friendly|rival|own|opponent's) (Gigs?)\\b|(${L})${you}`, 'g');
    }
    const byLabel = l => pids.find(p => esc(R.labels[p]) === l);
    const other = who && pids.find(p => p !== who);
    const nm = (p, t) => `<span class="lp ${sideCls(p)}">${t}</span>`;
    const die = (p, t) => `<span class="ldie ${p ? sideCls(p) : ''}">${t}</span>`;
    return html.split(/(<[^>]+>)/).map(seg => seg.startsWith('<') ? seg : seg.replace(toneRe,
      (m, lab, pos, sides, val, fr, gig, name, you) => {
        if (sides) {
          const owner = lab ? byLabel(lab) : pos === 'your' ? R.me : pos === "opponent's" ? other : who;
          const pre = lab ? `${nm(owner, lab)}'s ` : pos ? `${pos} ` : '';
          return pre + die(owner, `d${sides}${val ? ` (${val})` : ''}`);
        }
        if (fr) return die(fr === 'friendly' || fr === 'own' ? who : other, `${fr} ${gig}`);
        if (name) return nm(byLabel(name), name);
        if (you) return nm(R.me, you);
        return m;
      })).join('');
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
      const name = o.actor && o.actor !== e.turnOwnerPlayerId ? `<span class="lp ${sideCls(o.actor)}">${esc(R.labels[o.actor])}</span> ` : '';
      const line = name + entryHtml(o, who);
      if (line === lastLine) continue;               // the sim sometimes logs the same thing twice
      lastLine = line;
      html += `<li class="e ${who ? (who === R.me ? 'mine' : 'theirs') : ''}" data-step="${e.step}" title="${esc(e.message)}">${line}</li>`;
    }
    $('log').innerHTML = html;
    document.dispatchEvent(new CustomEvent('board:log'));   // live.js adds its flag buttons
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
    const opts = { duration: 420 * SPD, easing: 'cubic-bezier(.2,.8,.2,1)' };
    const els = document.querySelectorAll('#table [data-uid], #table .card[data-cid], #my-hand .card[data-cid], #table [data-gid]');
    for (const el of els) {
      if (el.closest('.unit') && !el.dataset.uid) continue;          // a Unit and its Gear move together
      const key = el.dataset.uid ? 'u' + el.dataset.uid : el.dataset.gid ? 'g' + el.dataset.gid : 'c' + el.dataset.cid;
      let was = before.get(key);
      if (!was && el.dataset.uid) was = before.get('c' + el.dataset.uid);   // e.g. hand card → field Unit
      const now = el.getBoundingClientRect();
      // fanned hand cards keep their tilt: animate back to their own CSS transform
      const rest = null;
      const rot = el.classList.contains('spent') ? 90 : 0;
      const restT = rest && rest !== 'none' ? rest : `rotate(${rot}deg)`;
      const flip = 1;
      if (was) {
        const dx = flip * ((was.r.left + was.r.width / 2) - (now.left + now.width / 2));
        const dy = flip * ((was.r.top + was.r.height / 2) - (now.top + now.height / 2));
        const wasRot = was.spent ? 90 : 0;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) { el.classList.add('flying'); setTimeout(() => el.classList.remove('flying'), opts.duration + 50); }
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || wasRot !== rot)
          el.animate([{ transform: rest ? `translate(${dx}px, ${dy}px) ${restT}` : `translate(${dx}px, ${dy}px) rotate(${wasRot}deg)` }, { transform: restT }], opts);
        if (el.dataset.gid && was.v !== el.dataset.v)
          el.animate([{ transform: 'scale(1.5)', filter: 'brightness(2.2)' }, { transform: 'none', filter: 'none' }], { duration: 520 * SPD, easing: 'ease-out' });
      } else if (dir > 0) {
        // something new: glide in from its owner's hand (rival) or deck (you), else just fade in
        const pid = el.closest('.pz')?.classList.contains('rival') ? R.rival : R.me;
        const src = before.get(`z${pid}-hand`) || before.get(`z${pid}-deck`);
        const from = src && !el.dataset.gid
          ? `translate(${flip * ((src.r.left + src.r.width / 2) - (now.left + now.width / 2))}px, ${flip * ((src.r.top + src.r.height / 2) - (now.top + now.height / 2))}px) rotate(${rot}deg) scale(.6)`
          : `rotate(${rot}deg) scale(${el.dataset.gid ? 1.8 : .6})`;
        el.classList.add('flying'); setTimeout(() => el.classList.remove('flying'), opts.duration + 50);
        el.animate([{ transform: from, opacity: 0 }, { transform: restT, opacity: 1 }], opts);
      }
    }
  }

  // Field cards as large as the Field allows: one row, every Unit's Gear strips and spent rotation included.
  const CARD_H = 1024 / 733, PEEK = .24, FIELD_GAP = 1.4, MAX_CW = 12;
  // Card sizes on the Field and Legends rows. Sized for room to spare - every Unit spent (lying
  // sideways) and carrying up to GEAR_RESERVE Gear strips - so attaching Gear or attacking doesn't
  // resize the board; sizes change when the number of Units does, or past that reserve. Both players'
  // Fields share one size (and both Legends rows), so the two sides always match.
  const GEAR_RESERVE = 2;
  function sizeFields() {
    const cq = $('table').clientWidth / 100;                // px per cqw
    if (!cq) return;
    for (const sel of ['#table .field', '#table .legends']) {
      const rows = [...document.querySelectorAll(sel)];
      let cw = Infinity;
      for (const f of rows) {
        const leg = f.classList.contains('legends');
        const units = [...f.querySelectorAll(':scope > .unit')];
        const n = Math.max(units.length, leg ? 3 : 1);
        const availW = f.clientWidth / cq - (leg ? 1.6 : 2.4), availH = f.clientHeight / cq - (leg ? 1 : 1.6);   // minus padding
        const gap = leg ? 1.2 : FIELD_GAP;
        const gearMax = Math.max(leg ? 0 : GEAR_RESERVE, ...units.map(u => (leg ? 0 : +u.style.getPropertyValue('--n') || 0)));
        const tall = CARD_H * (1 + PEEK * gearMax);           // a ready Unit with its Gear strips, in card widths
        // reserve: each Unit as wide as a spent card; the real layout wins only if it needs even more room
        let sumW = 0;
        for (const u of units) sumW += u.classList.contains('spent') ? CARD_H * (1 + PEEK * (leg ? 0 : +u.style.getPropertyValue('--n') || 0)) : 1;
        const fit = Math.min(availH / tall, (availW - gap * (n - 1)) / Math.max(n * CARD_H, sumW));
        cw = Math.min(cw, leg ? 8.5 : MAX_CW, fit);
      }
      for (const f of rows) f.style.setProperty('--cw', `${Math.max(3, cw).toFixed(2)}cqw`);
    }
  }

  // Hands: cards as tall as their row, overlapping when they don't fit side by side
  function sizeHands() {
    for (const h of document.querySelectorAll('#table .handrow')) {
      const cards = [...h.querySelectorAll(':scope > .card')];
      if (!cards.length) continue;
      const H = h.clientHeight, W = h.clientWidth;
      const cw = Math.min(H / CARD_H, W);
      const step = cards.length > 1 ? Math.min(cw + 6, (W - cw) / (cards.length - 1)) : 0;
      const off = Math.max(0, (W - (cw + step * (cards.length - 1))) / 2);
      cards.forEach((c, i) => { c.style.width = `${cw}px`; c.style.height = `${cw * CARD_H}px`; c.style.left = `${off + i * step}px`; });
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
    // a search takes the top cards out of the deck one step and puts the rest back the next (Sketchy Ripper,
    // River Ward, V), so the deck count can go UP on the step the found card arrives: any change counts
    const deckMoved = pid => (prevState.players[pid]?.deckCount ?? 0) !== (st.players[pid]?.deckCount ?? 0);
    const hiddenHand = pid => { const p = prevState.players[pid]; return !!p && (p.hand || []).length < (p.handCount ?? 0); };
    const arrivals = [];
    for (const [id, n] of now) {
      if (!POP_ZONES.has(n.zone)) continue;
      // (a hidden hand has no card ids here, so only hands drawn face up - yours, or both when watching - pop)
      const w = was.get(id);
      if (w && (w.zone === n.zone || w.zone === 'field' || w.zone === 'gear' || w.zone === 'legends')) continue;
      if (!w && n.zone === 'hand' && hiddenHand(n.pid) && !deckMoved(n.pid)) continue;   // a hidden hand shown at game end
      arrivals.push({ id, ...n, from: w?.zone || null });
    }
    // sales: a card that left a hand for the Eddies pile (live games name it in game.sold, since the
    // Rival's hand is hidden; replays: cards from your own hand)
    const before = new Set(Object.values(prevState.players).flatMap(p => (p.eddies || []).map(e => e.id)));
    for (const [pid, p] of Object.entries(st.players)) for (const e of p.eddies || []) {
      if (!e.id || before.has(e.id)) continue;
      const sold = st.game.sold?.id === e.id ? st.game.sold : null, w = was.get(e.id);
      const c = sold ? { id: e.id, cardId: sold.cardId, name: sold.name } : w?.zone === 'hand' ? w.c : null;
      if (c) arrivals.push({ id: e.id, pid, zone: 'eddies', c, from: 'hand' });
    }
    // deck -> trash -> hand in one step (V: Streetkid's "Trash 3, then add a Program from your trash"): show it
    // trashed with the others first, then going from the trash to the hand, last
    const rec = new Set(st.game?.recovered || []);
    if (rec.size) {
      const back = [];
      for (const a of arrivals.filter(x => rec.has(x.id) && x.zone === 'hand')) {
        arrivals.splice(arrivals.indexOf(a), 1);
        arrivals.push({ ...a, id: `${a.id}~trash`, zone: 'trash', from: 'deck' });
        back.push({ ...a, from: 'trash' });
      }
      arrivals.push(...back);
    }
    if (!arrivals.length) return;
    const shown = arrivals.slice(-6);
    const T = $('table').getBoundingClientRect();
    const k = shown.length, gap = 14;
    const W = Math.min(200, (T.width * .9 - gap * (k - 1)) / k), H = W * CARD_H;
    const rowLeft = T.left + T.width / 2 - (k * W + (k - 1) * gap) / 2, top = T.top + T.height / 2 - H / 2;
    // where it comes from: its trash or hand if it was seen there, else (hidden) the deck when the deck
    // count changed this step (draws, top-of-deck trashes, searches) or it lands in a hand shown face up,
    // else the hand (Gear / Programs from the Rival's hidden hand)
    const srcEl = a => {
      let from = a.from;
      if (!from) from = deckMoved(a.pid) || (a.zone === 'hand' && !hiddenHand(a.pid)) ? 'deck' : 'hand';
      return (from === 'trash' && document.querySelector(`#table [data-trash="${a.pid}"]`))
        || (from === 'hand' && document.querySelector(`#table [data-zone="${a.pid}-hand"]`))
        || document.querySelector(`#table [data-zone="${a.pid}-deck"]`);
    };
    shown.forEach((a, i) => {
      // destination: the card itself if it's drawn on screen, else its owner's trash pile
      let dest = a.zone === 'eddies' ? null : document.querySelector(`#table [data-cid="${CSS.escape(a.id)}"]`);
      // a sale lands on the newest ready Eddie, which stays hidden until it arrives
      if (a.zone === 'eddies') dest = [...document.querySelectorAll(`#table [data-eddies="${a.pid}"] > .card:not(.spent-e)`)].pop() || null;
      const exact = !!dest;
      if (!dest && a.zone === 'eddies') dest = document.querySelector(`#table [data-eddies="${a.pid}"]`);
      if (!dest) dest = document.querySelector(`#table [data-trash="${a.pid}"]`) || document.querySelector(`#table [data-zone="${a.pid}-deck"]`);
      if (!dest) return;
      // this card's normal slide (e.g. hand → trash) would start it back at its old spot: the pop replaces it
      if (exact) dest.getAnimations().forEach(x => x.cancel());
      const d = dest.getBoundingClientRect();
      const x = rowLeft + i * (W + gap), y = top;
      const clone = document.createElement('div');
      clone.className = 'card face pop-card';
      // data-img: the missing-art check must not mark it no-img (that style reset the background
      // and only the art's top-left corner showed); size/position set here so nothing can override them
      clone.dataset.img = imgUrl(a.c.cardId);
      if (missingArt.has(clone.dataset.img)) clone.classList.add('no-img');
      clone.dataset.checked = '1';
      clone.innerHTML = `<span class="cname">${esc(short(a.c.name))}</span>`;
      clone.style.cssText = `position:fixed; z-index:40; width:${W}px; height:${H}px; left:${x}px; top:${y}px; background-image:url('${imgUrl(a.c.cardId)}'); background-size:cover; background-position:center`;
      document.body.appendChild(clone);
      if (exact) dest.style.visibility = 'hidden';
      pops.push({ clone, dest: exact ? dest : null });
      const dx = (d.left + d.width / 2) - (x + W / 2), dy = (d.top + d.height / 2) - (y + H / 2);
      const flip = 0;
      const end = `translate(${dx}px, ${dy}px) scale(${Math.min(d.width, d.height / CARD_H) / W}) rotate(${flip}deg)`;
      // starts on its source pile / hand at that card size, rises to the middle, holds, then flies
      const src = srcEl(a), S = src ? src.getBoundingClientRect() : null;
      if (a.zone === 'hand' && src?.matches?.('[data-zone$="-deck"]')) snd('draw', i * 420 * SPD);
      const sw = S ? Math.min(S.width, S.height / CARD_H, W) : W * .4;
      const start = S ? `translate(${(S.left + S.width / 2) - (x + W / 2)}px, ${(S.top + S.height / 2) - (y + H / 2)}px) scale(${sw / W})` : 'scale(.4)';
      const anim = clone.animate([
        { transform: start, opacity: S ? 1 : 0, offset: 0, easing: 'cubic-bezier(.2,.7,.3,1)' },
        { transform: 'scale(1.04)', opacity: 1, offset: .26 },
        { transform: 'scale(1)', opacity: 1, offset: .32 },
        { transform: 'scale(1)', opacity: 1, offset: .66, easing: 'cubic-bezier(.5,0,.3,1)' },
        { transform: end, opacity: exact ? 1 : .2, offset: 1 },
      ], { duration: 1700 * SPD, delay: i * 420 * SPD, fill: 'both' });   // each leg eases on its own; one after another
      busyFor((1700 + i * 420) * SPD);
      anim.onfinish = () => { clone.remove(); if (exact) dest.style.visibility = ''; pops = pops.filter(p => p.clone !== clone); };
    });
  }

  // Paying: Eddies spent this step turn sideways one after another with a yellow flash, and
  // Legends spent to pay (or by their own {Spend}) flash too, so you see what paid.
  function spendFx(prev, st) {
    if (reduceMotion) return;
    for (const pid of Object.keys(st.players)) {
      const spentOf = s => (s.players[pid]?.eddies || []).filter(e => e.exhausted).length;
      const fresh = spentOf(st) - spentOf(prev);
      if (fresh > 0) {
        const cards = [...document.querySelectorAll(`#table [data-eddies="${pid}"] .card.spent-e`)];
        cards.slice(0, fresh).forEach((el, i) => el.animate([
          { transform: 'rotate(0deg) translateY(0)', filter: 'url(#ctcg-swap) brightness(1.5) drop-shadow(0 0 6px #f5e400)' },
          { transform: 'rotate(0deg) translateY(-12%)', filter: 'url(#ctcg-swap) brightness(1.7) drop-shadow(0 0 10px #f5e400)', offset: .35 },
          { transform: 'rotate(90deg) translateY(0)', filter: 'url(#ctcg-swap) brightness(.6)' },
        ], { duration: 650 * SPD, delay: i * 140 * SPD, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'backwards' }));
      }
      const was = new Map((prev.players[pid]?.legends || []).concat(prev.players[pid]?.field || []).map(u => [u.id, u.exhausted]));
      for (const u of (st.players[pid]?.legends || []).concat(st.players[pid]?.field || []))
        if (u.exhausted && was.get(u.id) === false) document.querySelector(`#table [data-uid="${CSS.escape(u.id)}"]`)?.classList.add('just-spent');
    }
  }

  // ── sound (board/sfx.js), one call per forward step, timed to the animations ──
  const snd = (name, ms = 0) => window.Sfx?.play(name, ms);
  const ST = () => window.Sfx?.TIMING || { shuffle: 640, drawPeak: 220, rollSettle: 560, flipPeak: 220 };
  function soundFx(prev, st, mull = null) {   // mull: whose mulligan this step is (mulliganFx sounds its cards)
    const g0 = prev.game, g1 = st.game;
    if (g1.turnNumber && g1.turnNumber !== g0.turnNumber) snd(g1.activePlayerId === R.me ? 'yourturn' : 'turn');
    if (g1.attack && (!g0.attack || g0.attack.attackerId !== g1.attack.attackerId)) snd('attack');
    if (g1.attack?.blockerId && !g0.attack?.blockerId) snd('block');
    let draws = 0, rolls = 0;
    for (const pid of Object.keys(st.players)) {
      const a = prev.players[pid] || {}, b = st.players[pid] || {};
      const ids = (list, f = x => x.id) => new Set((list || []).map(f));
      // dice: new = rolled (rollFx), value changed = blip, changed hands = whoosh
      const was = new Map(Object.values(prev.players).flatMap(q => (q.gigDice || []).map(d => [d.id, { v: d.value, q }])));
      for (const d of b.gigDice || []) {
        const w = was.get(d.id);
        if (!w) { if ((!d.originalOwnerId || d.originalOwnerId === pid) && reduceMotion) snd('roll', rolls++ * 150 * SPD); }
        else if (w.q !== a) snd('steal', 100);
        else if (w.v !== d.value) snd('blip', 150 * SPD);
      }
      // Eddies: a sale lands as a coin, spending ticks one by one
      const newE = (b.eddies || []).filter(e => !ids(a.eddies).has(e.id)).length;
      for (let i = 0; i < Math.min(2, newE); i++) snd('sell', 1500 * SPD + i * 120);
      const spent = x => (x.eddies || []).filter(e => e.exhausted).length;
      for (let i = 0; i < Math.min(5, spent(b) - spent(a)); i++) snd('spend', i * 140 * SPD);
      // Units in / out, Gear attached, Legends flipped
      const before = ids(a.field), after = ids(b.field);
      for (const u of b.field || []) if (!before.has(u.id)) snd('unit', 300 * SPD);
      const trashNow = ids(b.trash);
      for (const u of a.field || []) if (!after.has(u.id) && trashNow.has(u.id)) snd('defeat', 200 * SPD);
      const gearOf = x => new Set([...(x.field || []), ...(x.legends || [])].flatMap(h => (h.attachments || []).map(g => g.id)));
      const g0s = gearOf(a);
      for (const id of gearOf(b)) if (!g0s.has(id)) snd('gear', 1550 * SPD);
      const up0 = new Set((a.legends || []).filter(l => !l.faceDown).map(l => l.id));
      for (const l of b.legends || []) if (!l.faceDown && !up0.has(l.id) && reduceMotion) snd('flip', 100);   // else flipFx
      // cards: drawn (your hand, or the Rival's hand count), Programs played, other cards trashed
      const handN = x => (x.hand || []).length || x.handCount || 0;
      const drawn = Math.max(0, (a.deckCount ?? 0) - (b.deckCount ?? 0));
      if (drawn && handN(b) > handN(a) && pid !== mull && (pid !== R.me || reduceMotion)) for (let i = 0; i < Math.min(2, drawn); i++) snd('draw', draws++ * 160 * SPD);
      const hand0 = ids(a.hand);
      for (const c of b.trash || []) {
        if (trashNow.has(c.id) && ids(a.trash).has(c.id)) continue;
        if (before.has(c.id)) continue;   // a defeated Unit
        snd(/program/i.test(c.type || c.cardType || '') && (hand0.has(c.id) || !hand0.size) ? 'program' : 'deal', 120 * SPD);
      }
    }
  }

  // ── opening hand / mulligan ──
  const handEls = pid => [...document.querySelectorAll(`#table [data-zone="${pid}-hand"] > .card`)];
  const deckEl = pid => document.querySelector(`#table [data-zone="${pid}-deck"]`);
  // the cards now in pid's hand fly in from the deck one after another (no stop in the middle)
  function dealFx(pid, delay = 0) {
    const deck = deckEl(pid);
    if (reduceMotion || !deck) return;
    const D = deck.getBoundingClientRect();
    handEls(pid).forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const from = `translate(${D.left + D.width / 2 - (r.left + r.width / 2)}px, ${D.top + D.height / 2 - (r.top + r.height / 2)}px) scale(${Math.min(1, D.width / r.width)})`;
      el.classList.add('flying');
      el.animate([{ transform: from }, { transform: 'none' }], { duration: 520 * SPD, delay: (delay + i * 130) * SPD, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' })
        .onfinish = () => el.classList.remove('flying');
      busyFor((520 + delay + i * 130) * SPD);
      snd('deal', (delay + i * 130) * SPD);
    });
  }
  // A riffle shuffle on a deck pile, `total` ms for two riffles: the pile splits into two halves that
  // slide apart and tilt, then the cards drop back into one pile alternating left / right.
  function riffleFx(deck, total) {
    const A = ST().shuffle;                                   // the sound's cascade, ms
    const R = Math.max(A + 380, total / 2);                   // one riffle
    const split = R - A - 120;                                // halves slide apart (silent)
    snd('shuffle', split); snd('shuffle', R + split);
    if (reduceMotion || !document.contains(deck)) return;
    const D = deck.querySelector('.card')?.getBoundingClientRect() || deck.getBoundingClientRect();
    const N = 12, half = N / 2, w = D.width;
    deck.style.visibility = 'hidden';
    const cards = [];
    for (let j = 0; j < N; j++) {
      const c = document.createElement('div');
      c.className = 'card back riffle';
      c.style.cssText = `position:fixed; z-index:45; left:${D.left}px; top:${D.top}px; width:${D.width}px; height:${D.height}px`;
      document.body.appendChild(c);
      cards.push(c);
      const left = j < half, k = left ? j : j - half;
      const side = `translate(${left ? -0.62 * w : 0.62 * w}px, ${-k * 1.5}px) rotate(${left ? -9 : 9}deg)`;
      const order = 2 * k + (left ? 0 : 1);                  // interleave: L0 R0 L1 R1 ...
      // card `order` lands at its share of the cascade; the last ones on its loud end
      const land = (split + A * (order + 1) / N) / R, lift = Math.max(split / R, land - 70 / R);
      const pile = `translate(0, ${-order * 0.9}px)`;
      c.animate([
        { transform: `translate(0, ${-j * 0.9}px)`, offset: 0 },
        { transform: side, offset: Math.min(lift, (split - 40) / R), easing: 'ease-in-out' },
        { transform: side, offset: lift },
        { transform: pile, offset: Math.min(.99, land), easing: 'ease-in' },
        { transform: pile, offset: 1 },
      ], { duration: R, iterations: 2, easing: 'linear', fill: 'both' });
      pops.push({ clone: c, dest: null });
    }
    setTimeout(() => {
      cards.forEach(c => { c.remove(); pops = pops.filter(q => q.clone !== c); });
      deck.style.visibility = '';
    }, 2 * R + 40);
    return 2 * R;
  }

  // whose mulligan this step is (its log line says so; that player's hand was replaced)
  function mulliganOf(s, prev, st) {
    const line = (s.newLog || []).find(e => /mulligan/i.test(e.message) && !/keep/i.test(e.message));
    if (!line) return null;
    const pid = Object.keys(st.players).find(p => p === line.turnOwnerPlayerId) || Object.keys(st.players).find(p => line.message.startsWith(R.labels[p]));
    return pid || null;
  }
  // the old hand goes back face down into the deck, the deck shuffles, then the new six are dealt
  function mulliganFx(pid, prev, st) {
    const deck = deckEl(pid), row = document.querySelector(`#table [data-zone="${pid}-hand"]`);
    if (reduceMotion || !deck || !row) return;
    const D = deck.getBoundingClientRect(), H = row.getBoundingClientRect();
    const n = (prev.players[pid].hand || []).length || prev.players[pid].handCount || 6;
    const cw = Math.min(H.height / CARD_H, H.width), step = n > 1 ? Math.min(cw + 6, (H.width - cw) / (n - 1)) : 0;
    const off = Math.max(0, (H.width - (cw + step * (n - 1))) / 2);
    handEls(pid).forEach(el => { el.style.visibility = 'hidden'; });
    for (let i = 0; i < n; i++) {
      const x = H.left + off + i * step, y = H.top;
      const c = document.createElement('div');
      c.className = 'card back riffle';
      c.style.cssText = `position:fixed; z-index:40; left:${x}px; top:${y}px; width:${cw}px; height:${cw * CARD_H}px`;
      document.body.appendChild(c);
      pops.push({ clone: c, dest: null });
      const to = `translate(${D.left + D.width / 2 - (x + cw / 2)}px, ${D.top + D.height / 2 - (y + cw * CARD_H / 2)}px) scale(${D.width / cw})`;
      const a = c.animate([{ transform: 'none' }, { transform: to }], { duration: 480 * SPD, delay: i * 90 * SPD, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'both' });
      a.onfinish = () => { c.remove(); pops = pops.filter(q => q.clone !== c); };
      snd('deal', i * 90 * SPD);
    }
    const backIn = (480 + n * 90) * SPD;
    const SHUF = Math.max(2 * (ST().shuffle + 380), 1900 * SPD);   // two riffles (riffleFx's length)
    busyFor(backIn + SHUF + 60 * SPD + (520 + 6 * 130) * SPD);
    setTimeout(() => riffleFx(deck, SHUF), backIn);
    setTimeout(() => {
      if (!document.contains(row)) return;   // stepped away meanwhile
      handEls(pid).forEach(el => { el.style.visibility = ''; });
      dealFx(pid);
    }, backIn + SHUF + 60 * SPD);
  }

  // A Gig die rolled this step tumbles out of its owner's fixer dice to the middle of the table,
  // its number flickering, settles on the result, then drops into the Gig row.
  function rollFx(prev, st) {
    if (reduceMotion) return;
    const old = new Set(Object.values(prev.players).flatMap(q => (q.gigDice || []).map(g => g.id)));
    const T = $('table').getBoundingClientRect();
    let k = 0;
    for (const [pid, p] of Object.entries(st.players)) for (const g of p.gigDice || []) {
      if (old.has(g.id) || (g.originalOwnerId && g.originalOwnerId !== pid)) continue;   // new, not stolen
      const el = document.querySelector(`#table [data-gid="${CSS.escape(g.id)}"]`);
      const src = document.querySelector(`#table .pz.${sideOf(pid)}.dice-z`);
      if (!el || !src) continue;
      el.getAnimations().forEach(a => a.cancel());
      const size = Math.min(T.width, T.height) * .16, d = el.getBoundingClientRect(), S = src.getBoundingClientRect();
      const x = T.left + T.width / 2 - size / 2 + k * size * 1.2, y = T.top + T.height / 2 - size / 2;
      // 3D: a real die thrown across the table, landing on the engine's number; then the 2D die slides
      // from the middle into its Gig row (board/dice3d.js; falls back to the 2D tumble below)
      if (window.Dice3D && window.Dice3D.ok !== false) {
        roll3d(el, g, pid, d, x, y, size, k);
        k++;
        continue;
      }
      const clone = el.cloneNode(true);
      clone.removeAttribute('data-gid');
      clone.classList.add('roll-die');
      clone.style.cssText = `position:fixed; z-index:41; left:${x}px; top:${y}px; width:${size}px; height:${size}px; --gs:${size}px`;
      document.body.appendChild(clone);
      el.style.visibility = 'hidden';
      pops.push({ clone, dest: el });
      const b = clone.querySelector('b'), final = b.textContent;
      const iv = setInterval(() => { b.textContent = 1 + Math.floor(Math.random() * (g.sides || 6)); }, 70);
      const settle = .58 * 2200 * SPD;                       // the keyframe where it comes to rest
      setTimeout(() => { clearInterval(iv); b.textContent = final; }, settle + k * 150 * SPD);
      snd('roll', k * 150 * SPD + Math.max(0, settle - ST().rollSettle));
      const from = `translate(${S.left + S.width / 2 - (x + size / 2)}px, ${S.top + S.height / 2 - (y + size / 2)}px) rotate(0deg) scale(.3)`;
      const to = `translate(${d.left + d.width / 2 - (x + size / 2)}px, ${d.top + d.height / 2 - (y + size / 2)}px) rotate(1080deg) scale(${d.width / size})`;
      const anim = clone.animate([
        { transform: from, offset: 0, easing: 'cubic-bezier(.2,.7,.3,1)' },
        { transform: 'translate(0, 0) rotate(720deg) scale(1.1)', offset: .45, easing: 'ease-out' },
        { transform: 'translate(0, 0) rotate(1080deg) scale(1)', offset: .58 },
        { transform: 'translate(0, 0) rotate(1080deg) scale(1)', offset: .78, easing: 'cubic-bezier(.5,0,.3,1)' },
        { transform: to, offset: 1 },
      ], { duration: 2200 * SPD, delay: k * 150 * SPD, fill: 'both' });
      busyFor((2200 + k * 150) * SPD);
      anim.onfinish = () => { clearInterval(iv); clone.remove(); el.style.visibility = ''; pops = pops.filter(q => q.clone !== clone); };
      k++;
    }
  }

  async function roll3d(el, g, pid, d, x, y, size, k) {
    el.style.visibility = 'hidden';
    busyFor(1800 + k * 500);    // a throw (board/dice3d.js: ~1.8 s); several dice 0.5 s apart
    if (k) await new Promise(ok => setTimeout(ok, k * 500));
    snd('roll', ST().roll3dSound ?? 0);
    const ran = await window.Dice3D.roll(g.sides || 6, g.value, (g.originalOwnerId || pid) === R.me ? 'mine' : 'theirs', { x, y, size });
    if (!document.contains(el)) return;
    if (!ran) { el.style.visibility = ''; return; }
    busyFor(750 * SPD);
    const clone = el.cloneNode(true);
    clone.removeAttribute('data-gid');
    clone.classList.add('roll-die');
    clone.style.cssText = `position:fixed; z-index:41; left:${x}px; top:${y}px; width:${size}px; height:${size}px; --gs:${size}px`;
    document.body.appendChild(clone);
    pops.push({ clone, dest: el });
    const to = `translate(${d.left + d.width / 2 - (x + size / 2)}px, ${d.top + d.height / 2 - (y + size / 2)}px) scale(${d.width / size})`;
    busyFor(700 * SPD);
    const anim = clone.animate([
      { transform: 'scale(.6)', opacity: 0 },
      { transform: 'scale(1.08)', opacity: 1, offset: .3 },
      { transform: 'scale(1)', opacity: 1, offset: .45, easing: 'cubic-bezier(.5,0,.3,1)' },
      { transform: to, opacity: 1 },
    ], { duration: 700 * SPD, fill: 'both' });
    anim.onfinish = () => { clone.remove(); el.style.visibility = ''; pops = pops.filter(q => q.clone !== clone); };
  }

  // A Legend turned face up this step flips over (back -> face); edge-on exactly on the flip sound's snap.
  function flipFx(prev, st) {
    if (reduceMotion) return;
    let k = 0;
    for (const pid of Object.keys(st.players)) {
      const up0 = new Set((prev.players[pid]?.legends || []).filter(l => !l.faceDown).map(l => l.id));
      for (const l of st.players[pid]?.legends || []) {
        if (l.faceDown || up0.has(l.id)) continue;
        const el = document.querySelector(`#table [data-uid="${CSS.escape(l.id)}"]`);
        const delay = 100 + k++ * 300, P = ST().flipPeak;
        snd('flip', delay);
        if (!el) continue;
        el.animate([
          { transform: 'perspective(600px) rotateY(180deg)', filter: 'brightness(.25)' },
          { transform: 'perspective(600px) rotateY(90deg)', filter: 'brightness(.25)', offset: .5 },
          { transform: 'perspective(600px) rotateY(90deg)', filter: 'brightness(1.4)', offset: .501 },
          { transform: 'perspective(600px) rotateY(0deg)', filter: 'brightness(1)' },
        ], { duration: 2 * P, delay, easing: 'ease-in-out', fill: 'backwards' });
        busyFor(delay + 2 * P);
      }
    }
  }

  // A die whose value changed or that changed hands this step keeps a ring while you're on the step,
  // so "Bot A's d6: 4 → 5" points at one die even though both players have a d6.
  function diceMarks(prev, st) {
    const was = new Map(Object.entries(prev.players).flatMap(([pid, p]) => (p.gigDice || []).map(g => [g.id, { v: g.value, pid }])));
    for (const [pid, p] of Object.entries(st.players)) for (const g of p.gigDice || []) {
      const w = was.get(g.id);
      if (w && (w.v !== g.value || w.pid !== pid)) document.querySelector(`#table [data-gid="${CSS.escape(g.id)}"]`)?.classList.add('gig-hot');
    }
  }

  // During an attack the attacker and what it attacks stay marked until the fight is over.
  function attackMarks(st) {
    const A = st.game.attack;
    if (!A) return;
    document.querySelector(`#table [data-uid="${CSS.escape(A.attackerId)}"]`)?.classList.add('attacking');
    if (A.targetId) document.querySelector(`#table [data-uid="${CSS.escape(A.targetId)}"]`)?.classList.add('attacked');
    else document.querySelector(`#table .pz.${A.targetSide === R.me ? 'you' : 'rival'}.gig-z`)?.classList.add('attacked');
    if (A.blockerId) document.querySelector(`#table [data-uid="${CSS.escape(A.blockerId)}"]`)?.classList.add('blocking');
  }

  // ── render one step ─────────────────────────────────────────────────────
  function render(dir = 0) {
    clearPops();
    const before = Math.abs(dir) === 1 ? snapshot() : null;
    const s = R.steps[cur], st = s.state;
    cardsById = new Map();

    const lines = s.newLog.map(e => fmt(e.message)).filter(Boolean);
    $('table').innerHTML = tableHtml(st, s, lines, dir);

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
    sizeFields(); sizeHands();
    animate(before, dir);
    if (dir === 1) {
      const prev = R.steps[cur - 1].state;
      const mull = mulliganOf(s, prev, st);
      if (mull) mulliganFx(mull, prev, st);
      else { spendFx(prev, st); popArrivals(prev, st); rollFx(prev, st); flipFx(prev, st); }
      soundFx(prev, st, mull);
    }
    attackMarks(st);
    if (cur > 0) diceMarks(R.steps[cur - 1].state, st);
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
      ? lines.map(o => `<span class="bn-l">${o.actor && o.actor !== actor ? `<span class="lp ${sideCls(o.actor)}">${esc(R.labels[o.actor])}</span> ` : ''}${entryHtml(o, o.actor || actor)}</span>`).join('<span class="bn-sep">›</span>')
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
      // a new game: both opening hands are dealt from the decks
      if (!R.steps[cur].state.game.turnNumber) for (const pid of [R.rival, R.me]) dealFx(pid, pid === R.me ? 300 : 0);
    },
    // append steps; if you were watching the latest step, play them one at a time (`gap` ms apart)
    // so every move animates instead of jumping to the end. Resolves when the last one is shown.
    async extend(steps, log, gap = 0) {
      if (!R || !steps.length) return;
      const follow = cur >= R.steps.length - 1;
      R.steps.push(...steps); R.log.push(...log);
      steps.forEach(s => walkNames(s.state.players));
      fmt = LogFmt.makeFormatter([...nameToId.keys()], R.labels);
      R.turnStarts = turnStartsOf(R.steps);
      $('scrub').max = R.steps.length - 1;
      buildLog();
      if (!follow) { render(0); return; }
      const end = R.steps.length - 1;
      const wait = ms => new Promise(ok => setTimeout(ok, ms));
      while (cur < end) {
        go(cur + 1);
        const at = cur;
        await wait(Math.max(cur < end ? gap : 0, animUntil - performance.now()));
        if (cur !== at) return;   // you moved the timeline meanwhile
      }
    },
    // Game Review (board/review.js): open a replay; show another line from step `at` (the board plays
    // `steps` after it, `gap` ms apart; lines' `step` counts from 1 = the first new step); unbranch()
    // puts the game back and jumps to `to`.
    open,
    async branch(at, steps, log, gap = 1100) {
      if (!R) return;
      if (!R.main) R.main = { steps: R.steps, log: R.log, turnStarts: R.turnStarts };
      const M = R.main, token = (R.branchToken = (R.branchToken || 0) + 1);
      R.steps = M.steps.slice(0, at + 1).concat(steps);
      R.log = M.log.filter(e => e.step <= at).concat(log.map(l => ({ ...l, step: at + l.step })));
      R.turnStarts = turnStartsOf(R.steps);
      steps.forEach(s => walkNames(s.state.players));
      fmt = LogFmt.makeFormatter([...nameToId.keys()], R.labels);
      $('scrub').max = R.steps.length - 1;
      buildLog(); document.body.classList.add('branch');
      if (cur !== at) go(at);
      return this.playTo(R.steps.length - 1, gap, token);
    },
    unbranch(to) {
      if (!R?.main) return;
      Object.assign(R, R.main); delete R.main; R.branchToken = (R.branchToken || 0) + 1;
      fmt = LogFmt.makeFormatter([...nameToId.keys()], R.labels);
      $('scrub').max = R.steps.length - 1;
      buildLog(); document.body.classList.remove('branch');
      cur = Math.min(cur, R.steps.length - 1); go(to ?? cur);
    },
    branched: () => !!R?.main,
    // step forward to `to`, one animated step every `gap` ms; stops if you move the timeline meanwhile
    async playTo(to, gap = 1100, token = R?.branchToken) {
      const wait = ms => new Promise(ok => setTimeout(ok, ms));
      while (R && cur < to && R.branchToken === token) {
        await wait(cur === to ? 0 : 120);
        const at = cur + 1; go(at);
        await wait(Math.max(gap, animUntil - performance.now()));
        if (cur !== at) return;
      }
    },
    logHtml(msg) { if (!fmt) return esc(msg); const o = fmt(msg); return o ? entryHtml(o) : ''; },   // '' = a line the log hides
    setSpeed(k) { SPD = k; document.documentElement.style.setProperty('--spd', k); },
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
    // A / S / D: step back, play-pause, step forward; Q / E: a whole turn back / forward.
    // Live games on the latest step: D = the bot's next move, E = finish the turn, S = Auto (live.js).
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase(), atEnd = cur >= R.steps.length - 1;
    const live = what => document.dispatchEvent(new CustomEvent('board:live-key', { detail: what }));
    if (k === 'a') go(cur - 1);
    else if (k === 'd') { if (R.live && atEnd) live('step'); else go(cur + 1); }
    else if (k === 'q') turnJump(-1);
    else if (k === 'e') { if (R.live && atEnd) live('turn'); else turnJump(1); }
    else if (k === 's') { if (R.live) live('auto'); else togglePlay(); }
    else return;
    e.preventDefault();
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
    // ?r=<replay name> (links from the home page) opens that replay
    const q = new URLSearchParams(location.search).get('r');
    if (q && list.some(f => f.name === q)) { $('replay-pick').value = q; $('replay-pick').onchange({ target: $('replay-pick') }); }
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
