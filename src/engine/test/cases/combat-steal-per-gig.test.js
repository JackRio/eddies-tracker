// 10.16.3 / 11.5.1.6.1 — a Unit stealing 2 Gigs moves both at once, then "when ...
// steals a Gig" triggers fire once per Gig, each seeing its own Gig.
// FAQ: 6th Street Recruits — stealing two d6 triggers it twice.
'use strict';
const assert = require('assert');
const { E, mainBoard, unit, gig } = require('./_helpers');

const b = mainBoard();
b.p2.zones.gigs = [gig('ga', 6, 2, 'p2'), gig('gb', 6, 3, 'p2'), gig('gc', 8, 5, 'p2')];
unit(b, 'p1', 'WNTC-006');                                   // 6th Street Recruits
const w = unit(b, 'p1', 'WNTC-007');                         // Animals Wrecker, P10: steals 2
let r = E.step(b, { step: 'declare_attack', attacker_iid: w.iid, target: { kind: 'gigs' } });
r = E.step(r.board, { step: 'pass_defensive' });
assert.strictEqual(r.waitingFor.step, 'choose_gig_to_steal');
assert.strictEqual(r.waitingFor.count, 2);
r = E.step(r.board, { step: 'choose_gig_to_steal', iids: ['ga', 'gb'] });
let prompts = 0;
for (let i = 0; i < 20 && r.waitingFor.step === 'effect_choice'; i++) {
  const cn = r.waitingFor.choice_needed;
  if (cn.kind === 'confirm_optional') {
    prompts++;
    assert.ok(['ga', 'gb'].every(iid => r.board.p1.zones.gigs.some(g => g.iid === iid)),
      'both Gigs moved before any trigger resolves');
    r = E.step(r.board, { step: 'effect_choice_response', response: { accept: false } });
  } else {
    r = E.step(r.board, { step: 'effect_choice_response', response: { iid: cn.available_iids?.[0], amount: 0 } });
  }
}
assert.strictEqual(prompts, 2, '6th Street Recruits triggers once per stolen d6');
assert.strictEqual(r.waitingFor.step, 'main_phase');

// Maelstrom Goons (equipped) steals 2 Gigs: the rival discards once per Gig.
const b3 = mainBoard();
b3.p2.zones.gigs = [gig('g1', 4, 1, 'p2'), gig('g2', 4, 2, 'p2')];
b3.p2.zones.hand = [{ iid: 'x1', card_id: 'WNTC-016' }, { iid: 'x2', card_id: 'WNTC-019' }, { iid: 'x3', card_id: 'WNTC-018' }];
const goons = unit(b3, 'p1', 'WNTC-049', { _temp_power: 7, equipped_gear: [{ iid: 'gear1', card_id: 'WNTC-094' }] });
r = E.step(b3, { step: 'declare_attack', attacker_iid: goons.iid, target: { kind: 'gigs' } });
r = E.step(r.board, { step: 'pass_defensive' });
assert.strictEqual(r.waitingFor.count, 2, 'setup: Goons (P3+7 temp+1 gear) steals 2');
r = E.step(r.board, { step: 'choose_gig_to_steal', iids: ['g1', 'g2'] });
for (let i = 0; i < 10 && r.waitingFor.step === 'effect_choice'; i++)
  r = E.step(r.board, { step: 'effect_choice_response', response: { iid: r.waitingFor.choice_needed.available_iids?.[0] } });
assert.strictEqual(r.board.p2.zones.hand.length, 1, 'rival discarded once per stolen Gig');

// V: Roamer of the Badlands raises exactly the Gig just stolen.
const b2 = mainBoard();
b2.p2.zones.gigs = [gig('gx', 12, 4, 'p2')];
const v = unit(b2, 'p1', 'WNTC-020');                        // P6: steals 1
r = E.step(b2, { step: 'declare_attack', attacker_iid: v.iid, target: { kind: 'gigs' } });
r = E.step(r.board, { step: 'pass_defensive' });
r = E.step(r.board, { step: 'choose_gig_to_steal', iids: ['gx'] });
assert.strictEqual(r.waitingFor.step, 'effect_choice');
r = E.step(r.board, { step: 'effect_choice_response', response: { amount: 5 } });
assert.strictEqual(r.board.p1.zones.gigs.find(g => g.iid === 'gx').value, 9);
console.log('ok');
