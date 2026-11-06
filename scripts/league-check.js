// Spot-check league games before their decisions become training data.
//   node scripts/league-check.js [--dir notes/league] [--games 3] [--seed S] [--bot strong] [--all]
// Picks random games from <dir>/matches.jsonl, replays them exactly (same decks after sideboarding,
// same first player, same seeds -> the same decisions), and prints every searched decision: the moves
// the bot compared with their win-chance estimates, and flags:
//   END+   ended the turn although an affordable play scored within 3 points of ending
//   TIE    the top two moves within 1 point (too close to teach anything)
//   DONE   every option under 5% or over 95% (the game was decided; no lesson)
//   MISS   legal moves the search never tried (shortlist size vs legal moves)
// Ends with the share of informative decisions (best 5-95% and moves at least 1 point apart) - the
// ones worth training on.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const dir = path.resolve(flag('--dir', path.join(ROOT, 'notes', 'league')));
const nGames = +flag('--games', 3);
const botSpec = flag('--bot', 'strong');
const { mulberry } = require('../src/coach/bridge');
const rng = mulberry(+flag('--seed', Date.now() % 1e6));

const { setupGame, step, defaultPassAction } = require('../src/engine');
const { tryApply, moves } = require('../src/coach/policy');
const { makeBot } = require('../src/bot/bots');
const { botView } = require('../src/bot/view');
const { describe } = require('../src/bot/describe');
const P = require('../src/bot/pilot');

let lines = fs.readFileSync(path.join(dir, 'matches.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(m => m.games && !m.error);
// --mistakes: only games where the teacher flagged a mistake; at each flagged decision the teacher
// re-searches and the bot's and the teacher's evaluations are printed side by side
const mistakesMode = args.includes('--mistakes');
const teacher = mistakesMode ? makeBot(flag('--teacher', 'strong:deals=24:k=10')) : null;
const recsBySeed = new Map();
if (mistakesMode) {
  for (const f of fs.readdirSync(dir).filter(f => /^data-.*\.jsonl$/.test(f)))
    for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!l.trim()) continue;
      const o = JSON.parse(l);
      if (o.recs.some(r => r.mistake)) recsBySeed.set(o.g, o.recs);
    }
  lines = lines.filter(m => m.games.some(g => recsBySeed.has(g.seed)));
  console.log(recsBySeed.size + ' recorded games contain a flagged mistake');
}
const add = (m, id, k) => { const r = { ...m }; r[id] = (r[id] || 0) + k; if (r[id] <= 0) delete r[id]; return r; };
const applyPlan = (main, plan) => { if (!plan || plan === 'none') return main; for (const sw of plan.split(',')) { const [o, i] = sw.split('>'); main = add(add(main, o, -1), i, 1); } return main; };
const bot = makeBot(botSpec);
const tot = { dec: 0, info: 0, end: 0, tie: 0, done: 0, miss: 0 };

