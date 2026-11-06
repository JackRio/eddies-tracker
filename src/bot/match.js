// Best-of-3 matches between two sides (pilots or field decks), the way the Tournament Rules run them:
//   - each game: both players roll a D20 (re-roll ties); the higher roller chooses to go first or second
//   - between games: each side may swap cards 1-for-1 with its sideboard (a pilot's learned plan);
//     every game starts from the registered deck + sideboard
//   - first to 2 game wins takes the match
// Bots decide on botView() (their honest view), never on the real board.
//
// side = { key, bot, deck: { legends, main, side }, choose(first?) , sideboard?(deck, oppKey, rng) }
// opts.teacher = { bot, rate }: on a sample of decisions that aren't already decided, a deeper search
// (more imagined games, more moves) re-scores the options; those records carry its values instead and
// teach: 1 (the policy net trains on teacher records; 'mistake' = the teacher's best beat the move played
// by >= 3 points). The bot's own move is still the one played.
// opts.record: keep, per game, every searched decision in the policy-data format (scripts/train-*.py):
//   { pid, turn, step, s: [dense, sparse], c: [[menc, greedyRank, shortlisted, value|null]], pick }
'use strict';
const { setupGame, step, defaultPassAction } = require('../engine');
const { tryApply, moves } = require('../coach/policy');
const { mulberry } = require('../coach/bridge');
const { botView } = require('./view');
const { deckDef } = require('./pilot');
const BELIEF = require('./belief');

let ENC = null;
const enc = () => (ENC ||= { encode: require('./vfeatures').encode, move: require('./menc').encodeMove });
const r3 = x => Math.round(x * 1000) / 1000;
// turn cap (user's rule, Nov 2026): 16 turns = 8 each; a game still going after that is a draw (half a
// game each). Only 0.1% of league games went past 16.
const MAX_TURNS = 16;
let DESC = null;
const say = (b, pid, seq, wf) => { try { return (DESC ||= require('./describe')).describe(b, pid, seq, wf.prompt); } catch { return seq.map(a => a.step).join(' + '); } };

// one game; sides = { p1, p2 }; returns { winner: 'p1'|'p2'|null, turns, recs, seen: { p1, p2 } }
function playGame(sides, decks, first, seed, opts = {}) {
  let res = step(setupGame(decks.p1, decks.p2, first, { seed }), undefined);
  let b = res.board, wf = res.waitingFor;
  b._trace = null;
  const ctx = { p1: { rng: mulberry(seed * 2 + 1) }, p2: { rng: mulberry(seed * 2 + 2) } };
  const recs = [];
  const trng = mulberry(seed * 5 + 11);
  let lastTurn = -1;
  const actions = [];
  const nameOf = p => (sides.p1.key === sides.p2.key ? `${sides[p].key}-${p === 'p1' ? 'A' : 'B'}` : sides[p].key);
  let error = null;
  for (let i = 0; i < 8000 && wf && !b.winner && b.turn_number <= (opts.maxTurns || MAX_TURNS); i++) {
    const pid = wf.owner || b.active_player;
    const c = ctx[pid];
    c.lastSearch = null;
    let seq = null;
    try { seq = sides[pid].bot.act(botView(b, pid, c.rng), wf, pid, c); } catch (e) { error ||= e.message; }
    let r = seq && tryApply(b, wf, seq), applied = seq;
    if (!r) { seq = null; const d = defaultPassAction(wf); r = d && tryApply(b, wf, [d]); applied = d ? [d] : null; }
    if (!r) for (const m of moves(wf, b)) { r = tryApply(b, wf, m); if (r) { applied = m; break; } }
    if (!r) { error ||= `stuck at ${wf.step}`; break; }
    if (opts.record) actions.push(applied);   // full move list: any position can be rebuilt with the engine alone
    if (opts.log) {   // live log: one readable line per move (opts.log(text))
      if (b.turn_number !== lastTurn) { lastTurn = b.turn_number; opts.log(`-- Turn ${b.turn_number}: ${nameOf(b.active_player)}`); }
      const L0 = c.lastSearch, v = L0 && seq ? L0.options.find(o => o.seq === seq)?.value : null;
      const used = seq || [];
      if (used.length) opts.log(`  ${nameOf(pid)}: ${say(b, pid, used, wf)}${v != null ? `  (${Math.round(100 * v)}%)` : ''}`);
    }
    // a searched decision with a real choice -> one training record (from the acting side's view)
    const L = c.lastSearch;
    if (opts.record && sides[pid].record !== false && L && L.ranked.length >= 2 && L.options.length && seq) {
      let val = new Map(L.options.map(x => [x.seq, x.value])), teach = 0, mistake = 0;
      const sl = new Set(L.shortlist), x = enc().encode(b, pid);
      const vs = L.options.map(o => o.value), best = Math.max(...vs);
      // teacher: only where there is something to learn (not decided, not a single real option)
      if (opts.teacher && best > 0.03 && best < 0.97 && trng() < opts.teacher.rate) {
        const tc = { rng: mulberry(seed * 31 + i) };
        try { opts.teacher.bot.act(botView(b, pid, tc.rng), wf, pid, tc); } catch { tc.lastSearch = null; }
        const T = tc.lastSearch;
        if (T && T.options.length >= 2) {
          // the teacher's values replace the bot's for the moves it tried (by move text: seqs differ per search)
          const key = m => JSON.stringify(m);
          const tv = new Map(T.options.map(o => [key(o.seq), o.value]));
          val = new Map(L.ranked.filter(m => tv.has(key(m))).map(m => [m, tv.get(key(m))]));
          teach = 1;
          const tBest = Math.max(...tv.values()), played = tv.get(key(seq));
          if (played != null && tBest - played >= 0.03) mistake = 1;
          for (const o of T.options) if (!L.ranked.some(m => key(m) === key(o.seq))) { /* a move outside the ranking: rare, skip */ }
        }
      }
      recs.push({ pid, turn: b.turn_number, step: wf.step, s: [x.dense.map(r3), x.sparse],
        c: L.ranked.map((m, k) => [enc().move(b, pid, m), k, sl.has(m) ? 1 : 0, val.has(m) ? r3(val.get(m)) : null]), pick: L.ranked.indexOf(seq),
        ...(teach ? { teach, mistake } : {}) });
    }
    b = r.board; wf = r.waitingFor; b._trace = null;
  }
  // what each player showed face up (the other side's sideboarding may use it)
  const seen = { p1: [...BELIEF.shown(b, 'p1').cards.keys()], p2: [...BELIEF.shown(b, 'p2').cards.keys()] };
  return { winner: b.winner || null, turns: b.turn_number, recs, seen, error, actions: opts.record ? actions : undefined };
}

