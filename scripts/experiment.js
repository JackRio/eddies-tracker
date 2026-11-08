// The no-greedy self-play experiment (Nov 8 2026): can a bot made of only the two nets + search teach itself?
//
//   node scripts/experiment.js [--rounds 3] [--matches 400] [--pairs 80] [--baseline] [--dry]
//
// Bot: strong:nogreedy=1 - the policy net shortlists and plays every decision inside the imagined games, the
// value net judges the board at the start of the Rival's turn. No greedy anywhere (src/bot/strong.js).
// Each round:
//   1. League (scripts/league.js): the current nets play themselves (75% whole-pool decks, 25% pilots, 15% vs the
//      earlier rounds' nets, unrecorded), explore=2; teacher = the same bot, deeper (deals=32:k=10) - pure
//      self-play, nothing from greedy.
//   2. Train from the current nets: value net on older league games (results only) + this experiment's games
//      (50/50 result / search value); policy net on this experiment's games only, WITHOUT greedy's rank as an input.
//   3. No gate: the new nets always become the current ones (AlphaZero style).
//   4. Measuring stick: the new bot vs the FIXED current Daemon, pilot decks, sequential (pilot-arena --seq).
//      Rising scores = it is teaching itself. --baseline first measures round 0 (today's nets).
// State: notes/league/exp-nogreedy.json; log: notes/league/exp-nogreedy.log; nets: src/bot/*-net-ng<N>.json.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DRY = args.includes('--dry');
const PY = flag('--python', 'D:/Codebase/venv/nitorch/Scripts/python.exe');
const LEAGUE = path.join(ROOT, 'notes', 'league');
const outDir = DRY ? path.join(LEAGUE, 'dry') : LEAGUE;
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(path.join(ROOT, 'notes', 'nets'), { recursive: true });
const STATE = path.join(outDir, DRY ? 'exp-dry.json' : 'exp-nogreedy.json');
const rel = p => path.relative(ROOT, p).replace(/\\/g, '/');
const rounds = +flag('--rounds', DRY ? 1 : 3), matches = +flag('--matches', DRY ? 4 : 400), pairs = +flag('--pairs', DRY ? 2 : 80);

// the fixed measuring stick: Daemon as of Nov 8 2026
const DAEMON = 'strong:vnet=src/bot/value-net-r3.json:pnet=src/bot/policy-net-r3.json:prior=mix:gb=1:alt=1:tb=1';
const ng = (v, p, extra = '') => `strong:vnet=${v}:pnet=${p}:nogreedy=1:alt=1:tb=1${extra}`;
const OLD_DATA = ['notes/league/data-2001-re.jsonl', 'notes/league/data-3001-re.jsonl', 'notes/league/data-3301-re.jsonl', 'notes/league/data-3302-re.jsonl', 'notes/league/data-4001.jsonl', 'notes/league/data-5101.jsonl'];

const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {
  // round 0: r3 value net + the r3 policy net retrained without greedy's rank (policy-net-nog.json)
  current: { name: 'ng0', value: 'src/bot/value-net-r3.json', policy: 'src/bot/policy-net-nog.json' },
  past: [], rounds: [],
};
const logFile = path.join(outDir, DRY ? 'exp-dry.log' : 'exp-nogreedy.log');
const log = fs.createWriteStream(logFile, { flags: 'a' });
const say = s => { const line = `[${new Date().toTimeString().slice(0, 5)}] ${s}`; console.log(line); log.write(line + '\n'); };
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 1));

function run(cmd, cargs, label) {
  return new Promise((resolve, reject) => {
    say(`${label}: ${[path.basename(cmd), ...cargs].join(' ')}`);
    const p = spawn(cmd, cargs, { cwd: ROOT });
    let out = '';
    const take = d => { const s = d.toString(); out += s; log.write(s); };
    p.stdout.on('data', take); p.stderr.on('data', take);
    p.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`${label} failed (exit ${code}) - see ${rel(logFile)}`))));
  });
}
const node = (script, a, label) => run(process.execPath, [path.join(ROOT, script), ...a.map(String)], label);

async function measure(cur, label, seed) {
  const txt = await node('scripts/pilot-arena.js', [ng(cur.value, cur.policy), DAEMON, '--pairs', pairs, '--seed', seed, ...(DRY ? [] : ['--seq'])], label);
  const m = [...txt.matchAll(/matches ([\d.]+)% \[(-?[\d.]+), (-?[\d.]+)\]\s+Elo (-?\d+)/g)].pop();
  if (!m) throw new Error('could not read the gate result');
  const r = { score: +m[1], lo: +m[2], hi: +m[3], elo: +m[4] };
  say(`  ${cur.name} vs Daemon: ${r.score}% [${r.lo}, ${r.hi}]  Elo ${r.elo}`);
  return r;
}