for (let n = 0; n < nGames; n++) {
  const m = lines[Math.floor(rng() * lines.length)];
  const pool = mistakesMode ? m.games.filter(g => recsBySeed.has(g.seed)) : m.games;
  const g = pool[Math.floor(rng() * pool.length)];
  const recs = recsBySeed.get(g.seed) || [];
  let ri = 0;
  const dA = P.deckDef(m.decks.A.legends, applyPlan(m.decks.A.main, g.planA), m.A), dB = P.deckDef(m.decks.B.legends, applyPlan(m.decks.B.main, g.planB), m.B);
  console.log(`\n══ match ${m.k} game ${g.g}: ${m.A} (p1) vs ${m.B} (p2) · ${g.aFirst ? m.A : m.B} goes first · winner ${g.winner === 'A' ? m.A : g.winner === 'B' ? m.B : '-'} in ${g.turns} turns`);
  if (g.planA && g.planA !== 'none') console.log(`   ${m.A} sideboarded: ${g.planA.split(',').map(s => s.split('>').map(P.cardName).map(x => x.split(':')[0]).join(' → ')).join('; ')}`);
  let res = step(setupGame(dA, dB, g.aFirst ? 'p1' : 'p2', { seed: g.seed }), undefined);
  let b = res.board, wf = res.waitingFor; b._trace = null;
  const ctx = { p1: { rng: mulberry(g.seed * 2 + 1) }, p2: { rng: mulberry(g.seed * 2 + 2) } };
  let lastTurn = -1;
  for (let i = 0; i < 8000 && wf && !b.winner && b.turn_number <= 60; i++) {
    const pid = wf.owner || b.active_player, c = ctx[pid];
    c.lastSearch = null;
    let seq = null;
    try { seq = bot.act(botView(b, pid, c.rng), wf, pid, c); } catch { /* fall through */ }
    let r = seq && tryApply(b, wf, seq);
    if (!r) { seq = null; const d = defaultPassAction(wf); r = d && tryApply(b, wf, [d]); }
    if (!r) for (const mv of moves(wf, b)) { r = tryApply(b, wf, mv); if (r) break; }
    if (!r) break;
    const L = c.lastSearch;
    if (L && L.ranked.length >= 2 && L.options.length && seq) {
      if (b.turn_number !== lastTurn) { lastTurn = b.turn_number; const Z = b[b.active_player].zones; console.log(`  ─ T${b.turn_number} ${b.active_player === 'p1' ? m.A : m.B}: hand ${Z.hand.length}, field ${Z.field.length}, eddies ${Z.eddies.filter(e => e.state === 'ready').length}/${Z.eddies.length}, gigs ${Z.gigs.length} vs ${b[b.active_player === 'p1' ? 'p2' : 'p1'].zones.gigs.length}`); }
      const opts = L.options.map(o => ({ t: describe(b, pid, o.seq, wf.choice_needed), v: Math.round(o.value * 1000) / 10, chosen: o.seq === seq, end: o.seq[o.seq.length - 1].step === 'end_turn' }));
      opts.sort((x, y) => y.v - x.v);
      const best = opts[0].v, second = opts[1]?.v ?? best;
      const fl = [];
      const ch = opts.find(o => o.chosen);
      if (ch?.end && opts.some(o => !o.end && o.v >= ch.v - 3)) fl.push('END+');
      if (best - second < 1) fl.push('TIE');
      if (opts.every(o => o.v < 5) || opts.every(o => o.v > 95)) fl.push('DONE');
      const miss = L.ranked.length - L.options.length;
      if (miss > 0) fl.push(`MISS ${miss}`);
      const info = best >= 5 && best <= 95 && best - second >= 1;
      const rec = recs[ri++];
      if (mistakesMode) {
        if (rec && rec.mistake) {
          const tc = { rng: mulberry(g.seed * 31 + i) };
          try { teacher.act(botView(b, pid, tc.rng), wf, pid, tc); } catch { /* */ }
          const T = tc.lastSearch;
          const key = q => JSON.stringify(q);
          const tv = new Map((T ? T.options : []).map(o => [key(o.seq), Math.round(o.value * 1000) / 10]));
          const Z = b[pid].zones, oz = b[pid === 'p1' ? 'p2' : 'p1'].zones;
          console.log(`    MISTAKE? ${pid === 'p1' ? m.A : m.B} T${b.turn_number} ${wf.step} · hand ${Z.hand.length}, field ${Z.field.length} vs ${oz.field.length}, ready eddies ${Z.eddies.filter(e => e.state === 'ready').length}, gigs ${Z.gigs.length} vs ${oz.gigs.length}`);
          const rows = L.options.map(o => ({ t: describe(b, pid, o.seq, wf.choice_needed), v: Math.round(o.value * 1000) / 10, tv: tv.get(key(o.seq)), chosen: o.seq === seq }));
          for (const o of (T ? T.options : [])) if (!L.options.some(x => key(x.seq) === key(o.seq))) rows.push({ t: describe(b, pid, o.seq, wf.choice_needed), v: null, tv: Math.round(o.value * 1000) / 10, chosen: false });
          rows.sort((x, y) => (y.tv ?? -1) - (x.tv ?? -1));
          console.log('         bot  teacher');
          for (const o of rows.slice(0, 7)) console.log(`      ${o.chosen ? '▶' : ' '} ${o.v == null ? '     -' : (o.v.toFixed(1) + '%').padStart(6)} ${o.tv == null ? '     -' : (o.tv.toFixed(1) + '%').padStart(6)}  ${o.t}`);
        }
        b = r.board; wf = r.waitingFor; b._trace = null; continue;
      }
      tot.dec++; if (info) tot.info++; if (fl.includes('END+')) tot.end++; if (fl.includes('TIE')) tot.tie++; if (fl.includes('DONE')) tot.done++; if (miss) tot.miss++;
      if (args.includes('--all') || fl.some(f => f !== `MISS ${miss}`)) {
        console.log(`    ${pid === 'p1' ? m.A : m.B} ${wf.step}${fl.length ? '  [' + fl.join(' ') + ']' : ''}`);
        for (const o of opts.slice(0, 6)) console.log(`      ${o.chosen ? '▶' : ' '} ${o.v.toFixed(1).padStart(5)}%  ${o.t}`);
      }
    }
    b = r.board; wf = r.waitingFor; b._trace = null;
  }
}
const pc = x => `${Math.round(100 * x / Math.max(1, tot.dec))}%`;
console.log(`\n${tot.dec} searched decisions: informative ${pc(tot.info)}, END+ ${pc(tot.end)}, TIE ${pc(tot.tie)}, DONE ${pc(tot.done)}, MISS ${pc(tot.miss)}`);
