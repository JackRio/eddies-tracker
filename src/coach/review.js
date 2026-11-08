// Game Review: grade every move you made on your own turns, chess-engine style.
//
// A "move" is everything between two calm positions of your turn in the replay (one play / sale /
// Call / attack with its prompts), plus ending the turn. For each move:
//   1. Find it in the engine: from the position before (C0), try every legal macro move and its
//      prompts until one lands on the position after (C1) - by visible cards, not hidden draws.
//   2. Bot A (strong bot, league r3 nets - the play page's Daemon) scores its own shortlist AND your move on the same imagined
//      deals of the hidden cards (Rival hand / both decks re-dealt from what a player could know):
//      apply the move, then Bot A plays BOTH sides (the rest of your turn, the Rival's reply); the value net says who
//      is winning at the start of your next turn. Paired, so the deals' luck cancels.
//   3. Loss = best option - your move (win-chance points) -> Great / Good / Okay / Misplay /
//      Mistake / Blunder. The "why" is built from the boards and those imagined replies (explainMove).
// Moves that can't be matched (a random effect rolled differently, a payment the bot never tries)
// are scored from the replay position after the move, unpaired, and flagged `matched: false`.
'use strict';
const path = require('path');
const { loadReplay, allStates, cardKnowledge } = require('./sim');
const { inferDeck } = require('./decks');
const { toBoard, isCalm, mulberry } = require('./bridge');
const { turnPositions } = require('./positions');
const { mainWaiting } = require('../engine/lib/combat');
const policy = require('./policy');
const { cardByNumber } = require('./cards');
const { describe } = require('../bot/describe');
const { explainMove } = require('./explain-move');

const BOT_SPEC = 'strong:vnet=src/bot/value-net-r3.json:pnet=src/bot/policy-net-r3.json:prior=mix:gb=1:alt=1:tb=1';   // = Daemon
// deals: re-dealt worlds per option; k: Bot A's greedy shortlist size (plus its policy-net picks and
// ending the turn). Every playout is Bot A on both sides, so this is the slow part.
// halve / cut: every option plays `halve` worlds first; one trailing the leader and your move by more
// than `cut` (win chance) on those worlds stops there - only contenders play all `deals`
const DEFAULTS = { deals: 10, k: 5, halve: 3, cut: 0.15 };
// loss thresholds in win-chance points (0-100)
const GRADES = [['good', 2], ['okay', 5], ['misplay', 10], ['mistake', 20], ['blunder', Infinity]];
// 1: greedy playouts; 2: greedy scan + Bot A verification; both out of date
const REVIEW_VERSION = 4;   // 3: Bot A plays every playout (no greedy scan); 4: r3 nets (current Bot A)
const ORDER = ['great', 'good', 'okay', 'misplay', 'mistake', 'blunder'];

let BOT = null;
const NETS = path.join(__dirname, '..', 'bot');
const NETOPTS = { vnet: path.join(NETS, 'value-net-r3.json'), pnet: path.join(NETS, 'policy-net-r3.json'), prior: 'mix', gb: 1, alt: 1, tb: 1 };   // = Daemon (keep in sync with BOT_SPEC)
const bot = () => (BOT ||= require('../bot/strong').make('strong', NETOPTS));
// the player inside verification playouts: Bot A at full strength (the play page's settings), deciding
// on what that side could know (botView), for you and the Rival alike
let PLAYER = null;
function player() {
  if (PLAYER) return PLAYER;
  const P = require('../bot/strong').make('strong', NETOPTS);
  const { botView } = require('../bot/view');
  return (PLAYER = (b, wf, p, rng) => (wf.step === 'mulligan_decision' ? null : P.act(botView(b, p, rng), wf, p, { rng })));
}

