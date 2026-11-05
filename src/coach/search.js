// Turn plans and rollouts.
//   playTurn    - the bot plays pid's turn from a main-phase position, stopping just before
//                 end_turn; returns the end position and every move made (a "plan").
//   replayPlan  - re-run a recorded plan on another determinization of the same position; moves
//                 that no longer apply (a hidden card came out different) are re-chosen by the bot.
//   rollout     - from an end-of-turn position, end the turn and let the bot play both sides for
//                 `depth` more turns (or to the end); returns pid's win chance in [0, 1].
'use strict';
const { step } = require('../engine');
const { botStep, tryApply, evaluate, winProb, opp, nm, card } = require('./policy');

function playTurn(b, wf, pid, opts) {
  const turn = b.turn_number, plan = [];
  for (let i = 0; i < (opts.maxSteps || 80); i++) {
    if (!wf || b.winner || b.turn_number !== turn || b.active_player !== pid) break;
    const r = botStep(b, wf, opts);
    if (!r) break;
    if (r.seq[r.seq.length - 1].step === 'end_turn') break;       // stop before ending: caller decides
    plan.push({ owner: wf.owner || b.active_player, seq: r.seq, before: b, prompt: wf.choice_needed?.prompt });
    b = r.board; wf = r.waitingFor;
  }
  return { board: b, waitingFor: wf, plan, finished: !!b.winner || b.turn_number !== turn };
}

function replayPlan(b, wf, pid, plan, opts) {
  const turn = b.turn_number;
  let diverged = 0;
  for (const m of plan) {
    if (!wf || b.winner || b.turn_number !== turn) break;
    const owner = wf.owner || b.active_player;
    let r = owner === m.owner ? tryApply(b, wf, m.seq) : null;
    if (!r) { diverged++; r = botStep(b, wf, opts); if (!r) break; }
    b = r.board; wf = r.waitingFor;
  }
  // the plan may end mid-sequence for this deal (e.g. an extra prompt): finish pending prompts
  for (let i = 0; i < 20 && wf && !b.winner && b.turn_number === turn && wf.step !== 'main_phase'; i++) {
    const r = botStep(b, wf, opts); if (!r) break; b = r.board; wf = r.waitingFor;
  }
  return { board: b, waitingFor: wf, diverged };
}

function rollout(b, wf, pid, opts) {
  const start = b.turn_number;
  if (!b.winner && b.turn_number === start && b.active_player === pid && wf?.step === 'main_phase') {
    const r = tryApply(b, wf, [{ step: 'end_turn' }]);
    if (!r) return { p: winProb(evaluate(b, pid)), turns: 0, ended: false, atEnd: null, afterRival: null, afterMine: null };
    b = r.board; wf = r.waitingFor;
  }
  // snapshots for the "why": after the Rival's reply (start+1) and after your next turn (start+2)
  const snap = () => ({ gigs: b[pid].zones.gigs.length, rivalGigs: b[opp(pid)].zones.gigs.length,
    units: b[pid].zones.field.length, rivalUnits: b[opp(pid)].zones.field.length, winner: b.winner || null });
  const atEnd = snap();
  let afterRival = null, afterMine = null;
  let steps = 0;
  while (wf && !b.winner && b.turn_number <= start + (opts.depth ?? 40) && steps++ < (opts.maxSteps || 4000)) {
    const r = botStep(b, wf, opts);
    if (!r) break;
    b = r.board; wf = r.waitingFor;
    if (!afterRival && b.turn_number >= start + 2) afterRival = snap();
    if (!afterMine && b.turn_number >= start + 3) afterMine = snap();
  }
  afterRival ||= snap(); afterMine ||= snap();
  const base = { turns: b.turn_number - start, ended: !!b.winner, atEnd, afterRival, afterMine };
  if (b.winner) return { ...base, p: b.winner === pid ? 1 : 0 };
  return { ...base, p: winProb(evaluate(b, pid)) };
}

