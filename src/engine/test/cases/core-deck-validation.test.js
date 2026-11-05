// Rule 7.3: max 3 copies per name+subtitle across all list entries (7.3.4); cards must fit
// the RAM limits (7.3.5) with an error message; setupGame refuses an illegal deck unless
// opts.skipValidation is set.
'use strict';
const assert = require('assert');
const { E, deck, card } = require('./_helpers');

const base = deck('4-red-2-green-standard');
assert.deepStrictEqual(E.validateDeck(base).errors, [], 'setup: base deck is legal');

// (a) 6 copies of one card split across two entries.
const a = structuredClone(base);
const three = a.cards.find(c => c.count === 3);
a.cards.push({ card_id: three.card_id, count: 3 });
const va = E.validateDeck(a);
assert.ok(va.errors.some(e => /copies/.test(e)), `split entries must be summed: errors ${JSON.stringify(va.errors)}`);
assert.ok(E.deckIsIllegal(a));

// (b) an off-color card gets an error message (not just a flag).
const blue = E.CARDS.find(c => c.type === 'Unit' && c.color === 'Blue').number;
const bdeck = structuredClone(base); bdeck.cards[0] = { card_id: blue, count: bdeck.cards[0].count };
const vb = E.validateDeck(bdeck);
assert.ok(vb.ramInvalid, 'setup: off-color card should be RAM-invalid');
assert.ok(vb.errors.some(e => e.includes(card(blue).name)), `RAM/color violation must be listed in errors: ${JSON.stringify(vb.errors)}`);

// (c) setupGame throws on an illegal deck; opts.skipValidation allows it.
const tiny = { legends: base.legends, cards: [{ card_id: three.card_id, count: 3 }] };
assert.throws(() => E.setupGame(tiny, base, 'p1', { seed: 1 }), /Illegal p1 deck/, 'setupGame must reject an illegal deck');
assert.doesNotThrow(() => E.setupGame(tiny, base, 'p1', { seed: 1, skipValidation: true }));
assert.doesNotThrow(() => E.setupGame(base, base, 'p1', { seed: 1 }), 'legal decks still set up');
console.log('ok');
