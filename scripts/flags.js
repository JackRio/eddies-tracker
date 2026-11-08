// Bot plays flagged on the play page (board/play.html: ⚑ on a log line) -> a readable review list, misplays
// first, then UI issues, then good plays.
//   node scripts/flags.js [--all] [--kind misplay|good|ui] [--tag "Bad attack"] [--board]
// Reads notes/bot-flags/flags.jsonl (removed flags are skipped). For each flag: when and where (game seed,
// decks, turn), the flagged log line, your tags and note, what the bot compared at that decision (win
// chance per option, its deck guess) and - with --board - the position just before the move, rebuilt from
// the game's seed + recorded moves (so it can be re-searched or turned into a test).
// Default: only flags not yet marked reviewed; --all shows every flag.
'use strict';
const fs = require('fs');
const path = require('path');
const play = require('../src/bot/play');
const { CARDS } = require('../src/engine');

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const tagF = flag('--tag'), kindF = flag('--kind'), withBoard = args.includes('--board');
if (!fs.existsSync(play.FLAG_FILE)) { console.log('No flags yet (' + play.FLAG_FILE + ').'); process.exit(0); }
const rows = fs.readFileSync(play.FLAG_FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const removed = new Set(rows.filter(r => r.remove).map(r => r.remove));
const reviewed = new Set(rows.filter(r => r.reviewed).map(r => r.reviewed));
let list = rows.filter(r => r.id && !removed.has(r.id));
if (!args.includes('--all')) list = list.filter(r => !reviewed.has(r.id));
if (tagF) list = list.filter(r => r.tags.includes(tagF) || r.grade === tagF);
const kindOf = r => r.kind || 'misplay';
if (kindF) list = list.filter(r => kindOf(r) === kindF);
const ORDER = { misplay: 0, ui: 1, good: 2 };
list.sort((a, b) => ORDER[kindOf(a)] - ORDER[kindOf(b)]);

const BY = new Map(CARDS.map(c => [c.number, c]));
const nm = id => (BY.get(id)?.name || id);
function boardText(b, me) {
  const out = [];
  for (const p of ['p1', 'p2']) {
    const Z = b[p].zones;
    out.push(`    ${p}${p === me ? ' (you)' : ''}: gigs ${Z.gigs.map(g => `d${g.sides}=${g.value}`).join(' ')} | eddies ${Z.eddies.filter(e => e.state === 'ready').length}/${Z.eddies.length} ready | hand ${Z.hand.length} | deck ${Z.deck.length}`);
    out.push(`      Legends: ${Z.legends.map(l => (l.face === 'face_up' ? nm(l.card_id) : 'face-down') + (l.state === 'spent' ? ' (spent)' : '')).join(', ')}`);
    out.push(`      Field: ${Z.field.map(u => nm(u.card_id) + (u.state === 'spent' ? ' (spent)' : '') + (u.equipped_gear?.length ? ` [${u.equipped_gear.map(g => nm(g.card_id)).join(', ')}]` : '')).join(', ') || '-'}`);
    out.push(`      Hand: ${Z.hand.map(c => nm(c.card_id)).join(', ') || '-'}`);
  }
  return out.join('\n');
}

console.log(`${list.length} flag(s)${removed.size ? `, ${removed.size} removed` : ''}${reviewed.size ? `, ${reviewed.size} reviewed` : ''}\n`);
for (const f of list) {
  const g = f.game;
  const head = f.kind === 'good' ? `GOOD PLAY · ${f.grade}` : f.kind === 'ui' ? `UI ISSUE · ${f.grade}` : `MISPLAY${f.grade ? ` · ${f.grade}` : ''}`;
  console.log(`== ${head}  ${f.at.slice(0, 16).replace('T', ' ')}  [${f.tags.join(', ') || 'no reason picked'}]  id ${f.id}`);
  console.log(`   game seed ${g.seed}: ${g.deckLabels.p1} vs ${g.deckLabels.p2}; bots ${Object.entries(g.bots).map(([p, B]) => `${p}=${B.name}`).join(', ')}; ${g.first} first`);
  console.log(`   turn ${f.turn}, step ${f.step}: "${f.line}"${f.firstLineOfMove !== f.line ? `  (move: "${f.firstLineOfMove}")` : ''}`);
  if (f.note) console.log(`   note: ${f.note}`);
  if (f.think?.considered) {
    console.log(`   bot compared${f.think.notSearched ? ` (${f.think.notSearched} more not searched)` : ''}:`);
    for (const o of f.think.considered) console.log(`     ${o.chosen ? '>' : ' '} ${String(o.pct).padStart(5)}%  ${o.text}${o.explored ? '  (explored)' : ''}`);
  }
  if (f.think?.belief) console.log(`   deck guess: ${f.think.belief.map(x => `${x.deck} ${x.p}%`).join(', ')}`);
  if (withBoard) {
    const r = play.rebuild({ ...g, moves: f.moves }, f.mvBefore);
    console.log(r ? `   position before the move (turn ${r.b.turn_number}, ${r.wf?.step}):\n${boardText(r.b, g.you)}` : '   (could not rebuild the position - engine changed since?)');
  }
  console.log('');
}
