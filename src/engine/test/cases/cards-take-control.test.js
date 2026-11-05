// Take Control: "A rival Unit steals 1 fewer Gig this turn." FAQ: an effect steal by that
// Unit is reduced too. Also (FAQ, Gorilla Arms) a Unit cut to 0 steals nothing, so
// Gorilla Arms' "the first time this Unit steals" does not trigger.
'use strict';
const assert = require('assert');
const { E, mainBoard, eddies, unit, gig, run } = require('./_helpers');

// p1 attacks the Gig area with a Unit wearing Gorilla Arms; p2 answers with Take Control.
function attack(gearIds) {
  const b = mainBoard();
  b.turn_number = 3;
  b.p1.zones.gigs = [gig('m', 4, 1, 'p1')];
  b.p2.zones.gigs = [gig('a', 6, 2, 'p2'), gig('c', 8, 3, 'p2'), gig('d', 10, 4, 'p2')];
  unit(b, 'p1', 'WNTC-077', { iid: 'atk',                       // Emergency Atlus, power 4
    equipped_gear: gearIds.map((id, i) => ({ iid: 'gear' + i, card_id: id })) });
  b.p2.zones.hand = [{ iid: 'tc', card_id: 'WNTC-103' }];
  eddies(b, 'p2', 2);
  let cast = false;
  const r = run(E.step(b, { step: 'declare_attack', attacker_iid: 'atk', target: { kind: 'gigs' } }),
    x => x.waitingFor?.step === 'main_phase', wf => {
      if (wf.step === 'defensive_step' && !cast && (wf.interrupt_castable_iids || []).includes('tc')) {
        cast = true; return { step: 'play_card_interrupt_cast', iid: 'tc' };
      }
      if (wf.step === 'choose_gig_to_steal') return { step: 'choose_gig_to_steal', iids: wf.available_iids.slice(0, wf.count) };
      return null;
    });
  assert.ok(cast, 'Take Control was cast');
  return 3 - r.board.p2.zones.gigs.length;                     // Gigs stolen from p2
}

// Power 4+3 = 7: steals 1, Take Control makes it 0 -> Gorilla Arms must not fire.
assert.strictEqual(attack(['WNTC-060']), 0, 'steal cut to 0: Gorilla Arms does not steal');
// Power 4+3+2+2 = 11: steals 2 -> 1; Gorilla Arms' extra (effect) steal is cut to 0 too.
assert.strictEqual(attack(['WNTC-060', 'WNTC-025', 'WNTC-025']), 1, 'effect steal also 1 fewer (FAQ)');
console.log('ok');
