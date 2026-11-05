// Arasaka Emergency Radioport: "When this Unit or Legend is spent, ... you may Call it for free.
// (You may only Call a Legend once per turn.)" Confirmed with Weird Co: it can Call on the
// rival's turn even if you Called on your own turn — the limit is per turn.
'use strict';
const assert = require('assert');
const { E, newGame, unit, run, pickFirst } = require('./_helpers');

const b = newGame({ seed: 6 });
b.turn_number = 4;
const V = b.p1.zones.legends.find(l => l.card_id === 'WNTC-005a');   // V: Streetkid — has {Go Solo}
assert.ok(V, 'setup: red deck should contain V: Streetkid');
const blk = unit(b, 'p1', 'WNTC-014', { iid: 'BLK' });               // Meredith Stout (Blocker)
blk.equipped_gear.push({ iid: 'RADIO', card_id: 'WNTC-023' });
unit(b, 'p2', 'WNTC-124', { iid: 'A2' });

// p1's own turn: Call some other Legend (uses p1's Call for turn 5).
let r = E.step(b, undefined);
if (r.waitingFor.step === 'choose_gig_die') r = E.step(r.board, { step: 'choose_gig_die', sides: 4 });
const other = r.board.p1.zones.legends.find(l => l.iid !== V.iid && l.face !== 'face_up' && l.state === 'ready');
r = E.step(r.board, { step: 'tap_resource', iid: other.iid });
r = E.step(r.board, { step: 'call_legend', iid: other.iid });
r = run(r, x => x.waitingFor?.step === 'main_phase');
assert.strictEqual(r.board.p1.called_legend_this_turn, true);
r = E.step(r.board, { step: 'end_turn' });
if (r.waitingFor.step === 'choose_gig_die') r = E.step(r.board, { step: 'choose_gig_die', sides: 4 });
assert.strictEqual(r.board.active_player, 'p2');

// p2 attacks; p1 blocks with the Radioport host -> spent -> look at V -> Call it for free.
r = E.step(r.board, { step: 'declare_attack', attacker_iid: 'A2', target: { kind: 'gigs' } });
r = run(r, x => x.waitingFor?.step === 'defensive_step');
assert.ok(r.waitingFor.blocker_iids.includes('BLK'), 'setup: BLK should be able to block');
r = E.step(r.board, { step: 'blocker', iid: 'BLK' });
r = run(r, x => x.waitingFor?.step === 'main_phase', wf => {
  const cn = wf.choice_needed;
  if (wf.step === 'effect_choice' && cn?.kind === 'choose_legend' && (cn.available_iids || []).some(i => (i.iid || i) === V.iid))
    return { step: 'effect_choice_response', response: { iid: V.iid } };
  return pickFirst(wf);
});
const v2 = r.board.p1.zones.legends.find(l => l.iid === V.iid);
assert.strictEqual(v2.face, 'face_up', 'Radioport must Call V on the rival\'s turn even though p1 Called on its own turn');
console.log('ok');
