// Replay Coach: grade every turn of the reviewed player.
//
// For each of your turns there are two positions from the replay: A (after your Gig roll) and
// B (just before you ended the turn). The coach
//   1. lets the bot build a few different turn plans from A (one greedy, the rest with noise),
//   2. plays each plan, and your actual position B, forward `depth` turns `samples` times - each
//      sample a different deal of the hidden cards (Rival hand, deck orders) shared by every option,
//   3. compares the win rates. A plan that beats yours by a clear, consistent margin is a flag.
// Results are estimates from a simple bot; the report says so.
'use strict';
const path = require('path');
const { loadReplay, allStates, cardKnowledge } = require('./sim');
const { inferDeck } = require('./decks');
const { toBoard, signature, mulberry } = require('./bridge');
const { turnPositions } = require('./positions');
const { playTurn, replayPlan, rollout, describePlan, outcome } = require('./search');
const { evaluate } = require('./policy');
const { mainWaiting } = require('../engine/lib/combat');
const { cardByNumber } = require('./cards');
const { boardReasons, playoutReasons } = require('./explain');

// depth: turns per rollout after yours. 40 = play to the end; the position score is only a
// fallback for the rare game that runs longer (or a stuck rollout).
const DEFAULTS = { samples: 24, plans: 6, keep: 4, depth: 40, noise: 3, resolve: false };   // resolve: true/'fight' = greedy blocks after the fight; tested worse for one-ply greedy (Nov 8 2026)

function start(state, ctx, seed) {
  const { board } = toBoard(state, ctx, seed);
  const r = mainWaiting(structuredClone(board));
  return { board: r.board, waitingFor: r.waitingFor };
}

const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const se = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1) / a.length); };


function analyzeReplay(file, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const t0 = Date.now();
  const R = loadReplay(file);
  const states = allStates(R.json);
  const knowledge = cardKnowledge(states);
  const last = states[states.length - 1].state;
  const decks = {}, pidMap = {};
  for (const sid of Object.keys(last.players)) {
    decks[sid] = inferDeck(knowledge, sid, last.players[sid].deckName);
    pidMap[sid] = sid === 'player1' ? 'p1' : 'p2';
  }
  const ctx = { pidMap, knowledge, decks };
  const pid = pidMap[R.me];
  const turns = [];

  for (const T of turnPositions(states, R.me)) {
    if (!T.ended) continue;                       // the game ended (or was conceded) inside this turn
    if (o.onlyTurn && T.turn !== o.onlyTurn) continue;
    const A = states[T.a].state, B = states[T.b].state;

    // 1. candidate plans on one deal
    const base = start(A, ctx, 1);
    const plans = new Map();
    for (let k = 0; k < o.plans; k++) {
      const res = playTurn(base.board, base.waitingFor, pid, { rng: mulberry(1000 + k), noise: k === 0 ? 0 : o.noise + k, resolve: o.resolve });
      if (res.finished && !res.board.winner) continue;
      const sig = signature(res.board);
      if (!plans.has(sig)) plans.set(sig, { plan: res.plan, end: res.board, score: evaluate(res.board, pid) });
    }
    const cands = [...plans.values()].sort((x, y) => y.score - x.score).slice(0, o.keep);
    const actualSig = signature(start(B, ctx, 1).board);

    // 2. rollouts, one deal per sample shared by all options
    const actualR = [], candR = cands.map(() => []), diverged = cands.map(() => 0);
    for (let s = 1; s <= o.samples; s++) {
      const ro = { rng: mulberry(50000 + s), noise: 2, depth: o.depth, resolve: o.resolve };
      const b = start(B, ctx, s);
      actualR.push(rollout(b.board, b.waitingFor, pid, { ...ro, rng: mulberry(50000 + s) }));
      cands.forEach((c, i) => {
        const a = start(A, ctx, s);
        const r = replayPlan(a.board, a.waitingFor, pid, c.plan, { rng: mulberry(70000 + s), noise: 0, resolve: o.resolve });
        diverged[i] += r.diverged ? 1 : 0;
        candR[i].push(rollout(r.board, r.waitingFor, pid, { ...ro, rng: mulberry(50000 + s) }));
      });
    }

    // 3. compare
    const actualP = actualR.map(r => r.p);
    const actual = { p: mean(actualP), se: se(actualP) };
    const yourEnd = start(B, ctx, 1).board;
    const options = cands.map((c, i) => {
      const diffs = candR[i].map((r, s) => r.p - actualP[s]);
      return { idx: i, p: mean(candR[i].map(r => r.p)), se: se(candR[i].map(r => r.p)), gain: mean(diffs), gainSe: se(diffs),
        moves: describePlan(c.plan, pid), sameAsYours: signature(c.end) === actualSig,
        outcome: outcome(c.end, pid), divergedSamples: diverged[i] };
    }).sort((x, y) => y.p - x.p);
    const best = options[0];
    const actualOutcome = outcome(yourEnd, pid);
    let verdict = 'good';
    if (best && !best.sameAsYours && best.gain > 0.08 && best.gain > 2 * best.gainSe) verdict = best.gain > 0.18 ? 'blunder' : 'mistake';
    else if (best && !best.sameAsYours && best.gain > 0.04) verdict = 'inaccuracy';

    // 4. why: concrete board differences first, then what happened next in the playouts
    let why = [];
    if (best && verdict !== 'good') {
      why = [...boardReasons(yourEnd, cands[best.idx].end, base.board, pid), ...playoutReasons(actualR, candR[best.idx], pid)];
      if (!why.length) why = ["The end-of-turn boards look alike; the difference only shows over the rest of the game, so treat this one as a hint."];
    }

    turns.push({
      turn: T.turn, stepA: T.a, stepB: T.b,
      youDid: T.log, actual: { ...actual, outcome: actualOutcome },
      options: options.map(({ idx, ...o }) => o), verdict, why,
    });
  }

  const deckInfo = sid => ({ source: decks[sid].source, legends: decks[sid].legends.map(n => cardByNumber(n)?.name), seen: decks[sid].seen.cards.size + decks[sid].seen.legends.size });
  return {
    format: 'eddies-replay-coach', version: 1,
    replay: path.basename(file), matchId: R.json.match.matchId,
    me: R.me, you: R.labels[R.me], rival: R.labels[R.rival], result: R.json.match.result,
    decks: { you: deckInfo(R.me), rival: deckInfo(R.rival) },
    settings: o, seconds: Math.round((Date.now() - t0) / 1000),
    turns,
  };
}

module.exports = { analyzeReplay, DEFAULTS };
