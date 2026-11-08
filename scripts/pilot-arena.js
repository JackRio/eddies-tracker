// Is bot spec A better than bot spec B at Bo3 with the pilots' decks? (the gate before keeping new nets)
//   node scripts/pilot-arena.js <specA> <specB> [--pairs N] [--workers N] [--seed S] [--field] [--pool] [--seq [--min 30]]
// Every pair = the same two decks and seeds played twice with the bots swapped (A pilots deck X vs B
// on deck Y, then B on X vs A on Y), so deck strength and luck cancel. Decks: the four pilots'
// champion lists (src/bot/pilots/state, else the ChoomBattler seed); --field adds the ChoomBattler
// field lists as opponents. Both sides sideboard with the pilots' learned plans; field decks don't.
// Prints A's match score and game score with 95% intervals and Elo.
'use strict';
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

if (!isMainThread) {
  const { playMatch } = require('../src/bot/match');
  const { makeBot } = require('../src/bot/bots');
  const P = require('../src/bot/pilot');
  const A = makeBot(workerData.specA), B = makeBot(workerData.specB);
  const side = (d, bot) => ({ key: d.key, bot, deck: d.deck,
    choose: rng => (d.state ? P.chooseFirst(d.state, 'arena', rng) : rng() < 0.6),
    sideboard: d.state && workerData.sideboard ? (deck, opp, rng) => P.chooseSideboard(d.state, deck, opp, rng) : null });   // on hold unless --sideboard
  parentPort.on('message', job => {
    if (!job) return process.exit(0);
    const m1 = playMatch(side(job.x, A), side(job.y, B), job.seed);   // A on X
    const m2 = playMatch(side(job.x, B), side(job.y, A), job.seed);   // B on X
    parentPort.postMessage({ job: { k: job.k, x: job.x.key, y: job.y.key }, m1: { w: m1.winner, s: m1.score }, m2: { w: m2.winner, s: m2.score } });
  });
  parentPort.postMessage({ ready: true });
  return;
}

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const [specA, specB] = pos;
const pairs = +flag('--pairs', 32), seed0 = +flag('--seed', 900000);
const workers = Math.min(+flag('--workers', Math.max(1, os.cpus().length - 1)), pairs);
const P = require('../src/bot/pilot');
const { summarize } = require('../src/bot/arena');

const decks = ['BBG', 'YYR', 'RRG', 'RGB'].map(id => { const st = P.load(id); return { key: id, deck: { legends: st.legends, main: st.champion.main, side: st.champion.side }, state: st }; });
if (args.includes('--field')) {
  const { loadDecks } = require('../src/bot/arena');
  for (const d of loadDecks().filter(d => d.name.startsWith('choombattler'))) {
    const main = {}; for (const { card_id, count } of d.cards) main[card_id] = (main[card_id] || 0) + count;
    decks.push({ key: d.name.replace(/\.txt$/, ''), deck: { legends: d.legends, main, side: {} }, state: null });
  }
}
// --pool: every pair is two random decks from the whole pool (field lists + netdeck community lists) instead
// of the pilots' - the general gate. Seeded, so two runs with the same --seed play the same decks.
let pool = null;
if (args.includes('--pool')) {
  const fs = require('fs');
  const { loadDecks, TRAIN_DIRS } = require('../src/bot/arena');
  const dirs = [...TRAIN_DIRS, path.join(__dirname, '..', 'src', 'bot', 'field-decks', 'netdeck')];
  pool = loadDecks(dirs).map(d => { const main = {}; for (const { card_id, count } of d.cards) main[card_id] = (main[card_id] || 0) + count; return { key: d.name.replace(/\.txt$/, ''), deck: { legends: d.legends, main, side: {} }, state: null }; });
}
const prng = require('../src/coach/bridge').mulberry(seed0 + 17);
const jobs = [];
for (let k = 0; k < pairs; k++) {
  let x, y;
  if (pool) { x = pool[Math.floor(prng() * pool.length)]; do { y = pool[Math.floor(prng() * pool.length)]; } while (y === x); }
  else { x = decks[k % 4]; y = decks[(k + 1 + Math.floor(k / 4)) % decks.length]; }
  jobs.push({ k, x, y, seed: seed0 + k * 104729 });
}
console.log(`${specA} vs ${specB}: ${pairs} pairs (${pairs * 2} Bo3 matches), ${pool ? `random decks from a pool of ${pool.length}` : `${decks.length} decks`}, ${workers} workers`);
// --seq: sequential test - after --min pairs (default 30), stop as soon as the 99% interval of the match score
// excludes 50% (a clear win or loss); otherwise play on up to --pairs. The stricter 99% bound pays for looking
// at the score after every pair. The final line still prints the 95% interval (what scripts/batch.js reads).
const SEQ = args.includes('--seq'), minPairs = +flag('--min', 30);
let stopped = false;
const all = [];
const t0 = Date.now(), mScores = [], gScores = [];
let next = 0, done = 0;
for (let w = 0; w < workers; w++) {
  const worker = new Worker(__filename, { workerData: { specA, specB, sideboard: args.includes('--sideboard') } });
  all.push(worker);
  const feed = () => worker.postMessage(next < jobs.length ? jobs[next++] : null);
  worker.on('message', msg => {
    if (msg.ready) return feed();
    if (stopped) return;
    const { m1, m2 } = msg;
    const mw = x => (x === 'A' ? 1 : x === 'B' ? 0 : 0.5);
    mScores.push((mw(m1.w) + (1 - mw(m2.w))) / 2);   // A won m1 as side A, and m2 as side B
    const g1 = m1.s[0] / (m1.s[0] + m1.s[1]), g2 = m2.s[1] / (m2.s[0] + m2.s[1]);
    gScores.push((g1 + g2) / 2);
    done++;
    if (done % Math.max(1, Math.floor(pairs / 4)) === 0 || done === pairs) {
      const S = summarize(mScores);
      console.log(`  ${done}/${pairs}  match score ${(100 * S.score).toFixed(1)}%  (${Math.round((Date.now() - t0) / 60000)} min)`);
    }
    if (SEQ && done >= minPairs && done < pairs) {
      const n = mScores.length, mean = mScores.reduce((a, x) => a + x, 0) / n;
      const se = Math.sqrt(mScores.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1) / n);
      if (Math.abs(mean - 0.5) > 2.576 * se) {
        stopped = true;
        console.log(`  stopped early after ${done} pairs: ${(100 * mean).toFixed(1)}% is clear at 99%`);
        for (const x of all) x.terminate();
        return;
      }
    }
    feed();
  });
}
process.on('exit', () => {
  if (done < pairs && !stopped) return;
  const S = summarize(mScores), G = summarize(gScores), f = x => x.toFixed(0);
  console.log(`\n${specA} vs ${specB}: matches ${(100 * S.score).toFixed(1)}% [${(100 * S.lo).toFixed(1)}, ${(100 * S.hi).toFixed(1)}]  Elo ${f(S.elo)} [${f(S.eloLo)}, ${f(S.eloHi)}]`);
  console.log(`  games ${(100 * G.score).toFixed(1)}% [${(100 * G.lo).toFixed(1)}, ${(100 * G.hi).toFixed(1)}]  |  ${Math.round((Date.now() - t0) / 60000)} min`);
});
