// The greedy policy with a pluggable position score: coach/policy.js chooseMove/botStep, but
// opts.ev picks the score (default: the coach's hand-tuned evaluate) and opts.sell the selling
// bonus. src/bot/tuned.js builds the tuned score; src/bot/strong.js plays out with this policy.
'use strict';
const { defaultPassAction } = require('../engine');
const policy = require('../coach/policy');

// policy.chooseMove with a pluggable evaluation
const FIGHT = new Set(['defensive_step', 'attacker_interrupt_step']);   // resolve: 'fight' settles only these
function chooseMove(wf, b, opts = {}) {
  // keep/mulligan by hand quality (src/bot/mulligan.js); opts.mull === 'old': the old score-based tie (always keeps)
  if (wf.step === 'mulligan_decision' && opts.mull !== 'old') return require('./mulligan').choose(b, wf, opts.rng || Math.random);
  const ev = opts.ev || policy.evaluate;
  const pid = wf.owner || b.active_player;
  // opts.filter(seq): only these moves (strong.js alt=1 plays the rest of a turn without attacks)
  const all = policy.moves(wf, b), kept = opts.filter ? all.filter(opts.filter) : all;
  const cands = kept.length ? kept : all;
  if (!cands.length) { const d = defaultPassAction(wf); return d ? [d] : null; }
  if (cands.length === 1) return cands[0];
  const scored = [];
  for (const seq of cands) {
    if (seq[seq.length - 1].step === 'end_turn') { scored.push({ seq, s: ev(b, pid) }); continue; }
    const r = policy.tryApply(b, wf, seq);
    if (!r) continue;
    // opts.resolve: score every choice after it plays out (settle) - without it a block is scored before the
    // fight happens, so greedy (almost) never blocks; strong.js gb=1 turns it on inside playouts
    const st = wf.step === 'main_phase' || (opts.resolve === 'fight' ? FIGHT.has(wf.step) : opts.resolve) ? policy.settle(r.board, r.waitingFor, pid) : r;
    let s = ev(st.board, pid);
    if (seq.some(a => a.step === 'sell_card')) s += opts.sell ?? 0.6;
    scored.push({ seq, s });
  }
  if (!scored.length) { const d = defaultPassAction(wf); return d ? [d] : null; }
  scored.sort((x, y) => y.s - x.s);
  const noise = opts.noise || 0;
  if (noise > 0 && opts.rng) {
    const top = scored.slice(0, 4);
    const w = top.map(x => Math.exp((x.s - top[0].s) / noise));
    let u = opts.rng() * w.reduce((a, c) => a + c, 0);
    for (let i = 0; i < top.length; i++) { u -= w[i]; if (u <= 0) return top[i].seq; }
  }
  return scored[0].seq;
}

function botStep(b, wf, opts) {
  let seq = chooseMove(wf, b, opts);
  let r = seq && policy.tryApply(b, wf, seq);
  if (!r) { const d = defaultPassAction(wf); r = d && policy.tryApply(b, wf, [d]); seq = d ? [d] : null; }
  if (!r) for (const m of policy.moves(wf, b)) { r = policy.tryApply(b, wf, m); if (r) { seq = m; break; } }
  return r ? { ...r, seq } : null;
}

module.exports = { chooseMove, botStep };
