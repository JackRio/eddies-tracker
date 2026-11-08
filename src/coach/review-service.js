// Game Review service for scripts/serve-board.js (board/review.html):
//   validate(json)          is this replay complete and usable? -> { ok, checks, info }
//   save(json, name?)       store an uploaded replay in board/replays/uploads/
//   start(name)             review every move on a worker pool -> job id; job(id) = progress
//   load(name)              a finished review (board/replays/coach/<name>.review.json)
//   branch(name, step)      the better move at replay step `step` played out on the board (frames in
//                           the play page's format, ids mapped to the replay's so the board animates)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');

const ROOT = path.join(__dirname, '..', '..');
const REPLAYS = path.join(ROOT, 'board', 'replays');
const UPLOADS = path.join(REPLAYS, 'uploads');
const OUT = path.join(REPLAYS, 'coach');
const DOWNLOADS = path.join(os.homedir(), 'Downloads');
const REPLAY_RE = /^cyberpunk-tcg-sim-replay-[\w.-]+\.json$/;
const outFile = name => path.join(OUT, name.replace(/\.json$/, '.review.json'));
// a review made by an older method counts as not reviewed
const current = name => { try { return JSON.parse(fs.readFileSync(outFile(name), 'utf8')).version >= require('./review').REVIEW_VERSION; } catch { return false; } };
// what the game lists show: reviewed by the current method (or an older one), players, result, accuracy
function reviewInfo(name) {
  try {
    const r = JSON.parse(fs.readFileSync(outFile(name), 'utf8')), V = require('./review').REVIEW_VERSION;
    return { reviewed: r.version >= V, old: r.version < V, you: r.you, rival: r.rival,
      won: r.result ? r.result.winnerId === r.me : null, accuracy: r.version >= V ? r.summary?.accuracy ?? null : null };
  } catch { return { reviewed: false }; }
}

function findReplay(name) {
  if (!REPLAY_RE.test(name)) return null;
  return [UPLOADS, DOWNLOADS, REPLAYS].map(d => path.join(d, name)).find(f => fs.existsSync(f)) || null;
}

function list() {
  const seen = new Map();
  for (const [dir, src] of [[UPLOADS, 'upload'], [DOWNLOADS, 'downloads'], [REPLAYS, 'shared']]) {
    try {
      for (const f of fs.readdirSync(dir).filter(f => REPLAY_RE.test(f))) if (!seen.has(f))
        seen.set(f, { name: f, src, date: (f.match(/replay-(\d{4}-\d\d-\d\d)/) || [])[1] || '', ...reviewInfo(f) });
    } catch { /* folder missing */ }
  }
  return [...seen.values()].sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
}