(async () => {
  const pilotsDir = path.join(ROOT, 'src', 'bot', 'pilots', 'state');
  const backup = DRY ? Object.fromEntries(fs.readdirSync(pilotsDir).filter(f => f.endsWith('.json')).map(f => [f, fs.readFileSync(path.join(pilotsDir, f))])) : null;
  try {
    say(`== no-greedy experiment: ${rounds} round(s) from ${state.current.name}, ${matches} matches/round${DRY ? ' (DRY RUN)' : ''}`);
    if (args.includes('--baseline') && !state.baseline) {
      state.baseline = await measure(state.current, 'round 0 baseline vs Daemon', DRY ? 9950000 : 5000000);
      save();
    }
    for (let r = 0; r < rounds; r++) {
      const k = state.rounds.length + 1, name = DRY ? 'ngdry' : `ng${k}`, cur = state.current;
      const seed = DRY ? 99101 : 7001 + 100 * k;
      const t0 = Date.now(), rec = { name, from: cur.name, seed };
      say(`-- round ${k}: ${cur.name} plays itself`);
      // 1. league
      await node('scripts/league.js', ['--matches', matches, '--record', '--teach', 0.15, '--general', 0.75,
        ...(state.past.length ? ['--past', state.past.join(','), '--past-share', 0.15] : []),
        '--bot', ng(cur.value, cur.policy, ':explore=2'), '--teacher', ng(cur.value, cur.policy, ':deals=32:k=10'), '--seed', seed, '--out', outDir], `round ${k} league`);
      const data = path.join(outDir, `data-${seed}.jsonl`);
      rec.data = rel(data);
      rec.games = fs.readFileSync(data, 'utf8').split('\n').filter(Boolean).length;
      say(`  ${rec.games} recorded games`);
      const expData = [...state.rounds.map(x => x.data), rec.data].map(f => path.join(ROOT, f));
      // 2. train
      const rowsNew = path.join(outDir, `value-rows-${name}-new.jsonl`), rowsOld = path.join(outDir, `value-rows-ng-old.jsonl`);
      await node('scripts/league-to-value.js', [...expData, '--mix', '0.5', '--out', rowsNew], `round ${k} value rows (experiment games)`);
      if (!fs.existsSync(rowsOld) || DRY) await node('scripts/league-to-value.js', [...OLD_DATA.filter(f => fs.existsSync(path.join(ROOT, f))), '--mix', '1', '--out', rowsOld], `round ${k} value rows (older games, results only)`);
      const vOut = path.join(ROOT, 'notes', 'nets', `value-${name}.json`), pOut = path.join(ROOT, 'notes', 'nets', `policy-${name}.json`);
      const ep = DRY ? ['--epochs', '1'] : [];
      const vtxt = await run(PY, [path.join(ROOT, 'scripts', 'train-value.py'), rowsOld, rowsNew, '--init', path.join(ROOT, cur.value), '--out', vOut, ...ep], `round ${k} train value net`);
      const ptxt = await run(PY, [path.join(ROOT, 'scripts', 'train-policy.py'), ...expData, '--init', path.join(ROOT, cur.policy), '--informative-only', '--grank', '0', '--out', pOut,
        '--report', path.join(outDir, `policy-report-${name}.json`), ...ep], `round ${k} train policy net`);
      rec.valueLoss = (vtxt.match(/net ([\d.]+) \(([\d.]+)%\)/) || []).slice(1).map(Number);
      rec.policyBest = ((ptxt.match(/best-move net ([\d.]+)%/g) || []).pop() || '').replace('best-move net ', '');
      say(`  value net held-out: log loss ${rec.valueLoss[0]} (${rec.valueLoss[1]}% right) | policy picks the search's best move ${rec.policyBest}`);
      const vSrc = `src/bot/value-net-${name}.json`, pSrc = `src/bot/policy-net-${name}.json`;
      fs.copyFileSync(vOut, path.join(ROOT, vSrc)); fs.copyFileSync(pOut, path.join(ROOT, pSrc));
      const chk = (await node('src/bot/value.js', [vSrc], 'check value net')) + (await node('src/bot/pnet.js', [pSrc], 'check policy net'));
      if (/MISMATCH/.test(chk)) throw new Error('JS forward pass does not match PyTorch');
      // 3. no gate: the new nets are the current ones
      state.past = [ng(cur.value, cur.policy), ...state.past].slice(0, 2);
      state.current = { name, value: vSrc, policy: pSrc };
      // 4. measuring stick
      rec.vsDaemon = await measure(state.current, `round ${k} vs Daemon`, (DRY ? 9960000 : 5000000) + 100000 * k);
      rec.minutes = Math.round((Date.now() - t0) / 60000);
      state.rounds.push(rec);
      if (!DRY) save();
      say(`-- round ${k} done in ${rec.minutes} min: vs Daemon ${rec.vsDaemon.score}% (baseline ${state.baseline ? state.baseline.score + '%' : 'not measured'})`);
    }
  } catch (e) {
    say(`STOPPED: ${e.message}`);
    process.exitCode = 1;
  } finally {
    if (backup) {
      for (const [f, buf] of Object.entries(backup)) fs.writeFileSync(path.join(pilotsDir, f), buf);
      for (const f of ['value-net-ngdry.json', 'policy-net-ngdry.json']) fs.rmSync(path.join(ROOT, 'src', 'bot', f), { force: true });
    }
    say('== experiment stopped/finished');
    log.end();
  }
})();
