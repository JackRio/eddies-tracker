// Leak test for botView(): a bot's view of the board must depend ONLY on what it may know.
//   node scripts/leak-test.js [--games 20] [--seed 1]
// Plays fast games (tuned greedy) on the four pilots' decks; at every decision it builds a second
// board that differs from the real one only in hidden facts the deciding player can't know:
//   - the opponent's hand, deck and face-down Eddies get different cards (reshuffled, plus one card
//     swapped for a card the opponent doesn't even own), and its face-down Legends swap places;
//   - the player's own deck is reordered and its own face-down Legends swap places.
// botView() of both boards with the same random seed must be identical. Any difference = a leak.
'use strict';
const { setupGame, step, defaultPassAction, CARDS } = require('../src/engine');
const { tryApply, moves } = require('../src/coach/policy');
const { mulberry } = require('../src/coach/bridge');
const { makeBot } = require('../src/bot/bots');
const { botView } = require('../src/bot/view');
const { cloneBoard } = require('../src/engine/lib/clone');
const P = require('../src/bot/pilot');

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const GAMES = +flag('--games', 20), SEED = +flag('--seed', 1);
const opp = p => (p === 'p1' ? 'p2' : 'p1');
const shuffle = (a, r) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const MAINS = CARDS.filter(c => c.type !== 'Legend' && c.legal !== false).map(c => c.number);

// a board with the same public facts and different hidden ones (from `me`'s point of view)
function scramble(b, me, r) {
  const d = cloneBoard(b), O = d[opp(me)].zones, M = d[me].zones;
  const hid = [...O.hand, ...O.deck, ...O.eddies.filter(e => !e.seen)];   // a card sold from hand was revealed
  const ids = shuffle(hid.map(c => c.card_id), r);
  if (ids.length) {
    const own = new Set(ids);
    const stranger = MAINS.find(n => !own.has(n));
    if (stranger) ids[Math.floor(r() * ids.length)] = stranger;
  }
  hid.forEach((c, i) => { c.card_id = ids[i]; });
  for (const Z of [O, M]) {
    const down = Z.legends.filter(l => l.face !== 'face_up');
    const lid = down.map(l => l.card_id);
    lid.push(lid.shift());   // rotate: every face-down Legend moves
    down.forEach((l, i) => { l.card_id = lid[i]; });
  }
  const mine = shuffle(M.deck.map(c => c.card_id), r);
  M.deck.forEach((c, i) => { c.card_id = mine[i]; });
  d._rngState = (b._rngState ^ 0x5bd1e995) | 0;   // the engine's own RNG state is hidden too
  return d;
}

const pilots = ['BBG', 'YYR', 'RRG', 'RGB'].map(id => { const st = P.load(id); return P.deckDef(st.legends, st.champion.main, id); });
const bot = makeBot('greedyt');
let checks = 0, leaks = 0;
for (let g = 0; g < GAMES; g++) {
  const seed = SEED + g * 7919, r = mulberry(seed);
  const d1 = pilots[g % 4], d2 = pilots[(g + 1 + (g >> 2)) % 4];
  let res = step(setupGame(d1, d2, g % 2 ? 'p2' : 'p1', { seed }), undefined), b = res.board, wf = res.waitingFor;
  b._trace = null;
  const ctx = { p1: { rng: mulberry(seed * 2 + 1) }, p2: { rng: mulberry(seed * 2 + 2) } };
  for (let i = 0; i < 3000 && wf && !b.winner && b.turn_number <= 16; i++) {
    const pid = wf.owner || b.active_player;
    const s = Math.floor(r() * 1e9);
    const a = JSON.stringify(botView(b, pid, mulberry(s)));
    const z = JSON.stringify(botView(scramble(b, pid, mulberry(s + 1)), pid, mulberry(s)));
    checks++;
    if (a !== z) {
      leaks++;
      if (leaks <= 3) {
        const A = JSON.parse(a), Z = JSON.parse(z);
        const diff = [];
        (function walk(x, y, p) {
          if (diff.length > 5) return;
          if (typeof x !== 'object' || x === null || typeof y !== 'object' || y === null) { if (x !== y) diff.push(`${p}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`); return; }
          for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], `${p}.${k}`);
        })(A, Z, '');
        console.log(`LEAK game ${g} turn ${b.turn_number} (${pid} deciding, ${wf.step}):\n  ` + diff.join('\n  '));
      }
    }
    let seq = null;
    try { seq = bot.act(botView(b, pid, ctx[pid].rng), wf, pid, ctx[pid]); } catch { /* */ }
    let nx = seq && tryApply(b, wf, seq);
    if (!nx) { const dp = defaultPassAction(wf); nx = dp && tryApply(b, wf, [dp]); }
    if (!nx) for (const m of moves(wf, b)) { nx = tryApply(b, wf, m); if (nx) break; }
    if (!nx) break;
    b = nx.board; wf = nx.waitingFor; b._trace = null;
  }
}
console.log(`${checks} decisions checked in ${GAMES} games: ${leaks ? `${leaks} LEAKS` : 'no leaks'}`);
process.exit(leaks ? 1 : 0);
