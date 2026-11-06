// Match quality: does a bot play sensible games? Checks every turn of bot-vs-itself games for the
// mistakes that make training data bad (found by reading logs: a bot that never sold, sat on 11 cards
// and passed turn after turn).
//   node scripts/match-quality.js <botSpec> [--games N] [--decks meta|all|coverage] [--seed S] [--workers N]
// Per player-turn, at the moment the player ends the turn:
//   no sale       - ended the turn without selling although they had a card that can be sold
//   idle turn     - did nothing all turn (no sell / play / call / attack / ability) although they could
//   left plays    - ended the turn with an affordable play, Legend call or attack still available
//   hoarding      - 9+ cards in hand at the end of their turn
// Also: average Eddies at the start of turn 6/7, Units played and attacks per game, game length,
// and how often the first player wins.
'use strict';
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

if (!isMainThread) {
  const { setupGame, step } = require('../src/engine');
  const { loadDecks, TRAIN_DIRS } = require('../src/bot/arena');
  const { makeBot } = require('../src/bot/bots');
  const { tryApply, moves, card } = require('../src/coach/policy');
  const { mulberry } = require('../src/coach/bridge');
  const all = workerData.decks === 'coverage' ? loadDecks(TRAIN_DIRS).filter(d => d.name.startsWith('coverage'))
    : loadDecks().filter(d => workerData.decks === 'all' || d.name.startsWith('choombattler'));
  const bot = makeBot(workerData.spec);
  const ACT = new Set(['sell_card', 'play_card', 'call_legend', 'play_legend_solo', 'declare_attack', 'activate_anytime_spend']);
  parentPort.on('message', g => {
    if (g == null) return process.exit(0);
    const r = mulberry(g * 17 + 3);
    const d1 = all[Math.floor(r() * all.length)], d2 = all[Math.floor(r() * all.length)];
    const first = r() < 0.5 ? 'p1' : 'p2';
    let res = step(setupGame(d1, d2, first, { seed: g }), undefined);
    let b = res.board, wf = res.waitingFor; b._trace = null;
    const ctx = { p1: { rng: mulberry(g * 2 + 1) }, p2: { rng: mulberry(g * 2 + 2) } };
    const S = { turns: 0, noSale: 0, idle: 0, leftPlays: 0, hoard: 0, units: 0, attacks: 0, eddiesT6: [], did: false };
    let turn = -1;
    for (let i = 0; i < 6000 && wf && !b.winner && b.turn_number <= 60; i++) {
      const pid = wf.owner || b.active_player;
      if (b.turn_number !== turn) {
        turn = b.turn_number; S.did = false;
        if (turn === 6 || turn === 7) S.eddiesT6.push(b[b.active_player].zones.eddies.length);
      }
      const seq = bot.act(b, wf, pid, ctx[pid]);
      const a = seq && seq[seq.length - 1];
      if (a && pid === b.active_player && wf.step === 'main_phase') {
        if (ACT.has(a.step)) S.did = true;
        if (a.step === 'play_card' && card(b[pid].zones.hand.find(h => h.iid === a.iid)?.card_id).type === 'Unit') S.units++;
        if (a.step === 'declare_attack') S.attacks++;
        if (a.step === 'end_turn') {
          const P = b[pid], Z = P.zones, opts = moves(wf, b);
          S.turns++;
          const canSell = !P.sold_card_this_turn && Z.hand.some(h => card(h.card_id).eddie);
          if (canSell) S.noSale++;
          const plays = opts.filter(m => ['play_card', 'call_legend', 'play_legend_solo', 'declare_attack'].includes(m[m.length - 1].step) && tryApply(b, wf, m));
          if (plays.length) S.leftPlays++;
          if (!S.did && (canSell || plays.length)) S.idle++;
          if (Z.hand.length >= 9) S.hoard++;
        }
      }
      const nx = seq && tryApply(b, wf, seq);
      if (!nx) break;
      b = nx.board; wf = nx.waitingFor; b._trace = null;
    }
    delete S.did;
    parentPort.postMessage({ g, S, winner: b.winner, first, turnsPlayed: b.turn_number });
  });
  parentPort.postMessage({ ready: true });
  return;
}

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const spec = args.find(a => !a.startsWith('--') && !/^\d+$/.test(a) && !['meta', 'all', 'coverage'].includes(a)) || 'greedyt';
const games = +flag('--games', 22), seed0 = +flag('--seed', 60000000), decks = flag('--decks', 'meta');
const nW = Math.min(games, +flag('--workers', Math.max(1, os.cpus().length - 1)));
const T = { games: 0, turns: 0, noSale: 0, idle: 0, leftPlays: 0, hoard: 0, units: 0, attacks: 0, eddiesT6: [], firstWins: 0, length: 0 };
let next = 0, done = 0;
const t0 = Date.now();
for (let w = 0; w < nW; w++) {
  const worker = new Worker(__filename, { workerData: { spec, decks } });
  const feed = () => worker.postMessage(next < games ? seed0 + next++ : null);
  worker.on('message', m => {
    if (m.ready) return feed();
    done++; T.games++;
    for (const k of ['turns', 'noSale', 'idle', 'leftPlays', 'hoard', 'units', 'attacks']) T[k] += m.S[k];
    T.eddiesT6.push(...m.S.eddiesT6);
    if (m.winner === m.first) T.firstWins++;
    T.length += m.turnsPlayed;
    if (done === games) report();
    feed();
  });
}
function report() {
  const pc = x => `${(100 * x / (T.turns || 1)).toFixed(0)}%`;
  const avg = a => (a.reduce((x, y) => x + y, 0) / (a.length || 1)).toFixed(1);
  console.log(`match quality: ${spec} vs itself, ${T.games} games on ${decks} decks (${Math.round((Date.now() - t0) / 1000)}s)`);
  console.log(`  turns ending with no sale (could sell)   ${pc(T.noSale)}`);
  console.log(`  idle turns (did nothing, had options)    ${pc(T.idle)}`);
  console.log(`  turns ending with affordable plays left  ${pc(T.leftPlays)}`);
  console.log(`  hoarding (9+ cards at end of turn)       ${pc(T.hoard)}`);
  console.log(`  Eddies at turn 6/7 start                 ${avg(T.eddiesT6)}`);
  console.log(`  per game: Units played ${(T.units / T.games).toFixed(1)}, attacks ${(T.attacks / T.games).toFixed(1)}, length ${(T.length / T.games).toFixed(1)} turns, first player won ${(100 * T.firstWins / T.games).toFixed(0)}%`);
}
