// Self-play data for fitting the bot's evaluation.
//   node scripts/bot-data.js [--games N] [--noise X] [--bot spec] [--out file] [--workers N]
// The first main-phase decision of every turn (the position the strong bot scores) becomes one row: features from the acting player's
// side + whether that player went on to win. Writes JSON lines (one game per line).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

if (!isMainThread) {
  const { setupGame, step } = require('../src/engine');
  const { loadDecks } = require('../src/bot/arena');
  const { makeBot } = require('../src/bot/bots');
  const { tryApply } = require('../src/coach/policy');
  const { mulberry } = require('../src/coach/bridge');
  const { features } = require('../src/bot/features');
  const { evaluate } = require('../src/coach/policy');
  const decks = loadDecks();
  const bot = makeBot(workerData.bot);
  parentPort.on('message', g => {
    if (g == null) return process.exit(0);
    const r = mulberry(g * 31 + 7);
    const d1 = decks[Math.floor(r() * decks.length)], d2 = decks[Math.floor(r() * decks.length)];
    let res = step(setupGame(d1, d2, r() < 0.5 ? 'p1' : 'p2', { seed: g + 100000 }), undefined);
    let b = res.board, wf = res.waitingFor; b._trace = null;
    const rows = [], seen = new Set(), ctx = { p1: { rng: mulberry(g * 2 + 1) }, p2: { rng: mulberry(g * 2 + 2) } };
    for (let i = 0; i < 8000 && wf && !b.winner && b.turn_number <= 80; i++) {
      const pid = wf.owner || b.active_player;
      if (wf.step === 'main_phase' && !seen.has(b.turn_number) && seen.add(b.turn_number)) rows.push([pid, features(b, pid), evaluate(b, pid)]);
      const seq = bot.act(b, wf, pid, { ...ctx[pid], noise: workerData.noise });
      const nx = seq && tryApply(b, wf, seq);
      if (!nx) break;
      b = nx.board; wf = nx.waitingFor; b._trace = null;
    }
    if (!b.winner) return parentPort.postMessage({ g, rows: null });
    parentPort.postMessage({ g, rows: rows.map(([pid, f, ev]) => [f, pid === b.winner ? 1 : 0, ev]) });
  });
  parentPort.postMessage({ ready: true });
  return;
}

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const games = +flag('--games', 2000);
const out = flag('--out', path.join(__dirname, '..', 'notes', 'bot-data.jsonl'));
const spec = flag('--bot', 'noisy');
const workers = +flag('--workers', Math.max(1, os.cpus().length - 1));
fs.mkdirSync(path.dirname(out), { recursive: true });
const ws = fs.createWriteStream(out);
let next = 0, done = 0, kept = 0;
const t0 = Date.now();
for (let w = 0; w < workers; w++) {
  const worker = new Worker(__filename, { workerData: { bot: spec, noise: +flag('--noise', 0) } });
  const feed = () => worker.postMessage(next < games ? next++ : null);
  worker.on('message', m => {
    if (m.ready) return feed();
    done++;
    if (m.rows) { kept++; ws.write(JSON.stringify({ g: m.g, rows: m.rows }) + '\n'); }
    if (done % 250 === 0 || done === games) console.log(`${done}/${games} games (${kept} finished) ${Math.round((Date.now() - t0) / 1000)}s`);
    if (done === games) ws.end();
    feed();
  });
}