// a Bo3 match; A plays as p1 in every game (seats don't matter: who goes first is the D20 + choice)
function playMatch(A, B, seed, opts = {}) {
  const rng = mulberry(seed * 7 + 3);
  const wins = { A: 0, B: 0 }, games = [];
  let deckA = A.deck, deckB = B.deck;
  const shownBy = { A: new Set(), B: new Set() };
  for (let g = 0; g < 3 && wins.A < 2 && wins.B < 2; g++) {
    // sideboarding for games 2 and 3 (each side sees what the other showed so far)
    let planA = null, planB = null;
    if (g > 0) {
      if (A.sideboard) { const s = A.sideboard(A.deck, B.key, rng, [...shownBy.B]); deckA = { ...A.deck, main: s.main, side: s.side }; planA = s.key; }
      if (B.sideboard) { const s = B.sideboard(B.deck, A.key, rng, [...shownBy.A]); deckB = { ...B.deck, main: s.main, side: s.side }; planB = s.key; }
    }
    // D20 roll-off, re-roll ties; the winner chooses
    let ra, rb;
    do { ra = 1 + Math.floor(rng() * 20); rb = 1 + Math.floor(rng() * 20); } while (ra === rb);
    const chooser = ra > rb ? 'A' : 'B';
    const chooserFirst = (chooser === 'A' ? A : B).choose(rng);
    const aFirst = chooser === 'A' ? chooserFirst : !chooserFirst;
    const gseed = seed * 13 + g * 1009 + 17;
    if (opts.log) opts.log(`
== Game ${g + 1}: D20 ${A.key} ${ra} - ${B.key} ${rb}, ${chooser === 'A' ? A.key : B.key} chooses; ${aFirst ? A.key : B.key} goes first`);
    const r = playGame({ p1: A, p2: B }, { p1: deckDef(A.deck.legends, deckA.main, A.key), p2: deckDef(B.deck.legends, deckB.main, B.key) }, aFirst ? 'p1' : 'p2', gseed, opts);
    const w = r.winner === 'p1' ? 'A' : r.winner === 'p2' ? 'B' : null;
    if (opts.log) opts.log(`== Game ${g + 1} winner: ${w ? (w === 'A' ? A.key : B.key) : 'none (turn cap)'}${r.error ? ` (error: ${r.error})` : ''}`);
    if (opts.onGame) opts.onGame({ g: g + 1, d20: [ra, rb], chooser, aFirst, winner: w, turns: r.turns, error: r.error });
    if (w) wins[w]++;
    else { wins.A += 0.5; wins.B += 0.5; }   // no winner by the turn cap: a half each (rare)
    for (const c of r.seen.p1) shownBy.A.add(c);
    for (const c of r.seen.p2) shownBy.B.add(c);
    games.push({ g: g + 1, d20: [ra, rb], chooser, aFirst, winner: w, turns: r.turns, planA, planB, recs: opts.record ? r.recs : undefined, actions: r.actions, decks: opts.record ? { p1: deckDef(A.deck.legends, deckA.main, A.key), p2: deckDef(B.deck.legends, deckB.main, B.key) } : undefined, first: aFirst ? 'p1' : 'p2', error: r.error, seed: gseed });
  }
  return { winner: wins.A > wins.B ? 'A' : wins.B > wins.A ? 'B' : null, score: [wins.A, wins.B], games };
}

module.exports = { playMatch, playGame };
