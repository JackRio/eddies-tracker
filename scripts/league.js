// The pilots' league: Bo3 matches between the four archetype pilots (BBG, YYR, RRG, RGB), mirrors, and
// a field of every other deck we have (ChoomBattler + engine test lists, your published decks, the
// coverage decks), all played by the same search bot. After every match each pilot updates what it
// learns outside the nets (src/bot/pilot.js): go first or second, sideboard plans per opponent, and
// its deck (champion vs one-card challenger). With --record, every searched decision is kept for
// training the nets (policy-data format, one game per line).
//
//   node scripts/league.js [--matches N] [--workers N] [--bot strong] [--pilots BBG,YYR,RRG,RGB]
//                          [--mix 0.5] [--mirror 0.1] [--record] [--out notes/league] [--seed S]
//                          [--teach 0.15] [--teacher strong:deals=24:k=10]
//                          [--fresh] (re-seed the pilots from ChoomBattler, dropping learned state)
// --mix: share of matches against another pilot (the rest: mirror / field). Field decks have no
// sideboard and don't learn.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const ROOT = path.join(__dirname, '..');

// ── worker: plays one match from a fully specified job ──
if (!isMainThread) {
  const { playMatch } = require('../src/bot/match');
  const { makeBot } = require('../src/bot/bots');
  const P = require('../src/bot/pilot');
  const bots = new Map();
  const botFor = spec => { if (!bots.has(spec)) bots.set(spec, makeBot(spec)); return bots.get(spec); };
  const side = s => ({
    key: s.key, bot: botFor(s.bot), deck: s.deck, record: s.record,
    choose: rng => (s.state ? P.chooseFirst(s.state, s.opp, rng) : rng() < 0.6),   // field: mostly go first (59.5% for the field)
    // sideboarding is on hold (too noisy to learn yet): games 2-3 use the registered deck unless --sideboard
    sideboard: s.state && workerData.sideboard ? (d, opp, rng) => P.chooseSideboard(s.state, d, opp, rng) : null,
  });
  parentPort.on('message', job => {
    if (!job) return process.exit(0);
    const t = Date.now();
    let m;
    const teacher = workerData.teach ? { bot: botFor(workerData.teacher), rate: workerData.teach } : null;
    try { m = playMatch(side(job.A), side(job.B), job.seed, { record: workerData.record, teacher, onGame: g => parentPort.postMessage({ game: g, job: { k: job.k, A: job.A.key, B: job.B.key } }) }); } catch (e) { m = { error: e.stack }; }
    parentPort.postMessage({ job, m, ms: Date.now() - t });
  });
  parentPort.postMessage({ ready: true });
  return;
}

// ── main ──
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const matches = +flag('--matches', 40);
const workers = Math.min(+flag('--workers', Math.max(1, os.cpus().length - 1)), matches);
const botSpec = flag('--bot', 'strong:vnet=src/bot/value-net-r3.json:pnet=src/bot/policy-net-r3.json:prior=mix:gb=1:alt=1:tb=1');   // the current best Bot A
const pilotIds = flag('--pilots', 'BBG,YYR,RRG,RGB').split(',');
const mix = +flag('--mix', 0.5), mirror = +flag('--mirror', 0.1);
const record = args.includes('--record');
// --past A,B: earlier Bot A versions (bot specs); a --past-share of matches gives the opponent to one of
// them, so the bot keeps beating its old selves too (against rock-paper-scissors cycling between
// rounds). Their decisions are never recorded and their side learns nothing (pilot stats stay clean).
const PAST = (flag('--past', '') || '').split(',').filter(Boolean), pastShare = +flag('--past-share', 0.2);
// --teach R: a deeper search re-scores a share R of the undecided decisions (training targets + 'mistakes')
const teach = +flag('--teach', 0), teacherSpec = flag('--teacher', 'strong:vnet=src/bot/value-net-r3.json:pnet=src/bot/policy-net-r3.json:prior=mix:gb=1:alt=1:tb=1:deals=24:k=10');
const outDir = path.resolve(flag('--out', path.join(ROOT, 'notes', 'league')));
const seed0 = +flag('--seed', Date.now() % 1e6);
fs.mkdirSync(outDir, { recursive: true });

const P = require('../src/bot/pilot');
const { loadDecks, TRAIN_DIRS } = require('../src/bot/arena');
const { publishedDecks } = require('../src/coach/cards');
const { mulberry } = require('../src/coach/bridge');
const rng = mulberry(seed0);

if (args.includes('--fresh')) for (const id of pilotIds) { const f = path.join(P.STATE_DIR, `${id}.json`); if (fs.existsSync(f)) fs.renameSync(f, f.replace(/\.json$/, `.${Date.now()}.bak.json`)); }
const states = Object.fromEntries(pilotIds.map(id => [id, P.load(id)]));

