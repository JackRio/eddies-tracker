// Rogue Amendiares: Queen of the Afterlife — "The first time another friendly Unit steals a
// Gig with value less than its power each turn, ready 2 Eddies."
// FAQ: a friendly Unit already did that this turn, THEN you play Rogue; another friendly Unit
// steals such a Gig -> does it trigger? No (it's the second time this turn). So the "first
// time" is counted per controller, even before Rogue was in play.
'use strict';
const assert = require('assert');
const { E, mainBoard, eddies, unit, run, gig, pickFirst } = require('./_helpers');

const chooser = wf => wf.step === 'choose_gig_to_steal'
  ? { step: 'choose_gig_to_steal', iids: ['G1', 'G3'].filter(i => wf.available_iids.includes(i)).slice(0, wf.count) }
  : pickFirst(wf);   // always steal a value-1 Gig (< power 2)
const toMain = r => run(r, x => x.waitingFor?.step === 'main_phase' && x.board.active_player === 'p1', chooser);

const b = mainBoard(); b.turn_number = 3;
b.p2.zones.gigs = [gig('G1', 4, 1, 'p2'), gig('G2', 4, 2, 'p2'), gig('G3', 6, 1, 'p2')];
unit(b, 'p1', 'WNTC-043', { iid: 'A' });                       // Augmented Negotiators, power 2
unit(b, 'p1', 'WNTC-043', { iid: 'B' });                       // Augmented Negotiators, power 2
b.p1.zones.hand.push({ iid: 'ROGUE', card_id: 'WNTC-126' });

let r = E.step(b, { step: 'declare_attack', attacker_iid: 'A', target: { kind: 'gigs' } });
r = toMain(r);                                                   // A steals a 1 (< power 2): first time
assert.strictEqual(r.board.p2.zones.gigs.length, 2, 'setup: A stole a Gig');

for (const iid of eddies(r.board, 'p1', 5, 'R')) r = E.step(r.board, { step: 'tap_resource', iid });
r = E.step(r.board, { step: 'play_card', iid: 'ROGUE' });
r = toMain(r);
assert.ok(r.board.p1.zones.field.some(u => u.iid === 'ROGUE'), 'setup: Rogue in play');
const spentBefore = r.board.p1.zones.eddies.filter(e => e.state === 'spent').length;

r = E.step(r.board, { step: 'declare_attack', attacker_iid: 'B', target: { kind: 'gigs' } });
r = toMain(r);                                                   // B steals a Gig < its power: second time
assert.strictEqual(r.board.p2.zones.gigs.length, 1, 'setup: B stole a Gig');
const spentAfter = r.board.p1.zones.eddies.filter(e => e.state === 'spent').length;
assert.strictEqual(spentAfter, spentBefore, 'second qualifying steal this turn: Rogue must not ready Eddies');
console.log('ok');
