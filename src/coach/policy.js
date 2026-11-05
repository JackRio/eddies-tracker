// The coach's player: move generation, a position score, and a greedy bot.
//
// Moves are "macro" moves - one meaningful decision plus the resource taps that pay for it - so the
// bot never has to plan a tap sequence. The bot is one-ply greedy: it tries each move, lets the
// engine run until the next decision of the same turn (the other side answering with simple
// defaults), scores the result, and picks the best (or samples near-best with noise). It is a
// rollout policy, not a strong player: win rates come from many noisy games, not one perfect one.
'use strict';
const { step, defaultPassAction, effectivePlayCost, legendCallCost, goSoloCost, legendSpendable, effectiveKeywords } = require('../engine');
const { cardByNumber } = require('./cards');

const opp = pid => (pid === 'p1' ? 'p2' : 'p1');
const card = n => cardByNumber(n) || {};
const nm = n => card(n).name || String(n);

// ─── position score ─────────────────────────────────────────────────────────
function unitPower(b, pid, u) {
  let p = (card(u.card_id).power || 0) + (u._temp_power || 0);
  for (const g of u.equipped_gear || []) p += card(g.card_id).power || 0;   // Gear lists the power it grants
  return Math.max(0, p);
}

function sideScore(b, pid) {
  const Z = b[pid].zones;
  let s = 0;
  const gigs = Z.gigs.length;
  s += gigs * 11 + (gigs >= 6 ? 12 : 0) + (gigs >= 5 ? 4 : 0);
  s += Z.gigs.reduce((a, g) => a + g.value, 0) * 0.15;
  for (const u of Z.field) {
    const p = unitPower(b, pid, u);
    s += 2.5 + p * 0.9 + (u.state === 'ready' ? 1 + p * 0.15 : 0);
    s += (u.equipped_gear || []).length * 0.8;
  }
  for (const l of Z.legends) {
    s += l.face === 'face_up' ? 3 : 1.6;
    s += (l.equipped_gear || []).reduce((a, g) => a + 1 + (card(g.card_id).power || 0) * 0.3, 0);
  }
  s += Math.min(Z.hand.length, 7) * 2.4 + Math.max(0, Z.hand.length - 7) * 0.8;
  s += Math.min(Z.eddies.length, 8) * 2.6;
  if (Z.deck.length === 0) s -= 30;
  return s;
}

// Score for pid (positive = pid ahead). A finished game is ±1000.
function evaluate(b, pid) {
  if (b.winner) return b.winner === pid ? 1000 : -1000;
  return sideScore(b, pid) - sideScore(b, opp(pid));
}
const winProb = score => 1 / (1 + Math.exp(-score / 22));

// ─── move generation ────────────────────────────────────────────────────────
function readyResources(b, pid) {
  const p = b[pid], Z = p.zones;
  const eddies = Z.eddies.filter(e => e.state === 'ready' && !p.tapped.includes(e.iid));
  const legs = Z.legends.filter(l => l.state === 'ready' && !p.tapped.includes(l.iid) && legendSpendable(l));
  // face-down Legends before face-up ones: a face-up Legend may have a {Spend} ability worth keeping
  return [...eddies, ...legs.filter(l => l.face !== 'face_up'), ...legs.filter(l => l.face === 'face_up')];
}
function taps(b, pid, n) {
  const res = readyResources(b, pid);
  const need = Math.max(0, n - b[pid].tapped.length);
  if (need > res.length) return null;
  return res.slice(0, need).map(x => ({ step: 'tap_resource', iid: x.iid }));
}

const R = resp => [{ step: 'effect_choice_response', response: resp }];

function combos(arr, maxK, minK = 0, cap = 24) {
  const out = [];
  const rec = (start, cur) => {
    if (out.length >= cap) return;
    if (cur.length >= minK) out.push(cur.slice());
    if (cur.length === maxK) return;
    for (let i = start; i < arr.length; i++) { cur.push(arr[i]); rec(i + 1, cur); cur.pop(); }
  };
  rec(0, []);
  return out;
}

