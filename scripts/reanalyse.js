// Reanalyse: refresh old league training data with a newer / deeper search, without playing new games.
//   node scripts/reanalyse.js <data-SEED.jsonl> --bot <spec that PLAYED those games>
//        [--by <search spec>] [--rate 1] [--workers N] [--games N] [--out file]
// Each recorded game is replayed exactly (same decks, seeds and bot; old shuffle mode, see
// EDDIES_LEGACY_SHUFFLE in strong.js) and checked against the record at every decision (same number of
// moves offered, same move picked); a game that drifts is dropped, never mislabelled. At each recorded
// decision that isn't already decided (best 3-97%), on a --rate share of them, the --by search
// re-scores the moves. The record keeps its position and moves; its values become the new search's,
// marked teach: 1 (the trainers treat them like teacher records) and re: 1, with `mistake` recomputed
// and v = the new search's best value (a value target, see league-to-value.js --mix).
// Output: data-SEED-re.jsonl next to the input (same format).
'use strict';
// games before Nov 6 2026 were played with board-order shuffles and no memory of sold cards: the replay
// runs in that legacy mode, the new search (--by) in the current one (BELIEF.legacy toggled per call)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const NEW_BY = 'strong:vnet=src/bot/value-net-r3.json:pnet=src/bot/policy-net-r3.json:prior=mix:deals=24:k=10';

