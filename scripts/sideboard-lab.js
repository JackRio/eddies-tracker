// Sideboard lab: which sideboard swaps help a pilot against which opponent deck?
//   node scripts/sideboard-lab.js [--pilots BBG,YYR,RRG,RGB] [--games 24] [--keep 8] [--more 48]
//                                 [--bot greedyt] [--workers N] [--out notes/sideboard] [--seed S]
// For each pilot and each known opponent list (ChoomBattler + engine test lists - the deck guesser's
// candidates, so a pilot can map "what they showed" onto them), every legal 1-for-1 swap (a card from
// the sideboard in, a main-deck card out) is played on the SAME deals as the unchanged deck - paired
// games, so luck cancels and only the swap's effect shows: delta = win% with the swap - win% without.
// Successive halving: all candidates get --games paired games, the best --keep get --more.
// Seats and who goes first alternate. Output:
//   <out>/<PILOT>.json   { opp: [{ in, out, delta, se, n }] } sorted best first   (src/bot/pilot.js reads it)
//   <out>/rows.jsonl     one row per evaluated swap: { pilot, opp, oppCards, in, out, delta, se, n }
//                        - training data for the sideboard net (card-vs-card values)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

if (!isMainThread) {
  const { playGame } = require('../src/bot/arena');
  const { makeBot } = require('../src/bot/bots');
  const P = require('../src/bot/pilot');
  const bot = makeBot(workerData.bot);
  // job: { legends, main, swap: [out, in] | null, opp: deckDef, seeds: [..] } -> wins per seed (1/0/0.5)
  parentPort.on('message', job => {
    if (!job) return process.exit(0);
    let main = job.main;
    if (job.swap) { main = { ...main }; main[job.swap[0]]--; if (!main[job.swap[0]]) delete main[job.swap[0]]; main[job.swap[1]] = (main[job.swap[1]] || 0) + 1; }
    const me = P.deckDef(job.legends, main, 'pilot');
    const res = job.seeds.map((seed, i) => {
      const seat = i % 2 ? 'p2' : 'p1', first = (i >> 1) % 2 ? 'p2' : 'p1';
      const g = playGame({ p1: bot, p2: bot }, seat === 'p1' ? me : job.opp, seat === 'p1' ? job.opp : me, seed, first, { maxTurns: 40 });
      return g.winner === seat ? 1 : g.winner ? 0 : 0.5;
    });
    parentPort.postMessage({ id: job.id, res });
  });
  parentPort.postMessage({ ready: true });
  return;
}

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const pilotIds = flag('--pilots', 'BBG,YYR,RRG,RGB').split(',');
const G1 = +flag('--games', 24), KEEP = +flag('--keep', 8), G2 = +flag('--more', 48);
const botSpec = flag('--bot', 'greedyt');
const outDir = path.resolve(flag('--out', path.join(__dirname, '..', 'notes', 'sideboard')));
const seed0 = +flag('--seed', 4242);
const workers = +flag('--workers', Math.max(1, os.cpus().length - 1));
const onlyOpp = flag('--opp', null);   // test: only opponent lists whose name contains this
fs.mkdirSync(outDir, { recursive: true });

const P = require('../src/bot/pilot');
const { loadDecks } = require('../src/bot/arena');
const { deckIsIllegal } = require('../src/engine');
const opps = loadDecks().filter(d => !onlyOpp || d.name.includes(onlyOpp));   // = belief.js candidates (meta + test lists)
const { CARDS } = require('../src/engine');
const CARD = id => CARDS.find(c => c.number === id) || {};

// a pool of workers fed from one queue; run(jobs) resolves with results by id
const pool = [];
let queue = [], pending = new Map();
for (let w = 0; w < workers; w++) {
  const worker = new Worker(__filename, { workerData: { bot: botSpec } });
  const feed = () => { const j = queue.shift(); if (j) { worker.busy = true; worker.postMessage(j); } else worker.busy = false; };
  worker.on('message', m => { if (m.ready) return feed(); const p = pending.get(m.id); pending.delete(m.id); p(m.res); feed(); });
  worker.on('error', e => { console.error(e); process.exit(1); });
  worker.kick = feed;
  pool.push(worker);
}
let nextId = 1;
function run(job) { return new Promise(ok => { const id = nextId++; pending.set(id, ok); queue.push({ ...job, id }); for (const w of pool) if (!w.busy) { w.kick(); break; } }); }
const chunk = (seeds, n = 8) => { const out = []; for (let i = 0; i < seeds.length; i += n) out.push(seeds.slice(i, i + n)); return out; };
async function wins(job, seeds) { const parts = await Promise.all(chunk(seeds).map(s => run({ ...job, seeds: s }))); return parts.flat(); }

