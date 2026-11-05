// A steal of 0 Gigs is no steal: "when ... steals" triggers don't fire (FAQ: Gorilla
// Arms). A P0 GANGER attacks the Gig area; Evelyn Parker: Beautiful Enigma ("When a
// friendly CORPO or GANGER Unit steals 1 or more Gigs, ready 1 Eddie") must not trigger.
'use strict';
const assert = require('assert');
const { E, mainBoard, unit, gig, run } = require('./_helpers');

const b = mainBoard();
b.p2.zones.gigs.push(gig('g1', 6, 3, 'p2'));
b.p1.zones.legends[0] = { ...b.p1.zones.legends[0], card_id: 'WNTC-107', face: 'face_up', state: 'ready' };
b.p1.zones.eddies = [{ iid: 'e1', card_id: 'WNTC-012', state: 'spent' }];
const u = unit(b, 'p1', 'WNTC-079');                         // Maelstrom Zealots, Ganger, P0
let r = E.step(b, { step: 'declare_attack', attacker_iid: u.iid, target: { kind: 'gigs' } });
r = run(r, x => x.waitingFor?.step === 'main_phase');
assert.strictEqual(r.board.p2.zones.gigs.length, 1, 'nothing stolen');
assert.strictEqual(r.board.p1.zones.eddies[0].state, 'spent', 'Evelyn did not ready an Eddie');
console.log('ok');
