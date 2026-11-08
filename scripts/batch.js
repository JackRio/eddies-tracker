// One self-training batch: league -> train both nets -> gate -> (confirm) -> promote or keep.
//
//   node scripts/batch.js [--matches 400] [--pairs 40] [--name b1] [--dry]
//
// Other machines can add games: scripts/remote-league.js plays the same league there and pushes gzipped games to
// notes/league/remote/; this script trains on every file there made for the current champion (git pull first).
// --matches 0 = no local league, train on remote games only.
//
// 1. League (scripts/league.js): the current champion plays Bo3 matches against itself - 75% between two
//    decks from the whole pool (meta, coverage, published, 1,600 netdeck lists), 25% pilot matches, 15% of
//    matches against an older bot (not recorded). The player searches 2 random extra moves per decision
//    (explore=2). Every decision is recorded; the teacher - the full search with a played-out Rival reply,
//    whatever options the champion uses, deals=24:k=10 - re-scores 15% of the undecided ones.
// 2. Train (GPU, D:/Codebase/venv/nitorch): value net on game results (old rounds) + 50/50 result/search
//    value (batch data, searched with the fixed search); policy net on batch data only (older rounds were
//    searched with the no-block playouts). Both start from the champion's nets. JS forward pass checked.
// 3. Gate: new nets vs champion, paired Bo3 on the pilot decks AND on random pool decks (--pairs each).
//    Pass = combined match score's 95% lower bound > 50%. Then the same on fresh seeds (confirm); both must
//    pass. A lone "significant" gate was luck 4 times in a row on Nov 7 - hence the confirm.
// 4. Promote: notes/league/batches.json "champion" -> the new nets; the next batch plays with them. The
//    play page's Daemon is NOT changed here (play.js BOTS 'A', league.js, review.js NETOPTS).
//
// Everything is logged to notes/league/batch-<name>.log. --dry: a tiny run (4 matches, 2 pairs, 1 epoch)
// into notes/league/dry/ that restores the pilots' learned state afterwards and never promotes.
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
const C = require('./batch-config');
const zlib = require('zlib');
const STATE = C.STATE;
const rel = p => path.relative(ROOT, p).replace(/\\/g, '/');

const state = C.loadState();
const k = state.batches.length + 1;
const name = flag('--name', DRY ? 'dry' : `b${k}`);
const matches = +flag('--matches', DRY ? 4 : 400), pairs = +flag('--pairs', DRY ? 2 : 80);   // gate: up to `pairs`, stops early once clear (pilot-arena --seq)
const outDir = DRY ? path.join(LEAGUE, 'dry') : LEAGUE;
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(path.join(ROOT, 'notes', 'nets'), { recursive: true });
const seed = DRY ? 99001 : 6001 + 100 * k;   // league seed (data-<seed>.jsonl)
const gateSeed = (DRY ? 9900000 : 3000000 + 200000 * k);   // pilot, pool, confirm pilot, confirm pool: +0 / +50000 / +100000 / +150000
const champ = state.champion;
const spec = (v, p, extra = '') => C.spec(champ, v, p, extra);
const logFile = path.join(outDir, `batch-${name}.log`);
const log = fs.createWriteStream(logFile, { flags: 'a' });
const say = s => { const line = `[${new Date().toTimeString().slice(0, 5)}] ${s}`; console.log(line); log.write(line + '\n'); };

// run a command, its output into the log (and the console with --verbose); resolves with the output text
function run(cmd, cargs, label) {
  return new Promise((resolve, reject) => {
    say(`${label}: ${[path.basename(cmd), ...cargs].join(' ')}`);
    const p = spawn(cmd, cargs, { cwd: ROOT });
    let out = '';
    const take = d => { const s = d.toString(); out += s; log.write(s); if (args.includes('--verbose')) process.stdout.write(s); };
    p.stdout.on('data', take); p.stderr.on('data', take);
    p.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`${label} failed (exit ${code}) - see ${rel(logFile)}`))));
  });
}
const node = (script, a, label) => run(process.execPath, [path.join(ROOT, script), ...a], label);

