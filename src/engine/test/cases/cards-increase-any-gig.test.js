// "Increase a Gig by up to N" means ANY Gig, a rival's included (Industrial Assembly FAQ).
// La Llorona: Ghost of the Past ("When this Unit uses {Blocker}, increase a Gig by up to 3")
// and 6th Street Recruits ("When a friendly Unit steals a d6, increase a Gig by up to 6").
'use strict';
const assert = require('assert');
const { E, mainBoard, unit, gig, run } = require('./_helpers');

const gigChoice = (seen) => wf => {
  if (wf.step === 'effect_choice' && wf.choice_needed.kind === 'choose_gig') {
    seen.push(...wf.choice_needed.available_iids);
    return { step: 'effect_choice_response', response: { iid: wf.choice_needed.available_iids[0] } };
  }
  if (wf.step === 'effect_choice' && wf.choice_needed.kind === 'choose_amount')
    return { step: 'effect_choice_response', response: { amount: wf.choice_needed.max } };
  if (wf.step === 'choose_gig_to_steal') return { step: 'choose_gig_to_steal', iids: wf.available_iids.slice(0, wf.count) };
  return null;
};

// La Llorona blocks a p2 attack on p1's Gig area.
{
  const b = mainBoard();
  b.turn_number = 4; b.active_player = 'p2';
  b.p1.zones.gigs = [gig('mine', 6, 2, 'p1')];
  b.p2.zones.gigs = [gig('theirs', 8, 3, 'p2')];
  unit(b, 'p1', 'WNTC-013', { iid: 'll' });
  unit(b, 'p2', 'WNTC-077', { iid: 'att' });
  const seen = [];
  let blocked = false;
  run(E.step(b, { step: 'declare_attack', attacker_iid: 'att', target: { kind: 'gigs' } }),
    x => x.waitingFor?.step === 'main_phase', wf => {
      if (wf.step === 'defensive_step' && !blocked && (wf.blocker_iids || []).includes('ll')) {
        blocked = true; return { step: 'blocker', iid: 'll' };
      }
      return gigChoice(seen)(wf);
    });
  assert.ok(blocked, 'La Llorona blocked');
  assert.ok(seen.includes('theirs'), 'La Llorona may increase a rival Gig');
}

// 6th Street Recruits steals a d6.
{
  const b = mainBoard();
  b.turn_number = 3;
  b.p1.zones.gigs = [gig('mine', 8, 2, 'p1')];
  b.p2.zones.gigs = [gig('d6', 6, 4, 'p2'), gig('theirs', 10, 5, 'p2')];
  unit(b, 'p1', 'WNTC-006', { iid: 'six' });
  const seen = [];
  run(E.step(b, { step: 'declare_attack', attacker_iid: 'six', target: { kind: 'gigs' } }),
    x => x.waitingFor?.step === 'main_phase', wf =>
      wf.step === 'choose_gig_to_steal' ? { step: 'choose_gig_to_steal', iids: ['d6'] } : gigChoice(seen)(wf));
  assert.ok(seen.includes('theirs'), '6th Street Recruits may increase a rival Gig');
}
console.log('ok');
