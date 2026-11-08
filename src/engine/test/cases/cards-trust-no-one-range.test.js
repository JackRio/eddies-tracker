// Trust No One: "Decrease a Gig by up to 3. Then, if you control a min Gig, draw 1." Found in a user game:
// a lone d4 at 3 was picked silently, then 0-3 was offered; "3" fails by rule (rule 6.4.4), so nothing
// changed and no card was drawn. The script names its Gig with a bare { bind: 'g' }, which the amount
// range link didn't recognise. Now: the Gig is asked for first (play page), then only 0-2.
'use strict';
const assert = require('assert');
const { E, mainBoard, eddies, gig, run } = require('./_helpers');
const b = mainBoard();
b.p1.zones.gigs = [gig('d4', 4, 3, 'p1')]; b.p2.zones.gigs = [];
b.p1.zones.hand = [{ iid: 't', card_id: 'WNTC-139' }]; b.p1.tapped = eddies(b, 'p1', 3);
b.ask_single = { p1: true };
const seen = [];
const r = run(E.step(b, { step: 'play_card', iid: 't' }), x => x.waitingFor?.step === 'main_phase', wf => {
  const c = wf.choice_needed; if (!c) return null;
  seen.push(c.kind === 'choose_amount' ? `amount ${c.min}..${c.max}` : c.kind);
  return c.kind === 'choose_amount' ? { step: 'effect_choice_response', response: { amount: c.max } } : null;
});
assert.deepStrictEqual(seen, ['choose_gig', 'amount 0..2']);
assert.strictEqual(r.board.p1.zones.gigs[0].value, 1, 'd4 3 -> 1');
assert.strictEqual(r.board.p1.zones.hand.length, 1, 'a min Gig: draw 1');
console.log('ok');
