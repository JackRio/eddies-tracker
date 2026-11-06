// Readable examples of what Reanalyse changed: decisions where the old bot's pick and the new, deeper
// search's pick differ. Replays games from <data>.jsonl (old scores) and <data>-re.jsonl (new scores) with
// the bot that played them, and prints the board plus every move with both scores.
//   node scripts/reanalyse-examples.js [notes/league/data-2001.jsonl] [--bot strong] [--games 4]
//        [--min 3] [--out notes/league/reanalyse-examples.txt] [--seed S]
// --min: only decisions where the new search rates its pick at least this many points above the old pick.
'use strict';
const fs = require('fs');
const path = require('path');
const BELIEF = require('../src/bot/belief');
BELIEF.legacy.on = true;   // exact replay of games recorded before Nov 7 2026
const { setupGame, step, defaultPassAction, CARDS } = require('../src/engine');
const { tryApply, moves } = require('../src/coach/policy');
const { mulberry } = require('../src/coach/bridge');
const { makeBot } = require('../src/bot/bots');
const { botView } = require('../src/bot/view');
const { describe } = require('../src/bot/describe');
const P = require('../src/bot/pilot');

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const file = args.find(a => a.endsWith('.jsonl')) || path.join(__dirname, '..', 'notes', 'league', 'data-2001.jsonl');
const reFile = file.replace(/\.jsonl$/, '-re.jsonl');
const bot = makeBot(flag('--bot', 'strong'));
const N = +flag('--games', 4), MIN = +flag('--min', 3) / 100;
const outFile = flag('--out', path.join(path.dirname(file), 'reanalyse-examples.txt'));
const rng = mulberry(+flag('--seed', 7));
const BY = new Map(CARDS.map(c => [c.number, c]));
const nm = id => (BY.get(id)?.name || id).split(':')[0];

const orig = new Map();
for (const l of fs.readFileSync(file, 'utf8').split('\n')) if (l.trim()) { const o = JSON.parse(l); orig.set(o.g, o); }
const matches = new Map();
for (const l of fs.readFileSync(path.join(path.dirname(file), 'matches.jsonl'), 'utf8').split('\n')) {
  if (!l.trim()) continue;
  const m = JSON.parse(l);
  for (const g of m.games || []) matches.set(g.seed, { m, g });
}
// games whose re-search changed the best move somewhere by >= MIN
const cand = [];
for (const l of fs.readFileSync(reFile, 'utf8').split('\n')) {
  if (!l.trim()) continue;
  const re = JSON.parse(l), o = orig.get(re.g);
  if (!o || !matches.has(re.g)) continue;
  const hits = re.recs.filter((r, i) => r.re && changed(o.recs[i], r)).length;
  if (hits) cand.push({ re, o, hits });
}
function best(c) { let b = -1; c.forEach((x, k) => { if (x[3] != null && (b < 0 || x[3] > c[b][3])) b = k; }); return b; }
function changed(oldR, newR) {
  const nb = best(newR.c), np = newR.c[oldR.pick]?.[3];
  return nb >= 0 && nb !== oldR.pick && np != null && newR.c[nb][3] - np >= MIN;
}

const add = (m, id, k) => { const r = { ...m }; r[id] = (r[id] || 0) + k; if (r[id] <= 0) delete r[id]; return r; };
const applyPlan = (main, plan) => { if (!plan || plan === 'none') return main; for (const sw of plan.split(',')) { const [a, b] = sw.split('>'); main = add(add(main, a, -1), b, 1); } return main; };
const pct = v => (v == null ? '   -  ' : `${(100 * v).toFixed(0).padStart(3)}%  `);
function board(b, pid, names) {
  const o = pid === 'p1' ? 'p2' : 'p1', Z = b[pid].zones, Q = b[o].zones;
  const units = z => z.field.map(u => `${nm(u.card_id)}${u.state === 'spent' ? ' (spent)' : ''}${(u.equipped_gear || []).length ? ` +${u.equipped_gear.map(g => nm(g.card_id)).join('+')}` : ''}`).join(', ') || '-';
  const legs = z => z.legends.map(l => (l.face === 'face_up' ? nm(l.card_id) + (l.state === 'spent' ? ' (spent)' : '') : 'face-down')).join(', ');
  const gigs = z => (z.gigs || []).map(g => `d${g.sides || '?'}=${g.value}`).join(' ') || '-';
  return [
    `    ${names[pid]} (deciding): hand ${Z.hand.map(c => nm(c.card_id)).join(', ') || '-'}`,
    `      field ${units(Z)} | Legends ${legs(Z)} | Eddies ${Z.eddies.filter(e => e.state === 'ready').length} ready / ${Z.eddies.length} | Gigs ${gigs(Z)}`,
    `    ${names[o]}: hand ${Q.hand.length} cards | field ${units(Q)} | Legends ${legs(Q)} | Eddies ${Q.eddies.length} | Gigs ${gigs(Q)}`,
  ].join('\n');
}

