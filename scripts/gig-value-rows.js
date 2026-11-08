// League move lists (games-<seed>.jsonl) -> value-net rows WITH the Gig language (vfeatures DENSE_GIG).
//   node scripts/gig-value-rows.js notes/league/games-4001.jsonl [...] [--out notes/league/value-rows-gig.jsonl] [--mix L]
// Replays every game with the engine alone (setup from the game seed, then the recorded moves) and keeps
// the first main-phase decision of each player's turn - the start-of-turn position the search's leaf
// scores - labelled with whether that player won. Same row format as league-to-value.js:
// [label, dense[DENSE_GIG], sparse[[i, n]...] (offset DENSE_GIG), won, turnsLeft].
// --mix L: label = L x won + (1 - L) x the search's best value at that decision, read from the matching
// data-<seed>.jsonl next to the games file (same game id, turn, player); positions without one use won.
'use strict';
const fs = require('fs');
const path = require('path');
const { setupGame, step } = require('../src/engine');
const { tryApply } = require('../src/coach/policy');
const { encode, DENSE_GIG } = require('../src/bot/vfeatures');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const out = opt('--out', path.join(__dirname, '..', 'notes', 'league', 'value-rows-gig.jsonl'));
const MIX = +opt('--mix', 1);
const files = args.filter((a, i) => !a.startsWith('--') && !['--out', '--mix'].includes(args[i - 1]));

function searchValues(gamesFile) {
  const f = gamesFile.replace(/games-(\d+)\.jsonl$/, 'data-$1.jsonl'), m = new Map();
  if (MIX === 1 || !fs.existsSync(f)) return m;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    for (const x of o.recs) {
      if (x.step !== 'main_phase') continue;
      const k = `${o.g}|${x.turn}|${x.pid}`;
      if (m.has(k)) continue;
      const vs = x.c.map(c => c[3]).filter(v => v != null);
      if (x.v != null || vs.length) m.set(k, x.v ?? Math.max(...vs));
    }
  }
  return m;
}

const ws = fs.createWriteStream(out);
let games = 0, rows = 0, bad = 0;
for (const f of files) {
  const V = searchValues(f);
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    const winner = o.winner === 'A' ? 'p1' : o.winner === 'B' ? 'p2' : null;
    if (!winner) continue;
    let r = step(setupGame(o.decks.p1, o.decks.p2, o.first, { seed: o.g }), undefined);
    const seen = new Set(), got = [];
    let ok = true;
    for (const seq of o.actions) {
      const b = r.board, wf = r.waitingFor;
      if (wf?.step === 'main_phase') {
        const pid = wf.owner || b.active_player, k = `${b.turn_number}|${pid}`;
        if (!seen.has(k)) {
          seen.add(k);
          const x = encode(b, pid, DENSE_GIG), won = pid === winner ? 1 : 0;
          const v = V.get(`${o.g}|${k}`);
          got.push({ turn: b.turn_number, row: [Math.round((v == null ? won : MIX * won + (1 - MIX) * v) * 1000) / 1000, x.dense.map(z => Math.round(z * 1e4) / 1e4), x.sparse, won] });
        }
      }
      r = tryApply(b, wf, seq);
      if (!r) { ok = false; break; }
    }
    // the replay must end where the recorded game did
    if (!ok || (r.board.winner || null) !== winner) { bad++; continue; }
    const last = Math.max(...got.map(g => g.turn));
    games++; rows += got.length;
    ws.write(JSON.stringify({ g: o.g, rows: got.map(g => [...g.row, last - g.turn]) }) + '\n');
  }
}
ws.end();
console.log(`${games} games, ${rows} positions -> ${out}${bad ? ` (${bad} games didn't replay to the same result - skipped)` : ''}`);
