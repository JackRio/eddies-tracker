// Bot registry for the arena. Each entry builds a fresh bot: { name, act(b, wf, pid, ctx) }.
'use strict';
const { chooseMove } = require('../coach/policy');
const E = require('./eval');
const T = require('./tuned');
const weighted = (name, W, o = {}) => { const ev = T.makeEval(W); return { name: name + (o.mull ? `(mull=${o.mull})` : '') + (o.gb ? '(gb)' : ''), act: (b, wf, pid, ctx) => E.chooseMove(wf, b, { rng: ctx.rng, noise: 0, ev, sell: W.sell, mull: o.mull, resolve: o.gb === 2 ? 'fight' : !!o.gb }) }; };   // gb=1: score blocks etc. after they resolve

const BOTS = {
  // the coach's rollout bot: one-ply greedy over macro moves, hand-tuned position score
  greedy: (o = {}) => ({ name: o.gb ? 'greedy(gb)' : 'greedy', act: (b, wf, pid, ctx) => chooseMove(wf, b, { rng: ctx.rng, noise: 0, resolve: o.gb === 2 ? 'fight' : !!o.gb }) }),
  // greedy with the exposed-weight score: default weights (= greedy) or the tuned set
  greedyw: () => weighted('greedyw', T.DEFAULT_W),
  greedyt: (o) => { const W = T.loadTuned(); if (!W) throw new Error('no src/bot/tuned-weights.json yet'); return weighted('greedyt', W, o); },
  // greedy with softmax noise (weaker; useful as a sanity opponent)
  noisy: () => ({ name: 'noisy', act: (b, wf, pid, ctx) => chooseMove(wf, b, { rng: ctx.rng, noise: 6 }) }),
  // AlphaZero-style tree search, nets only (src/bot/mcts.js)
  mcts: (o) => require('./mcts').make(o),
};

function makeBot(spec) {
  const [name, ...kv] = spec.split(':');
  const opts = Object.fromEntries(kv.map(s => { const [k, v] = s.split('='); return [k, isNaN(+v) ? v : +v]; }));
  if (BOTS[name]) return BOTS[name](opts);
  try { return require('./strong').make(name, opts); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  throw new Error(`unknown bot "${spec}"`);
}

module.exports = { makeBot, BOTS };
