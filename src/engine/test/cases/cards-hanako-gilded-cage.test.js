// Hanako Arasaka: In a Gilded Cage: "Reveal ANY NUMBER of cards with cost equal to any
// friendly Gig values and add them to your hand." The player picks which (0..all).
'use strict';
const assert = require('assert');
const { E, mainBoard, eddies, gig, run } = require('./_helpers');

const b = mainBoard();
b.p1.zones.gigs = [gig('g', 6, 3, 'p1')];
// top 4: two cost-3 cards (Cyberpsychosis, Over the Edge) and two others
b.p1.zones.deck = [{ iid: 't1', card_id: 'WNTC-067' }, { iid: 't2', card_id: 'WNTC-034' },
                   { iid: 't3', card_id: 'WNTC-101' }, { iid: 't4', card_id: 'WNTC-025' },
                   ...b.p1.zones.deck];
b.p1.zones.hand = [{ iid: 'h', card_id: 'WNTC-046' }];
b.p1.tapped = eddies(b, 'p1', 4);
let offered = null;
const r = run(E.step(b, { step: 'play_card', iid: 'h' }), x => x.waitingFor?.step === 'main_phase', wf => {
  if (wf.step === 'effect_choice' && wf.choice_needed.kind === 'choose_from_top_n') {
    offered = wf.choice_needed.eligible_iids;
    return { step: 'effect_choice_response', response: { selected_iids: ['t2'] } };
  }
  return null;
});
assert.deepStrictEqual(offered && [...offered].sort(), ['t1', 't2'], 'both cost-3 cards offered');
assert.deepStrictEqual(r.board.p1.zones.hand.map(c => c.iid), ['t2'], 'only the chosen card was taken');
const bottom = r.board.p1.zones.deck.slice(-3).map(c => c.iid).sort();
assert.deepStrictEqual(bottom, ['t1', 't3', 't4'], 'the rest went to the bottom');
console.log('ok');