// ── validation ──────────────────────────────────────────────────────────────
function validate(json) {
  const checks = [], add = (level, text) => checks.push({ level, text });
  if (!json || json.format !== 'cyberpunk-tcg-replay' || !json.timeline?.frames || !json.timeline?.initialSnapshot) {
    add('error', 'Not a replay file from the simulator.');
    return { ok: false, checks };
  }
  if (json.schemaVersion !== 2) add('warn', `Replay format version ${json.schemaVersion}; this was built for version 2.`);
  // the export's own checksum: sha256 of the file without its "integrity" field
  if (json.integrity?.digest) {
    const { integrity, ...rest } = json;
    const ok = crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex') === integrity.digest;
    add(ok ? 'ok' : 'warn', ok ? 'File complete and unedited (checksum matches).' : "Checksum doesn't match: the file was cut short or edited.");
  } else add('warn', 'No checksum in the file.');
  const tl = json.timeline;
  // frameCount counts the initial snapshot too
  if (tl.frameCount != null && tl.frameCount !== tl.frames.length + 1 && tl.frameCount !== tl.frames.length) add('error', `${tl.frames.length} of ${tl.frameCount - 1} actions present.`);
  else add('ok', `${tl.frames.length} actions.`);
  const m = json.match, me = m.perspective?.playerId;
  if (!me || !m.players?.some(p => p.playerId === me)) { add('error', "The file doesn't say which player you are."); return { ok: false, checks }; }
  const labels = Object.fromEntries(m.players.map(p => [p.playerId, p.label]));
  const rival = m.players.find(p => p.playerId !== me)?.playerId;
  if (m.result?.winnerId) add('ok', `Game finished: ${m.result.winnerId === me ? 'you won' : 'you lost'} (${m.result.reason}).`);
  else add('warn', 'No result: the game was not finished. Turns played so far are reviewed.');

  // replay it: every patch must apply, and every card must be one the engine knows
  let info = { you: labels[me], rival: labels[rival], result: m.result || null, startedAt: m.startedAt };
  try {
    const { allStates, cardKnowledge } = require('./sim');
    const { engineCard } = require('./cards');
    const states = allStates(json);
    const unknown = new Set();
    for (const k of cardKnowledge(states).values()) if (!engineCard(k.name) && !engineCard(k.cardId)) unknown.add(k.name);
    if (unknown.size) add('warn', `Cards the engine doesn't know: ${[...unknown].slice(0, 6).join(', ')}${unknown.size > 6 ? '…' : ''}. Moves with them may be skipped.`);
    else add('ok', 'Every card is known to the engine.');
    const { turnPositions } = require('./positions');
    const turns = turnPositions(states, me).filter(T => T.ended).length;
    if (!turns) add('error', 'None of your turns finished in this replay.');
    else add('ok', `${turns} of your turns to review.`);
    info = { ...info, turns, last: states[states.length - 1].state.game.turnNumber };
  } catch (e) {
    add('error', `The replay doesn't play back: ${e.message}`);
  }
  return { ok: !checks.some(c => c.level === 'error'), checks, info };
}

function save(json) {
  const m = json.match;
  const me = m.perspective?.playerId, rv = m.players.find(p => p.playerId !== me)?.playerId;
  const lab = id => String(m.players.find(p => p.playerId === id)?.label || id).toLowerCase().replace(/[^a-z0-9_]+/g, '');
  const first = m.players[0]?.playerId === me ? `${lab(me)}-vs-${lab(rv)}` : `${lab(rv)}-vs-${lab(me)}`;
  const name = `cyberpunk-tcg-sim-replay-${String(m.startedAt || '').slice(0, 10) || 'undated'}-${first}-${String(m.matchId || Date.now()).slice(0, 8)}.json`;
  fs.mkdirSync(UPLOADS, { recursive: true });
  fs.writeFileSync(path.join(UPLOADS, name), JSON.stringify(json));
  return name;
}

// ── jobs ────────────────────────────────────────────────────────────────────
const JOBS = new Map();
let nextJob = 1;
const WORKER = path.join(__dirname, 'review-worker.js');