// All macro moves for the decision `wf` (each an array of engine actions).
function moves(wf, b) {
  const pid = wf.owner || b.active_player;
  const p = b[pid], Z = p.zones, O = b[opp(pid)].zones;
  const out = [];
  switch (wf.step) {
    case 'mulligan_decision': return [[{ step: 'mulligan', mulligan: false }], [{ step: 'mulligan', mulligan: true }]];
    case 'choose_gig_die': return (wf.available || []).map(s => [{ step: 'choose_gig_die', sides: s }]);
    case 'main_phase': {
      for (const h of Z.hand) {
        const c = card(h.card_id);
        if (!p.sold_card_this_turn && c.eddie) out.push([{ step: 'sell_card', iid: h.iid }]);
        let cost;
        try { cost = effectivePlayCost(b, pid, h, c); } catch { cost = c.cost || 0; }
        const pay = taps(b, pid, cost);
        if (!pay) continue;
        if (c.type === 'Gear') {
          for (const host of [...Z.field, ...Z.legends.filter(l => l.face === 'face_up')]) out.push([...pay, { step: 'play_card', iid: h.iid, equip_to: host.iid }]);
        } else if (c.type === 'Unit' || c.type === 'Program') out.push([...pay, { step: 'play_card', iid: h.iid }]);
      }
      for (const l of Z.legends) {
        if (l.face !== 'face_up' && !p.called_legend_this_turn) {
          let cost = 1; try { cost = legendCallCost(b, pid); } catch { /* default */ }
          const pay = taps(b, pid, cost);
          if (pay) out.push([...pay, { step: 'call_legend', iid: l.iid }]);
        }
        if (l.face === 'face_up') {
          let kw = []; try { kw = effectiveKeywords(b, pid, l); } catch { /* none */ }
          if (kw.includes('GO_SOLO')) {
            let cost = card(l.card_id).cost || 0; try { cost = goSoloCost(b, pid, l); } catch { /* printed */ }
            const pay = taps(b, pid, cost);
            if (pay) out.push([...pay, { step: 'play_legend_solo', iid: l.iid }]);
          }
        }
      }
      for (const sp of wf.spend_activatable_iids || []) out.push([{ step: 'activate_anytime_spend', iid: sp.iid, ability_idx: sp.ability_idx }]);
      for (const a of wf.attackable || []) {
        const t = wf.attack_targets?.[a] || { gigs: true, unit_iids: O.field.filter(u => u.state === 'spent').map(u => u.iid) };
        if (t.gigs) out.push([{ step: 'declare_attack', attacker_iid: a, target: { kind: 'gigs' } }]);
        for (const u of t.unit_iids || []) out.push([{ step: 'declare_attack', attacker_iid: a, target: { kind: 'unit', iid: u } }]);
      }
      if (!(wf.must_attack_iids || []).length) out.push([{ step: 'end_turn' }]);
      return out;
    }
    case 'defensive_step': {
      for (const x of wf.blocker_iids || []) out.push([{ step: 'blocker', iid: x }]);
      if (wf.can_call_legend) for (const l of Z.legends.filter(l => l.face !== 'face_up')) out.push([{ step: 'call_legend_defensive', iid: l.iid, pay_iids: (wf.call_legend_payable_iids || []).slice(0, wf.call_legend_cost ?? 1) }]);
      for (const x of wf.interrupt_castable_iids || []) out.push([{ step: 'play_card_interrupt_cast', iid: x }]);
      for (const x of wf.interrupt_spendable_iids || []) out.push([{ step: 'activate_asset_spend', iid: x.iid, ability_idx: x.ability_idx }]);
      out.push([{ step: 'pass_defensive' }]);
      return out;
    }
    case 'attacker_interrupt_step': {
      for (const x of wf.interrupt_castable_iids || []) out.push([{ step: 'play_card_interrupt_cast', iid: x }]);
      for (const x of wf.interrupt_spendable_iids || []) out.push([{ step: 'activate_asset_spend', iid: x.iid, ability_idx: x.ability_idx }]);
      out.push([{ step: 'pass_attacker_interrupt' }]);
      return out;
    }
    case 'choose_gig_to_steal': {
      const ids = wf.available_iids || [];
      return combos(ids, wf.count, wf.count, 12).map(sel => [{ step: 'choose_gig_to_steal', iids: sel }]);
    }
    case 'effect_choice': {
      const cn = wf.choice_needed;
      switch (cn.kind) {
        case 'confirm_optional': return [R({ accept: true }), R({ accept: false })];
        case 'choose_pending_order': return cn.available_iids.map(i => R({ iid: i }));
        case 'choose_amount': { const o = []; for (let n = cn.min; n <= cn.max; n++) if (!(cn.exclude_zero && n === 0)) o.push(R({ amount: n })); return o; }
        case 'choose_card_type': return (cn.options || ['Unit', 'Gear', 'Program']).map(t => R({ card_type: t }));
        case 'acknowledge_reveal': return [R({ acknowledge: true })];
        case 'choose_from_top_n': return combos(cn.eligible_iids, Math.min(cn.take_up_to, cn.eligible_iids.length), cn.take_min || 0).map(s => R({ selected_iids: s }));
        case 'choose_units': return combos(cn.available_iids, Math.min(cn.take_up_to, cn.available_iids.length), cn.take_min || 0).map(s => R({ selected_iids: s }));
        default: { const o = (cn.available_iids || []).map(i => R({ iid: i })); if (cn.optional || !o.length) o.push(R({ iid: null })); return o; }
      }
    }
  }
  return [];
}

