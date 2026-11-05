// Rules 7.9.2 / 7.9.3: after the opening 6, the first player declares keep/mulligan first,
// then the second player; one mulligan each (whole hand back, shuffle, draw 6).
'use strict';
const assert = require('assert');
const { E, deck } = require('./_helpers');

const d = deck();
const b = E.setupGame(d, d, 'p2', { seed: 11 });
let r = E.step(b, undefined);
assert.strictEqual(r.waitingFor && r.waitingFor.step, 'mulligan_decision', 'the game must start with a mulligan decision');
assert.strictEqual(r.waitingFor.owner, 'p2', 'the first player decides first');
assert.deepStrictEqual(E.defaultPassAction(r.waitingFor), { step: 'mulligan', mulligan: false }, 'default = keep');

const before = r.board.p2.zones.hand.map(c => c.iid);
const deckN = r.board.p2.zones.deck.length;
r = E.step(r.board, { step: 'mulligan', mulligan: true });
const after = r.board.p2.zones.hand.map(c => c.iid);
assert.strictEqual(after.length, 6);
assert.strictEqual(r.board.p2.zones.deck.length, deckN, 'mulligan keeps deck size');
assert.notDeepStrictEqual(after, before, 'mulligan draws a new hand');
assert.strictEqual(r.waitingFor.step, 'mulligan_decision');
assert.strictEqual(r.waitingFor.owner, 'p1', 'then the second player');
const p1hand = r.board.p1.zones.hand.map(c => c.iid);
r = E.step(r.board, { step: 'mulligan', mulligan: false });
assert.deepStrictEqual(r.board.p1.zones.hand.slice(0, 6).map(c => c.iid), p1hand, 'keep leaves the hand alone');
assert.strictEqual(r.board.turn_number, 1, 'after both decisions turn 1 begins');
assert.strictEqual(r.board.active_player, 'p2');
assert.ok(['choose_gig_die', 'main_phase'].includes(r.waitingFor.step));

// preShuffled callers still work (and keep their exact hand).
const pre = { hand: d.cards.slice(0, 6).map(c => c.card_id), deck: d.cards.flatMap(c => Array(c.count).fill(c.card_id)).slice(6, 40) };
const bp = E.setupGame(d, d, 'p1', { seed: 1, skipValidation: true, preShuffled: { p1: pre, p2: pre } });
let rp = E.step(bp, undefined);
assert.strictEqual(rp.waitingFor.step, 'mulligan_decision');
rp = E.step(rp.board, { step: 'mulligan', mulligan: false });
rp = E.step(rp.board, { step: 'mulligan', mulligan: false });
assert.deepStrictEqual(rp.board.p1.zones.hand.slice(0, 6).map(c => c.card_id), pre.hand);
console.log('ok');
