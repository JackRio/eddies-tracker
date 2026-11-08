// Engine board -> the cyberpunk-tcg-sim state shape that board/app.js draws, so the replay board
// can show live games (board/play.html). Only what `viewer` may see is included: the other side's
// hand, deck order and face-down Legends stay hidden unless `revealAll` (spectating / game over).
'use strict';
const { CARDS } = require('../engine');
const { SCRIPTS } = require('../engine/lib/cards');
const { evalCondition } = require('../engine/lib/eval');
const { matchAffects } = require('../engine/lib/filters');
const { unitPower } = require('../coach/policy');
const { effectiveKeywords } = require('../engine/lib/events');

const BY = new Map(CARDS.map(c => [c.number, c]));
const PID = { p1: 'player1', p2: 'player2' };
// the board's /card/<id> route matches card art by the letters of the card's site slug
const artId = n => {
  const url = BY.get(n)?.url || '';
  const m = url.match(/\/cards\/([^?#]+)/);
  return m ? m[1].replace(/-/g, '_') : String(n).toLowerCase();
};
const cardOf = (r, zone, extra = {}) => {
  const c = BY.get(r.card_id) || {};
  return { id: r.iid, cardId: artId(r.card_id), name: c.name || r.card_id, power: c.power, basePower: c.power, zone,
    type: c.type, color: c.color, cost: c.cost, ram: c.ram, text: c.rules_text || '', ...extra };
};

// Keyword effects a card puts on a Unit for a while (Chrome Reverie: "can't attack until your next turn")
const KW_TEXT = { CANNOT_ATTACK: "can't attack", CANNOT_ATTACK_GIGS: "can't attack Gigs", CANNOT_READY: "can't ready", FIGHT_IMMUNE: "can't be defeated in fights",
  BLOCKER: 'has Blocker', ADRENALINE: 'has Adrenaline', UNBLOCKABLE: "can't be blocked", MUST_ATTACK: 'must attack' };
const kwText = kw => KW_TEXT[kw] || String(kw).toLowerCase().replace(/_/g, ' ');
// Keywords a Unit has right now from its own CONDITIONAL text or from another card's aura (Jacked-In Voodoo
// Boy can't attack until a Program is played; a Gear gives its host Blocker). Printed, always-on keywords
// (Blocker, Go Solo...) are on the card already and aren't listed. [{ kw, why }]
const COND_TEXT = c => {
  const j = JSON.stringify(c || {});
  if (/PlayedProgramThisTurn/.test(j)) return 'until you play a Program this turn';
  if (/street_cred/.test(j)) return c.op === '<' ? 'while your Street Cred is lower' : 'while your Street Cred is higher';
  if (/gig_count/.test(j)) return /"args"/.test(j) ? 'while the Rival has 2+ more Gigs' : 'while the Rival has more Gigs';
  return 'from its own text';
};
function statusKeywords(b, pid, u) {
  const out = [];
  const ctxOf = (p, r) => ({ self_pid: p, self_iid: r.iid, self_card_id: r.card_id, bindings: {} });
  for (const st of SCRIPTS[u.card_id]?.statics || [])
    if (st.kind === 'SelfKeyword' && (st.condition ? evalCondition(st.condition, b, ctxOf(pid, u)) : /^CANNOT_/.test(st.keyword)))
      out.push({ kw: String(st.keyword).toUpperCase(), why: st.condition ? COND_TEXT(st.condition) : 'its own text' });
  const me = { ...u, _pid: pid };
  for (const p of ['p1', 'p2']) for (const host of [...b[p].zones.field, ...b[p].zones.legends.filter(l => l.face === 'face_up')])
    for (const src of [host, ...(host.equipped_gear || [])])
      for (const st of SCRIPTS[src.card_id]?.statics || []) {
        if (st.kind !== 'AuraKeyword' || !matchAffects(st.affects, me, p, b, src.iid)) continue;
        if (st.condition && !evalCondition(st.condition, b, ctxOf(p, src))) continue;
        out.push({ kw: String(st.keyword).toUpperCase(), why: `from ${BY.get(src.card_id)?.name.split(':')[0] || 'another card'}${st.condition ? ` ${COND_TEXT(st.condition)}` : ''}` });
      }
  return out;
}
// what the on-card icon says (hover text = label - description)
const KW_LABEL = { CANNOT_ATTACK: "Can't attack", CANNOT_ATTACK_GIGS: "Can't attack Gigs", CANNOT_READY: "Can't ready", MUST_ATTACK: 'Must attack',
  UNBLOCKABLE: "Can't be blocked", FIGHT_IMMUNE: "Not defeated in fights", BLOCKER: 'Blocker', ADRENALINE: 'Adrenaline',
  HASTE_VS_GIGS: 'Can attack Gigs on arrival', NO_HASTE: 'No Adrenaline', ATTACK_READY_BLOCKERS: 'Can attack ready Blockers',
  ATTACK_READY_UNITS: 'Can attack ready Units', HASTE_VS_SPENT: 'Can attack spent Units on arrival' };
// only matters the turn a Unit arrives
const ARRIVAL = new Set(['ADRENALINE', 'HASTE_VS_GIGS', 'NO_HASTE', 'HASTE_VS_SPENT']);

// [{ kw, until }] currently on unit u; until = { pid, turn } or 'turn' (this turn only)
function unitKeywords(u) {
  return [...(u._until_keywords || []).map(k => ({ kw: k.kw, until: { pid: k.until_pid, turn: k.until_turn } })),
    ...(u._temp_keywords || []).map(kw => ({ kw, until: 'turn' }))];
}

function player(b, pid, seeAll, revealDown, showLast = true, labels = {}) {
  const Z = b[pid].zones, P = b[pid];
  const tapped = new Set(P.tapped || []);
  const effects = u => {
    const fx = [];
    const fresh = u.entered_play_turn === b.turn_number && pid === b.active_player;
    const timed = unitKeywords(u), fromText = statusKeywords(b, pid, u);
    const has = kw => timed.some(k => k.kw === kw) || fromText.some(k => k.kw === kw)
      || (SCRIPTS[u.card_id]?.statics || []).some(st => st.kind === 'SelfKeyword' && !st.condition && st.keyword === kw);
    const blocked = has('NO_HASTE');
    if (fresh && has('ADRENALINE') && !blocked) fx.push({ kind: 'ADRENALINE', tone: 'positive', label: 'Adrenaline', description: 'Can attack the turn it arrived' });
    // no Lag when the engine lets it attack anyway (a Legend that went Solo, "can attack spent Units / Gigs the turn it arrives")
    else if (fresh && (blocked || !effectiveKeywords(b, pid, u).some(k => k === 'GO_SOLO' || k === 'HASTE_VS_SPENT' || k === 'HASTE_VS_GIGS'))) fx.push({ kind: 'lag', label: 'Lag', description: "Arrived this turn - can't attack yet" });
    if (u._must_attack_on !== undefined) fx.push({ kind: 'MUST_ATTACK', tone: 'negative', label: 'Must attack', description: u._must_attack_on === b.turn_number ? 'This turn, if able' : `On turn ${u._must_attack_on}, if able` });
    if (u._temp_power) fx.push({ kind: 'power', label: `${u._temp_power > 0 ? '+' : ''}${u._temp_power} power`, description: 'This turn' });
    // effects other cards put on it: "Can't attack - until Bot A's turn 10"
    const seen = new Set(['ADRENALINE']);
    for (const k of timed) {
      if (seen.has(k.kw)) continue; seen.add(k.kw);
      const t = KW_LABEL[k.kw] || kwText(k.kw);
      fx.push({ kind: k.kw, tone: /^can't|must|no /i.test(t) ? 'negative' : 'positive', label: t[0].toUpperCase() + t.slice(1),
        description: k.until === 'turn' ? 'This turn' : `Until ${labels[k.until.pid] || k.until.pid}'s turn ${k.until.turn}` });
    }
    for (const k of fromText) {
      if (seen.has(k.kw) || (ARRIVAL.has(k.kw) && !fresh)) continue; seen.add(k.kw);
      const t = KW_LABEL[k.kw] || kwText(k.kw);
      fx.push({ kind: k.kw, tone: /^can't|must|no /i.test(t) ? 'negative' : 'positive', label: t[0].toUpperCase() + t.slice(1), description: k.why[0].toUpperCase() + k.why.slice(1) });
    }
    return fx;
  };
  const gear = u => (u.equipped_gear || []).map(g => cardOf(g, 'gear'));
  return {
    playerId: PID[pid],
    dicePool: (Z.fixer || []).map(d => ({ sides: d.sides, available: true })),
    gigDice: Z.gigs.map(g => {
      const owner = (String(g.iid).match(/^(p[12])/) || [])[1] || pid;
      return { id: g.iid, label: `D${g.sides}`, value: g.value, sides: g.sides, originalOwnerId: PID[owner] };
    }),
    field: Z.field.map(u => cardOf(u, 'field', { exhausted: u.state === 'spent', attackPower: unitPower(b, pid, u), attachments: gear(u), currentEffects: effects(u) })),
    // face-down Legends are hidden from their owner too, except the LAST one (known by elimination)
    legends: Z.legends.map((l, i) => {
      const down = l.face !== 'face_up';
      const lastOne = down && Z.legends.filter(x => x.face !== 'face_up').length === 1;
      if (down && !(seeAll && (revealDown || (lastOne && showLast)))) return { id: l.iid, faceDown: true, exhausted: l.state === 'spent' || tapped.has(l.iid), slotIndex: i, zone: 'legend' };
      return cardOf(l, 'legend', { faceDown: down, known: down, exhausted: l.state === 'spent' || tapped.has(l.iid), slotIndex: i, attachments: gear(l), currentEffects: down ? [] : effects(l) });
    }),
    eddies: Z.eddies.map(e => ({ id: e.iid, exhausted: e.state === 'spent' || tapped.has(e.iid) })),
    trash: Z.trash.map(c => cardOf(c, 'trash')),
    hand: seeAll ? Z.hand.map(c => cardOf(c, 'hand')) : [],
    handCount: Z.hand.length,
    deckCount: Z.deck.length,
  };
}

// the attack in progress (the board marks attacker, target and blocker until the fight ends)
function attackOf(b) {
  const A = b.current_attack;
  if (!A || !A.attacker_iid) return null;
  const def = b.active_player === 'p1' ? 'p2' : 'p1';
  return { attackerId: A.attacker_iid, targetId: A.target?.kind === 'unit' ? A.target.iid : null, targetSide: PID[def], blockerId: A.blocker_iid || null };
}

// viewer: 'p1' | 'p2' (whose hidden cards are visible); labels: { p1, p2 }
// revealDown: show face-down Legends' faces (game over). Watching bots, face-down Legends stay backs
// (spectate = everything else visible); playing, your last one shows (known by elimination).
function simState(b, viewer, labels, revealAll = false, revealDown = revealAll) {
  const active = b.active_player;
  return {
    game: { turnNumber: b.turn_number, activePlayerId: PID[active], activePlayerLabel: labels[active], stageLabel: b.phase, matchClockEnabled: false,
      attack: attackOf(b) },
    players: { player1: player(b, 'p1', revealAll || viewer === 'p1', revealDown, !revealAll, labels), player2: player(b, 'p2', revealAll || viewer === 'p2', revealDown, !revealAll, labels) },
  };
}

module.exports = { simState, PID, artId, unitKeywords, kwText };
