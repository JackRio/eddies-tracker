// Tune the greedy policy's position-score weights on win rate (SPSA).
//   node scripts/tune-greedy.js [--iters N] [--pairs N] [--from default|tuned] [--workers N]
// Each iteration nudges every weight up or down at random (+/- c, relative), plays the "+" set
// against the "-" set in paired games on fresh seeds, and moves the weights toward the winner.
// Writes src/bot/tuned-weights.json every 25 iterations. Validate with
//   node scripts/arena.js greedyt greedy --pairs 400
'use strict';
const fs = require('fs');
const os = require('os');
const { Worker, isMainThread, parentPort } = require('worker_threads');

if (!isMainThread) {
  const { loadDecks, playGame } = require('../src/bot/arena');
  const E = require('../src/bot/eval');
  const T = require('../src/bot/tuned');
  const decks = loadDecks().filter(d => d.name.startsWith('choombattler'));
  const bot = W => { const ev = T.makeEval(W); return { name: 'w', act: (b, wf, pid, ctx) => E.chooseMove(wf, b, { rng: ctx.rng, noise: 0, ev, sell: W.sell }) }; };
  parentPort.on('message', m => {
    if (!m) return process.exit(0);
    const A = bot(m.Wa), B = bot(m.Wb);
    const d1 = decks[m.i], d2 = decks[m.j];
    const g1 = playGame({ p1: A, p2: B }, d1, d2, m.seed, m.first, { maxTurns: 40 });
    const g2 = playGame({ p1: B, p2: A }, d1, d2, m.seed, m.first, { maxTurns: 40 });
    const s = (g1.winner === 'p1' ? 1 : g1.winner ? 0 : 0.5) + (g2.winner === 'p2' ? 1 : g2.winner ? 0 : 0.5);
    parentPort.postMessage({ id: m.id, s: s / 2 });
  });
  parentPort.postMessage({ ready: true });
  return;
}

const T = require('../src/bot/tuned');
const { mulberry } = require('../src/coach/bridge');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const iters = +flag('--iters', 400), pairs = +flag('--pairs', 32);
const nW = +flag('--workers', Math.max(1, os.cpus().length - 1));
let W = flag('--from', 'default') === 'tuned' ? (T.loadTuned() || { ...T.DEFAULT_W }) : { ...T.DEFAULT_W };
const rng = mulberry(+flag('--seed', 4242));
const A0 = 0.6, C0 = 0.2;

const pool = [], idle = [];
let pending = new Map();
function run(jobs) {
  return new Promise(resolve => {
    const res = new Array(jobs.length); let left = jobs.length, next = 0;
    const give = w => { if (next < jobs.length) { const id = next++; pending.set(id, v => { res[id] = v; if (--left === 0) resolve(res); give(w); }); w.postMessage({ ...jobs[id], id }); } else idle.push(w); };
    while (idle.length) give(idle.pop());
  });
}
function start() {
  return new Promise(ok => {
    let ready = 0;
    for (let k = 0; k < nW; k++) {
      const w = new Worker(__filename);
      w.on('message', m => { if (m.ready) { idle.push(w); if (++ready === nW) ok(); return; } const f = pending.get(m.id); pending.delete(m.id); f(m.s); });
      pool.push(w);
    }
  });
}
const save = (k, note) => fs.writeFileSync(T.FILE, JSON.stringify({ iterations: k, pairsPerIteration: pairs, note, weights: W }, null, 1));

(async () => {
  await start();
  const t0 = Date.now();
  let seedBase = 1e6, recent = [];
  for (let k = 1; k <= iters; k++) {
    const a = A0 / (1 + k / 50) ** 0.602, c = C0 / k ** 0.101;
    const D = {}, Wp = {}, Wm = {};
    for (const key of T.KEYS) {
      D[key] = rng() < 0.5 ? -1 : 1;
      const sc = Math.max(Math.abs(W[key]), 0.2) * c;
      Wp[key] = Math.max(0, W[key] + sc * D[key]); Wm[key] = Math.max(0, W[key] - sc * D[key]);
    }
    const jobs = [];
    for (let p = 0; p < pairs; p++) {
      const i = Math.floor(rng() * 8); let j = Math.floor(rng() * 7); if (j >= i) j++;
      jobs.push({ Wa: Wp, Wb: Wm, i, j, seed: seedBase++, first: rng() < 0.5 ? 'p1' : 'p2' });
    }
    const scores = await run(jobs);
    const r = scores.reduce((x, y) => x + y, 0) / scores.length - 0.5;
    recent.push(r); if (recent.length > 25) recent.shift();
    for (const key of T.KEYS) W[key] = Math.max(0, W[key] + a * r * D[key] * Math.max(Math.abs(W[key]), 0.2));
    if (k % 5 === 0) console.log(`iter ${k} r ${r.toFixed(3)} ${Math.round((Date.now() - t0) / 1000)}s`);
    if (k % 25 === 0 || k === iters) {
      save(k, 'SPSA on greedy-vs-greedy win rate');
      const drift = T.KEYS.map(key => `${key} ${W[key].toFixed(2)}`).join(' ');
      console.log(`iter ${k}/${iters}  mean|r| ${(recent.reduce((x, y) => x + Math.abs(y), 0) / recent.length).toFixed(3)}  ${Math.round((Date.now() - t0) / 1000)}s\n  ${drift}`);
    }
  }
  for (const w of pool) w.postMessage(null);
})();
