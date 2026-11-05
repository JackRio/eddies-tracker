// Rule 1.11: in overtime, 7+ friendly Gigs AT ANY POINT wins immediately, whatever moved
// the Gig. And the threshold is "seven (7) or more", not "more than half".
'use strict';
const assert = require('assert');
const { E, newGame, unit, eddies, run } = require('./_helpers');

function overtimeBoard() {
  const b = newGame({ seed: 3 });
  b.turn_number = 20; b.overtime = true;
  for (const pid of ['p1', 'p2']) { const z = b[pid].zones; z.gigs = z.fixer.splice(0).map(d => ({ ...d, value: 2, origin_pid: pid })); }
  return b;
}

// (a) A fight-triggered steal (Appetite for Destruction on a Unit-target attack) brings p1 to 7.
const b = overtimeBoard();
// both players hold 6 Gigs (all 12 dice rolled in)
unit(b, 'p1', 'WNTC-007', { iid: 'ATK' });                   // Animals Wrecker, power 10
unit(b, 'p2', 'WNTC-124', { iid: 'DEF', state: 'spent' });   // Psycho Squad, power 6
b.p1.zones.hand.push({ iid: 'APP', card_id: 'WNTC-028' });
const ed = eddies(b, 'p1', 3);
let r = E.step(b, undefined);
assert.strictEqual(r.waitingFor.step, 'main_phase');
for (const iid of ed) r = E.step(r.board, { step: 'tap_resource', iid });
r = E.step(r.board, { step: 'play_card', iid: 'APP' });
r = E.step(r.board, { step: 'declare_attack', attacker_iid: 'ATK', target: { kind: 'unit', iid: 'DEF' } });
r = run(r, x => x.waitingFor?.step === 'main_phase');
assert.strictEqual(r.board.p1.zones.gigs.length, 7, 'setup: Appetite should have stolen a 7th Gig');
assert.strictEqual(r.board.winner, 'p1', 'overtime: reaching 7 Gigs mid-turn must win immediately');
assert.strictEqual(r.status, 'ended');

// (b) "7 or more", not "more than half": with only 11 Gigs in play, 6 is not a win.
const b2 = overtimeBoard();
b2.p2.zones.gigs.pop();                                      // 6 v 5 (a die gone from play)
const r2 = E.step(b2, undefined);
assert.strictEqual(r2.board.winner, null, `6 Gigs is not a win in overtime (got winner ${r2.board.winner})`);
console.log('ok');