// paired difference stats
function paired(a, b) {
  const d = a.map((x, i) => x - b[i]), n = d.length, m = d.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, n - 1));
  return { delta: m, se: sd / Math.sqrt(n), n };
}

(async () => {
  const rowsOut = fs.createWriteStream(path.join(outDir, 'rows.jsonl'), { flags: 'a' });
  const t0 = Date.now();
  for (const id of pilotIds) {
    const st = P.load(id);
    const { main, side } = st.champion;
    const swaps = [];
    for (const inn of Object.keys(side)) for (const out of Object.keys(main)) {
      if (inn === out) continue;
      // sensible swaps only: the card going out shares a type with the one coming in, or costs within 1
      const ci = CARD(inn), co = CARD(out);
      if (!(ci.type === co.type || Math.abs((ci.cost || 0) - (co.cost || 0)) <= 1)) continue;
      const m2 = { ...main }; m2[out]--; if (!m2[out]) delete m2[out]; m2[inn] = (m2[inn] || 0) + 1;
      if (!deckIsIllegal(P.deckDef(st.legends, m2))) swaps.push([out, inn]);
    }
    const table = {};
    console.log(`${id}: ${swaps.length} legal swaps x ${opps.length} opponent lists`);
    for (const opp of opps) {
      const oppKey = opp.name.replace(/\.txt$/, '');
      const base = { legends: st.legends, main, opp };
      const seedsA = Array.from({ length: G1 }, (_, i) => seed0 + i * 7919);
      const seedsB = Array.from({ length: G2 }, (_, i) => seed0 + 1e6 + i * 7919);
      const baseA = await wins({ ...base, swap: null }, seedsA);
      const r1 = await Promise.all(swaps.map(async sw => ({ sw, w: await wins({ ...base, swap: sw }, seedsA) })));
      const s1 = r1.map(x => ({ sw: x.sw, ...paired(x.w, baseA) })).sort((a, b) => b.delta - a.delta);
      // the best few get a second, larger batch (fresh seeds), combined with the first
      const top = s1.slice(0, KEEP);
      const baseB = await wins({ ...base, swap: null }, seedsB);
      const r2 = await Promise.all(top.map(async x => ({ sw: x.sw, w: await wins({ ...base, swap: x.sw }, seedsB) })));
      const final = s1.map(x => {
        const more = r2.find(y => y.sw === x.sw);
        if (!more) return x;
        const wA = r1.find(y => y.sw === x.sw).w;
        return { sw: x.sw, ...paired([...wA, ...more.w], [...baseA, ...baseB]) };
      }).sort((a, b) => b.delta - a.delta);
      table[oppKey] = final.map(x => ({ in: x.sw[1], out: x.sw[0], delta: Math.round(x.delta * 1000) / 1000, se: Math.round(x.se * 1000) / 1000, n: x.n }));
      const oppCards = [...opp.legends, ...opp.cards.map(c => c.card_id)];
      for (const x of final) rowsOut.write(JSON.stringify({ pilot: id, opp: oppKey, oppCards, in: x.sw[1], out: x.sw[0], delta: x.delta, se: x.se, n: x.n }) + '\n');
      const b = final[0], baseWr = baseA.reduce((s, v) => s + v, 0) / baseA.length;
      console.log(`  vs ${oppKey.replace(/^choombattler-/, '').padEnd(28)} base ${(100 * baseWr).toFixed(0).padStart(3)}%  best +${P.cardName(b.sw[1]).split(':')[0]} -${P.cardName(b.sw[0]).split(':')[0]} ${(100 * b.delta >= 0 ? '+' : '')}${(100 * b.delta).toFixed(1)} ± ${(100 * b.se).toFixed(1)} pts (${b.n} pairs)  ${Math.round((Date.now() - t0) / 60000)} min`);
    }
    fs.writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify({ pilot: id, bot: botSpec, at: new Date().toISOString(), deck: st.champion, table }, null, 1));
  }
  rowsOut.end();
  for (const w of pool) w.postMessage(null);
})();