// ─── running the engine ─────────────────────────────────────────────────────
function apply(b, wf, seq) {
  let w = wf;
  for (const a of seq) { const r = step(b, a); b = r.board; w = r.waitingFor; if (!w) break; }
  return { board: b, waitingFor: w };
}
function tryApply(b, wf, seq) {
  try { return apply(b, wf, seq); } catch { return null; }
}

// Simple answer for decisions inside a move's look-ahead: block when the blocker survives or
// trades, otherwise pass; take the first legal option of any prompt.
function quickAnswer(wf, b) {
  if (wf.step === 'defensive_step' && (wf.blocker_iids || []).length && b.current_attack) {
    const pid = wf.owner, A = b[opp(pid)].zones.field.find(u => u.iid === b.current_attack.attacker_iid);
    const ap = A ? unitPower(b, opp(pid), A) : 0;
    let best = null, bp = -1;
    for (const x of wf.blocker_iids) { const u = b[pid].zones.field.find(v => v.iid === x); const p = u ? unitPower(b, pid, u) : 0; if (p > bp) { bp = p; best = x; } }
    if (best && (bp >= ap || b.current_attack.target?.kind === 'gigs')) return [{ step: 'blocker', iid: best }];
  }
  const d = defaultPassAction(wf);
  if (d) return [d];
  const m = moves(wf, b);
  return m[0] || null;
}

// Run until the next decision for `pid` in a main phase, or the game ends (max `cap` engine halts).
function settle(b, wf, pid, cap = 30) {
  for (let i = 0; i < cap && wf && !b.winner; i++) {
    if (wf.step === 'main_phase') return { board: b, waitingFor: wf };
    const seq = quickAnswer(wf, b);
    if (!seq) break;
    const r = tryApply(b, wf, seq);
    if (!r) break;
    b = r.board; wf = r.waitingFor;
  }
  return { board: b, waitingFor: wf };
}

// ─── the bot ────────────────────────────────────────────────────────────────
// opts: { rng, noise (0 = pure greedy), maxMoves }
function chooseMove(wf, b, opts = {}) {
  const pid = wf.owner || b.active_player;
  const cands = moves(wf, b);
  if (!cands.length) { const d = defaultPassAction(wf); return d ? [d] : null; }
  if (cands.length === 1) return cands[0];
  const scored = [];
  for (const seq of cands) {
    if (seq[seq.length - 1].step === 'end_turn') { scored.push({ seq, s: evaluate(b, pid) }); continue; }
    const r = tryApply(b, wf, seq);
    if (!r) continue;
    const st = wf.step === 'main_phase' ? settle(r.board, r.waitingFor, pid) : r;
    let s = evaluate(st.board, pid);
    if (seq.some(a => a.step === 'sell_card')) s += 0.6;            // selling early in the turn keeps options open
    scored.push({ seq, s });
  }
  if (!scored.length) { const d = defaultPassAction(wf); return d ? [d] : null; }
  scored.sort((x, y) => y.s - x.s);
  const noise = opts.noise || 0;
  if (noise > 0 && opts.rng) {
    // softmax over the top few
    const top = scored.slice(0, 4), T = noise;
    const w = top.map(x => Math.exp((x.s - top[0].s) / T));
    let u = opts.rng() * w.reduce((a, c) => a + c, 0);
    for (let i = 0; i < top.length; i++) { u -= w[i]; if (u <= 0) return top[i].seq; }
  }
  return scored[0].seq;
}

// Play out one decision of whoever is to act. Returns the new {board, waitingFor} or null if stuck.
function botStep(b, wf, opts) {
  let seq = chooseMove(wf, b, opts);
  let r = seq && tryApply(b, wf, seq);
  if (!r) { const d = defaultPassAction(wf); r = d && tryApply(b, wf, [d]); seq = d ? [d] : null; }
  if (!r) {   // last resort: any legal move
    for (const m of moves(wf, b)) { r = tryApply(b, wf, m); if (r) { seq = m; break; } }
  }
  return r ? { ...r, seq } : null;
}

module.exports = { evaluate, winProb, moves, chooseMove, botStep, settle, tryApply, apply, unitPower, opp, nm, card };
