// The strong bot: per-decision Monte Carlo search over hidden-information deals.
//
// At every decision with a real choice (main-phase moves, effect choices, blocks, interrupts,
// Gig dice, steals):
//   1. Determinize: the bot never looks at what it can't know. It builds `deals` worlds, each a
//      copy of the position with the Rival's hand + deck re-dealt (same cards, shuffled between
//      the two zones), its own deck shuffled and the engine's dice/random effects reseeded.
//   2. Candidates: the greedy policy ranks every option; the top `k` (plus ending the turn) go on.
//   3. Playout: each candidate is played on every world (the same worlds for every candidate, so
//      the comparison is paired), then the greedy policy finishes the bot's turn and plays the
//      Rival's whole reply, for `horizon` of the bot's turns. The position is scored at the start
//      of the bot's next turn - where the 7-Gig win is checked - and averaged over worlds.
//   4. The best mean wins. Ties keep the greedy order.
// This is a rollout policy improvement: with a sound score it is never worse than the greedy
// policy it plays out with, and the arena measures how much better (scripts/arena.js).
//
// Options (bot spec "strong:key=value:..."): deals (6), k (5), horizon (1), w (tuned|default:
// the weights of the greedy policy and the leaf score), mull (0: hand-quality mulligan, src/bot/mulligan.js; 'old': the old always-keep tie; 1: search it), leaf (prob|score|net),
// scale (score points per logit for 'prob'), belief (1: guess the Rival's deck from what they showed,
// src/bot/belief.js; 0: old reshuffle that knows their list), loo (1: testing - hide their real list), sh (1: sequential
// halving over the shortlist at the same total budget), explore (extra random
// moves searched per decision, for training data), prior (greedy|net|mix: who picks the shortlist; mix = greedy's top k + the net's top kn),
// cont (greedy|net: who plays the rest of the bot's own turn inside each playout), pb (weight of the
// net's log-probability added to each searched move's value; needs prior=net|mix).
'use strict';
const { defaultPassAction } = require('../engine');
const { cloneBoard } = require('../engine/lib/clone');
const policy = require('../coach/policy');
const E = require('./eval');
const T = require('./tuned');
const VALUE = require('./value');
const BELIEF = require('./belief');
const { mulberry } = require('../coach/bridge');

// default = value-net leaf (beat the play-to-end version 64.8%, 44 pairs); the old default is
// strong:leaf=prob:horizon=99:deals=6:k=4
const DEFAULTS = { deals: 8, k: 5, horizon: 1, w: 'tuned', mull: 0, leaf: 'net', scale: 30, belief: 1, loo: 0, vnet: '', pnet: '', explore: 0, prior: 'greedy', kn: 3, pb: 0, cont: 'greedy', sh: 0 };

function shuffleInPlace(a, rng) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// A copy of `b` where everything `me` can't see is re-dealt. With `belief` ({ post, seen } from
// belief.js) the Rival's hand, deck, Eddies and face-down Legends come from a decklist drawn from
// the deck-guessing posterior. Without it (belief=0, the old behaviour) their actual remaining
// cards are only reshuffled between hand and deck - which leaks their 40-card list.
// Shuffles start from a SORTED list, so the result can't depend on the real hidden order (checked by
// scripts/leak-test.js). EDDIES_LEGACY_SHUFFLE=1 restores the old behaviour (shuffle in board order),
// needed only to replay games recorded before Nov 6 2026 exactly (Reanalyse of rounds 1-3).
const canon = a => (BELIEF.legacy.on ? a : a.sort());
function determinize(b, me, rng, belief) {
  const d = cloneBoard(b);
  const R = d[policy.opp(me)].zones;
  if (belief) BELIEF.redeal(d, me, rng, belief.post, belief.seen);
  else {
    const pool = shuffleInPlace(canon([...R.hand, ...R.deck].map(x => x.card_id)), rng);
    R.hand.forEach((h, i) => { h.card_id = pool[i]; });
    R.deck.forEach((c, i) => { c.card_id = pool[R.hand.length + i]; });
  }
  hideOwnLegends(d, me, rng, false);
  const M = d[me].zones.deck;
  const mine = shuffleInPlace(canon(M.map(x => x.card_id)), rng);
  M.forEach((c, i) => { c.card_id = mine[i]; });
  d._rngState = Math.floor(rng() * 4294967296) | 0;
  d._rngMap = null;
  d._trace = null;
  return d;
}

// Face-down Legends are hidden from their owner too: shuffle which face-down slot holds which of
// my uncalled Legends (I know the three I brought, not where they are). Mutates d unless copy.
function hideOwnLegends(d, me, rng, copy = true) {
  if (copy) d = cloneBoard(d);
  const down = d[me].zones.legends.filter(l => l.face !== 'face_up');
  const ids = shuffleInPlace(canon(down.map(l => l.card_id)), rng);
  down.forEach((l, i) => { l.card_id = ids[i]; });
  return d;
}

