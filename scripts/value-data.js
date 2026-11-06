// Self-play positions for training the value net (scripts/train-value.py).
//   node scripts/value-data.js [--games N] [--bot greedyt] [--noisy 0.25] [--eps 0.15] [--seed S] [--out file] [--workers N]
// --eps: share of decisions played as a random legal move (exploration; see the comment in the loop)
// Plays bot-vs-bot games on the meta + test decks and the coverage decks (src/bot/train-decks;
// --meta-only to skip them); the first
// main-phase decision of every turn (the position the strong bot scores) becomes one row, encoded
// from the acting player's side (src/bot/vfeatures.js), labelled with whether that player won.
// A share of games (--noisy) has both sides play with softmax noise, for more varied positions.
// Output: JSON lines, one game each: { g, rows: [[label, dense[], sparse[[i, n]...]], ...] }.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

if (!isMainThread) {
  const { setupGame, step } = require('../src/engine');
  const { loadDecks, TRAIN_DIRS } = require('../src/bot/arena');
  const { tryApply, moves } = require('../src/coach/policy');
  const { mulberry } = require('../src/coach/bridge');
  const E = require('../src/bot/eval');
  const T = require('../src/bot/tuned');
  const { encode } = require('../src/bot/vfeatures');
  const decks = loadDecks(workerData.meta ? undefined : TRAIN_DIRS);
  const W = workerData.bot === 'greedy' ? T.DEFAULT_W : (T.loadTuned() || T.DEFAULT_W);
  const ev = T.makeEval(W);
  parentPort.on('message', g => {
    if (g == null) return process.exit(0);
    const r = mulberry(g * 31 + 7);
    const d1 = decks[Math.floor(r() * decks.length)], d2 = decks[Math.floor(r() * decks.length)];
    const noise = r() < workerData.noisy ? 3 : 0;
    let res = step(setupGame(d1, d2, r() < 0.5 ? 'p1' : 'p2', { seed: g }), undefined);
    let b = res.board, wf = res.waitingFor; b._trace = null;
    const rows = [], seen = new Set(), rng = mulberry(g * 2 + 1);
    for (let i = 0; i < 8000 && wf && !b.winner && b.turn_number <= 60; i++) {
      const pid = wf.owner || b.active_player;
      if (wf.step === 'main_phase' && !seen.has(b.turn_number)) { seen.add(b.turn_number); rows.push([pid, encode(b, pid)]); }
      // exploration: with probability eps play a random legal move instead (skip a sale, hold a card,
      // odd attacks...), so the net sees what such choices lead to - without it the net never learned
      // what an Eddie is worth (everyone sells every turn, so Eddies just track the turn number)
      let nx = null;
      if (workerData.eps && rng() < workerData.eps) {
        const ms = moves(wf, b);
        for (let k = 0; k < 4 && !nx && ms.length; k++) nx = tryApply(b, wf, ms[Math.floor(rng() * ms.length)]);
      }
      nx ||= E.botStep(b, wf, { ev, sell: W.sell, noise, rng });
      if (!nx) break;
      b = nx.board; wf = nx.waitingFor; b._trace = null;
    }
    if (!b.winner) return parentPort.postMessage({ g, rows: null });
    parentPort.postMessage({ g, rows: rows.map(([pid, x]) => [pid === b.winner ? 1 : 0, x.dense.map(v => Math.round(v * 1000) / 1000), x.sparse]) });
  });
  parentPort.postMessage({ ready: true });
  return;
}

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const games = +flag('--games', 20000), seed0 = +flag('--seed', 50000000);
const out = flag('--out', path.join(__dirname, '..', 'notes', 'value-data.jsonl'));
const workers = +flag('--workers', Math.max(1, os.cpus().length - 1));
fs.mkdirSync(path.dirname(out), { recursive: true });
const ws = fs.createWriteStream(out);
let next = 0, done = 0, kept = 0, rows = 0;
const t0 = Date.now();
for (let w = 0; w < workers; w++) {
  const worker = new Worker(__filename, { workerData: { meta: args.includes('--meta-only'), bot: flag('--bot', 'greedyt'), noisy: +flag('--noisy', 0.25), eps: +flag('--eps', 0) } });
  const feed = () => worker.postMessage(next < games ? seed0 + next++ : null);
  worker.on('message', m => {
    if (m.ready) return feed();
    done++;
    if (m.rows) { kept++; rows += m.rows.length; ws.write(JSON.stringify({ g: m.g, rows: m.rows }) + '\n'); }
    if (done % 2000 === 0 || done === games) console.log(`${done}/${games} games, ${kept} finished, ${rows} positions, ${Math.round((Date.now() - t0) / 1000)}s`);
    if (done === games) ws.end();
    feed();
  });
}
