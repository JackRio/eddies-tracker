// User scenario: the rival attacks your Gigs. In the React Step you Call River Ward (paying 1 of 2
// Eddies), use her {Quick}{Spend} to equip Mandibular Upgrade to a non-Blocker Unit, then block with it.
// The new Blocker must show up in the same React Step, and the React Step stays open after the block (9.7).
'use strict';
const assert = require('assert');
const { E, mainBoard, unit, gig, eddies } = require('./_helpers');
const id = n => E.CARDS.find(c => c.name === n).number;

const b = mainBoard();
b.p2.zones.gigs.push(gig('g1', 6, 3, 'p2'));
const att = unit(b, 'p1', id('Screw: Lovelorn Fool'));
const fo = unit(b, 'p2', id('Field Operator'));                       // no Blocker of its own
b.p2.zones.legends[0] = { iid: 'RW', card_id: id('River Ward: Detective on the Hunt'), state: 'ready', face: 'face_down' };
const ed = eddies(b, 'p2', 2);
b.p2.zones.hand.push({ iid: 'MU', card_id: id('Mandibular Upgrade') });

let r = E.step(b, { step: 'declare_attack', attacker_iid: att.iid, target: { kind: 'gigs' } });
assert.strictEqual(r.waitingFor.step, 'defensive_step');
assert.deepStrictEqual(r.waitingFor.blocker_iids, [], 'no Blocker yet');

r = E.step(r.board, { step: 'call_legend_defensive', iid: 'RW', pay_iids: [ed[0]] });
const rw = r.board.p2.zones.legends.find(l => l.iid === 'RW');
assert.strictEqual(rw.face, 'face_up'); assert.strictEqual(rw.state, 'ready');
const sp = r.waitingFor.interrupt_spendable_iids.find(x => x.iid === 'RW');
assert.ok(sp, 'River Ward\'s Quick ability is offered after the Call');

r = E.step(r.board, { step: 'activate_asset_spend', iid: 'RW', ability_idx: sp.ability_idx });
while (r.waitingFor.step === 'effect_choice') {
  const ids = r.waitingFor.choice_needed.available_iids || [];
  r = E.step(r.board, { step: 'effect_choice_response', response: { iid: ids.includes('MU') ? 'MU' : ids.includes(fo.iid) ? fo.iid : ids[0] } });
}
assert.strictEqual(r.waitingFor.step, 'defensive_step');
assert.ok(r.waitingFor.blocker_iids.includes(fo.iid), 'Field Operator is now a Blocker in the same React Step');

r = E.step(r.board, { step: 'blocker', iid: fo.iid });
assert.strictEqual(r.waitingFor.step, 'defensive_step', 'React Step stays open after the redirect');
r = E.step(r.board, { step: 'pass_defensive' });
assert.strictEqual(r.board.p2.zones.gigs.length, 1, 'the Gig was not stolen');
console.log('ok');
