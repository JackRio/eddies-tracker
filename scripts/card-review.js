// Card review: which cards would this pilot most like to have in hand against this opponent?
//   node scripts/card-review.js [--pilots BBG,YYR,RRG,RGB] [--opps pilots|all] [--games 12]
//        [--positions 4] [--eval strong:deals=6:k=5] [--workers N] [--out notes/card-review] [--seed S]
// Plays games of each pilot against each opponent (fast tuned-greedy bots on both sides) and takes
// some of the pilot's start-of-turn positions. At each one, every card the pilot's Legends allow (RAM
// and colour - not just its 40 + 7) is added to its hand in turn, and Bot A's search scores the
// position: value(card) = best win chance with that card in hand - best win chance without it.
// Averaged over positions, that is how much the card helps in this matchup: e.g. Dexter DeShawn
// (adjust a Gig on every attack) against BBG's min-Gig plans, MaxTac Suppression Team against Go Solo
// Legends. Output:
//   <out>/<PILOT>.json  { opp: [{ card, mean, se, n, inMain, inSide }] } best first
//   <out>/rows.jsonl    { pilot, opp, oppCards, card, mean, se, n } - training rows for the sideboard net
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

if (!isMainThread) {
  const { setupGame, step, defaultPassAction, CARDS } = require('../src/engine');
  const { tryApply, moves } = require('../src/coach/policy');
  const { mulberry } = require('../src/coach/bridge');
  const { makeBot } = require('../src/bot/bots');
  const { botView } = require('../src/bot/view');
  const { cloneBoard } = require('../src/engine/lib/clone');
  const player = makeBot(workerData.player), judge = makeBot(workerData.evalSpec);
  // the search's best option value at (b, wf) for pid
  function best(b, wf, pid, seed) {
    const c = { rng: mulberry(seed) };
    try { judge.act(botView(b, pid, c.rng), wf, pid, c); } catch { return null; }
    const L = c.lastSearch;
    return L && L.options.length ? Math.max(...L.options.map(o => o.value)) : null;
  }
  parentPort.on('message', job => {
    if (!job) return process.exit(0);
    const r = mulberry(job.seed);
    const seat = r() < 0.5 ? 'p1' : 'p2';
    let res = step(setupGame(seat === 'p1' ? job.me : job.opp, seat === 'p1' ? job.opp : job.me, r() < 0.5 ? 'p1' : 'p2', { seed: job.seed }), undefined);
    let b = res.board, wf = res.waitingFor; b._trace = null;
    const ctx = { p1: { rng: mulberry(job.seed * 2 + 1) }, p2: { rng: mulberry(job.seed * 2 + 2) } };
    // which of the pilot's turns to review: a few between its 2nd and 10th turn
    const myTurns = [], seen = new Set();
    const out = [];
    for (let i = 0; i < 6000 && wf && !b.winner && b.turn_number <= 40; i++) {
      const pid = wf.owner || b.active_player;
      if (pid === seat && wf.step === 'main_phase' && b.active_player === seat && !seen.has(b.turn_number)) {
        seen.add(b.turn_number); myTurns.push(b.turn_number);
        const k = myTurns.length;
        if (k >= 2 && k <= 10 && r() < job.positions / 9) {
          const base = best(b, wf, seat, job.seed + b.turn_number);
          if (base != null) {
            const vals = {};
            for (const card of job.cands) {
              const b2 = cloneBoard(b);
              b2[seat].zones.hand.push({ iid: `cf${b.turn_number}x`, card_id: card });
              const v = best(b2, wf, seat, job.seed + b.turn_number);   // same seed: same imagined worlds
              if (v != null) vals[card] = Math.round((v - base) * 1000) / 1000;
            }
            out.push({ turn: b.turn_number, base: Math.round(base * 1000) / 1000, vals });
          }
        }
      }
      let seq = null;
      try { seq = player.act(botView(b, pid, ctx[pid].rng), wf, pid, ctx[pid]); } catch { /* */ }
      let nx = seq && tryApply(b, wf, seq);
      if (!nx) { const d = defaultPassAction(wf); nx = d && tryApply(b, wf, [d]); }
      if (!nx) for (const m of moves(wf, b)) { nx = tryApply(b, wf, m); if (nx) break; }
      if (!nx) break;
      b = nx.board; wf = nx.waitingFor; b._trace = null;
    }
    parentPort.postMessage({ id: job.id, out, won: b.winner === seat });
  });
  parentPort.postMessage({ ready: true });
  return;
}

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const pilotIds = flag('--pilots', 'BBG,YYR,RRG,RGB').split(',');
const oppMode = flag('--opps', 'pilots');
const GAMES = +flag('--games', 12), POS = +flag('--positions', 4);
const evalSpec = flag('--eval', 'strong:deals=6:k=5'), playerSpec = flag('--player', 'greedyt');
const outDir = path.resolve(flag('--out', path.join(__dirname, '..', 'notes', 'card-review')));
const seed0 = +flag('--seed', 777000);
const workers = +flag('--workers', Math.max(1, os.cpus().length - 1));
fs.mkdirSync(outDir, { recursive: true });