const out = [`Reanalyse examples from ${path.basename(file)}: decisions where the deeper search (new) prefers a different move`,
  `than the old bot played by ${Math.round(MIN * 100)}+ points. Scores = estimated win chance for the deciding player.`,
  `${cand.length} re-searched games have at least one such decision; showing ${Math.min(N, cand.length)}.`, ''];
const pickN = cand.sort(() => rng() - 0.5).slice(0, N);
for (const { re, o } of pickN) {
  const { m, g } = matches.get(re.g);
  const names = { p1: m.A.replace(/^(deck|pub|net):/, ''), p2: m.B.replace(/^(deck|pub|net):/, '') };
  if (names.p1 === names.p2) { names.p1 += ' (A)'; names.p2 += ' (B)'; }
  out.push(`══ match ${m.k} game ${g.g}: ${names.p1} vs ${names.p2}, ${g.aFirst ? names.p1 : names.p2} first, winner ${g.winner === 'A' ? names.p1 : g.winner === 'B' ? names.p2 : '-'} in ${g.turns} turns`);
  const dA = P.deckDef(m.decks.A.legends, applyPlan(m.decks.A.main, g.planA), m.A), dB = P.deckDef(m.decks.B.legends, applyPlan(m.decks.B.main, g.planB), m.B);
  let res = step(setupGame(dA, dB, g.aFirst ? 'p1' : 'p2', { seed: g.seed }), undefined);
  let b = res.board, wf = res.waitingFor; b._trace = null;
  const ctx = { p1: { rng: mulberry(g.seed * 2 + 1) }, p2: { rng: mulberry(g.seed * 2 + 2) } };
  let ri = 0;
  for (let i = 0; i < 8000 && wf && !b.winner && b.turn_number <= 60; i++) {
    const pid = wf.owner || b.active_player, c = ctx[pid];
    c.lastSearch = null;
    let seq = null;
    try { seq = bot.act(botView(b, pid, c.rng), wf, pid, c); } catch { /* */ }
    let r = seq && tryApply(b, wf, seq);
    if (!r) { seq = null; const d = defaultPassAction(wf); r = d && tryApply(b, wf, [d]); }
    if (!r) for (const mv of moves(wf, b)) { r = tryApply(b, wf, mv); if (r) break; }
    if (!r) break;
    const L = c.lastSearch;
    if (L && L.ranked.length >= 2 && L.options.length && seq) {
      const oldR = o.recs[ri], newR = re.recs[ri];
      ri++;
      if (oldR && newR && newR.re && oldR.pick === L.ranked.indexOf(seq) && changed(oldR, newR)) {
        const nb = best(newR.c);
        out.push(`\n  Turn ${b.turn_number}, ${names[pid]} - ${wf.step.replace(/_/g, ' ')}`);
        out.push(board(b, pid, names));
        out.push('       old   new');
        const rows = L.ranked.map((mv, k) => ({ k, t: describe(b, pid, mv, wf.choice_needed), ov: oldR.c[k][3], nv: newR.c[k][3] }))
          .filter(x => x.ov != null || x.nv != null).sort((x, y) => (y.nv ?? -1) - (x.nv ?? -1));
        for (const x of rows.slice(0, 8)) out.push(`    ${x.k === oldR.pick ? 'played ▶' : x.k === nb ? 'better ★' : '        '} ${pct(x.ov)}${pct(x.nv)} ${x.t}`);
      }
    }
    b = r.board; wf = r.waitingFor; b._trace = null;
  }
  out.push('');
}
fs.writeFileSync(outFile, out.join('\n'));
console.log(`wrote ${outFile} (${pickN.length} games)`);
