// League games on ANOTHER machine, for the next self-training batch on the main one (scripts/batch.js).
//
//   git pull
//   node scripts/remote-league.js [--matches 400] [--workers N] [--seed S]
//   git add notes/league/remote && git commit -m "League games" && git push
//
// Plays the same self-play league batch.js plays (scripts/batch-config.js) with the current champion from
// notes/league/batches.json, then gzips the recorded games into notes/league/remote/:
//   data-<seed>.jsonl.gz   decisions (training data), games-<seed>.jsonl.gz   move lists,
//   league-<seed>.json     { champion, seed, matches, games, machine, finished }
// The next batch.js run on the main machine picks up every file made for ITS champion and trains on it with its
// own games (games made for an older champion are skipped - their searches came from the old nets).
// Needs only Node 18+ (no Python, no GPU). The pilots' learned state is restored afterwards, so the only change
// in the working tree is the new files under notes/league/remote/. Ctrl+C keeps nothing; re-run with a new seed.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const C = require('./batch-config');

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const state = C.loadState();
const matches = +flag('--matches', 400);
const seed = +flag('--seed', 200000 + Math.floor(Math.random() * 700) * 1000);   // far from the main machine's seeds
const tmp = path.join(C.REMOTE, `tmp-${seed}`);
fs.mkdirSync(tmp, { recursive: true });
const pilotsDir = path.join(C.ROOT, 'src', 'bot', 'pilots', 'state');
const backup = Object.fromEntries(fs.readdirSync(pilotsDir).filter(f => f.endsWith('.json')).map(f => [f, fs.readFileSync(path.join(pilotsDir, f))]));
const restore = () => { for (const [f, buf] of Object.entries(backup)) fs.writeFileSync(path.join(pilotsDir, f), buf); };

console.log(`remote league: champion ${state.champion.name}, ${matches} matches, seed ${seed}, ${os.cpus().length} CPUs`);
const la = C.leagueArgs(state, matches, seed, tmp);
if (flag('--workers')) la.push('--workers', flag('--workers'));
const p = spawn(process.execPath, [path.join(C.ROOT, 'scripts', 'league.js'), ...la], { cwd: C.ROOT, stdio: 'inherit' });
process.on('SIGINT', () => { p.kill(); restore(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(130); });
p.on('close', code => {
  restore();
  if (code !== 0) { console.error(`league failed (exit ${code}); nothing saved`); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(1); }
  const data = fs.readFileSync(path.join(tmp, `data-${seed}.jsonl`));
  const games = data.toString('utf8').split('\n').filter(Boolean).length;
  for (const f of [`data-${seed}.jsonl`, `games-${seed}.jsonl`]) {
    fs.writeFileSync(path.join(C.REMOTE, f + '.gz'), zlib.gzipSync(fs.readFileSync(path.join(tmp, f)), { level: 9 }));
  }
  fs.writeFileSync(path.join(C.REMOTE, `league-${seed}.json`), JSON.stringify({ champion: state.champion.name, seed, matches, games, machine: os.hostname(), finished: new Date().toISOString() }, null, 1));
  fs.rmSync(tmp, { recursive: true, force: true });
  const mb = fs.statSync(path.join(C.REMOTE, `data-${seed}.jsonl.gz`)).size / 1e6;
  console.log(`\nsaved ${games} games for champion ${state.champion.name} in notes/league/remote/ (data ${mb.toFixed(1)} MB gzipped). Now:\n  git add notes/league/remote && git commit -m "League games ${seed}" && git push`);
});
