'use strict';

const { act, def } = require('./board');
const { effectiveKeywords } = require('./events');
const { WIN_GIG_COUNT } = require('./constants');

function canUnitAttack(u, b, pid) {
  if (u.state !== 'ready') return false;
  const kw = effectiveKeywords(b, pid, u);
  if (kw.includes('CANNOT_ATTACK')) return false;
  if (u.entered_play_turn === b.turn_number) {
    if (kw.includes('NO_HASTE')) return false;
    if (!kw.includes('GO_SOLO') && !kw.includes('HASTE_VS_SPENT') && !kw.includes('ADRENALINE') &&
        !kw.includes('HASTE_VS_GIGS')) return false;
  }
  return true;
}

// 9.3.2.4 — a Unit with no valid target can't attack, so it isn't listed.
function attackableUnits(b) {
  return act(b).zones.field.filter(u => canUnitAttack(u, b, b.active_player) &&
                                        hasAttackTarget(b, u, b.active_player));
}

function legalAttackTargets(b, u, pid) {
  const kw = effectiveKeywords(b, pid, u);
  const enteredThisTurn = u.entered_play_turn === b.turn_number;
  const dpid = b.active_player === 'p1' ? 'p2' : 'p1';
  let unit_iids = def(b).zones.field.filter(x => x.state === 'spent').map(x => x.iid);
  if (kw.includes('ATTACK_READY_UNITS'))
    unit_iids = unit_iids.concat(def(b).zones.field
      .filter(x => x.state === 'ready')
      .map(x => x.iid));
  else if (kw.includes('ATTACK_READY_BLOCKERS'))
    unit_iids = unit_iids.concat(def(b).zones.field
      .filter(x => x.state === 'ready' && hasBlocker(x, b, dpid))
      .map(x => x.iid));
  // 9.3.2.2 — only a rival Gig area holding 1+ Gigs is a valid attack target.
  let gigs = !kw.includes('CANNOT_ATTACK_GIGS') && def(b).zones.gigs.length > 0;
  if (enteredThisTurn) {
    if (kw.includes('HASTE_VS_SPENT')) gigs = false;
    if (kw.includes('HASTE_VS_GIGS') &&
        !kw.includes('GO_SOLO') && !kw.includes('ADRENALINE') && !kw.includes('HASTE_VS_SPENT'))
      unit_iids = [];
  }
  return { gigs, unit_iids };
}

function hasAttackTarget(b, u, pid) {
  const t = legalAttackTargets(b, u, pid);
  return t.gigs || t.unit_iids.length > 0;
}

// Rule 11.3: a Unit has Lag the turn it entered the field (lost at end of each turn).
// Go Solo / haste keywords only waive the attack restriction, never this one.
function isLagging(u, b) {
  return !!u && u.entered_play_turn !== undefined && u.entered_play_turn === b.turn_number;
}

// 11.3.1.2 "Lagging Units can't activate effects." `spender` is the unit/legend that
// would activate (a gear's host). A unit's own {Attack} trigger scripted as a
// spend_activated "may pay" (by:'self' on OnCardAttacks) is a trigger, not an activation.
function lagBlocksActivation(b, spender, ab) {
  if (!isLagging(spender, b)) return false;
  return !(ab?.trigger?.event === 'OnCardAttacks' && ab.trigger.by === 'self');
}

// 9.21 — is the current attack still going? False when the attacker left the
// field (9.21.1), the target Unit left (9.21.2), or the target Unit became ready
// and the attacker may not attack ready Units (9.21.3). A one-shot "attack ready
// Units" grant is consumed at declaration, so `atk.ready_target_ok` remembers it.
// A Gig area target stays valid even if emptied (5.12.4).
function attackStillValid(b) {
  const atk = b.current_attack;
  if (!atk) return false;
  const pid = b.active_player;
  const attU = act(b).zones.field.find(u => u.iid === atk.attacker_iid);
  if (!attU) return false;
  if (atk.target.kind !== 'unit') return true;
  const defU = def(b).zones.field.find(u => u.iid === atk.target.iid);
  if (!defU) return false;
  if (defU.state === 'spent' || atk.ready_target_ok) return true;
  const kw = effectiveKeywords(b, pid, attU);
  if (kw.includes('ATTACK_READY_UNITS')) return true;
  const dpid = pid === 'p1' ? 'p2' : 'p1';
  return kw.includes('ATTACK_READY_BLOCKERS') && hasBlocker(defU, b, dpid);
}

function hasBlocker(u, b, pid) {
  return effectiveKeywords(b, pid, u).includes('BLOCKER');
}


function checkWin(b) {
  if (b.overtime) return require('./primitives').overtimeWinner(b);   // 1.11: 7+ Gigs, either player
  if (b[b.active_player].zones.gigs.length >= WIN_GIG_COUNT) return b.active_player;
  return null;
}

module.exports = {
  canUnitAttack, attackableUnits, hasBlocker, isLagging, lagBlocksActivation, attackStillValid,
  legalAttackTargets, hasAttackTarget,
  checkWin,
};
