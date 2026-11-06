// What a bot may know when it decides. Every bot (play page, league, arena via pilots) decides on this
// board, never on the real one:
//   - the opponent's hand, deck, face-down Eddies and face-down Legends are re-dealt from a decklist
//     drawn from its deck guess (belief.js: meta lists + what the opponent has shown face up);
//   - its own deck order and its own face-down Legends are shuffled (it brought them, but doesn't know
//     where each one is - a Call flips a random one).
'use strict';
const BELIEF = require('./belief');
const { determinize } = require('./strong');

function botView(b, me, rng) {
  const seen = BELIEF.shown(b, me === 'p1' ? 'p2' : 'p1');
  return determinize(b, me, rng, { seen, post: BELIEF.posterior(seen) });
}

module.exports = { botView };