// the field: every legal list we have, as { key, legends, main }
const toMain = cards => { const m = {}; for (const { card_id, count } of cards) m[card_id] = (m[card_id] || 0) + count; return m; };
const field = [];
for (const d of loadDecks(TRAIN_DIRS)) field.push({ key: `deck:${d.name.replace(/\.txt$/, '')}`, legends: d.legends, main: toMain(d.cards) });
for (const d of publishedDecks()) {
  const main = Object.fromEntries(d.cards);
  if (P.legal(d.legends, main, null)) field.push({ key: `pub:${d.name}`, legends: d.legends, main });
}
// community lists (scripts/fetch-netdeck.js): a --net-share of field matches, weighted 1 + likes so liked
// lists come up more often but every legal list can appear
const netShare = +flag('--net-share', 0.5);
const netField = [];
const NET_DIR = path.join(ROOT, 'src', 'bot', 'field-decks', 'netdeck');
for (const d of loadDecks([NET_DIR])) {
  const head = fs.readFileSync(path.join(NET_DIR, d.name), 'utf8').split('\n')[0];
  const likes = +(head.match(/, (\d+) likes/) || [0, 0])[1];
  netField.push({ key: `net:${d.name.replace(/\.txt$/, '')}`, legends: d.legends, main: toMain(d.cards), w: 1 + likes });
}
const netTotal = netField.reduce((a, f) => a + f.w, 0);
const pickNet = () => { let x = rng() * netTotal; for (const f of netField) { x -= f.w; if (x <= 0) return f; } return netField[netField.length - 1]; };
console.log(`league: ${matches} matches, ${workers} workers, bot ${botSpec}, pilots ${pilotIds.join(' ')}, field ${field.length} decks + ${netField.length} netdeck lists${record ? ', recording' : ''}${PAST.length ? `, past bots ${PAST.join(' | ')} in ${Math.round(100 * pastShare)}% of matches` : ''}`);

// a job: pilot A vs (pilot B | itself | field deck)
// --general G: a share G of matches is two decks from the whole pool (field lists + netdeck lists, liked
// ones more often), both sides recording - the bot practises every deck, not just the pilots'. The rest
// are the usual pilot matches (pilots keep learning go-first and deck tuning).
const generalShare = +flag('--general', 0);
const pickPool = () => (netField.length && rng() < netShare ? pickNet() : field[Math.floor(rng() * field.length)]);
function makeJob(k) {
  if (generalShare && rng() < generalShare) {
    const fa = pickPool(); let fb = pickPool();
    for (let t = 0; t < 5 && fb.key === fa.key; t++) fb = pickPool();
    const A = { key: fa.key, bot: botSpec, deck: { legends: fa.legends, main: fa.main, side: {} }, state: null, opp: fb.key };
    const B = { key: fb.key, bot: botSpec, deck: { legends: fb.legends, main: fb.main, side: {} }, state: null, opp: fa.key };
    if (PAST.length && rng() < pastShare) { B.bot = PAST[Math.floor(rng() * PAST.length)]; B.record = false; B.past = true; }
    return { k, A, B, seed: seed0 + k * 7919, general: true };
  }
  const a = pilotIds[k % pilotIds.length];
  const SA = states[a];
  const regA = P.registerDeck(SA, rng);
  const u = rng();
  let B, oppKey;
  if (u < mix && pilotIds.length > 1) {
    const b = pilotIds.filter(x => x !== a)[Math.floor(rng() * (pilotIds.length - 1))];
    const SB = states[b];
    const regB = { main: SB.champion.main, side: SB.champion.side, challenger: false };   // the opponent plays its champion
    oppKey = b;
    B = { key: b, bot: botSpec, deck: { legends: SB.legends, main: regB.main, side: regB.side }, state: SB, opp: a, pilot: b };
  } else if (u < mix + mirror) {
    oppKey = a;
    B = { key: a, bot: botSpec, deck: { legends: SA.legends, main: SA.champion.main, side: SA.champion.side }, state: SA, opp: a, pilot: a, mirror: true };
  } else {
    const f = netField.length && rng() < netShare ? pickNet() : field[Math.floor(rng() * field.length)];
    oppKey = f.key;
    B = { key: f.key, bot: botSpec, deck: { legends: f.legends, main: f.main, side: {} }, state: null, opp: a };
  }
  if (PAST.length && rng() < pastShare) { B.bot = PAST[Math.floor(rng() * PAST.length)]; B.record = false; B.past = true; }
  const A = { key: a, bot: botSpec, deck: { legends: SA.legends, main: regA.main, side: regA.side }, state: SA, opp: oppKey, pilot: a, challenger: regA.challenger };
  return { k, A, B, seed: seed0 + k * 7919 };
}

const matchesFile = fs.createWriteStream(path.join(outDir, 'matches.jsonl'), { flags: 'a' });
const gamesFile = record ? fs.createWriteStream(path.join(outDir, `games-${seed0}.jsonl`), { flags: 'a' }) : null;   // full move lists (rebuild any position)
const dataFile = record ? fs.createWriteStream(path.join(outDir, `data-${seed0}.jsonl`), { flags: 'a' }) : null;
const t0 = Date.now();
let next = 0, done = 0, games = 0, recs = 0, teachN = 0, mistakes = 0;
const tally = {};   // pilot -> { vs -> [w, n] }

