// Position features for the learned evaluation. All from the point of view of `pid`, the player
// about to act; "rv" is the Rival. Only public information plus pid's own hand size.
'use strict';
const { unitPower, card, opp } = require('../coach/policy');

function side(b, pid) {
  const Z = b[pid].zones;
  const g = Z.gigs.length;
  let pow = 0, rpow = 0, ready = 0, maxp = 0, gear = 0;
  for (const u of Z.field) {
    const p = unitPower(b, pid, u);
    pow += p; maxp = Math.max(maxp, p); gear += (u.equipped_gear || []).length;
    if (u.state === 'ready') { ready++; rpow += p; }
  }
  let legUp = 0, legGear = 0;
  for (const l of Z.legends) {
    if (l.face === 'face_up') legUp++;
    legGear += (l.equipped_gear || []).length;
  }
  return {
    gigs: g, g4: +(g >= 4), g5: +(g >= 5), g6: +(g >= 6),
    gigSum: Z.gigs.reduce((a, d) => a + d.value, 0),
    fixer: (Z.fixer || []).length,
    units: Z.field.length, power: pow, readyUnits: ready, readyPower: rpow, maxPower: maxp, gear,
    legUp, legDown: Z.legends.length - legUp, legGear,
    hand: Math.min(Z.hand.length, 7), handOver: Math.max(0, Z.hand.length - 7),
    eddies: Math.min(Z.eddies.length, 8), eddiesOver: Math.max(0, Z.eddies.length - 8),
    deckLow: +(Z.deck.length < 5), deckOut: +(Z.deck.length === 0),
    trash: Z.trash.length,
  };
}

const KEYS = Object.keys(side({ p1: { zones: { gigs: [], fixer: [], field: [], legends: [], hand: [], eddies: [], deck: [], trash: [] } } }, 'p1'));
const NAMES = [...KEYS.map(k => 'my.' + k), ...KEYS.map(k => 'rv.' + k), 'turn'];

function features(b, pid) {
  const a = side(b, pid), r = side(b, opp(pid));
  return [...KEYS.map(k => a[k]), ...KEYS.map(k => r[k]), Math.min(b.turn_number, 20) / 10];
}

module.exports = { features, NAMES };