// ── replay → positions ──────────────────────────────────────────────────────
function prepare(file) {
  const R = loadReplay(file);
  const states = allStates(R.json);
  const knowledge = cardKnowledge(states);
  const last = states[states.length - 1].state;
  const decks = {}, pidMap = {};
  for (const sid of Object.keys(last.players)) {
    decks[sid] = inferDeck(knowledge, sid, last.players[sid].deckName);
    pidMap[sid] = sid === 'player1' ? 'p1' : 'p2';
  }
  return { R, states, ctx: { pidMap, knowledge, decks }, pid: pidMap[R.me] };
}

function boardAt(P, i, seed = 1) {
  const { board } = toBoard(P.states[i].state, P.ctx, seed);
  const r = mainWaiting(structuredClone(board));
  return { board: r.board, waitingFor: r.waitingFor };
}

// your moves in one turn: [{ from, to, log, end }] between calm states that changed something
function movesOfTurn(P, T) {
  const S = P.states, calm = [];
  const endIdx = S.findIndex((s, i) => i > T.a && s.action?.actorPlayerId === P.R.me && /^Ended the turn/.test(s.action.label || '')
    && S[i - 1].state.game.turnNumber === T.turn);
  const last = endIdx > 0 ? endIdx - 1 : T.b;
  for (let i = T.a; i <= last; i++) if (isCalm(S[i].state) && S[i].state.game.turnNumber === T.turn) calm.push(i);
  const logOf = (a, b) => { const out = []; for (let i = a + 1; i <= b; i++) for (const h of S[i].newLog) out.push(h.message); return out; };
  const moves = [];
  let from = calm[0];
  for (const c of calm.slice(1)) {
    const log = logOf(from, c);
    if (!log.length) continue;            // nothing happened (UI-only frames)
    moves.push({ from, to: c, log });
    from = c;
  }
  if (endIdx > 0) moves.push({ from, to: endIdx, log: ['Ended the turn.'], end: true });
  return moves;
}

// ── matching your move to engine moves ─────────────────────────────────────
const hiddenIid = iid => /^p[12][hd]\d+$/.test(String(iid));
function fingerprint(b, known) {
  const k = iid => known.has(iid);
  const side = p => {
    const Z = b[p].zones, tapped = new Set(b[p].tapped || []);
    const spent = x => (x.state === 'spent' || tapped.has(x.iid) ? '*' : '');
    return [
      'G' + Z.gigs.map(g => `${g.sides}:${g.value}`).sort().join(','),
      'F' + Z.field.map(u => u.iid + spent(u) + (u.equipped_gear || []).map(g => '+' + g.iid).sort().join('')).sort().join('|'),
      'L' + Z.legends.map(l => l.iid + (l.face === 'face_up' ? '^' : '') + (l.equipped_gear || []).map(g => '+' + g.iid).sort().join('')).sort().join('|'),
      'Ls' + Z.legends.filter(l => spent(l)).length, 'E' + Z.eddies.length, 'Es' + Z.eddies.filter(e => spent(e)).length,
      'H' + Z.hand.length + ':' + Z.hand.map(h => h.iid).filter(k).sort().join(','),
      'T' + Z.trash.length + ':' + Z.trash.map(h => h.iid).filter(k).sort().join(','),
      'D' + Z.deck.length,
    ].join(';');
  };
  return `${side('p1')} / ${side('p2')}`;
}
// the same without which resources paid (the bot pays automatically, you may have picked others)
const loose = f => f.replace(/;Ls\d+/g, '').replace(/;Es\d+/g, '');

function knownIids(b) {
  const s = new Set();
  for (const p of ['p1', 'p2']) for (const z of Object.values(b[p].zones)) if (Array.isArray(z)) for (const r of z) {
    if (r.iid && !hiddenIid(r.iid)) s.add(r.iid);
    for (const g of r.equipped_gear || []) s.add(g.iid);
  }
  return s;
}

