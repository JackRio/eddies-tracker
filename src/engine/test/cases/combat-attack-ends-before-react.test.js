// 9.6 — if the attacker leaves the field while its {Attack} triggers resolve, the
// attack ends: no React Step. And an attacker that is gone by the Steal Step steals
// nothing and fires no steal triggers.
'use strict';
const assert = require('assert');
const { E, mainBoard, unit, gig } = require('./_helpers');

// Dexter DeShawn's {Attack} (adjust a Gig) waits for a choice; remove him meanwhile.
const b = mainBoard();
b.p2.zones.gigs.push(gig('g1', 6, 3, 'p2'));
const dex = unit(b, 'p1', 'HEIST-002');
let r = E.step(b, { step: 'declare_attack', attacker_iid: dex.iid, target: { kind: 'gigs' } });
assert.strictEqual(r.waitingFor.step, 'effect_choice', 'setup: {Attack} trigger waits for a choice');
r.board.p1.zones.field = r.board.p1.zones.field.filter(u => u.iid !== dex.iid);
r.board.p1.zones.trash.push({ iid: dex.iid, card_id: dex.card_id });
r = E.step(r.board, { step: 'effect_choice_response', response: { iid: null } });
for (let i = 0; i < 5 && r.waitingFor.step === 'effect_choice'; i++)
  r = E.step(r.board, { step: 'effect_choice_response', response: { amount: 0, iid: null } });
assert.strictEqual(r.waitingFor.step, 'main_phase', 'attack ended before the React Step');
assert.strictEqual(r.board.current_attack, null);

// Attacker gone during the React Step: no steal, no OnStealGigs
// (Evelyn Parker: Beautiful Enigma would ready an Eddie for a GANGER's steal).
const b2 = mainBoard();
b2.p2.zones.gigs.push(gig('g1', 6, 3, 'p2'));
b2.p1.zones.legends[0] = { ...b2.p1.zones.legends[0], card_id: 'WNTC-107', face: 'face_up', state: 'ready' };
b2.p1.zones.eddies = [{ iid: 'e1', card_id: 'WNTC-012', state: 'spent' }];
const rip = unit(b2, 'p1', 'WNTC-049');                       // Maelstrom Goons, Ganger, P3
r = E.step(b2, { step: 'declare_attack', attacker_iid: rip.iid, target: { kind: 'gigs' } });
assert.strictEqual(r.waitingFor.step, 'defensive_step');
r.board.p1.zones.field = r.board.p1.zones.field.filter(u => u.iid !== rip.iid);
r = E.step(r.board, { step: 'pass_defensive' });
assert.strictEqual(r.waitingFor.step, 'main_phase');
assert.strictEqual(r.board.p2.zones.gigs.length, 1, 'nothing stolen');
assert.strictEqual(r.board.p1.zones.eddies[0].state, 'spent', 'no steal trigger fired');
console.log('ok');
