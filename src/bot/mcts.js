// AlphaZero-style tree search (Phase 1 of notes/alphazero-plan.md): no greedy anywhere in the search.
//
// Every decision with a real choice:
//   1. Worlds: `worlds` re-deals of everything the bot can't see (strong.js determinize(): deck guess from
//      belief.js, Rival hand / deck / Eddies / face-down Legends, own deck order, own face-down Legends).
//   2. One PUCT tree per world, `sims` simulations each. A node = a decision point (whoever acts there:
//      the bot or the Rival). Children = the engine's macro moves (policy.moves), with the policy net's
//      softmax as the prior P. Selection maximises Q + c * P * sqrt(N) / (1 + n), Q seen from the side
//      that acts at the node (unvisited children: parent Q - fpu). Forced single-option steps are applied
//      without making a node.
//   3. Leaf value: the value net (no playouts with greedy). The net is trained on turn starts, so
//      leaf=turn (default) first lets the policy net finish the current turn (its top legal move each step)
//      and scores the next turn start; leaf=direct scores the leaf as it stands.
//      A board where the Rival is to act is scored 1 - value(Rival) (same as strong.js after=1).
//   4. The root's visit counts are summed over worlds; the most visited move is played.
// Options (bot spec "mcts:key=value:..."): worlds (8), sims (32 per world), c (1.5), fpu (0.1), leaf
// (turn|direct), pnet / vnet (net files), belief (1), temp (0 = most visited; >0 samples visits^(1/temp)).
// Self-play exploration (scripts/selfplay.js): dir (Dirichlet noise weight on each world's root priors, 0 = off),
// alpha (0.3), tempTurn (decisions up to this game turn sample a move in proportion to its visits).
// After each search ctx.root = { moves: [{ seq, n, q }], q, sims }: the record self-play trains on.
// The mulligan still uses src/bot/mulligan.js (rules-based hand score).
'use strict';
const path = require('path');
const { defaultPassAction } = require('../engine');
const policy = require('../coach/policy');
const VALUE = require('./value');
const PN = require('./pnet');
const BELIEF = require('./belief');
const { determinize } = require('./strong');
const { mulberry } = require('../coach/bridge');

const DEFAULTS = { worlds: 8, sims: 32, c: 1.5, fpu: 0.1, leaf: 'turn', pnet: 'src/bot/policy-net-nog.json', vnet: 'src/bot/value-net-r3.json', belief: 1, temp: 0, dir: 0, alpha: 0.3, tempTurn: 0 };
const ROOT = path.join(__dirname, '..', '..');
const key = seq => JSON.stringify(seq);

