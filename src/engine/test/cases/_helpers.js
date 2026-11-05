// Shared helpers for test/cases/*.test.js. Not a test itself (no .test.js suffix).
//
// The engine under test is ENGINE_DIR if set (e.g. the unpatched baseline), else src/engine.
// Each test should FAIL (non-zero exit via node:assert) on the baseline and PASS on the fix.
//
// API (keep it small):
//   E                      the engine module (setupGame, step, defaultPassAction, CARDS, ...)
//   ENGINE_DIR             resolved engine path
//   card(id)               cards.json entry by number, e.g. card('WNTC-011')
//   deck(name)             deckDef from test/decks/<name>.txt (default '4-red-2-green-standard')
//   newGame(opts)          setupGame(deck p1, deck p2, opts.first||'p1', {seed, mulligan:false, skipValidation:true, ...opts.setup})
//                          opts: { p1, p2, first, seed, setup } — p1/p2 are deckDefs (default deck()).
//                          Returns the BOARD (not started): call E.step(board, undefined) to begin turn 1.
//   unit(b, pid, card_id, extra)   put a unit on pid's field (ready, entered turn 0 = no Lag); returns it
//   eddies(b, pid, n, prefix)      add n ready Eddies to pid; returns their iids
//   run(r, stopFn, chooser)        keep stepping from result r with chooser(wf, board) || defaultPassAction(wf)
//                                  until stopFn(r) is true or the game ends / nothing to do. Returns r.
//                                  The default chooser accepts optional prompts and picks the first iid.
//   pickFirst(wf)                  that default chooser, exported so tests can wrap it
'use strict';
const path = require('path');
const fs = require('fs');

const ENGINE_DIR = process.env.ENGINE_DIR || path.resolve(__dirname, '../..');
const E = require(ENGINE_DIR);
const DB = Object.fromEntries(E.CARDS.map(c => [c.number, c]));

const card = id => DB[id];

const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const byName = new Map();
for (const c of E.CARDS) { const k = norm(c.name); if (!byName.has(k)) byName.set(k, c); }

function deck(name = '4-red-2-green-standard') {
  const file = path.resolve(__dirname, '../decks', name + '.txt');
  const legends = [], cards = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^(\d+)\s+(.+)$/); if (!m) continue;
    const c = byName.get(norm(m[2])); if (!c) continue;
    if (c.type === 'Legend') legends.push(c.number); else cards.push({ card_id: c.number, count: +m[1] });
  }
  return { legends, cards };
}

function newGame(opts = {}) {
  return E.setupGame(opts.p1 || deck(), opts.p2 || deck(), opts.first || 'p1',
    { seed: opts.seed ?? 1, mulligan: false, skipValidation: true, ...(opts.setup || {}) });
}

function unit(b, pid, card_id, extra = {}) {
  const u = { iid: extra.iid || `${pid}_${card_id}_${Math.random().toString(36).slice(2, 7)}`,
              card_id, state: 'ready', equipped_gear: [], entered_play_turn: 0, ...extra };
  b[pid].zones.field.push(u);
  return u;
}

function eddies(b, pid, n, prefix = `${pid}_E`) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const iid = `${prefix}${i}`;
    b[pid].zones.eddies.push({ iid, card_id: 'WNTC-012', state: 'ready' });
    out.push(iid);
  }
  return out;
}

function pickFirst(wf) {
  if (wf.step !== 'effect_choice') return null;
  const cn = wf.choice_needed || {};
  if (cn.kind === 'confirm_optional') return { step: 'effect_choice_response', response: { accept: true } };
  const ids = cn.available_iids || [];
  return { step: 'effect_choice_response', response: { iid: ids.length ? (ids[0].iid || ids[0]) : null } };
}

function run(r, stopFn = () => false, chooser = pickFirst) {
  for (let i = 0; i < 200; i++) {
    if (stopFn(r) || r.status !== 'waiting' || !r.waitingFor) return r;
    const inp = chooser(r.waitingFor, r.board) || pickFirst(r.waitingFor) || E.defaultPassAction(r.waitingFor);
    if (!inp) return r;
    r = E.step(r.board, inp);
  }
  throw new Error('run(): no progress after 200 steps');
}

// mainBoard(opts): newGame(opts) stepped to p1's turn-1 Main phase (first Gig die
// rolled), with both fields and hands emptied. p2 has no Gigs yet. Returns the BOARD.
// mainWaiting(b): the main_phase waitingFor the engine would show for board b.
function mainBoard(opts = {}) {
  const r = run(E.step(newGame(opts), undefined), x => x.waitingFor?.step === 'main_phase',
                wf => wf.step === 'choose_gig_die' ? { step: 'choose_gig_die', sides: wf.available[0] } : null);
  const b = r.board;
  for (const p of ['p1', 'p2']) { b[p].zones.field = []; b[p].zones.hand = []; }
  return b;
}
const mainWaiting = b => require(path.join(ENGINE_DIR, 'lib/combat')).mainWaiting(structuredClone(b)).waitingFor;
const gig = (iid, sides, value, pid) => ({ iid, sides, value, origin_pid: pid });

module.exports = { E, ENGINE_DIR, card, deck, newGame, unit, eddies, run, pickFirst, mainBoard, mainWaiting, gig };
