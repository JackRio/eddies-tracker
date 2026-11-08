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
// pay (1: each costed move also comes in its distinct alternative payments - Eddies / face-down Legends /
// each face-up Legend first - so 'pay with the Mercs, then attack with Pepe' is a move it can choose),
// opp (greedy|net|look: who plays the Rival inside playouts - greedy one-ply; the policy net; or 'look': at the
// Rival's attack and block decisions its top `ol` greedy options are each played to the end of that turn and
// the one best for the Rival is kept - a Rival that punishes a spent board),
// noop (1: drop Programs whose play changes nothing but the card and the payment), kinds (1: the
// shortlist always holds the best-ranked move of every kind - attack, equip, program, unit, call, sell...).
// alt (1: on its own turn each move is scored twice - the rest of the turn by greedy, and by greedy that makes no
// more attacks - and keeps the better; greedy alone attacks with everything, so 'develop, then hold back' was never
// compared and every order of the same moves tied), tb (1: near-ties (< 0.3 points) go to moves that aren't
// attacks - equip / spend / play first, attack after), gb (1: greedy - in playouts and the shortlist ranking - scores
// blocks and other prompts after they play out; without it a block is scored before the fight, so the playout Rival
// never blocked and attacks into a ready blocker looked free).
// after (1: a move on its own turn is scored at the START OF THE RIVAL'S TURN - no imagined Rival reply, which greedy
// played badly - as 1 - the value net's win chance for the Rival there; leaf=net only; ~4x faster per decision).
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
const DEFAULTS = { deals: 8, k: 5, horizon: 1, w: 'tuned', mull: 0, leaf: 'net', scale: 30, belief: 1, loo: 0, vnet: '', pnet: '', explore: 0, prior: 'greedy', kn: 3, pb: 0, cont: 'greedy', sh: 0, pay: 0, noop: 0, kinds: 0, opp: 'greedy', ol: 3, od: 2, ok: 2, bpool: 0, alt: 0, tb: 0, gb: 0, after: 0 };

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
  delete d.ask_single;   // the human's "show me single picks" setting; bots search without the extra prompts
  const R = d[policy.opp(me)].zones;
  if (belief) BELIEF.redeal(d, me, rng, belief.post, belief.seen);
  else {
    const pool = shuffleInPlace(canon([...R.hand, ...R.deck].map(x => x.card_id)), rng);
    R.hand.forEach((h, i) => { h.card_id = pool[i]; });
    R.deck.forEach((c, i) => { R.deck[i] = { ...c, card_id: pool[R.hand.length + i] }; });   // deck cards are shared between copies: replace
  }
  hideOwnLegends(d, me, rng, false);
  const M = d[me].zones.deck;
  const mine = shuffleInPlace(canon(M.map(x => x.card_id)), rng);
  M.forEach((c, i) => { M[i] = { ...c, card_id: mine[i] }; });   // deck cards are shared between board copies: replace, never edit
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