// breadth-first over a main-phase move and its prompts until the turn is calm again
function matchMove(b0, wf0, target, pid, budget = 600) {
  const known = knownIids(b0);
  const want = fingerprint(target, known), wantLoose = loose(want);
  let queue = policy.moves(wf0, b0).filter(s => s[s.length - 1].step !== 'end_turn').map(seq => ({ path: [seq], b: b0, wf: wf0 }));
  let looseHit = null, n = 0;
  for (let depth = 0; depth < 8 && queue.length; depth++) {
    const next = [];
    for (const q of queue) {
      if (++n > budget) return looseHit;
      const r = policy.tryApply(q.b, q.wf, q.path[q.path.length - 1]);
      if (!r) continue;
      const calm = !r.waitingFor || r.board.winner || r.board.turn_number !== b0.turn_number || r.waitingFor.step === 'main_phase';
      if (calm) {
        const f = fingerprint(r.board, known);
        if (f === want) return { path: q.path, exact: true };
        if (!looseHit && loose(f) === wantLoose) looseHit = { path: q.path, exact: false };
        continue;
      }
      for (const seq of policy.moves(r.waitingFor, r.board)) next.push({ path: [...q.path, seq], b: r.board, wf: r.waitingFor });
    }
    queue = next;
  }
  return looseHit;
}

// ── scoring ─────────────────────────────────────────────────────────────────
const mean = v => { const x = v.filter(y => y !== null); return x.length ? x.reduce((a, c) => a + c, 0) / x.length : null; };
function pairedDiff(a, b) {
  const d = [];
  a.forEach((x, i) => { if (x !== null && b[i] !== null) d.push(x - b[i]); });
  if (d.length < 2) return { d: 0, se: 1 };
  const m = d.reduce((x, y) => x + y, 0) / d.length;
  const se = Math.sqrt(d.reduce((x, y) => x + (y - m) ** 2, 0) / (d.length - 1) / d.length);
  return { d: m, se };
}
const sameSeq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function grade(loss, se, yoursVsBest, onlyMove, botsFirst) {
  // great: clearly better than the bot's own first instinct (or the one good move among bad ones)
  if (onlyMove || (!botsFirst && yoursVsBest >= Math.max(4, 2 * se * 100))) return 'great';
  let g = GRADES.find(([, t]) => loss < t)[0];
  // a gap inside the noise drops one step (never below Okay)
  if (ORDER.indexOf(g) >= ORDER.indexOf('misplay') && loss < 2 * se * 100) g = ORDER[ORDER.indexOf(g) - 1];
  return g;
}

