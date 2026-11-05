// Sim replay state -> engine board.
//
// The two simulators disagree on shape (player1/p1, exhausted/state, gigDice/gigs...) and the
// replay hides things the engine needs: the Rival's hand, both deck orders, face-down Legends
// and every Eddie's card. Those are dealt from the inferred decklists (decks.js) with a seeded
// RNG - one "determinization" per seed. Visible cards keep their sim instance id as the engine
// iid, so the same card has the same iid in every determinization and at every step of a game:
// a move recorded on one board can be replayed on another.
//
// Only call this on calm positions: a main phase with no attack, prompt or pending effect.
'use strict';
const { engineCard, cardByNumber } = require('./cards');
const { MAIN_SIZE } = require('./decks');

function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const shuffle = (arr, r) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
// UUIDs are shortened to 8 hex chars (unique enough within one game); hidden-card ids such as
// "player1:eddies:hidden:0" share their first 8 chars, so those are kept whole.
const iidOf = simId => { const s = String(simId); return /^[0-9a-f]{8}-/.test(s) ? s.slice(0, 8) : s; };

// Is this sim state a position the bridge can convert? After the first attack the sim's turnStep
// stays 'attack' for the rest of the turn; between attacks (no prompt pending) it is just as calm.
// Treating only 'play' as calm once made "where you ended the turn" the position *before* your
// attacks - every attacking turn was graded as if you hadn't attacked.
function isCalm(state) {
  const g = state.game;
  return g.stage === 'player_turn' && (g.turnStep === 'play' || g.turnStep === 'attack')
    && !state.controls?.pending && !state.controls?.cardReveal;
}

// multiset helpers over Map(number -> count)
const take = (pool, num) => { const k = pool.get(num) || 0; if (k > 0) { pool.set(num, k - 1); return true; } return false; };
const flat = pool => { const out = []; for (const [n, k] of pool) for (let i = 0; i < k; i++) out.push(n); return out; };

/**
 * @param state  sim state (one frame)
 * @param ctx    { pidMap: {player1:'p1', player2:'p2'}, knowledge, decks: {player1: deck, player2: deck} }
 * @param seed   determinization seed
 * @returns { board, notes } - notes lists anything approximated
 */
