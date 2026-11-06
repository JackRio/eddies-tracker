// Self-play search records for training the policy ("intuition") net - expert iteration data.
//   node scripts/policy-data.js [--games N] [--bot spec] [--seed S] [--out file] [--workers N]
// Decks: meta + test + coverage decks (--meta-only to skip coverage). Both sides are the strong bot with exploration on (default strong:deals=4:k=5:explore=2). Every
// decision with a real choice becomes one record: the position from the acting player's side
// (vfeatures), every legal move (menc) with its greedy rank, whether it was on the shortlist, and the
// search's value for each move it tried. Games also carry the winner, so the same file can retrain
// the value net on strong-bot positions.
// Output: JSON lines, one game each: { g, winner, recs: [{ pid, turn, step, s, c: [[menc, greedyRank,
// shortlisted, value|null]], pick }] }.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

if (!isMainThread) {
  const { setupGame, step } = require('../src/engine');
  const { loadDecks, TRAIN_DIRS } = require('../src/bot/arena');
  const { tryApply } = require('../src/coach/policy');
  const { mulberry } = require('../src/coach/bridge');
  const { makeBot } = require('../src/bot/bots');
  const { encode } = require('../src/bot/vfeatures');
  const { encodeMove } = require('../src/bot/menc');
  const decks = loadDecks(workerData.meta ? undefined : TRAIN_DIRS);
  const bot = makeBot(workerData.bot);
  const r3 = x => Math.round(x * 1000) / 1000;
  parentPort.on('message', g => {
    if (g == null) return process.exit(0);
    const r = mulberry(g * 13 + 5);
    const d1 = decks[Math.floor(r() * decks.length)], d2 = decks[Math.floor(r() * decks.length)];
    let res = step(setupGame(d1, d2, r() < 0.5 ? 'p1' : 'p2', { seed: g }), undefined);
    let b = res.board, wf = res.waitingFor; b._trace = null;
    const ctx = { p1: { rng: mulberry(g * 2 + 1) }, p2: { rng: mulberry(g * 2 + 2) } }, recs = [];
    for (let i = 0; i < 6000 && wf && !b.winner && b.turn_number <= 60; i++) {
      const pid = wf.owner || b.active_player;
      ctx[pid].lastSearch = null;
      const seq = bot.act(b, wf, pid, ctx[pid]);
      const L = ctx[pid].lastSearch;
      if (L && L.ranked.length >= 2 && L.options.length) {
        const val = new Map(L.options.map(x => [x.seq, x.value]));
        const sl = new Set(L.shortlist);
        const x = encode(b, pid);
        recs.push({
          pid, turn: b.turn_number, step: wf.step,
          s: [x.dense.map(r3), x.sparse],
          c: L.ranked.map((m, k) => [encodeMove(b, pid, m), k, sl.has(m) ? 1 : 0, val.has(m) ? r3(val.get(m)) : null]),
          pick: L.ranked.indexOf(seq),
        });
      }
      const nx = seq && tryApply(b, wf, seq);
      if (!nx) break;
      b = nx.board; wf = nx.waitingFor; b._trace = null;
    }
    parentPort.postMessage({ g, winner: b.winner || null, recs });
  });
  parentPort.postMessage({ ready: true });
  return;
}

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const games = +flag('--games', 800), seed0 = +flag('--seed', 80000000);
const out = flag('--out', path.join(__dirname, '..', 'notes', 'policy-data.jsonl'));
const workers = +flag('--workers', Math.max(1, os.cpus().length - 1));
fs.mkdirSync(path.dirname(out), { recursive: true });
const ws = fs.createWriteStream(out, { flags: args.includes('--append') ? 'a' : 'w' });
let next = 0, done = 0, recs = 0;
const t0 = Date.now();
for (let w = 0; w < workers; w++) {
  const worker = new Worker(__filename, { workerData: { meta: args.includes('--meta-only'), bot: flag('--bot', 'strong:deals=4:k=5:explore=2') } });
  const feed = () => worker.postMessage(next < games ? seed0 + next++ : null);
  worker.on('message', m => {
    if (m.ready) return feed();
    done++; recs += m.recs.length;
    ws.write(JSON.stringify({ g: m.g, winner: m.winner, recs: m.recs }) + '\n');
    if (done % 20 === 0 || done === games) console.log(`${done}/${games} games, ${recs} decisions, ${Math.round((Date.now() - t0) / 1000)}s`);
    if (done === games) ws.end();
    feed();
  });
}
