// Alt Cunningham: Soulkiller Architect — first ability: "{Spend} Your next Program this
// turn plays for -1 €$ for each friendly min Gig, to a minimum of 1 €$." FAQ:
//  - the min-Gig count is fixed when the ability resolves;
//  - two activations stack (still at least 1 €$);
//  - a Program played from the trash (Alt's second ability) counts as the next Program.
'use strict';
const assert = require('assert');
const { E, mainBoard, mainWaiting, eddies, gig, run } = require('./_helpers');

const b = mainBoard();
const alt = b.p1.zones.legends[0];
Object.assign(alt, { card_id: 'WNTC-106', face: 'face_up', state: 'ready' });
b.p1.zones.gigs = [gig('a', 4, 1, 'p1'), gig('b', 6, 1, 'p1'), gig('c', 8, 6, 'p1')];   // 2 min Gigs

const altAbilities = bd => (mainWaiting(bd).spend_activatable_iids || []).filter(x => x.iid === alt.iid);
assert.strictEqual(altAbilities(b).length, 2, 'Alt has two activated abilities');
const altScript = [].concat(E.CARD_SCRIPTS).find(x => x.card_id === 'WNTC-106') || E.CARD_SCRIPTS['WNTC-106'];
const discountIdx = altScript.abilities
  .findIndex(a => (a.effect || []).some(e => e.action === 'DiscountNextPlay'));
const replayIdx = altScript.abilities
  .findIndex(a => (a.effect || []).some(e => e.action === 'PlayFromZone'));
assert.ok(discountIdx >= 0, 'discount ability is scripted');

const toMain = x => x.waitingFor?.step === 'main_phase';
const activate = (bd, idx) => run(E.step(bd, { step: 'activate_anytime_spend', iid: alt.iid, ability_idx: idx }), toMain).board;
const cost = (bd, id) => E.effectivePlayCost(bd, 'p1', { card_id: id }, E.CARDS.find(c => c.number === id));

let bd = activate(b, discountIdx);                       // -2 locked in
for (const g of bd.p1.zones.gigs) g.value = 5;           // no min Gigs any more
assert.strictEqual(cost(bd, 'WNTC-066'), 3, 'Bootleg (5) costs 3: count fixed at resolution');

bd.p1.zones.legends[0].state = 'ready';
bd.p1.zones.gigs[0].value = 1;                           // 1 min Gig now
bd = activate(bd, discountIdx);                          // another -1, stacks
assert.strictEqual(cost(bd, 'WNTC-066'), 2, 'two activations stack (5 - 2 - 1)');
assert.strictEqual(cost(bd, 'WNTC-067'), 1, 'Cyberpsychosis (3) floored at 1 €$');

// Replay Cyberpsychosis from the trash with Alt's second ability: it is the "next Program".
bd.p1.zones.legends[0].state = 'ready';
bd.p1.zones.trash.push({ iid: 'cp', card_id: 'WNTC-067' });
eddies(bd, 'p1', 5, 'x');
const ready = x => x.p1.zones.eddies.filter(e => e.state === 'ready').length;
const before = ready(bd);
bd = activate(bd, replayIdx);
assert.strictEqual(before - ready(bd), 2, 'paid 1 €$ (Alt) + 1 €$ (discounted Cyberpsychosis)');
assert.strictEqual(cost(bd, 'WNTC-066'), 5, 'discount used up by the Program from the trash');
console.log('ok');