// "matches 58.1% [51.5, 64.8]" -> { score, lo, hi }
function gateResult(text) {
  const m = text.match(/matches ([\d.]+)% \[(-?[\d.]+), (-?[\d.]+)\]/g);
  if (!m) throw new Error('could not read the gate result');
  const [, s, lo, hi] = m[m.length - 1].match(/matches ([\d.]+)% \[(-?[\d.]+), (-?[\d.]+)\]/);
  return { score: +s, lo: +lo, hi: +hi };
}
// two equal-size independent gates -> combined score and an approximate 95% interval
const combine = (a, b) => { const score = (a.score + b.score) / 2, half = Math.sqrt(((a.hi - a.lo) / 2) ** 2 + ((b.hi - b.lo) / 2) ** 2) / 2; return { score: +score.toFixed(1), lo: +(score - half).toFixed(1), hi: +(score + half).toFixed(1) }; };

async function gate(newSpec, oldSpec, s, label) {
  const pilot = gateResult(await node('scripts/pilot-arena.js', [newSpec, oldSpec, '--pairs', pairs, '--seed', s, ...(DRY ? [] : ['--seq'])].map(String), `${label} (pilot decks)`));
  say(`  pilot decks: ${pilot.score}% [${pilot.lo}, ${pilot.hi}]`);
  const pool = gateResult(await node('scripts/pilot-arena.js', [newSpec, oldSpec, '--pairs', pairs, '--seed', s + 50000, '--pool', ...(DRY ? [] : ['--seq'])].map(String), `${label} (pool decks)`));
  say(`  pool decks: ${pool.score}% [${pool.lo}, ${pool.hi}]`);
  const all = combine(pilot, pool);
  say(`  combined: ${all.score}% [${all.lo}, ${all.hi}] -> ${all.lo > 50 ? 'PASS' : 'no'}`);
  return { pilot, pool, all, pass: all.lo > 50 };
}

