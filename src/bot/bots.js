// Bot registry for the arena. Each entry builds a fresh bot: { name, act(b, wf, pid, ctx) }.
'use strict';
const { chooseMove } = require('../coach/policy');
const E = require('./eval');
const T = require('./tuned');
const weighted = (name, W) => { const ev = T.makeEval(W); return { name, act: (b, wf, pid, ctx) => E.chooseMove(wf, b, { rng: ctx.rng, noise: 0, ev, sell: W.sell }) }; };

const BOTS = {
  // the coach's rollout bot: one-ply greedy over macro moves, hand-tuned position score
  greedy: () => ({ name: 'greedy', act: (b, wf, pid, ctx) => chooseMove(wf, b, { rng: ctx.rng, noise: 0 }) }),
  // greedy with the exposed-weight score: default weights (= greedy) or the tuned set
  greedyw: () => weighted('greedyw', T.DEFAULT_W),
  greedyt: () => { const W = T.loadTuned(); if (!W) throw new Error('no src/bot/tuned-weights.json yet'); return weighted('greedyt', W); },
  // greedy with softmax noise (weaker; useful as a sanity opponent)
  noisy: () => ({ name: 'noisy', act: (b, wf, pid, ctx) => chooseMove(wf, b, { rng: ctx.rng, noise: 6 }) }),
};

function makeBot(spec) {
  const [name, ...kv] = spec.split(':');
  const opts = Object.fromEntries(kv.map(s => { const [k, v] = s.split('='); return [k, isNaN(+v) ? v : +v]; }));
  if (BOTS[name]) return BOTS[name](opts);
  try { return require('./strong').make(name, opts); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  throw new Error(`unknown bot "${spec}"`);
}

module.exports = { makeBot, BOTS };