if (!isMainThread) {
  const { setupGame, step, defaultPassAction } = require('../src/engine');
  const { tryApply, moves } = require('../src/coach/policy');
  const { mulberry } = require('../src/coach/bridge');
  const { makeBot } = require('../src/bot/bots');
  const { botView } = require('../src/bot/view');
  const P = require('../src/bot/pilot');
  const BELIEF = require('../src/bot/belief');
  const bot = makeBot(workerData.bot), by = makeBot(workerData.by);
  const add = (m, id, k) => { const r = { ...m }; r[id] = (r[id] || 0) + k; if (r[id] <= 0) delete r[id]; return r; };
  const applyPlan = (main, plan) => { if (!plan || plan === 'none') return main; for (const sw of plan.split(',')) { const [o, i] = sw.split('>'); main = add(add(main, o, -1), i, 1); } return main; };
  const key = q => JSON.stringify(q);
  const r3 = x => Math.round(x * 1000) / 1000;
  BELIEF.legacy.on = true;   // the replay itself: the old rules / shuffles, everywhere (engine included)
  parentPort.on('message', job => {
    if (!job) return process.exit(0);
    const { line, m, g } = job, recs = line.recs, rr = mulberry(g.seed * 41 + 7);
    const dA = P.deckDef(m.decks.A.legends, applyPlan(m.decks.A.main, g.planA), m.A), dB = P.deckDef(m.decks.B.legends, applyPlan(m.decks.B.main, g.planB), m.B);
    let res = step(setupGame(dA, dB, g.aFirst ? 'p1' : 'p2', { seed: g.seed }), undefined);
    let b = res.board, wf = res.waitingFor; b._trace = null;
    const ctx = { p1: { rng: mulberry(g.seed * 2 + 1) }, p2: { rng: mulberry(g.seed * 2 + 2) } };
    const out = [];
    let ri = 0, drift = null, redone = 0;
    for (let i = 0; i < 8000 && wf && !b.winner && b.turn_number <= 60 && !drift; i++) {
      const pid = wf.owner || b.active_player, c = ctx[pid];
      c.lastSearch = null;
      let seq = null;
      try { seq = bot.act(botView(b, pid, c.rng), wf, pid, c); } catch { /* */ }
      let r = seq && tryApply(b, wf, seq);
      if (!r) { seq = null; const d = defaultPassAction(wf); r = d && tryApply(b, wf, [d]); }
      if (!r) for (const mv of moves(wf, b)) { r = tryApply(b, wf, mv); if (r) break; }
      if (!r) { drift = 'stuck'; break; }
      const L = c.lastSearch;
      if (L && L.ranked.length >= 2 && L.options.length && seq) {
        const rec = recs[ri++];
        if (!rec) { drift = 'more decisions than recorded'; break; }
        if (rec.pid !== pid || rec.c.length !== L.ranked.length || rec.pick !== L.ranked.indexOf(seq)) { drift = `decision ${ri - 1} differs`; break; }
        const vals = rec.c.map(x => x[3]).filter(v => v != null), best = Math.max(...vals);
        let nr = rec;
        if (best > 0.03 && best < 0.97 && rr() < workerData.rate) {
          const tc = { rng: mulberry(g.seed * 37 + i) };
          BELIEF.legacy.on = false;   // the new search plays by today's rules
          try { by.act(botView(b, pid, tc.rng), wf, pid, tc); } catch { tc.lastSearch = null; }
          BELIEF.legacy.on = true;
          const T = tc.lastSearch;
          if (T && T.options.length >= 2) {
            const tv = new Map(T.options.map(o => [key(o.seq), o.value]));
            const c2 = rec.c.map((x, k) => [x[0], x[1], x[2], tv.has(key(L.ranked[k])) ? r3(tv.get(key(L.ranked[k]))) : null]);
            const tBest = Math.max(...tv.values()), played = tv.get(key(seq));
            nr = { ...rec, c: c2, teach: 1, re: 1, mistake: played != null && tBest - played >= 0.03 ? 1 : 0, v: r3(tBest) };
            redone++;
          }
        }
        out.push(nr);
      }
      b = r.board; wf = r.waitingFor; b._trace = null;
    }
    if (!drift && ri !== recs.length) drift = `replayed ${ri} of ${recs.length} decisions`;
    const won = b.winner === 'p1' ? 'A' : b.winner === 'p2' ? 'B' : null;
    if (!drift && won !== g.winner) drift = 'different winner';
    parentPort.postMessage({ id: job.id, drift, redone, line: drift ? null : { ...line, recs: out } });
  });
  parentPort.postMessage({ ready: true });
  return;
}

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const file = args.find(a => a.endsWith('.jsonl'));
const botSpec = flag('--bot', null), by = flag('--by', NEW_BY), rate = +flag('--rate', 1);
if (!file || !botSpec) { console.error('usage: reanalyse.js <data.jsonl> --bot <spec that played it> [--by spec] [--rate 1]'); process.exit(1); }
const out = flag('--out', file.replace(/\.jsonl$/, '-re.jsonl'));
// <data>.jsonl.skip next to the input: pass the data through unchanged (used to skip a round mid-pipeline)
if (fs.existsSync(file + '.skip')) { fs.copyFileSync(file, out); console.log(`reanalyse ${path.basename(file)}: skipped (${path.basename(file)}.skip), copied unchanged`); process.exit(0); }
const limit = +flag('--games', 1e9);
const workers = +flag('--workers', Math.max(1, os.cpus().length - 1));
const dir = path.dirname(file);
const matches = new Map();
for (const l of fs.readFileSync(path.join(dir, 'matches.jsonl'), 'utf8').split('\n')) {
  if (!l.trim()) continue;
  const m = JSON.parse(l);
  for (const g of m.games || []) matches.set(g.seed, { m, g });
}
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)).slice(0, limit);
const jobs = [];
for (const line of lines) { const x = matches.get(line.g); if (x) jobs.push({ id: jobs.length, line, m: x.m, g: x.g }); }
console.log(`reanalyse ${path.basename(file)}: ${jobs.length} games (${lines.length - jobs.length} without a match record), played by ${botSpec}, re-searched by ${by}, rate ${rate}, ${workers} workers`);
const ws = fs.createWriteStream(out);
const t0 = Date.now();
let next = 0, done = 0, kept = 0, redone = 0;
const drifts = {};
for (let w = 0; w < Math.min(workers, jobs.length); w++) {
  const worker = new Worker(__filename, { workerData: { bot: botSpec, by, rate } });
  const feed = () => worker.postMessage(next < jobs.length ? jobs[next++] : null);
  worker.on('message', msg => {
    if (msg.ready) return feed();
    done++;
    if (msg.drift) drifts[msg.drift.replace(/\d+/g, 'N')] = (drifts[msg.drift.replace(/\d+/g, 'N')] || 0) + 1;
    else { kept++; redone += msg.redone; ws.write(JSON.stringify(msg.line) + '\n'); }
    if (done % 25 === 0 || done === jobs.length) console.log(`  ${done}/${jobs.length} games, ${kept} replayed exactly, ${redone} decisions re-searched, ${Math.round((Date.now() - t0) / 60000)} min${Object.keys(drifts).length ? ' | dropped: ' + JSON.stringify(drifts) : ''}`);
    feed();
  });
  worker.on('error', e => { console.error(e); process.exit(1); });
}
process.on('exit', () => ws.end());
