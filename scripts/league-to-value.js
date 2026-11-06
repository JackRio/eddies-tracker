// League decision records -> value-net training rows (scripts/train-value.py input).
//   node scripts/league-to-value.js <league data-*.jsonl ...> [--out notes/league/value-rows.jsonl]
// Keeps, per game, the first main-phase decision of each player's turn (the position the search's
// leaf scores: start of a turn) labelled with whether that player won the game. Games without a
// winner are skipped. Output lines: { g, rows: [[label, dense[], sparse[[i, n]...], won, turnsLeft], ...] }.
// --mix L (default 1): label = L * won + (1 - L) * the search's best win chance at that position
// (rec.v from scripts/reanalyse.js, else the recorded best value) - a bootstrapped target with less
// noise than the bare result; `won` stays separate so the held-out loss is measured on real results.
// turnsLeft = the game's last turn - this turn (the trainer's auxiliary "how long is left" head).
'use strict';
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const oi = args.indexOf('--out');
const out = oi >= 0 ? args[oi + 1] : path.join(__dirname, '..', 'notes', 'league', 'value-rows.jsonl');
const mi = args.indexOf('--mix');
const MIX = mi >= 0 ? +args[mi + 1] : 1;
const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out' && args[i - 1] !== '--mix');
const ws = fs.createWriteStream(out);
let games = 0, rows = 0;
for (const f of files) {
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (!o.winner) continue;
    const seen = new Set(), r = [], last = Math.max(...o.recs.map(x => x.turn));
    for (const x of o.recs) {
      if (x.step !== 'main_phase') continue;
      const k = `${x.turn}|${x.pid}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const won = x.pid === o.winner ? 1 : 0;
      const vs = x.c.map(c => c[3]).filter(v => v != null), v = x.v ?? (vs.length ? Math.max(...vs) : won);
      r.push([Math.round((MIX * won + (1 - MIX) * v) * 1000) / 1000, x.s[0], x.s[1], won, last - x.turn]);
    }
    if (!r.length) continue;
    games++; rows += r.length;
    ws.write(JSON.stringify({ g: o.g, rows: r }) + '\n');
  }
}
ws.end();
console.log(`${games} games, ${rows} positions -> ${out}`);
