// Memory Relapse: "Spend a rival Unit. It can't ready until your next turn."
// "Can't ready" must also stop EFFECTS that ready it, not just the Ready Step. Here the
// rival's Modded Muramasa ("At the end of your turn, if you have less Street Cred than a
// Rival, ready this Unit") must stay spent through the rival's end of turn.
'use strict';
const assert = require('assert');
const { E, mainBoard, eddies, gig, unit, run } = require('./_helpers');

const b = mainBoard();
b.p1.zones.gigs = [gig('P1G', 20, 15, 'p1')];
b.p2.zones.gigs = [gig('P2G', 4, 1, 'p2')];                  // p2 has less Street Cred
unit(b, 'p2', 'WNTC-121', { iid: 'MUR' });                    // Modded Muramasa
b.p1.zones.hand.push({ iid: 'MR', card_id: 'WNTC-100' });
let r = { board: b };
for (const iid of eddies(b, 'p1', 4)) r = E.step(r.board, { step: 'tap_resource', iid });
r = E.step(r.board, { step: 'play_card', iid: 'MR' });
r = run(r, x => x.waitingFor?.step === 'main_phase');
const mur = () => r.board.p2.zones.field.find(u => u.iid === 'MUR');
assert.strictEqual(mur().state, 'spent', 'setup: Memory Relapse spends the rival Unit');

r = E.step(r.board, { step: 'end_turn' });                       // -> p2's turn
r = run(r, x => x.waitingFor?.step === 'main_phase' && x.board.active_player === 'p2',
        wf => wf.step === 'choose_gig_die' ? { step: 'choose_gig_die', sides: wf.available[0] } : null);
assert.strictEqual(mur().state, 'spent', 'stays spent through the rival Ready Step');

r = E.step(r.board, { step: 'end_turn' });                       // p2's end of turn: Muramasa trigger
assert.notStrictEqual(r.board.active_player, 'p2', 'setup: p2 turn should have ended');
assert.strictEqual(mur().state, 'spent',
  'Modded Muramasa\'s end-of-turn ready must not ready a Unit that "can\'t ready until your next turn"');
console.log('ok');