const P = require('../src/bot/pilot');
const { loadDecks } = require('../src/bot/arena');
const { CARDS, deckIsIllegal } = require('../src/engine');
const states = Object.fromEntries(['BBG', 'YYR', 'RRG', 'RGB'].map(id => [id, P.load(id)]));
const deckOfPilot = id => P.deckDef(states[id].legends, states[id].champion.main, id);
const opps = oppMode === 'all'
  ? loadDecks().map(d => ({ key: d.name.replace(/\.txt$/, ''), deck: d }))
  : ['BBG', 'YYR', 'RRG', 'RGB'].map(id => ({ key: id, deck: deckOfPilot(id) }));
// every non-Legend card the pilot's Legends allow (adding one copy keeps the deck legal)
function candidates(st) {
  const out = [];
  for (const c of CARDS) {
    if (c.type === 'Legend' || c.legal === false) continue;
    const m = { ...st.champion.main }; m[c.number] = Math.min(3, (m[c.number] || 0) + 1);
    if (!deckIsIllegal(P.deckDef(st.legends, m))) out.push(c.number);
  }
  return [...new Set(out)];
}

const pool = [], queue = [], pending = new Map();
for (let w = 0; w < workers; w++) {
  const worker = new Worker(__filename, { workerData: { player: playerSpec, evalSpec } });
  const feed = () => { const j = queue.shift(); if (j) { worker.busy = true; worker.postMessage(j); } else worker.busy = false; };
  worker.on('message', m => { if (m.ready) return feed(); const p = pending.get(m.id); pending.delete(m.id); p(m); feed(); });
  worker.on('error', e => { console.error(e); process.exit(1); });
  worker.kick = feed; pool.push(worker);
}
let nextId = 1;
const run = job => new Promise(ok => { const id = nextId++; pending.set(id, ok); queue.push({ ...job, id }); for (const w of pool) if (!w.busy) { w.kick(); break; } });

(async () => {
  const rows = fs.createWriteStream(path.join(outDir, 'rows.jsonl'), { flags: 'a' });
  const t0 = Date.now();
  await Promise.all(pilotIds.map(async id => {
    const st = states[id], cands = candidates(st), me = deckOfPilot(id), table = {};
    console.log(`${id}: ${cands.length} candidate cards (legal for its Legends) vs ${opps.length} opponents`);
    await Promise.all(opps.map(async o => {
      const res = await Promise.all(Array.from({ length: GAMES }, (_, g) => run({ me, opp: o.deck, cands, positions: POS, seed: seed0 + g * 104729 + o.key.length * 13 })));
      const per = {};
      for (const r of res) for (const p of r.out) for (const [c, v] of Object.entries(p.vals)) (per[c] ||= []).push(v);
      const list = Object.entries(per).map(([card, v]) => {
        const n = v.length, mean = v.reduce((a, x) => a + x, 0) / n, sd = Math.sqrt(v.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, n - 1));
        return { card, mean: Math.round(mean * 1000) / 1000, se: Math.round(sd / Math.sqrt(n) * 1000) / 1000, n, inMain: st.champion.main[card] || 0, inSide: st.champion.side[card] || 0 };
      }).sort((a, b) => b.mean - a.mean);
      table[o.key] = list;
      const oppCards = [...o.deck.legends, ...o.deck.cards.map(c => c.card_id)];
      for (const x of list) rows.write(JSON.stringify({ pilot: id, opp: o.key, oppCards, card: x.card, mean: x.mean, se: x.se, n: x.n }) + '\n');
      const nm = c => P.cardName(c).split(':')[0];
      const top = list.slice(0, 5).map(x => `${nm(x.card)} ${(100 * x.mean).toFixed(1)}${x.inMain ? '' : x.inSide ? ' (side)' : ' (new)'}`).join(', ');
      const weak = list.filter(x => x.inMain).slice(-3).map(x => `${nm(x.card)} ${(100 * x.mean).toFixed(1)}`).join(', ');
      console.log(`  ${id} vs ${o.key}: ${res.reduce((a, r) => a + r.out.length, 0)} positions | best in hand: ${top} | weakest main-deck cards: ${weak}  (${Math.round((Date.now() - t0) / 60000)} min)`);
    }));
    fs.writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify({ pilot: id, eval: evalSpec, at: new Date().toISOString(), deck: st.champion, table }, null, 1));
  }));
  rows.end();
  for (const w of pool) w.postMessage(null);
  console.log(`done in ${Math.round((Date.now() - t0) / 60000)} min`);
})();