// ── move-list helpers (pay / noop / kinds) ──
// Alternative payments for a costed macro move: the same play, paid in a different order of resource
// groups. Two payments that spend the same group mix (n Eddies, m face-down Legends, these face-up
// Legends) are one option.
function payVariants(b, pid, seq) {
  const n = seq.filter(a => a.step === 'tap_resource').length;
  if (!n) return [seq];
  const body = seq.filter(a => a.step !== 'tap_resource');
  const used = new Set(body.map(a => a.iid).filter(Boolean));
  const res = policy.readyResources(b, pid).filter(x => !used.has(x.iid));
  const E = res.filter(x => !x.face), D = res.filter(x => x.face && x.face !== 'face_up'), U = res.filter(x => x.face === 'face_up');
  const orders = [[...E, ...D, ...U], [...U, ...D, ...E], [...D, ...E, ...U], [...E, ...U, ...D], ...U.map(u => [u, ...E, ...D, ...U.filter(x => x !== u)])];
  const out = [], seen = new Set();
  for (const ord of orders) {
    if (ord.length < n) continue;
    const pick = ord.slice(0, n);
    const key = `${pick.filter(x => !x.face).length}|${pick.filter(x => x.face && x.face !== 'face_up').length}|${pick.filter(x => x.face === 'face_up').map(x => x.iid).sort().join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([...pick.map(x => ({ step: 'tap_resource', iid: x.iid })), ...body]);
    if (out.length >= 4) break;
  }
  return out.length ? out : [seq];
}
// A Program play that changes nothing except moving the card to the trash and spending the payment.
// the flag is real only if a card in play reads it (Jacked-In Voodoo Boy: "can't attack unless you played a Program")
const READS_PROGRAM = new Set(require('../engine/data/card_scripts.json').filter(c => /PlayedProgramThisTurn/.test(JSON.stringify(c))).map(c => c.card_id));
function boardSig(b, skipIid) {
  const c = cloneBoard(b);
  for (const k of ['_trace', '_rngState', '_rngMap', '_card_count', '_ev_seq']) delete c[k];
  for (const p of ['p1', 'p2']) if (![...c[p].zones.field, ...c[p].zones.legends].some(u => READS_PROGRAM.has(u.card_id))) delete c[p]._played_program_this_turn;
  for (const p of ['p1', 'p2']) {
    const Z = c[p].zones;
    Z.hand = Z.hand.filter(x => x.iid !== skipIid); Z.trash = Z.trash.filter(x => x.iid !== skipIid);
    for (const e of Z.eddies) e.state = '-';
    for (const l of Z.legends) l.state = '-';
    c[p].tapped = [];
  }
  return JSON.stringify(c);
}
function isNoop(b, seq, after) {
  const play = seq.find(a => a.step === 'play_card');
  if (!play) return false;
  const pid = b.active_player, h = b[pid].zones.hand.find(x => x.iid === play.iid);
  if (!h || policy.card(h.card_id)?.type !== 'Program') return false;
  return boardSig(b, play.iid) === boardSig(after, play.iid);
}
// the kind of a macro move, for kinds=1
function moveKind(seq) {
  const a = seq.find(x => x.step !== 'tap_resource') || seq[0];
  if (a.step === 'play_card') return a.equip_to ? 'equip' : 'play';
  if (a.step === 'declare_attack') return a.target?.kind === 'unit' ? 'attack_unit' : 'attack_gigs';
  return a.step;
}

function make(name, opts = {}) {
  if (name !== 'strong') throw Object.assign(new Error('no such bot'), { code: 'MODULE_NOT_FOUND' });
  const o = { ...DEFAULTS, ...opts };
  // nogreedy=1: nets and search only, no greedy anywhere - the policy net orders the shortlist and plays every
  // decision inside the imagined games (the rest of my turn, the Rival's prompts in it), the value net judges the
  // board at the start of the Rival's turn (after=1). Use a policy net trained WITHOUT greedy's rank as an input
  // (train-policy.py --grank 0), e.g. pnet=src/bot/policy-net-nog.json.
  const NG = !!o.nogreedy;
  if (NG) { o.after = 1; o.prior = 'net'; }
  const W = o.w === 'default' ? T.DEFAULT_W : (T.loadTuned() || T.DEFAULT_W);
  const ev = T.makeEval(W);
  const pol = { ev, sell: W.sell, noise: 0, ...(o.gb ? { resolve: true } : {}) };
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
  // after=1 (leaf=net): a playout of a move on my own turn stops when the Rival's turn starts (no imagined
  // Rival reply); that board is scored as 1 - the net's win chance for the Rival at the start of its turn -
  // the same kind of position the net is trained on (turn starts, both players' sides)
  const score = o.leaf === 'net' ? (b, me) => (o.after && !b.winner && b.active_player !== me ? 1 - VALUE.value(b, policy.opp(me), vnet) : VALUE.value(b, me, vnet))
    : o.leaf === 'score' ? ev
    : (b, me) => (b.winner ? (b.winner === me ? 1 : 0) : 1 / (1 + Math.exp(-ev(b, me) / o.scale)));

  // greedy for both sides until `me` has started `horizon` more of its own turns (or the game ends)
  // cont=net: the bot's own decisions in the turn being searched are played by the policy net
  // (its top move that applies), so a combo's follow-up gets played and its first step gets credit
  const PN = o.cont === 'net' || o.opp === 'net' || NG ? require('./pnet') : null;
  const pnFile = PN && o.pnet ? PN.load(require('path').resolve(o.pnet)) : undefined;
  function netStep(b, wf, me) {
    const cands = policy.moves(wf, b);
    if (cands.length < 2) return null;
    const z = PN.logits(b, me, cands, pnFile);
    const order = cands.map((seq, i) => [z[i], seq]).sort((a, c) => c[0] - a[0]);
    for (const [, seq] of order) { const r = policy.tryApply(b, wf, seq); if (r) return r; }
    return null;
  }

  // nogreedy: any decision, either side - the policy net's top move that applies (filter: alt=1's no-more-attacks)
  function netAny(b, wf, pid, filter) {
    let cands = policy.moves(wf, b);
    if (filter) { const f = cands.filter(filter); if (f.length) cands = f; }
    if (!cands.length) { const d = defaultPassAction(wf); return d ? policy.tryApply(b, wf, [d]) : null; }
    if (cands.length === 1) return policy.tryApply(b, wf, cands[0]);
    const z = PN.logits(b, pid, cands, pnFile);
    const order = cands.map((seq, i) => [z[i], seq]).sort((a, c) => c[0] - a[0]);
    for (const [, seq] of order) { const r = policy.tryApply(b, wf, seq); if (r) return r; }
    const d = defaultPassAction(wf);
    return d ? policy.tryApply(b, wf, [d]) : null;
  }

  // opp=net: the Rival's move = the policy net's top pick over greedy's ranking (the net reads greedy's rank
  // as an input, like prior=mix)
  function oppNetStep(b, wf, rv) {
    const R = ranked(b, wf, rv);
    if (R.length < 2) return null;
    const z = PN.logits(b, rv, R.map(x => x.seq), pnFile, R.map((_, i) => i));
    const order = R.map((x, i) => [z[i], x.seq]).sort((a, c) => c[0] - a[0]);
    for (const [, seq] of order) { const r = policy.tryApply(b, wf, seq); if (r) return r; }
    return null;
  }

  // opp=look: the Rival's attack / block choice, each of its top `ol` greedy options played to the end of
  // the current turn with greedy, scored from the Rival's side (tuned score) - the best one is played
  function lookStep(b, wf, rv, rng) {
    const key = (wf.step === 'main_phase' && (wf.attackable || []).length) || (wf.step === 'defensive_step' && (wf.blocker_iids || []).length);
    if (!key) return null;
    const cands = [];
    for (const seq of policy.moves(wf, b)) {
      const r = policy.tryApply(b, wf, seq);
      if (!r) continue;
      const st = wf.step === 'main_phase' ? policy.settle(r.board, r.waitingFor, rv) : r;
      cands.push({ r, s: ev(st.board, rv) });
    }
    if (cands.length < 2) return cands[0]?.r || null;
    cands.sort((x, y) => y.s - x.s);
    let best = null, bs = -Infinity;
    for (const c of cands.slice(0, o.ol)) {
      let x = c.r.board, w = c.r.waitingFor;
      const t = x.turn_number;
      for (let i = 0; i < 80 && w && !x.winner && x.turn_number === t; i++) { const q = E.botStep(x, w, { ...pol, rng }); if (!q) break; x = q.board; w = q.waitingFor; }
      const sc = x.winner ? (x.winner === rv ? 1e6 : -1e6) : ev(x, rv);
      if (sc > bs) { bs = sc; best = c.r; }
    }
    return best;
  }

  // opp=deep: the Rival's attack / block choice comes from a tiny nested copy of this bot (od worlds x ok
  // moves, own view of the imagined board, no deck guessing); everything else it does stays greedy
  let nested = null;
  function deepStep(b, wf, rv, rng) {
    const key = (wf.step === 'main_phase' && (wf.attackable || []).length) || (wf.step === 'defensive_step' && (wf.blocker_iids || []).length);
    if (!key) return null;
    nested ||= make('strong', { ...opts, opp: 'greedy', belief: 0, deals: o.od, k: o.ok });
    const seq = nested.act(b, wf, rv, { rng });
    return seq ? policy.tryApply(b, wf, seq) : null;
  }

  const noAttack = seq => !seq.some(a => a.step === 'declare_attack');
  function playout(b, wf, me, rng, hold) {
    let last = b.turn_number, arrived = 0;
    const turn = b.turn_number, mine = b.active_player === me;
    for (let i = 0; i < 1200 && wf && !b.winner; i++) {
      if (o.after && mine && b.active_player !== me && wf.step === 'main_phase') break;   // after=1: stop at the Rival's turn start
      if (b.active_player === me && b.turn_number !== last && wf.step === 'main_phase') {
        last = b.turn_number;
        if (++arrived >= o.horizon) break;
      }
      const owner = wf.owner || b.active_player;
      const r = NG ? netAny(b, wf, owner, hold && owner === me && b.turn_number === turn ? noAttack : null) : ((o.cont === 'net' && owner === me && b.turn_number === turn && netStep(b, wf, me))
        || (owner !== me && o.opp === 'net' && oppNetStep(b, wf, owner))
        || (owner !== me && o.opp === 'look' && lookStep(b, wf, owner, rng))
        || (owner !== me && o.opp === 'deep' && deepStep(b, wf, owner, rng))
        || E.botStep(b, wf, { ...pol, rng, ...(hold && owner === me && b.turn_number === turn ? { filter: noAttack } : {}) }));
      if (!r) break;
      b = r.board; wf = r.waitingFor;
    }
    return b;
  }

  // nogreedy: the policy net's order; only the moves it takes to fill the shortlist (k + end turn) are checked
  // as legal - the rest stay unchecked (exploration may pick one; an illegal one just gets no playouts)
  function rankedNet(b, wf, me) {
    const all = policy.moves(wf, b);
    if (all.length < 2) return all.filter(seq => policy.tryApply(b, wf, seq)).map(seq => ({ seq, s: 0 }));
    const z = PNET.logits(b, me, all, pnetFile || undefined);
    const order = all.map((seq, i) => ({ seq, s: z[i] })).sort((x, y) => y.s - x.s);
    const out = [], rest = [];
    for (const x of order) {
      if (out.length >= o.k) { rest.push(x); continue; }
      if (x.seq[x.seq.length - 1].step === 'end_turn' || policy.tryApply(b, wf, x.seq)) out.push(x);
    }
    return [...out, ...rest];
  }

  // greedy one-ply ranking of the options, best first
  function ranked(b, wf, me) {
    if (NG) return rankedNet(b, wf, me);
    const out = [];
    const base = policy.moves(wf, b);
    const all = base;   // payment variants are added AFTER the shortlist (pay=1, see search) - ranked here they filled it
    for (const seq of all) {
      if (seq[seq.length - 1].step === 'end_turn') { out.push({ seq, s: ev(b, me) }); continue; }
      const r = policy.tryApply(b, wf, seq);
      if (!r) continue;
      if (o.noop && wf.step === 'main_phase' && isNoop(b, seq, r.board)) continue;
      const st = wf.step === 'main_phase' || o.gb ? policy.settle(r.board, r.waitingFor, me) : r;
      out.push({ seq, s: ev(st.board, me) + (seq.some(a => a.step === 'sell_card') ? W.sell : 0) });
    }
    return out.sort((x, y) => y.s - x.s);
  }

  function search(b, wf, me, ctx) {
    const R = ranked(hideOwnLegends(b, me, ctx.rng), wf, me);   // greedy must not peek at its Legends
    if (R.length < 2) return { seq: R[0]?.seq || null, options: [] };
    // shortlist: greedy's top k; prior=net: the policy net's top k instead; prior=mix: greedy's top k
    // plus the net's top kn (the net adds what it learned the search likes; greedy keeps the basics)
    const netOrder = NG ? R : prior ? prior(b, wf, me, R) : null;
    const order = o.prior === 'net' ? netOrder : R;
    const keep = order.slice(0, o.k);
    if (o.prior === 'mix') for (const x of netOrder.slice(0, o.kn)) if (!keep.includes(x)) keep.push(x);
    const end = R.find(x => x.seq[x.seq.length - 1].step === 'end_turn');
    if (end && !keep.includes(end)) keep.push(end);
    if (o.kinds && wf.step === 'main_phase') {   // the best-ranked move of every kind gets searched too
      const have = new Set(keep.map(x => moveKind(x.seq)));
      for (const x of order) { const kd = moveKind(x.seq); if (!have.has(kd)) { have.add(kd); keep.push(x); } }
    }
    // pay=1: each shortlisted costed play also gets its alternative payments, searched on top of the shortlist
    if (o.pay && wf.step === 'main_phase') {
      for (const x of keep.slice()) for (const v of payVariants(b, me, x.seq).slice(1)) keep.push({ seq: v, s: x.s, payVariant: true });
    }
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
      belief = { seen, post: BELIEF.posterior(seen, { pool: !!o.bpool, ...(real ? { exclude: d => BELIEF.sameList(d, real) } : {}) }) };
      ctx.belief = belief.post.slice(0, 3).map(x => ({ deck: x.deck.name || x.deck, p: x.w }));
    }
    // a world = one re-deal of everything hidden; world i is shared by every move (paired comparison)
    const worlds = [];
    const world = i => (worlds[i] ||= determinize(b, me, mulberry(seed + i), belief));
    const stats = new Map(keep.map(x => [x.seq, { total: 0, ok: 0, n: 0, held: 0 }]));
    const alt = o.alt && b.active_player === me;
    const run = (seq, from, to) => {
      const st = stats.get(seq);
      for (let i = from; i < to; i++) {
        st.n++;
        const r = policy.tryApply(world(i), wf, seq);
        if (!r) continue;
        st.ok++;
        st.total += score(playout(r.board, r.waitingFor, me, mulberry(seed + 5000 + i)), me);
        if (alt) st.held += score(playout(r.board, r.waitingFor, me, mulberry(seed + 5000 + i), true), me);
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
      const hold = alt && st.ok && st.held > st.total;   // alt=1: the better of 'then greedy' / 'then no more attacks'
      if (st.ok) options.push({ seq, ...(hold ? { hold: true } : {}), ...(alt && st.ok ? { vg: st.total / st.ok, vh: st.held / st.ok } : {}), value: (hold ? st.held : st.total) / st.ok + (o.pb && lastLogp ? o.pb * Math.max(-10, lastLogp.get(seq) ?? -10) : 0), n: st.ok });
    }
    options.sort((x, y) => y.value - x.value);
    if (o.tb && options.length > 1 && wf.step === 'main_phase') {   // near-ties: attack after the other moves
      const top = options[0].value, near = options.filter(x => top - x.value < 0.003 && x.seq[x.seq.length - 1].step !== 'end_turn');
      const first = near.find(x => noAttack(x.seq));
      if (first && first !== options[0]) { options.splice(options.indexOf(first), 1); options.unshift(first); }
    }
    // payment variants are real options: listed after the ranked moves so training records see them
    ctx.lastSearch = { ranked: [...R.map(x => x.seq), ...keep.filter(x => x.payVariant).map(x => x.seq)], shortlist: shortlist.map(x => x.seq), options };
    return { seq: options[0]?.seq || R[0].seq, options };
  }

  function act(b, wf, me, ctx) {
    if (wf.step === 'mulligan_decision' && o.mull !== 1) return E.chooseMove(wf, b, { ...pol, rng: ctx.rng, mull: o.mull });
    const r = search(b, wf, me, ctx);
    ctx.last = r.options;   // for UIs / explanations: every option tried and its mean score
    return r.seq || E.chooseMove(wf, b, { ...pol, rng: ctx.rng }) || (defaultPassAction(wf) ? [defaultPassAction(wf)] : null);
  }

  // Replay review (src/coach/review.js): score this decision's shortlist AND extra `paths` (a path is
  // a list of seqs - the player's real move with its follow-up prompts) on the SAME worlds, so the
  // player's move and the bot's options are a paired comparison. Each world's leaf board is reported
  // too (`ends`), for "what happened next" stats. An empty path scores the position as it stands.
  function analyse(b, wf, me, paths = [], a = {}) {
    const rng = a.rng || mulberry(1), deals = a.deals || o.deals;
    const R = ranked(hideOwnLegends(b, me, rng), wf, me);
    const keep = R.slice(0, a.k || o.k);
    if (prior && R.length > 1) for (const x of prior(b, wf, me, R).slice(0, o.kn)) if (!keep.includes(x)) keep.push(x);
    const end = R.find(x => x.seq[x.seq.length - 1].step === 'end_turn');
    if (end && !keep.includes(end)) keep.push(end);
    const seed = Math.floor(rng() * 1e9);
    let belief = null;
    if (o.belief) { const seen = BELIEF.shown(b, policy.opp(me)); belief = { seen, post: BELIEF.posterior(seen) }; }
    const worlds = [];
    const world = i => (worlds[i] ||= determinize(b, me, mulberry(seed + i), belief));
    // one world of one path: apply it, play out, record value / leaf / events at index i
    const runOne = (it, i) => {
      let cur = { board: world(i), waitingFor: wf }, ok = true;
      for (let j = 0; j < it.path.length; j++) {
        const r = policy.tryApply(cur.board, cur.waitingFor, it.path[j]);
        if (!r) { if (j === 0) ok = false; break; }
        cur = r;
      }
      if (!ok) { it.vals[i] = null; it.ends[i] = null; it.events[i] = null; return; }
      const { leaf, ev } = tracedPlayout(cur.board, cur.waitingFor, me, mulberry(seed + 5000 + i), a.reply);
      it.vals[i] = score(leaf, me); it.ends[i] = leaf; it.events[i] = ev;
    };
    // a.cands: score exactly these moves instead of the shortlist
    let list = a.cands ? a.cands.map(seq => ({ seq, rank: R.findIndex(x => JSON.stringify(x.seq) === JSON.stringify(seq)) }))
      : keep.map(x => ({ seq: x.seq, rank: R.indexOf(x) }));
    // a.skip: a move already scored as one of `paths` (the player's own) - don't play it out twice
    const skipKey = a.skip ? JSON.stringify(a.skip) : null;
    const skipRank = skipKey ? R.findIndex(x => JSON.stringify(x.seq) === skipKey) : -1;
    if (skipKey) list = list.filter(x => JSON.stringify(x.seq) !== skipKey);
    const mk = (path, extra) => ({ path, vals: new Array(deals).fill(null), ends: new Array(deals).fill(null), events: new Array(deals).fill(null), alive: true, ...extra });
    const cands = list.map(x => mk([x.seq], { seq: x.seq, greedyRank: x.rank }));
    const pathItems = paths.map(p => mk(p, { keep: true }));
    const all = [...cands, ...pathItems];
    // a.halve = N: every move plays N worlds first; a shortlisted move that trails the leader (and every
    // kept path) by more than a.cut on those same worlds stops there - only contenders get all `deals`
    const first = a.halve ? Math.min(a.halve, deals) : deals;
    for (let i = 0; i < first; i++) for (const it of all) runOne(it, i);
    if (first < deals) {
      const pm = (x, y) => { let s = 0, n = 0; for (let i = 0; i < first; i++) if (x.vals[i] !== null && y.vals[i] !== null) { s += x.vals[i] - y.vals[i]; n++; } return n ? s / n : 0; };
      const mean = x => { const v = x.vals.slice(0, first).filter(z => z !== null); return v.length ? v.reduce((p, q) => p + q, 0) / v.length : -1; };
      const lead = all.reduce((p, q) => (mean(q) > mean(p) ? q : p), all[0]);
      for (const it of cands) if (it !== lead && pm(it, lead) < -a.cut && pathItems.every(p => pm(it, p) < -a.cut)) it.alive = false;
      for (let i = first; i < deals; i++) for (const it of all) if (it.alive) runOne(it, i);
    }
    const out = it => ({ vals: it.vals, ends: it.ends, events: it.events, dropped: !it.alive });
    return {
      ranked: R.length, skipRank,
      cands: cands.map(it => ({ seq: it.seq, greedyRank: it.greedyRank, ...out(it) })),
      paths: pathItems.map(out),
    };
  }

  // playout() for the review: same stop rule (the start of my next turn), but every decision - the rest
  // of my turn and the Rival's whole reply - can come from `reply(b, wf, pid, rng)` (the same strong bot
  // for both sides; greedy where it has nothing), and it records what the Rival
  // did: attacks (attacker -> target), which of my Units / Legends' Gear were defeated, Gigs I lost.
  const short = n => String(policy.nm(n)).split(':')[0];
  function tracedPlayout(b, wf, me, rng, reply) {
    const rv = policy.opp(me), turn = b.turn_number;
    let last = b.turn_number, pre = null, post = null;
    const ev = { attacks: [], lost: [], gigsLost: 0, myAttacks: [] };
    const nameAt = (bb, iid) => { for (const p of ['p1', 'p2']) for (const z of ['field', 'legends']) { const u = bb[p].zones[z].find(x => x.iid === iid); if (u) return short(u.card_id); } return '?'; };
    for (let i = 0; i < 1500 && wf && !b.winner; i++) {
      if (b.active_player === me && b.turn_number !== last && wf.step === 'main_phase') break;
      if (!pre && b.active_player === rv) pre = { field: b[me].zones.field.map(u => [u.iid, short(u.card_id)]), gigs: b[me].zones.gigs.length };
      if (pre && !post && b.active_player === me) post = { field: new Set(b[me].zones.field.map(u => u.iid)), gigs: b[me].zones.gigs.length };
      const owner = wf.owner || b.active_player;
      let r = null;
      if (reply) {
        let seq = null;
        try { seq = reply(b, wf, rv, rng); } catch { seq = null; }
        r = seq && policy.tryApply(b, wf, seq);
        if (r) r.seq = seq;
      }
      if (!r) r = E.botStep(b, wf, { ...pol, rng });
      if (!r) break;
      for (const x of r.seq || []) if (x.step === 'declare_attack') {
        const rec = { by: nameAt(b, x.attacker_iid), to: x.target.kind === 'gigs' ? 'Gigs' : nameAt(b, x.target.iid) };
        (b.active_player === rv ? ev.attacks : b.turn_number === turn ? ev.myAttacks : []).push(rec);
      }
      b = r.board; wf = r.waitingFor;
    }
    if (pre) {
      const after = post || { field: new Set(b[me].zones.field.map(u => u.iid)), gigs: b[me].zones.gigs.length };
      ev.lost = pre.field.filter(([iid]) => !after.field.has(iid)).map(([, n]) => n);
      ev.gigsLost = Math.max(0, pre.gigs - after.gigs);
    }
    ev.won = b.winner ? b.winner === me : null;
    return { leaf: b, ev };
  }

  const tag = Object.entries(opts).map(([k, v]) => `${k}=${v}`).join(',');
  return { name: tag ? `strong(${tag})` : 'strong', act, analyse };
}

module.exports = { make, determinize, hideOwnLegends, DEFAULTS };
