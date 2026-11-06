// Bot-vs-bot arena: is bot A stronger than bot B?
//   node scripts/arena.js <botA> <botB> [--pairs N] [--workers N] [--decks meta|all|coverage] [--seed S] [--quiet]
// Bot specs: greedy, noisy, strong, or name:key=value:... (e.g. strong:plans=8:deals=6).
// Games are played in pairs (same seed, decks and seats, bots swapped), so deck strength and the
// opening deal cancel out. Prints A's score with a 95% interval and the Elo difference.
'use strict';
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

if (!isMainThread) {
  const { loadDecks, playGame, TRAIN_DIRS } = require('../src/bot/arena');
  const { makeBot } = require('../src/bot/bots');
  const { specA, specB, deckSet } = workerData;
  const decks = deckSet === 'coverage' ? loadDecks(TRAIN_DIRS).filter(d => d.name.startsWith('coverage')) : loadDecks().filter(d => deckSet === 'all' || d.name.startsWith('choombattler'));
  const A = makeBot(specA), B = makeBot(specB);
  parentPort.on('message', job => {
    if (!job) return process.exit(0);
    const d1 = decks[job.i], d2 = decks[job.j];
    const g1 = playGame({ p1: A, p2: B }, d1, d2, job.seed, job.first);
    const g2 = playGame({ p1: B, p2: A }, d1, d2, job.seed, job.first);
    parentPort.postMessage({ job, g1, g2 });
  });
  parentPort.postMessage({ ready: true });
  return;
}

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const [specA = 'greedy', specB = 'greedy'] = pos;
const pairs = +flag('--pairs', 64);
const workers = Math.min(+flag('--workers', Math.max(1, os.cpus().length - 1)), pairs);
const deckSet = flag('--decks', 'meta');
const seed0 = +flag('--seed', 1);
const quiet = args.includes('--quiet');

const { loadDecks, summarize, TRAIN_DIRS } = require('../src/bot/arena');
const decks = deckSet === 'coverage' ? loadDecks(TRAIN_DIRS).filter(d => d.name.startsWith('coverage')) : loadDecks().filter(d => deckSet === 'all' || d.name.startsWith('choombattler'));
const jobs = [];
for (let k = 0; k < pairs; k++) {
  const i = k % decks.length, j = (k + 1 + Math.floor(k / decks.length)) % decks.length;
  jobs.push({ k, i, j, seed: seed0 + k * 7919, first: k % 2 ? 'p2' : 'p1' });
}

const t0 = Date.now();
const results = [];
let next = 0, done = 0;
const msA = { t: 0, n: 0 }, msB = { t: 0, n: 0 };
const errors = new Map();
console.log(`${specA} vs ${specB}: ${pairs} pairs (${pairs * 2} games), ${decks.length} decks, ${workers} workers`);

for (let w = 0; w < workers; w++) {
  const worker = new Worker(__filename, { workerData: { specA, specB, deckSet } });
  const feed = () => worker.postMessage(next < jobs.length ? jobs[next++] : null);
  worker.on('message', m => {
    if (m.ready) return feed();
    const { job, g1, g2 } = m;
    // A is p1 in g1, p2 in g2
    const s = (g1.winner === 'p1' ? 1 : g1.winner ? 0 : 0.5) + (g2.winner === 'p2' ? 1 : g2.winner ? 0 : 0.5);
    results.push({ job, score: s / 2, turns: (g1.turns + g2.turns) / 2 });
    msA.t += g1.ms.p1 + g2.ms.p2; msA.n += g1.moves.p1 + g2.moves.p2;
    msB.t += g1.ms.p2 + g2.ms.p1; msB.n += g1.moves.p2 + g2.moves.p1;
    for (const g of [g1, g2]) if (g.error) errors.set(g.error, (errors.get(g.error) || 0) + 1);
    done++;
    if (!quiet && (done % Math.max(1, Math.floor(pairs / 8)) === 0 || done === pairs)) {
      const S = summarize(results.map(r => r.score));
      console.log(`  ${done}/${pairs}  score ${(100 * S.score).toFixed(1)}%  Elo ${S.elo.toFixed(0)}  (${Math.round((Date.now() - t0) / 1000)}s)`);
    }
    feed();
  });
  worker.on('error', e => { console.error(e); process.exit(1); });
}

process.on('exit', () => {
  if (done < pairs) return;
  const S = summarize(results.map(r => r.score));
  const f = x => x.toFixed(0);
  console.log(`\n${specA} vs ${specB}: score ${(100 * S.score).toFixed(1)}% [${(100 * S.lo).toFixed(1)}, ${(100 * S.hi).toFixed(1)}]  Elo ${f(S.elo)} [${f(S.eloLo)}, ${f(S.eloHi)}]`);
  console.log(`  avg turns ${(results.reduce((a, r) => a + r.turns, 0) / results.length).toFixed(1)}  |  ms/decision: A ${(msA.t / msA.n).toFixed(1)}, B ${(msB.t / msB.n).toFixed(1)}  |  ${Math.round((Date.now() - t0) / 1000)}s`);
  const per = new Map();
  for (const r of results) { const k = decks[r.job.i].name.replace(/^choombattler-|\.txt$/g, ''); const e = per.get(k) || []; e.push(r.score); per.set(k, e); }
  if (!quiet) console.log('  A score by A\'s seat-1 deck: ' + [...per].map(([k, v]) => `${k} ${Math.round(100 * v.reduce((a, x) => a + x, 0) / v.length)}%`).join(', '));
  if (errors.size) console.log('  errors: ' + [...errors].map(([k, v]) => `${v}x ${k}`).join('; '));
});