function toBoard(state, ctx, seed = 1) {
  const r = mulberry(seed * 2654435761 + 17);
  const notes = [];
  const g = state.game;
  const P = sid => ctx.pidMap[sid];

  const b = {
    p1: null, p2: null,
    turn_number: g.turnNumber || 0,
    active_player: P(g.activePlayerId) || 'p1',
    first_player: P(g.firstPlayerId) || 'p1',
    phase: 'main',
    current_attack: null, effect_stack: [], scheduled_effects: [],
    rate_limits: { p1: {}, p2: {} },
    overtime: !!g.overtime, winner: null, _next_iid: 100000,
    _rng_seq: 0, _rngMap: null, _rngState: (seed * 7919 + 1) | 0,
    _trace: null,
  };

  // the controller's next turn number, for "until your next turn" style effects
  const nextTurnOf = pid => (b.active_player === pid ? b.turn_number + 2 : b.turn_number + 1);

  for (const [sid, S] of Object.entries(state.players)) {
    const pid = P(sid);
    const deck = ctx.decks[sid];
    const known = id => {
      const k = ctx.knowledge.get(id);
      return k ? (engineCard(k.name) || engineCard(k.cardId)) : null;
    };
    const cardOf = c => (c.cardId ? engineCard(c.name) || engineCard(c.cardId) : null) || known(c.id);

    // what's left of the decklist once every card we can name is placed
    const pool = new Map(deck.cards);
    const legendPool = deck.legends.slice();
    const claim = (c, isLegend) => {
      if (isLegend) { const i = legendPool.indexOf(c.number); if (i >= 0) legendPool.splice(i, 1); return; }
      if (!take(pool, c.number)) notes.push(`${pid}: more copies of ${c.name} than the inferred list`);
    };

    const zones = { hand: [], deck: [], trash: [], removed: [], legends: [], eddies: [], field: [], fixer: [], gigs: [] };
    const hidden = { hand: 0, eddies: [], legends: [] };

    const gearOf = host => (host.attachments || []).map(a => {
      const c = cardOf(a);
      if (!c) { notes.push(`${pid}: unknown gear ${a.name}`); return null; }
      claim(c, false);
      return { iid: iidOf(a.id), card_id: c.number };
    }).filter(Boolean);

    const applyEffects = (ref, effs, isUnit) => {
      for (const e of effs || []) {
        const kind = e.kind, src = (e.id || '').split(':')[0];
        if (kind === 'lag') ref.entered_play_turn = b.turn_number;
        else if (kind === 'adrenaline') (ref._temp_keywords ||= []).push('ADRENALINE');
        else if (kind === 'blocker' && src === 'granted') (ref._temp_keywords ||= []).push('BLOCKER');
        else if (kind === 'power' && src === 'power') {           // "+N power this turn"
          const n = +((e.label || '').match(/([+-]\d+)/) || [])[1] || 0;
          if (n) ref._temp_power = (ref._temp_power || 0) + n;
        } else if (kind === 'must-attack') ref._must_attack_on = nextTurnOf(pid);
        else if (kind === 'ready-lock') (ref._until_keywords ||= []).push({ kw: 'CANNOT_READY', until_pid: pid, until_turn: nextTurnOf(pid) + 2 });
        else if (kind === 'attack-lock') (ref._until_keywords ||= []).push({ kw: 'CANNOT_ATTACK', until_pid: pid, until_turn: nextTurnOf(pid) + 2 });
        else if (kind === 'gig-steal') ref._steal_mod = (ref._steal_mod || 0) - 1;
        else if (kind === 'delayed-defeat') notes.push(`${pid}: ${e.sourceName} delayed defeat not carried over`);
        // spent / attachment-power / passive / attack-power: the engine derives these itself
      }
      if (isUnit && ref.entered_play_turn === undefined) ref.entered_play_turn = Math.max(0, b.turn_number - 2);
    };

    for (const u of S.field || []) {
      const c = cardOf(u);
      if (!c) { notes.push(`${pid}: unknown unit ${u.name}`); continue; }
      claim(c, c.type === 'Legend');                             // a Go Solo Legend on the field
      const ref = { iid: iidOf(u.id), card_id: c.number, state: u.exhausted ? 'spent' : 'ready', equipped_gear: gearOf(u) };
      if (c.type === 'Legend') ref.from_solo = true;
      applyEffects(ref, u.currentEffects, true);
      zones.field.push(ref);
    }
    for (const l of S.legends || []) {
      const c = cardOf(l);
      const ref = { iid: iidOf(l.id), card_id: c?.number, state: l.exhausted ? 'spent' : 'ready', face: l.faceDown ? 'face_down' : 'face_up', equipped_gear: gearOf(l) };
      applyEffects(ref, l.currentEffects, false);
      if (c) claim(c, true); else hidden.legends.push(ref);
      zones.legends.push(ref);
    }
    for (const c0 of S.trash || []) {
      const c = cardOf(c0);
      if (!c) { notes.push(`${pid}: unknown trash card ${c0.name}`); continue; }
      claim(c, c.type === 'Legend');
      zones.trash.push({ iid: iidOf(c0.id), card_id: c.number });
    }
    for (const c0 of S.hand || []) {
      const c = cardOf(c0);
      if (c) { claim(c, false); zones.hand.push({ iid: iidOf(c0.id), card_id: c.number }); }
      else hidden.hand++;
    }
    for (const e of S.eddies || []) {
      const c = known(e.id);
      const ref = { iid: iidOf(e.id), card_id: c?.number, state: e.exhausted ? 'spent' : 'ready' };
      if (c) claim(c, false); else hidden.eddies.push(ref);
      zones.eddies.push(ref);
    }

    // deal the hidden cards from what's left
    let rest = shuffle(flat(pool), r);
    const deal = () => rest.length ? rest.pop() : shuffle(flat(deck.cards), r)[0];
    for (const ref of hidden.eddies) ref.card_id = deal();
    for (let i = 0; i < hidden.hand; i++) zones.hand.push({ iid: `${pid}h${i}`, card_id: deal() });
    let lp = shuffle(legendPool, r);
    for (const ref of hidden.legends) ref.card_id = lp.pop() || deck.legends[0];
    const deckCount = S.deckCount ?? rest.length;
    if (rest.length < deckCount) { notes.push(`${pid}: deck padded ${rest.length} -> ${deckCount}`); while (rest.length < deckCount) rest.push(shuffle(flat(deck.cards), r)[0]); }
    rest = rest.slice(0, deckCount);
    zones.deck = rest.map((n, i) => ({ iid: `${pid}d${i}`, card_id: n }));

    // dice: gigs keep their original owner; the fixer holds the unrolled ones
    for (const d of S.gigDice || []) {
      const origin = P(d.originalOwnerId) || pid;
      zones.gigs.push({ iid: `${origin}_d${d.sides}`, sides: d.sides, value: d.value, origin_pid: origin });
    }
    for (const d of S.dicePool || []) if (d.available) zones.fixer.push({ iid: `${pid}_d${d.sides}`, sides: d.sides, value: 0 });

    b[pid] = {
      id: pid, zones,
      called_legend_this_turn: !!S.calledLegendThisTurn,
      sold_card_this_turn: !!S.soldCardThisTurn,
      tapped: [],
      took_gig_this_turn: pid === b.active_player,
    };
  }
  return { board: b, notes };
}

// Engine board summary used to compare positions: per player, gigs, and the names on the
// field/legends/trash/hand counts. Two boards with the same signature are "the same turn outcome".
function signature(b) {
  const nm = n => cardByNumber(n)?.name || n;
  const side = p => {
    const Z = b[p].zones;
    return [
      'G' + Z.gigs.map(g => `${g.sides}:${g.value}`).sort().join(','),
      'F' + Z.field.map(u => nm(u.card_id) + (u.state === 'spent' ? '*' : '') + (u.equipped_gear || []).map(x => '+' + nm(x.card_id)).sort().join('')).sort().join('|'),
      'L' + Z.legends.map(l => (l.face === 'face_up' ? nm(l.card_id) : '?') + (l.state === 'spent' ? '*' : '')).sort().join('|'),
      'T' + Z.trash.length, 'H' + Z.hand.length, 'E' + Z.eddies.length,
    ].join(' ; ');
  };
  return `p1[${side('p1')}] p2[${side('p2')}]`;
}

module.exports = { toBoard, isCalm, signature, mulberry, shuffle, iidOf, MAIN_SIZE };
