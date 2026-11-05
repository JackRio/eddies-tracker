// Yorinobu Arasaka: Embracing Destruction: "The first time a friendly ARASAKA Unit attacks
// each turn, draw 1." FAQ: after an ARASAKA attack, calling Yorinobu face-up and attacking
// with another ARASAKA Unit does NOT trigger it (the first time already happened).
'use strict';
const assert = require('assert');
const { E, mainBoard, eddies, unit, gig, run } = require('./_helpers');

const b = mainBoard();
b.turn_number = 3;
const L = b.p1.zones.legends;
L[0] = { ...L[0], card_id: 'EP-001', state: 'ready', face: 'face_down' };
b.p1.zones.gigs = [gig('m', 20, 20, 'p1')];          // 20 Street Cred: no discard
b.p2.zones.gigs = [gig('a', 4, 1, 'p2'), gig('b', 4, 2, 'p2')];
unit(b, 'p1', 'WNTC-078', { iid: 'a1' });            // Field Operator (ARASAKA)
unit(b, 'p1', 'WNTC-078', { iid: 'a2' });
const toMain = x => x.waitingFor?.step === 'main_phase';
let r = run(E.step(b, { step: 'declare_attack', attacker_iid: 'a1', target: { kind: 'gigs' } }), toMain,
  wf => wf.step === 'choose_gig_to_steal' ? { step: 'choose_gig_to_steal', iids: wf.available_iids.slice(0, wf.count) } : null);
r.board.p1.tapped = eddies(r.board, 'p1', 1);
r = run(E.step(r.board, { step: 'call_legend', iid: r.board.p1.zones.legends[0].iid }), toMain);
const hand = r.board.p1.zones.hand.length;
r = run(E.step(r.board, { step: 'declare_attack', attacker_iid: 'a2', target: { kind: 'gigs' } }), toMain,
  wf => wf.step === 'choose_gig_to_steal' ? { step: 'choose_gig_to_steal', iids: wf.available_iids.slice(0, wf.count) } : null);
assert.strictEqual(r.board.p1.zones.hand.length, hand, 'second ARASAKA attack this turn: no draw (FAQ)');
console.log('ok');
