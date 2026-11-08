// Game Review from the command line (the board's review page does the same through serve-board.js).
//   node scripts/review.js <replay file or name> [--force]   -> board/replays/coach/<name>.review.json
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('../src/coach/review-service');

const argv = process.argv.slice(2);
const arg = argv.find(a => !a.startsWith('--'));
if (!arg) { console.log('usage: node scripts/review.js <replay> [--force]'); process.exit(1); }
let name = path.basename(arg);
if (fs.existsSync(arg) && !S.findReplay(name)) {
  const json = JSON.parse(fs.readFileSync(arg, 'utf8'));
  const v = S.validate(json);
  for (const c of v.checks) console.log(`  [${c.level}] ${c.text}`);
  if (!v.ok) process.exit(1);
  name = S.save(json);
}
const id = S.start(name, { force: argv.includes('--force') });
const t = setInterval(() => {
  const j = S.job(id);
  process.stdout.write(`\r${j.done}/${j.total} moves, ${j.seconds}s   `);
  if (j.status !== 'running') {
    clearInterval(t);
    const r = S.load(name);
    console.log(`\n${r.you} vs ${r.rival}: accuracy ${r.summary.accuracy}, ${Object.entries(r.summary.counts).map(([k, v]) => `${v} ${k}`).join(', ')}${r.errors.length ? `\nerrors: ${r.errors.join('; ')}` : ''}`);
  }
}, 1000);