// Gamma(a, 1) sample (Marsaglia-Tsang; a < 1 boosted), for Dirichlet noise
function gamma(a, rng) {
  if (a < 1) return gamma(a + 1, rng) * Math.pow(rng(), 1 / a);
  const d = a - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { const u1 = rng() || 1e-12, u2 = rng(); x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function make(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const pnet = PN.load(path.resolve(ROOT, o.pnet));
  const vnet = VALUE.load(path.resolve(ROOT, o.vnet));
  const stats = { decisions: 0, sims: 0, ms: 0 };

  // value for `me` of a board, as the value net sees it (it is trained on the acting player's turn start)
  const val = (b, me) => (b.winner ? (b.winner === me ? 1 : 0)
    : b.active_player === me ? VALUE.value(b, me, vnet) : 1 - VALUE.value(b, policy.opp(me), vnet));

  // the policy net's top legal move (rollout step for leaf=turn)
  function netStep(b, wf) {
    const cands = policy.moves(wf, b);
    if (!cands.length) { const d = defaultPassAction(wf); return d ? policy.tryApply(b, wf, [d]) : null; }
    if (cands.length === 1) return policy.tryApply(b, wf, cands[0]);
    const z = PN.logits(b, wf.owner || b.active_player, cands, pnet);
    const order = cands.map((seq, i) => [z[i], seq]).sort((x, y) => y[0] - x[0]);
    for (const [, seq] of order) { const r = policy.tryApply(b, wf, seq); if (r) return r; }
    const d = defaultPassAction(wf);
    return d ? policy.tryApply(b, wf, [d]) : null;
  }
  function leafValue(b, wf, me) {
    if (b.winner || !wf) return val(b, me);
    if (o.leaf === 'turn') {
      const t = b.turn_number;
      for (let i = 0; i < 200 && wf && !b.winner; i++) {
        if (b.turn_number !== t && wf.step === 'main_phase') break;
        const r = netStep(b, wf);
        if (!r) break;
        b = r.board; wf = r.waitingFor;
      }
    }
    return val(b, me);
  }

  // apply forced steps (one or no option) so every node is a real choice
  function settleForced(b, wf) {
    for (let i = 0; i < 60 && wf && !b.winner; i++) {
      const m = policy.moves(wf, b);
      if (m.length > 1) return { board: b, waitingFor: wf, moves: m };
      const seq = m[0] || (defaultPassAction(wf) ? [defaultPassAction(wf)] : null);
      const r = seq && policy.tryApply(b, wf, seq);
      if (!r) return { board: b, waitingFor: wf, moves: m };
      b = r.board; wf = r.waitingFor;
    }
    return { board: b, waitingFor: wf, moves: [] };
  }

  function newNode(b, wf, me, moves) {
    const node = { b, wf, n: 0, w: 0, kids: null };
    if (b.winner || !wf || !moves || moves.length < 2) { node.terminal = true; node.v = val(b, me); return node; }
    node.owner = wf.owner || b.active_player;
    const z = PN.logits(b, node.owner, moves, pnet);
    const mx = Math.max(...z), e = z.map(x => Math.exp(x - mx)), S = e.reduce((a, c) => a + c, 0);
    node.kids = moves.map((seq, i) => ({ seq, p: e[i] / S, n: 0, w: 0, child: undefined }));
    node.v = leafValue(b, wf, me);
    return node;
  }

  // one simulation; returns the value for `me`
  function simulate(node, me) {
    if (node.terminal) { node.n++; node.w += node.v; return node.v; }
    const mine = node.owner === me;
    for (;;) {
      if (!node.kids.length) { node.terminal = true; node.n++; node.w += node.v; return node.v; }
      const q0 = node.n ? node.w / node.n : node.v, parentQ = mine ? q0 : 1 - q0;
      const sq = Math.sqrt(node.n + 1);
      let best = null, bs = -Infinity;
      for (const k of node.kids) {
        const q = k.n ? (mine ? k.w / k.n : 1 - k.w / k.n) : parentQ - o.fpu;
        const s = q + o.c * k.p * sq / (1 + k.n);
        if (s > bs) { bs = s; best = k; }
      }
      let v;
      if (best.child === undefined) {
        const r = policy.tryApply(node.b, node.wf, best.seq);
        if (!r) {   // illegal here: drop it and renormalise the priors
          node.kids.splice(node.kids.indexOf(best), 1);
          const S = node.kids.reduce((a, k) => a + k.p, 0) || 1;
          for (const k of node.kids) k.p /= S;
          continue;
        }
        const f = settleForced(r.board, r.waitingFor);
        best.child = newNode(f.board, f.waitingFor, me, f.moves);
        v = best.child.v;
        best.child.n++; best.child.w += v;
      } else v = simulate(best.child, me);
      best.n++; best.w += v;
      node.n++; node.w += v;
      return v;
    }
  }

  function act(b, wf, me, ctx) {
    if (wf.step === 'mulligan_decision') return policy.chooseMove(wf, b, { rng: ctx.rng, mull: 0 });
    const moves = policy.moves(wf, b);
    if (moves.length < 2) return moves[0] || (defaultPassAction(wf) ? [defaultPassAction(wf)] : null);
    const t0 = Date.now();
    let belief = null;
    if (o.belief) {
      const seen = BELIEF.shown(b, policy.opp(me));
      belief = { seen, post: BELIEF.posterior(seen) };
      ctx.belief = belief.post.slice(0, 3).map(x => ({ deck: x.deck.name || x.deck, p: x.w }));
    }
    const seed = Math.floor(ctx.rng() * 1e9);
    const total = new Map();   // move key -> { seq, n, w }
    for (let i = 0; i < o.worlds; i++) {
      const d = determinize(b, me, mulberry(seed + i), belief);
      const root = newNode(d, wf, me, policy.moves(wf, d));
      if (root.terminal) continue;
      if (o.dir > 0 && root.kids.length > 1) {
        const rng = mulberry(seed + 7777 + i), g = root.kids.map(() => gamma(o.alpha, rng)), G = g.reduce((a, c) => a + c, 0) || 1;
        root.kids.forEach((k, j) => { k.p = (1 - o.dir) * k.p + o.dir * g[j] / G; });
      }
      for (let s = 0; s < o.sims; s++) simulate(root, me);
      for (const k of root.kids) {
        const t = total.get(key(k.seq)) || { seq: k.seq, n: 0, w: 0, p: 0 };
        t.n += k.n; t.w += k.w; t.p += k.p / o.worlds;
        total.set(key(k.seq), t);
      }
    }
    const opts = [...total.values()].filter(t => t.n > 0).sort((x, y) => y.n - x.n || y.w / y.n - x.w / x.n);
    stats.decisions++; stats.sims += o.worlds * o.sims; stats.ms += Date.now() - t0;
    ctx.last = opts.map(t => ({ seq: t.seq, value: t.w / t.n, n: t.n, prior: t.p }));
    const N = opts.reduce((a, t) => a + t.n, 0);
    ctx.root = { moves: [...total.values()].map(t => ({ seq: t.seq, n: t.n, q: t.n ? t.w / t.n : null })), q: N ? opts.reduce((a, t) => a + t.w, 0) / N : null, sims: N };
    if (!opts.length) return moves[0];
    const temp = o.temp > 0 ? o.temp : (o.tempTurn && b.turn_number <= o.tempTurn ? 1 : 0);
    if (temp > 0) {
      const w = opts.map(t => Math.pow(t.n, 1 / temp)), S = w.reduce((a, c) => a + c, 0);
      let u = ctx.rng() * S;
      for (let i = 0; i < opts.length; i++) { u -= w[i]; if (u <= 0) return opts[i].seq; }
    }
    return opts[0].seq;
  }

  return { name: `mcts(w${o.worlds}x${o.sims},${o.leaf})`, act, stats };
}

module.exports = { make, DEFAULTS };
