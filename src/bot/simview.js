// Engine board -> the cyberpunk-tcg-sim state shape that board/app.js draws, so the replay board
// can show live games (board/play.html). Only what `viewer` may see is included: the other side's
// hand, deck order and face-down Legends stay hidden unless `revealAll` (spectating / game over).
'use strict';
const { CARDS } = require('../engine');
const { unitPower } = require('../coach/policy');

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

function player(b, pid, seeAll, revealDown) {
  const Z = b[pid].zones, P = b[pid];
  const tapped = new Set(P.tapped || []);
  const effects = u => {
    const fx = [];
    if (u.entered_play_turn === b.turn_number && pid === b.active_player) fx.push({ kind: 'lag', label: 'Lag', description: 'Entered play this turn' });
    if (u._temp_power) fx.push({ kind: 'power', label: `${u._temp_power > 0 ? '+' : ''}${u._temp_power} power`, description: 'This turn' });
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
      if (down && !(seeAll && (revealDown || lastOne))) return { id: l.iid, faceDown: true, exhausted: l.state === 'spent' || tapped.has(l.iid), slotIndex: i, zone: 'legend' };
      return cardOf(l, 'legend', { faceDown: down, known: down, exhausted: l.state === 'spent' || tapped.has(l.iid), slotIndex: i, attachments: gear(l) });
    }),
    eddies: Z.eddies.map(e => ({ id: e.iid, exhausted: e.state === 'spent' || tapped.has(e.iid) })),
    trash: Z.trash.map(c => cardOf(c, 'trash')),
    hand: seeAll ? Z.hand.map(c => cardOf(c, 'hand')) : [],
    handCount: Z.hand.length,
    deckCount: Z.deck.length,
  };
}

// viewer: 'p1' | 'p2' (whose hidden cards are visible); labels: { p1, p2 }
function simState(b, viewer, labels, revealAll = false) {
  const active = b.active_player;
  return {
    game: { turnNumber: b.turn_number, activePlayerId: PID[active], activePlayerLabel: labels[active], stageLabel: b.phase, matchClockEnabled: false },
    players: { player1: player(b, 'p1', revealAll || viewer === 'p1', revealAll), player2: player(b, 'p2', revealAll || viewer === 'p2', revealAll) },
  };
}

module.exports = { simState, PID, artId };
