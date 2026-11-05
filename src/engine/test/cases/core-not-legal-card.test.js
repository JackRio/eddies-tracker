// Rebecca: Having a Moment (PRM01-005) is a promo with no game text and is not legal for play.
// A deck that uses her as a Legend must fail validation.
'use strict';
const assert = require('assert');
const { E, deck } = require('./_helpers');

const d = deck();
d.legends = ['PRM01-005', ...d.legends.slice(1)];
const v = E.validateDeck(d);
assert.ok(v.errors.some(e => /not legal/.test(e)), `Rebecca should be rejected, got errors: ${JSON.stringify(v.errors)}`);
assert.ok(E.validateDeck(deck()).errors.length === 0, 'the normal meta deck is still legal');
console.log('ok');