// ─── words ─────────────────────────────────────────────────────────────────
function findRef(b, iid) {
  for (const p of ['p1', 'p2']) {
    const Z = b[p].zones;
    for (const z of ['hand', 'field', 'legends', 'trash', 'eddies', 'deck']) {
      for (const r of Z[z]) {
        if (r.iid === iid) return { r, p, z };
        for (const g of r.equipped_gear || []) if (g.iid === iid) return { r: g, p, z: 'gear' };
      }
    }
  }
  return null;
}
let viewer = 'p1';   // whose words "your"/"the Rival's" are from; set by describePlan
function dieName(b, iid) {
  for (const p of ['p1', 'p2']) {
    const g = b[p].zones.gigs.find(x => x.iid === iid);
    if (g) return `${p === viewer ? 'your' : "the Rival's"} d${g.sides} (${g.value})`;
  }
  const m = String(iid).match(/^(p[12])_d(\d+)$/);
  return m ? `d${m[2]}` : null;
}
const nameOf = (b, iid) => { const f = findRef(b, iid); return f ? nm(f.r.card_id) : dieName(b, iid) || 'a hidden card'; };

// One line per meaningful move of `pid` (taps folded into the move they pay for).
function describePlan(plan, pid) {
  viewer = pid;
  const lines = [];
  for (const { owner, seq, before: b, prompt } of plan) {
    if (owner !== pid) continue;
    const a = seq[seq.length - 1];
    switch (a.step) {
      case 'sell_card': lines.push(`Sell ${nameOf(b, a.iid)}`); break;
      case 'play_card': lines.push(a.equip_to ? `Play ${nameOf(b, a.iid)} on ${nameOf(b, a.equip_to)}` : `Play ${nameOf(b, a.iid)}`); break;
      case 'call_legend': lines.push(`Call ${nameOf(b, a.iid)}`); break;
      case 'play_legend_solo': lines.push(`${nameOf(b, a.iid)} goes Solo`); break;
      case 'activate_anytime_spend': lines.push(`Use ${nameOf(b, a.iid)}`); break;
      case 'declare_attack': lines.push(a.target.kind === 'gigs' ? `Attack the Rival's Gigs with ${nameOf(b, a.attacker_iid)}` : `Attack ${nameOf(b, a.target.iid)} with ${nameOf(b, a.attacker_iid)}`); break;
      case 'choose_gig_to_steal': lines.push(`  steal ${a.iids.map(i => nameOf(b, i)).join(' and ')}`); break;
      case 'blocker': lines.push(`Block with ${nameOf(b, a.iid)}`); break;
      case 'call_legend_defensive': lines.push(`Call ${nameOf(b, a.iid)} during the Rival's attack`); break;
      case 'play_card_interrupt_cast': lines.push(`Play ${nameOf(b, a.iid)}`); break;
      case 'effect_choice_response': {
        const r = a.response;
        const what = prompt && !/^(Choose|Click)/.test(prompt) ? ` - ${prompt}` : '';
        if (r.acknowledge) break;
        if (r.card_type) lines.push(`  name ${r.card_type}${what}`);
        else if (r.accept === false) lines.push(`  skip the optional effect${what}`);
        else if (r.accept === true) lines.push(`  use the optional effect${what}`);
        else if (r.iid) lines.push(`  pick ${nameOf(b, r.iid)}${what}`);
        else if (r.selected_iids?.length) lines.push(`  pick ${r.selected_iids.map(i => nameOf(b, i)).join(', ')}${what}`);
        else if (r.selected_iids) lines.push(`  pick nothing${what}`);
        else if (r.amount !== undefined) lines.push(`  ${r.amount > 0 ? '+' : ''}${r.amount}${what}`);
        break;
      }
      default: break;
    }
  }
  // fold consecutive duplicate prompt lines
  return lines.filter((l, i) => !(l.startsWith('  ') && l === lines[i - 1]));
}

// What changed for each side between two positions - the "why" of a comparison.
function outcome(b, pid) {
  const me = b[pid].zones, rv = b[opp(pid)].zones;
  const pw = Z => Z.field.reduce((a, u) => a + (card(u.card_id).power || 0) + (u.equipped_gear || []).reduce((x, g) => x + (card(g.card_id).power || 0), 0), 0);
  return {
    gigs: me.gigs.length, rivalGigs: rv.gigs.length,
    units: me.field.length, rivalUnits: rv.field.length,
    power: pw(me), rivalPower: pw(rv),
    readyUnits: me.field.filter(u => u.state === 'ready').length,
    hand: me.hand.length, eddies: me.eddies.length,
    unspent: me.eddies.filter(e => e.state === 'ready').length + me.legends.filter(l => l.state === 'ready').length,
    faceUpLegends: me.legends.filter(l => l.face === 'face_up').length,
  };
}

module.exports = { playTurn, replayPlan, rollout, describePlan, outcome, findRef };