function start(name, { force = false } = {}) {
  for (const j of JOBS.values()) if (j.name === name && j.status === 'running') return j.id;
  if (!force && current(name)) { const id = String(nextJob++); JOBS.set(id, { id, name, status: 'done', done: 1, total: 1 }); return id; }
  const file = findReplay(name);
  if (!file) throw new Error('replay not found');
  const R = require('./review');
  const P = R.prepare(file);
  const turns = R.turnsOf(P);
  const tasks = [];
  turns.forEach((x, ti) => x.moves.forEach((m, mi) => tasks.push({ ti, mi })));
  const id = String(nextJob++);
  const job = { id, name, status: 'running', done: 0, total: tasks.length, t0: Date.now(), results: turns.map(x => ({ turn: x.T.turn, stepA: x.T.a, moves: new Array(x.moves.length).fill(null) })) };
  JOBS.set(id, job);
  const n = Math.max(1, Math.min(tasks.length, os.cpus().length - 1));
  const queue = tasks.slice();
  let live = n;
  // the review so far: every turn whose moves are all graded (the page shows these while the rest runs)
  job.snap = () => {
    const turnsOut = job.results.filter(t => t.moves.every(Boolean));
    return { ...R.meta(P, file), partial: true, done: job.done, total: job.total, summary: R.summary(turnsOut), turns: turnsOut, errors: job.errors || [] };
  };
  const finish = () => {
    if (job.status !== 'running') return;
    const turnsOut = job.results.map(t => ({ ...t, moves: t.moves.filter(Boolean) })).filter(t => t.moves.length);
    const out = { ...R.meta(P, file), seconds: Math.round((Date.now() - job.t0) / 1000), summary: R.summary(turnsOut), turns: turnsOut, errors: job.errors || [] };
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(outFile(name), JSON.stringify(out, null, 1));
    job.status = 'done'; delete job.results; delete job.snap;
  };
  for (let i = 0; i < n; i++) {
    const w = new Worker(WORKER, { workerData: { file } });
    const next = () => { const t = queue.shift(); if (!t) { w.terminate(); if (--live === 0) finish(); return; } w.postMessage(t); };
    w.on('message', msg => {
      if (msg.ok) job.results[msg.ti].moves[msg.mi] = msg.move;
      else (job.errors ||= []).push(msg.error);
      job.done++;
      next();
    });
    w.on('error', e => { (job.errors ||= []).push(String(e)); if (--live === 0) finish(); });
    next();
  }
  return id;
}
function job(id) {
  const j = JOBS.get(id);
  return j ? { id: j.id, name: j.name, status: j.status, done: j.done, total: j.total, seconds: j.t0 ? Math.round((Date.now() - j.t0) / 1000) : 0 } : null;
}
function load(name) {
  for (const j of JOBS.values()) if (j.name === name && j.status === 'running' && j.snap) return j.snap();
  if (!current(name)) return null;
  try { return JSON.parse(fs.readFileSync(outFile(name), 'utf8')); } catch { return null; }
}

// ── the better move, on the board ──────────────────────────────────────────
const PREP = new Map();
function prepared(name) {
  if (!PREP.has(name)) { const f = findReplay(name); if (!f) return null; PREP.set(name, require('./review').prepare(f)); }
  return PREP.get(name);
}
const BCACHE = new Map();
function branch(name, from) {
  const key = `${name}#${from}`;
  if (BCACHE.has(key)) return BCACHE.get(key);
  const rev = load(name), P = prepared(name);
  if (!rev || !P) return null;
  const m = rev.turns.flatMap(t => t.moves).find(x => x.from === from);
  if (!m?.best?.seq) return null;
  const { boardAt } = require('./review');
  const A = boardAt(P, from, 1);
  const labels = { p1: P.R.labels.player1, p2: P.R.labels.player2 };
  const out = require('../bot/play').branch(A.board, A.waitingFor, P.pid, m.best.seq, labels);
  // ids: the bridge shortened the replay's card ids; give the frames the replay's own ids back
  const st = P.states[from].state, ids = new Map();
  const walk = o => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') { if (typeof o.id === 'string') ids.set(require('./bridge').iidOf(o.id), o.id); for (const v of Object.values(o)) walk(v); } };
  walk(st.players);
  for (const [sid, S] of Object.entries(st.players)) for (const d of S.gigDice || []) ids.set(`${P.ctx.pidMap[d.originalOwnerId] || P.ctx.pidMap[sid]}_d${d.sides}`, d.id);
  const fix = o => {
    if (Array.isArray(o)) return o.forEach(fix);
    if (!o || typeof o !== 'object') return;
    for (const k of ['id', 'attackerId', 'targetId', 'blockerId']) if (typeof o[k] === 'string' && ids.has(o[k])) o[k] = ids.get(o[k]);
    for (const v of Object.values(o)) fix(v);
  };
  out.steps.forEach(s => fix(s.state));
  BCACHE.set(key, out);
  return out;
}

module.exports = { list, validate, save, start, job, load, branch, findReplay, REPLAY_RE };
