// Bot-vs-bot games for measuring bot strength (the "is the new bot better?" gate).
//
// A bot is { name, act(b, wf, pid, ctx) -> action[] | null }, where the actions are one macro move
// (see coach/policy.js `moves`). `ctx` carries a per-game rng and timing counters.
//
// Matches are played in pairs: same seed, same deck per seat, same first player, bots swapped.
// Deck strength, seat and the opening deal cancel out, so the pair score measures the bots only.
'use strict';
const fs = require('fs');
const path = require('path');
const { setupGame, step, defaultPassAction } = require('../engine');
const { parseTxt } = require('../engine/test/decks');
const { tryApply, moves } = require('../coach/policy');
const { mulberry } = require('../coach/bridge');

const ROOT = path.join(__dirname, '..', '..');
const DECK_DIRS = [path.join(ROOT, 'board', 'meta-decks'), path.join(ROOT, 'src', 'engine', 'test', 'decks')];
// training data also uses the generated coverage decks (scripts/coverage-decks.js), so the nets see
// every legal card; strength is still measured on the real lists only
const TRAIN_DIRS = [...DECK_DIRS, path.join(ROOT, 'src', 'bot', 'train-decks')];

function loadDecks(dirs = DECK_DIRS) {
  const out = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).filter(f => f.endsWith('.txt')).sort()) {
      const deck = parseTxt(path.join(d, f));
      if (deck.legends.length === 3 && !deck.unknown.length) out.push(deck);
    }
  }
  return out;
}

// Plays one game. bots = { p1, p2 }. Returns { winner, turns, ms: {p1, p2}, moves: {p1, p2}, error }.
function playGame(bots, d1, d2, seed, first, opts = {}) {
  const maxTurns = opts.maxTurns || 80;
  let res = step(setupGame(d1, d2, first, { seed }), undefined);
  let b = res.board, wf = res.waitingFor;
  b._trace = null;
  const ms = { p1: 0, p2: 0 }, n = { p1: 0, p2: 0 };
  const ctx = { p1: { rng: mulberry(seed * 2 + 1) }, p2: { rng: mulberry(seed * 2 + 2) } };
  let error = null;
  for (let i = 0; i < 8000 && wf && !b.winner && b.turn_number <= maxTurns; i++) {
    const pid = wf.owner || b.active_player;
    const t = process.hrtime.bigint();
    let seq = null;
    try { seq = bots[pid].act(b, wf, pid, ctx[pid]); } catch (e) { error ||= `${bots[pid].name}: ${e.message}`; }
    ms[pid] += Number(process.hrtime.bigint() - t) / 1e6; n[pid]++;
    let r = seq && tryApply(b, wf, seq);
    if (!r) { const d = defaultPassAction(wf); r = d && tryApply(b, wf, [d]); }
    if (!r) for (const m of moves(wf, b)) { r = tryApply(b, wf, m); if (r) break; }
    if (!r) { error ||= `stuck at ${wf.step}`; break; }
    b = r.board; wf = r.waitingFor;
    if (b._trace) b._trace = null;
  }
  return { winner: b.winner || null, turns: b.turn_number, ms, moves: n, error };
}

// Elo difference from a score fraction, with a 95% interval from per-pair scores.
function elo(score) { const s = Math.min(Math.max(score, 1e-4), 1 - 1e-4); return -400 * Math.log10(1 / s - 1); }
function summarize(pairScores) {
  const n = pairScores.length;
  const m = pairScores.reduce((a, x) => a + x, 0) / (n || 1);
  const sd = Math.sqrt(pairScores.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, n - 1));
  const half = 1.96 * sd / Math.sqrt(Math.max(1, n));
  return { pairs: n, score: m, lo: m - half, hi: m + half, elo: elo(m), eloLo: elo(m - half), eloHi: elo(m + half) };
}

module.exports = { loadDecks, playGame, summarize, elo, DECK_DIRS, TRAIN_DIRS };