function learn(job, m) {
  const sides = [['A', job.A], ['B', job.B]];
  for (const [who, s] of sides) {
    if (!s.pilot || s.past) continue;
    const st = states[s.pilot];
    const meWon = m.winner === who;
    for (const g of m.games) {
      const iFirst = who === 'A' ? g.aFirst : !g.aFirst;
      const won = g.winner === who;
      P.recordFirst(st, s.opp, iFirst, won);   // every game says something about first vs second vs this opponent
      const plan = who === 'A' ? g.planA : g.planB;
      if (plan) P.recordSideboard(st, s.opp, plan, won);
    }
    if (who === 'A' && s.pilot && !s.mirror && !job.B.mirror) {
      const v = P.recordTuning(st, !!s.challenger, meWon, rng);
      if (v) { const h = st.history[st.history.length - 1]; console.log(`  ${st.id} ${v}: ${h.change.kind} -${h.change.outName} +${h.change.inName} (challenger ${h.chall[0]}/${h.chall[1]} vs champion ${h.champ[0]}/${h.champ[1]}, P(better) ${h.p})`); }
    }
    if (who === 'A' || !job.B.mirror) st.matches++;
    const t = (tally[s.pilot] ||= {}), key = /^(deck|pub|net):/.test(s.opp) ? 'field' : s.opp;
    const r = (t[key] ||= [0, 0]); r[1]++; if (meWon) r[0]++;
  }
}

function report() {
  const lines = Object.entries(tally).map(([p, t]) => `${p}: ` + Object.entries(t).map(([k, [w, n]]) => `${k} ${w}/${n}`).join(', '));
  console.log(`  ${done}/${matches} matches, ${games} games, ${recs} decisions recorded (${teachN} re-scored by the teacher, ${mistakes} where it beat the played move by 3+ points), ${Math.round((Date.now() - t0) / 60000)} min\n    ` + lines.join('\n    '));
}

for (let w = 0; w < workers; w++) {
  const worker = new Worker(__filename, { workerData: { record, teach, teacher: teacherSpec, sideboard: args.includes('--sideboard') } });
  const feed = () => worker.postMessage(next < matches ? makeJob(next++) : null);
  worker.on('message', msg => {
    if (msg.ready) return feed();
    if (msg.game) {   // one line per finished game
      const { game: g, job: j } = msg, nm = x => x.replace(/^(deck|pub):/, '');
      const [a, b] = [nm(j.A), nm(j.B)], win = g.winner === 'A' ? a : g.winner === 'B' ? b : null;
      const first = g.aFirst ? a : b, ch = g.chooser === 'A' ? a : b;
      console.log(`  [${new Date().toLocaleTimeString()}] match ${j.k} game ${g.g}: ${win ? `${win} beat ${win === a ? b : a}` : `${a} vs ${b} no winner`} in ${g.turns} turns. ${ch} won the D20 (${g.d20[0]}-${g.d20[1]}), ${first} went first.${g.error ? ` Error: ${g.error}` : ''}`);
      return;
    }
    const { job, m, ms } = msg;
    done++;
    if (m.error) console.log(`  match ${job.k} error: ${m.error.split('\n')[0]}`);
    else {
      games += m.games.length;
      learn(job, m);
      matchesFile.write(JSON.stringify({ k: job.k, seed: job.seed, A: job.A.key, B: job.B.key, challenger: !!job.A.challenger, ...(job.general ? { general: true } : {}), ...(job.B.past ? { pastBot: job.B.bot } : {}), winner: m.winner, score: m.score, ms,
        games: m.games.map(g => ({ g: g.g, d20: g.d20, chooser: g.chooser, aFirst: g.aFirst, winner: g.winner, turns: g.turns, planA: g.planA, planB: g.planB, seed: g.seed, error: g.error })),
        decks: { A: job.A.deck, B: job.B.deck } }) + '\n');
      if (gamesFile) for (const g of m.games) if (g.actions) gamesFile.write(JSON.stringify({ g: g.seed, match: job.k, A: job.A.key, B: job.B.key, first: g.first, winner: g.winner, decks: g.decks, actions: g.actions }) + '\n');
      if (dataFile) for (const g of m.games) if (g.recs?.length && g.winner) {
        teachN += g.recs.filter(r => r.teach).length; mistakes += g.recs.filter(r => r.mistake).length;
        // pid p1 = side A in every game; winner as the engine pid
        recs += g.recs.length;
        dataFile.write(JSON.stringify({ g: g.seed, winner: g.winner === 'A' ? 'p1' : 'p2', match: job.k, A: job.A.key, B: job.B.key, recs: g.recs }) + '\n');
      }
      for (const st of Object.values(states)) P.save(st);
    }
    if (done % Math.max(1, Math.floor(matches / 10)) === 0 || done === matches) report();
    if (done === matches) { matchesFile.end(); dataFile?.end(); }
    feed();
  });
  worker.on('error', e => { console.error(e); process.exit(1); });
}