(async () => {
  const t0 = Date.now();
  const rec = { name, started: new Date().toISOString(), champion: champ.name, seed, matches };
  say(`== batch ${name}: champion ${champ.name}${champ.opts || ''}, ${matches} matches, gate up to ${pairs} pairs x2${DRY ? ' (DRY RUN)' : ''}`);
  const pilotsDir = path.join(ROOT, 'src', 'bot', 'pilots', 'state');
  const backup = DRY ? Object.fromEntries(fs.readdirSync(pilotsDir).filter(f => f.endsWith('.json')).map(f => [f, fs.readFileSync(path.join(pilotsDir, f))])) : null;
  try {
    // 1. league
    // (player / teacher settings: scripts/batch-config.js leagueArgs)
    const data = path.join(outDir, `data-${seed}.jsonl`);
    if (matches > 0) {
      await node('scripts/league.js', C.leagueArgs(state, matches, seed, outDir), '1/4 league');
      rec.data = rel(data);
      rec.games = fs.readFileSync(data, 'utf8').split('\n').filter(Boolean).length;
      say(`  ${rec.games} recorded games`);
    }
    // games from other machines (scripts/remote-league.js) made for this champion and not used by a batch yet
    const used = new Set(state.batches.flatMap(b => b.remote || []));
    rec.remote = [];
    if (fs.existsSync(C.REMOTE)) for (const f of fs.readdirSync(C.REMOTE).filter(f => /^league-\d+\.json$/.test(f))) {
      const m = JSON.parse(fs.readFileSync(path.join(C.REMOTE, f), 'utf8'));
      if (m.champion !== champ.name || used.has(m.seed)) continue;
      const out = path.join(outDir, `data-${m.seed}.jsonl`);
      if (!fs.existsSync(out)) fs.writeFileSync(out, zlib.gunzipSync(fs.readFileSync(path.join(C.REMOTE, `data-${m.seed}.jsonl.gz`))));
      rec.remote.push(m.seed); rec.games = (rec.games || 0) + m.games;
      say(`  + ${m.games} games from ${m.machine} (seed ${m.seed})`);
    }
    rec.extra = rec.remote.map(sd => rel(path.join(outDir, `data-${sd}.jsonl`)));
    if (!rec.data && !rec.extra.length) throw new Error('no games: --matches 0 and no remote games for this champion');
    const batchData = state.batches.flatMap(b => [b.data, ...(b.extra || [])]).filter(Boolean).concat(rec.data ? [rec.data] : [], rec.extra);
    say(`  training on ${rec.games} new games (${batchData.length} batch data files in all)`);

    // 2. train
    const rowsNew = path.join(outDir, `value-rows-${name}-new.jsonl`), rowsOld = path.join(outDir, `value-rows-${name}-old.jsonl`);
    await node('scripts/league-to-value.js', [...batchData, '--mix', '0.5', '--out', rowsNew], '2/4 value rows (batch data, 50/50 result/search)');
    await node('scripts/league-to-value.js', [...state.oldData.filter(f => fs.existsSync(path.join(ROOT, f))), '--mix', '1', '--out', rowsOld], '2/4 value rows (older rounds, results only)');
    const vOut = path.join(ROOT, 'notes', 'nets', `value-${name}.json`), pOut = path.join(ROOT, 'notes', 'nets', `policy-${name}.json`);
    const vtxt = await run(PY, [path.join(ROOT, 'scripts', 'train-value.py'), rowsOld, rowsNew, '--init', path.join(ROOT, champ.value), '--out', vOut, ...(DRY ? ['--epochs', '1'] : [])], '2/4 train value net');
    const ptxt = await run(PY, [path.join(ROOT, 'scripts', 'train-policy.py'), ...batchData.map(f => path.join(ROOT, f)), '--init', path.join(ROOT, champ.policy), '--informative-only', '--out', pOut,
      '--report', path.join(outDir, `policy-report-${name}.json`), ...(DRY ? ['--epochs', '1'] : [])], '2/4 train policy net');
    rec.valueLoss = (vtxt.match(/net ([\d.]+) \(([\d.]+)%\)/) || []).slice(1).map(Number);
    rec.policyBest = ((ptxt.match(/best-move net ([\d.]+)%/g) || []).pop() || '').replace('best-move net ', '');
    say(`  value net held-out: log loss ${rec.valueLoss[0]} (${rec.valueLoss[1]}% right) | policy: picks the search's best move ${rec.policyBest}`);
    const vSrc = `src/bot/value-net-${name}.json`, pSrc = `src/bot/policy-net-${name}.json`;
    fs.copyFileSync(vOut, path.join(ROOT, vSrc)); fs.copyFileSync(pOut, path.join(ROOT, pSrc));
    const chk = (await node('src/bot/value.js', [vSrc], '2/4 check value net')) + (await node('src/bot/pnet.js', [pSrc], '2/4 check policy net'));
    if (/MISMATCH/.test(chk)) throw new Error('JS forward pass does not match PyTorch - nets not used');
    rec.nets = { value: vSrc, policy: pSrc };

    // 3. gate (+ confirm on fresh seeds)
    const newSpec = spec(vSrc, pSrc), oldSpec = spec(champ.value, champ.policy);
    rec.gate = await gate(newSpec, oldSpec, gateSeed, '3/4 gate');
    if (rec.gate.pass) {
      rec.confirm = await gate(newSpec, oldSpec, gateSeed + 100000, '3/4 confirm (fresh seeds)');
    }
    rec.promoted = !!(rec.gate.pass && rec.confirm?.pass) && !DRY;

    // 4. promote or keep
    if (rec.promoted) {
      state.past = [oldSpec, ...state.past].slice(0, 3);
      state.champion = { name, value: vSrc, policy: pSrc, opts: champ.opts || '' };
      say(`4/4 PROMOTED: ${name} is the new champion (next batch plays with it). Daemon on the play page is unchanged until applied.`);
    } else say(`4/4 kept ${champ.name}: ${name} ${rec.gate.pass ? 'passed the gate but not the confirm' : 'did not pass the gate'}.`);
  } catch (e) {
    rec.error = e.message;
    say(`STOPPED: ${e.message}`);
  } finally {
    if (backup) for (const [f, buf] of Object.entries(backup)) fs.writeFileSync(path.join(pilotsDir, f), buf);
    if (DRY) for (const f of ['value-net-dry.json', 'policy-net-dry.json']) fs.rmSync(path.join(ROOT, 'src', 'bot', f), { force: true });
    rec.minutes = Math.round((Date.now() - t0) / 60000);
    if (!DRY && (rec.data || rec.extra?.length)) { state.batches.push(rec); fs.writeFileSync(STATE, JSON.stringify(state, null, 1)); }
    say(`== batch ${name} done in ${rec.minutes} min`);
    log.end();
    process.exitCode = rec.error ? 1 : 0;
  }
})();
