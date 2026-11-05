// Replay Coach runner. Grades every one of your turns in each replay and writes
// board/replays/coach/<replay name>.coach.json, which the board shows in its Coach panel.
//   node scripts/coach.js [replay files or folder]    default: board/replays
//   --samples N --plans N --keep N --depth N           search size (see src/coach/analyze.js)
//   --turn N                                           only this turn (for testing)
//   --workers N                                        parallel replays (default: CPU count - 1)
//   --force                                            redo replays that already have a result
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const OUT = path.join(__dirname, '..', 'board', 'replays', 'coach');
const outFile = f => path.join(OUT, path.basename(f).replace(/\.json$/, '.coach.json'));

if (!isMainThread) {
  const { analyzeReplay } = require('../src/coach/analyze');
  parentPort.on('message', ({ file, opts }) => {
    try {
      const res = analyzeReplay(file, opts);
      fs.writeFileSync(outFile(file), JSON.stringify(res, null, 1));
      parentPort.postMessage({ file, ok: true, seconds: res.seconds, turns: res.turns.length,
        flags: res.turns.filter(t => t.verdict === 'mistake' || t.verdict === 'blunder').length });
    } catch (e) {
      parentPort.postMessage({ file, ok: false, error: e.stack || String(e) });
    }
  });
  return;
}

const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? +argv[i + 1] : d; };
const opts = {};
for (const k of ['samples', 'plans', 'keep', 'depth']) if (argv.includes('--' + k)) opts[k] = flag(k);
if (argv.includes('--turn')) opts.onlyTurn = flag('turn');
const force = argv.includes('--force') || opts.onlyTurn;
const inputs = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && argv[i - 1] !== '--force'));
const dir = path.join(__dirname, '..', 'board', 'replays');
const files = (inputs.length ? inputs : [dir]).flatMap(p => fs.statSync(p).isDirectory()
  ? fs.readdirSync(p).filter(f => /^cyberpunk-tcg-sim-replay-.*\.json$/.test(f)).map(f => path.join(p, f)) : [path.resolve(p)])
  .filter(f => force || !fs.existsSync(outFile(f)));

fs.mkdirSync(OUT, { recursive: true });
if (!files.length) { console.log('Nothing to do (use --force to redo).'); process.exit(0); }
const n = Math.max(1, Math.min(files.length, flag('workers', Math.max(1, os.cpus().length - 1))));
console.log(`Coaching ${files.length} replay(s) on ${n} worker(s)...`);
const queue = files.slice();
let running = 0, failed = 0;
const t0 = Date.now();
for (let i = 0; i < n; i++) {
  const w = new Worker(__filename);
  const next = () => { const f = queue.shift(); if (!f) { w.terminate(); return; } running++; w.postMessage({ file: f, opts }); };
  w.on('message', m => {
    running--;
    const name = path.basename(m.file).replace('cyberpunk-tcg-sim-replay-', '');
    if (m.ok) console.log(`  ${name}: ${m.turns} turns graded, ${m.flags} flagged (${m.seconds}s)`);
    else { failed++; console.log(`  ${name}: FAILED\n${m.error}`); }
    next();
  });
  w.on('error', e => { failed++; console.error(e); });
  next();
}
process.on('exit', () => console.log(`Done in ${Math.round((Date.now() - t0) / 1000)}s${failed ? `, ${failed} failed` : ''}. Results in board/replays/coach/`));
