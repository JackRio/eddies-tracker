// Jackie Welles: Pour One Out For Me: "The first time you play a Blue Unit or Blue Gear
// each turn, you may decrease a friendly Gig by up to 2. If it becomes a min Gig, draw 1."
// FAQ: a Blue Legend played from the Legends area triggers it; and a Blue Unit played
// BEFORE Jackie was flipped face-up already used up "the first time" this turn.
'use strict';
const assert = require('assert');
const { E, mainBoard, eddies, gig, run } = require('./_helpers');

const amt = wf => wf.step === 'effect_choice' && wf.choice_needed.kind === 'choose_amount'
  ? { step: 'effect_choice_response', response: { amount: wf.choice_needed.min } } : null;
const isJackie = wf => wf.step === 'effect_choice' && /Jackie/.test(wf.choice_needed?.prompt || '');
function setup() {
  const b = mainBoard();
  const L = b.p1.zones.legends;
  L[0] = { ...L[0], card_id: 'HEIST-011', state: 'ready', face: 'face_up' };   // Jackie
  L[1] = { ...L[1], card_id: 'HEIST-012', state: 'ready', face: 'face_up' };   // V: Corporate Exile (Blue, Go Solo)
  L[2] = { ...L[2], card_id: 'WNTC-039', state: 'ready', face: 'face_down' };
  b.p1.zones.gigs = [gig('g', 8, 3, 'p1')];
  return b;
}

// 1. Go Solo a Blue Legend: Jackie triggers.
let b = setup(), prompts = 0;
b.p1.tapped = eddies(b, 'p1', 5);
let r = run(E.step(b, { step: 'play_legend_solo', iid: b.p1.zones.legends[1].iid }),
  x => x.waitingFor?.step === 'main_phase', wf => { if (isJackie(wf)) prompts++; return amt(wf); });
assert.ok(prompts > 0, 'Jackie triggers on a Blue Legend played via Go Solo');

// 2. Blue Unit while Jackie is face-down, flip Jackie, another Blue Unit: no trigger.
b = setup();
b.p1.zones.legends[0].face = 'face_down';
b.p1.zones.hand = [{ iid: 'u1', card_id: 'WNTC-124' }, { iid: 'u2', card_id: 'WNTC-124' }];   // Psycho Squad (Blue)
b.p1.tapped = eddies(b, 'p1', 4, 'a');
r = run(E.step(b, { step: 'play_card', iid: 'u1' }), x => x.waitingFor?.step === 'main_phase');
r.board.p1.tapped = eddies(r.board, 'p1', 1, 'b');
r = run(E.step(r.board, { step: 'call_legend', iid: r.board.p1.zones.legends[0].iid }), x => x.waitingFor?.step === 'main_phase');
assert.strictEqual(r.board.p1.zones.legends[0].face, 'face_up');
r.board.p1.tapped = eddies(r.board, 'p1', 4, 'c');
prompts = 0;
r = run(E.step(r.board, { step: 'play_card', iid: 'u2' }), x => x.waitingFor?.step === 'main_phase',
  wf => { if (isJackie(wf)) prompts++; return amt(wf); });
assert.strictEqual(prompts, 0, 'not the first Blue Unit played this turn (FAQ)');
console.log('ok');