function reviewMove(P, m, opts) {
  const pid = P.pid, rng = mulberry(9000 + m.from);
  const A = boardAt(P, m.from, 1);
  const after = m.end ? null : boardAt(P, m.to, 1);
  const B = bot();
  let match = m.end ? { path: [[{ step: 'end_turn' }]], exact: true } : matchMove(A.board, A.waitingFor, after.board, pid);

  // Bot A's shortlist + your move, every one played out with Bot A on BOTH sides until your next turn,
  // on the same re-dealt worlds (your move is never played twice: `skip`)
  const forced = policy.moves(A.waitingFor, A.board).length <= 1;
  const reply = player();
  const res = forced ? { ranked: 1, skipRank: -1, cands: [], paths: [] }
    : B.analyse(A.board, A.waitingFor, pid, match ? [match.path] : [], { deals: opts.deals, k: opts.k, rng, reply, skip: match?.path[0], halve: opts.halve, cut: opts.cut });
  let yours = match && !forced ? res.paths[0] : null;
  if (!forced && (!yours || yours.vals.every(v => v === null))) {
    match = null;   // unmatched: score the replay's own position after the move (other worlds, not paired)
    yours = B.analyse(after.board, after.waitingFor, pid, [[]], { deals: opts.deals, rng: mulberry(9100 + m.from), cands: [], reply }).paths[0];
  }
  // dropped options (clearly behind after `halve` worlds) are listed, never the "better move"
  const cands = res.cands.map(c => ({ ...c, value: mean(c.vals) })).filter(c => c.value !== null && !c.dropped).sort((x, y) => y.value - x.value);
  const droppedC = res.cands.filter(c => c.dropped).map(c => ({ ...c, value: mean(c.vals) })).filter(c => c.value !== null);
  const yv = yours ? mean(yours.vals) : 0.5;
  const best = cands[0] || null;
  const loss = best ? Math.max(0, (best.value - yv) * 100) : 0;
  const pd = best ? pairedDiff(best.vals, yours.vals) : { d: 0, se: 0 };
  const se = match ? pd.se : Math.max(0.05, pd.se);
  const yoursVsBest = best ? (yv - best.value) * 100 : 0;
  const onlyMove = best && cands.length >= 2 && yoursVsBest >= 10 && yoursVsBest > 2 * se * 100;
  const botsFirst = res.skipRank === 0;
  const g = forced ? 'good' : grade(loss, se, yoursVsBest, onlyMove, botsFirst);
  const verified = !forced;

  const say = seq => describe(A.board, pid, seq, A.waitingFor.choice_needed);
  const opt = c => ({ text: say(c.seq), p: Math.round(c.value * 1000) / 10, seq: c.seq });
  const out = {
    from: m.from, to: m.to, end: !!m.end, log: m.log, grade: g, forced, verified,
    matched: match ? (match.exact ? 'exact' : 'loose') : null,
    you: { text: match ? match.path.map((s, j) => (j ? '  ' : '') + say(s)).join(' / ') : null, p: Math.round(yv * 1000) / 10 },
    best: best && loss >= 0.5 ? opt(best) : null,
    loss: Math.round(loss * 10) / 10, se: Math.round(se * 1000) / 10,
    options: [...cands, ...droppedC, { seq: match?.path[0], value: yv, yoursRow: true }].filter(c => c.seq)
      .sort((x, y) => y.value - x.value).slice(0, 8).map(c => ({ ...opt(c), yours: !!c.yoursRow })),
  };
  if (!forced && best && (g === 'great' || loss >= 0.5)) out.why = explainMove({ A, pid, yours, best, match, g, say, n: opts.vdeals });
  out.options.forEach(o => delete o.seq);
  return out;
}

// ── a whole game ────────────────────────────────────────────────────────────
function turnsOf(P) {
  return turnPositions(P.states, P.R.me).filter(T => T.a !== null).map(T => ({ T, moves: movesOfTurn(P, T) })).filter(x => x.moves.length);
}

function reviewTurn(P, x, opts = DEFAULTS) {
  const moves = x.moves.map(m => reviewMove(P, m, { ...DEFAULTS, ...opts }));
  return { turn: x.T.turn, stepA: x.T.a, moves };
}

function summary(turns) {
  const counts = Object.fromEntries(ORDER.map(k => [k, 0]));
  let loss = 0, n = 0;
  for (const t of turns) for (const m of t.moves) { if (m.forced) continue; counts[m.grade]++; loss += m.loss; n++; }
  // accuracy: 100 at no loss, falling off with the average loss per move
  return { counts, moves: n, avgLoss: n ? Math.round(10 * loss / n) / 10 : 0, accuracy: n ? Math.round(100 * Math.exp(-(loss / n) / 8)) : 100 };
}

function meta(P, file) {
  const deckInfo = sid => ({ source: P.ctx.decks[sid].source, legends: P.ctx.decks[sid].legends.map(n => cardByNumber(n)?.name) });
  return { format: 'eddies-game-review', version: REVIEW_VERSION, replay: path.basename(file), matchId: P.R.json.match.matchId,
    me: P.R.me, you: P.R.labels[P.R.me], rival: P.R.labels[P.R.rival], result: P.R.json.match.result,
    decks: { you: deckInfo(P.R.me), rival: deckInfo(P.R.rival) }, bot: BOT_SPEC };
}

module.exports = { REVIEW_VERSION, prepare, turnsOf, reviewTurn, reviewMove, summary, meta, ORDER, DEFAULTS, matchMove, boardAt };