function make(name, opts = {}) {
  if (name !== 'strong') throw Object.assign(new Error('no such bot'), { code: 'MODULE_NOT_FOUND' });
  const o = { ...DEFAULTS, ...opts };
  const W = o.w === 'default' ? T.DEFAULT_W : (T.loadTuned() || T.DEFAULT_W);
  const ev = T.makeEval(W);
  const pol = { ev, sell: W.sell, noise: 0 };
  // 'prob': average win chances (a won world counts 1, not +1000); 'score': average raw scores
  // 'net': the value net's win chance (src/bot/value-net.json) at the start of the bot's next turn
  // prior=net: the policy net (src/bot/policy-net.json) picks the shortlist instead of greedy
  // pnet=<file>: a different policy-net file (for comparing nets head to head)
  const PNET = o.prior === 'net' || o.prior === 'mix' ? require('./pnet') : null;
  const pnetFile = PNET && o.pnet ? PNET.load(require('path').resolve(o.pnet)) : null;
  // the net's logits for R (greedy order); with them, rank by intuition and remember each move's
  // log-probability for the prior bonus
  let lastLogp = null;
  const prior = PNET ? (b, wf, me, R) => {
    const z = PNET.logits(b, me, R.map(x => x.seq), pnetFile || undefined, R.map((_, i) => i));
    const m = Math.max(...z), lse = m + Math.log(z.reduce((a, v) => a + Math.exp(v - m), 0));
    lastLogp = new Map(R.map((x, i) => [x.seq, z[i] - lse]));
    return R.map((x, i) => [z[i], x]).sort((a, c) => c[0] - a[0]).map(y => y[1]);
  } : null;
  // vnet=<file>: a different value-net file (for comparing nets head to head)
  const vnet = o.vnet ? VALUE.load(require('path').resolve(o.vnet)) : null;
  const score = o.leaf === 'net' ? (b, me) => VALUE.value(b, me, vnet)
    : o.leaf === 'score' ? ev
    : (b, me) => (b.winner ? (b.winner === me ? 1 : 0) : 1 / (1 + Math.exp(-ev(b, me) / o.scale)));

  // greedy for both sides until `me` has started `horizon` more of its own turns (or the game ends)
  // cont=net: the bot's own decisions in the turn being searched are played by the policy net
  // (its top move that applies), so a combo's follow-up gets played and its first step gets credit
  const PN = o.cont === 'net' ? require('./pnet') : null;
  function netStep(b, wf, me) {
    const cands = policy.moves(wf, b);
    if (cands.length < 2) return null;
    const z = PN.logits(b, me, cands);
    const order = cands.map((seq, i) => [z[i], seq]).sort((a, c) => c[0] - a[0]);
    for (const [, seq] of order) { const r = policy.tryApply(b, wf, seq); if (r) return r; }
    return null;
  }

  function playout(b, wf, me, rng) {
    let last = b.turn_number, arrived = 0;
    const turn = b.turn_number;
    for (let i = 0; i < 1200 && wf && !b.winner; i++) {
      if (b.active_player === me && b.turn_number !== last && wf.step === 'main_phase') {
        last = b.turn_number;
        if (++arrived >= o.horizon) break;
      }
      const owner = wf.owner || b.active_player;
      const r = (PN && owner === me && b.turn_number === turn && netStep(b, wf, me)) || E.botStep(b, wf, { ...pol, rng });
      if (!r) break;
      b = r.board; wf = r.waitingFor;
    }
    return b;
  }

  // greedy one-ply ranking of the options, best first
  function ranked(b, wf, me) {
    const out = [];
    for (const seq of policy.moves(wf, b)) {
      if (seq[seq.length - 1].step === 'end_turn') { out.push({ seq, s: ev(b, me) }); continue; }
      const r = policy.tryApply(b, wf, seq);
      if (!r) continue;
      const st = wf.step === 'main_phase' ? policy.settle(r.board, r.waitingFor, me) : r;
      out.push({ seq, s: ev(st.board, me) + (seq.some(a => a.step === 'sell_card') ? W.sell : 0) });
    }
    return out.sort((x, y) => y.s - x.s);
  }

  function search(b, wf, me, ctx) {
    const R = ranked(hideOwnLegends(b, me, ctx.rng), wf, me);   // greedy must not peek at its Legends
    if (R.length < 2) return { seq: R[0]?.seq || null, options: [] };
    // shortlist: greedy's top k; prior=net: the policy net's top k instead; prior=mix: greedy's top k
    // plus the net's top kn (the net adds what it learned the search likes; greedy keeps the basics)
    const netOrder = prior ? prior(b, wf, me, R) : null;
    const order = o.prior === 'net' ? netOrder : R;
    const keep = order.slice(0, o.k);
    if (o.prior === 'mix') for (const x of netOrder.slice(0, o.kn)) if (!keep.includes(x)) keep.push(x);
    const end = R.find(x => x.seq[x.seq.length - 1].step === 'end_turn');
    if (end && !keep.includes(end)) keep.push(end);
    // exploration (data generation): also test a few moves outside the shortlist, so the search
    // can discover lines the ranking would never try (combos whose first step looks bad)
    const shortlist = keep.slice();
    const rest = order.filter(x => !keep.includes(x));
    for (let e = 0; e < o.explore && rest.length; e++) keep.push(rest.splice(Math.floor(ctx.rng() * rest.length), 1)[0]);
    const seed = Math.floor(ctx.rng() * 1e9);
    let belief = null;
    if (o.belief) {
      const rv = policy.opp(me), seen = BELIEF.shown(b, rv);
      // loo=1 (testing only): drop the Rival's real list from the candidates, as if they played a
      // list the bot has never seen
      const real = o.loo ? BELIEF.trueList(b, rv) : null;
      belief = { seen, post: BELIEF.posterior(seen, real ? { exclude: d => BELIEF.sameList(d, real) } : {}) };
      ctx.belief = belief.post.slice(0, 3).map(x => ({ deck: x.deck.name || x.deck, p: x.w }));
    }
    // a world = one re-deal of everything hidden; world i is shared by every move (paired comparison)
    const worlds = [];
    const world = i => (worlds[i] ||= determinize(b, me, mulberry(seed + i), belief));
    const stats = new Map(keep.map(x => [x.seq, { total: 0, ok: 0, n: 0 }]));
    const run = (seq, from, to) => {
      const st = stats.get(seq);
      for (let i = from; i < to; i++) {
        st.n++;
        const r = policy.tryApply(world(i), wf, seq);
        if (!r) continue;
        st.ok++;
        st.total += score(playout(r.board, r.waitingFor, me, mulberry(seed + 5000 + i)), me);
      }
    };
    if (o.sh && keep.length > 2) {
      // sh=1: sequential halving (Gumbel-style root search) with the SAME total budget as the flat
      // search (moves x deals playouts): every move gets a few worlds, the worse half is dropped, the
      // survivors get more worlds, and so on until 2 are left - budget goes to the moves that matter
      const budget = keep.length * o.deals, rounds = Math.ceil(Math.log2(keep.length));
      let alive = keep.map(x => x.seq), used = 0;
      for (let rd = 0; rd < rounds && alive.length > 1; rd++) {
        const per = Math.max(1, Math.floor(budget / rounds / alive.length));
        for (const seq of alive) { const st = stats.get(seq); run(seq, st.n, st.n + per); }
        used += per * alive.length;
        const mean = q => { const st = stats.get(q); return st.ok ? st.total / st.ok : -Infinity; };
        alive = alive.slice().sort((x, y) => mean(y) - mean(x)).slice(0, Math.max(2, Math.ceil(alive.length / 2)));
        if (alive.length === 2 && rd < rounds - 1) {   // last round: the final two share what is left
          const left = Math.max(0, budget - used), each = Math.max(1, Math.floor(left / 2));
          for (const seq of alive) { const st = stats.get(seq); run(seq, st.n, st.n + each); }
          break;
        }
      }
    } else {
      for (const { seq } of keep) run(seq, 0, o.deals);
    }
    const options = [];
    for (const { seq } of keep) {
      const st = stats.get(seq);
      // pb: AlphaZero-style blend - add pb x log(intuition probability), so a move that only looks
      // best because its few noisy playouts got lucky has to beat the net's opinion too
      if (st.ok) options.push({ seq, value: st.total / st.ok + (o.pb && lastLogp ? o.pb * Math.max(-10, lastLogp.get(seq) ?? -10) : 0), n: st.ok });
    }
    options.sort((x, y) => y.value - x.value);
    ctx.lastSearch = { ranked: R.map(x => x.seq), shortlist: shortlist.map(x => x.seq), options };
    return { seq: options[0]?.seq || R[0].seq, options };
  }

  function act(b, wf, me, ctx) {
    if (wf.step === 'mulligan_decision' && o.mull !== 1) return E.chooseMove(wf, b, { ...pol, rng: ctx.rng, mull: o.mull });
    const r = search(b, wf, me, ctx);
    ctx.last = r.options;   // for UIs / explanations: every option tried and its mean score
    return r.seq || E.chooseMove(wf, b, { ...pol, rng: ctx.rng }) || (defaultPassAction(wf) ? [defaultPassAction(wf)] : null);
  }

  const tag = Object.entries(opts).map(([k, v]) => `${k}=${v}`).join(',');
  return { name: tag ? `strong(${tag})` : 'strong', act };
}

module.exports = { make, determinize, hideOwnLegends, DEFAULTS };
