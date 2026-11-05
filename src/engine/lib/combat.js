'use strict';

const {
  act, def, waiting, ended, haltToWaiting,
  getCard,
} = require('./board');

const { attackableUnits, hasBlocker, canUnitAttack, legalAttackTargets, isLagging, lagBlocksActivation,
        attackStillValid } = require('./rules');
const { effectivePlayCost, consumeNextPlayDiscount } = require('./cost');
const { applyStaticPower, effectiveKeywords, legendCallCost } = require('./events');
const { resolveEffects } = require('./effects');
const { matchTrigger, evalCondition, evalExpr } = require('./eval');
const P = require('./primitives');
const { DB, SCRIPTS } = require('./cards');

function abilityEddieCost(ab, b, ctx) {
  const c = ab.cost?.eddies;
  if (c == null) return 0;
  return Math.max(0, typeof c === 'number' ? c : evalExpr(c, b, ctx));
}

function collectSpendOpportunities(b, playerPid, event, eventCtx) {
  const out = [];
  const assets = [];
  const p = b[playerPid];
  for (const u of p.zones.field) {
    assets.push({ pid: playerPid, ref: u, kind: 'unit' });
    for (const g of (u.equipped_gear || [])) assets.push({ pid: playerPid, ref: g, kind: 'gear', host_iid: u.iid, host: u });
  }
  for (const l of p.zones.legends) {
    if (l.face !== 'face_up') continue;
    assets.push({ pid: playerPid, ref: l, kind: 'legend' });
    for (const g of (l.equipped_gear || [])) assets.push({ pid: playerPid, ref: g, kind: 'gear', host_iid: l.iid, host: l });
  }

  for (const { pid, ref, kind, host_iid, host } of assets) {
    const spender = kind === 'gear' ? host : ref; 
    const script = SCRIPTS[ref.card_id];
    if (!script?.abilities) continue;
    for (let i = 0; i < script.abilities.length; i++) {

      const ab = script.abilities[i];
      if (ab.kind !== 'spend_activated' || !ab.trigger) continue;

      const quickReaction = event === 'OnCardAttacks' && ab.quick === true && playerPid !== b.active_player;
      if (ab.trigger.event !== event && !quickReaction) continue;
      const abEvent = ab.trigger.event;
      const ctx = {
        ...eventCtx, event: abEvent,
        self_pid: pid, self_iid: ref.iid, self_card_id: ref.card_id,
        bindings: {},
      };
      if (!matchTrigger(ab.trigger, abEvent, b, ctx)) continue;

      const rl = ab.trigger.rate_limit;
      const scopeId = P.rateLimitScopeId(ab.trigger, ref);

      if (rl === 'first_per_turn' && P.hasTriggered(b, pid, scopeId, abEvent)) continue;
      if (ab.condition && !evalCondition(ab.condition, b, ctx)) continue;
      if (ab.cost?.spend?.from_self && spender.state !== 'ready') continue;
      if (lagBlocksActivation(b, spender, ab)) continue;   // 11.3.1.2
      const eddieCost = abilityEddieCost(ab, b, ctx);
      if (eddieCost && P.readyPool(p, ref.iid) < eddieCost) continue;

      out.push({
        iid:        ref.iid,
        card_id:    ref.card_id,
        ability_idx: i,
        kind,
        host_iid:   host_iid || null,
        prompt:     ab.prompt || null,
      });

    }
  }
  return out;
}

function _interruptCastableIids(b, pid) {
  const p = b[pid];
  const avail = P.readyPool(p);
  return p.zones.hand
    .filter(ref => SCRIPTS[ref.card_id]?.quick === true &&
                   avail >= effectivePlayCost(b, pid, ref, DB[ref.card_id] || {}))
    .map(ref => ref.iid);
}

function _attackEventCtx(b) {
  const atk = b.current_attack;
  const attacker = atk ? b[b.active_player]?.zones.field.find(u => u.iid === atk.attacker_iid) : null;
  return {
    source_pid:     b.active_player,
    source_iid:     atk?.attacker_iid,
    source_card_id: attacker?.card_id,
    event_data:     { target: atk?.target },
  };
}

function attWaiting(b) {
  const attPid = b.active_player;
  const atk    = b.current_attack;

  // Quick cards react to a RIVAL attack only — the attacker's window exists
  // solely for spend abilities that trigger on their own attack.
  const eventCtx  = _attackEventCtx(b);
  const spendOpps = collectSpendOpportunities(b, attPid, 'OnCardAttacks', eventCtx);

  if (spendOpps.length === 0) {
    atk.step = 'defensive';
    return defWaiting(b);
  }

  atk.step = 'attacker_interrupt';
  return waiting(b, {
    step: 'attacker_interrupt_step',
    owner: attPid,
    attacker_iid: atk.attacker_iid,
    target: atk.target,
    interrupt_spendable_iids: spendOpps,
  });
}

function defWaiting(b) {
  const defPid = P.opponent(b.active_player);
  const defP   = b[defPid];
  const atk    = b.current_attack;
  const callCost = legendCallCost(b, defPid);
  const canCall = !defP.called_legend_this_turn &&
                  defP.zones.legends.some(l => l.face === 'face_down') &&
                  P.readyPool(defP) >= callCost;

  const attU = b[b.active_player].zones.field.find(u => u.iid === atk.attacker_iid);
  atk.target.unblockable = !!attU &&
    effectiveKeywords(b, b.active_player, attU).includes('UNBLOCKABLE');
  // 11.28.3.1 — the current target can't redirect the attack to itself.
  const curTargetIid = atk.target.kind === 'unit' ? atk.target.iid : null;
  const blockerIids = atk.target.unblockable ? [] : defP.zones.field
    .filter(u => u.state === 'ready' && !isLagging(u, b) && hasBlocker(u, b, defPid) &&
                 u.iid !== curTargetIid)
    .map(u => u.iid);

  const eventCtx = _attackEventCtx(b);
  const interruptCastIids = _interruptCastableIids(b, defPid);
  const spendOpps         = collectSpendOpportunities(b, defPid, 'OnCardAttacks', eventCtx);

  return waiting(b, {
    step: 'defensive_step',
    owner: defPid,
    attacker_iid: atk.attacker_iid,
    target: atk.target,
    can_call_legend: canCall,
    call_legend_cost: callCost,
    call_legend_payable_iids: canCall ? P.payableIids(defP) : [],
    blocker_iids: blockerIids,
    interrupt_castable_iids:  interruptCastIids,
    interrupt_spendable_iids: spendOpps,
  });
}

function mainWaiting(b) {
  const pid = b.active_player;
  const attackable = attackableUnits(b).map(u => u.iid);

  const attack_targets = {};
  for (const iid of attackable) {
    const u = act(b).zones.field.find(x => x.iid === iid);
    attack_targets[iid] = legalAttackTargets(b, u, pid);
  }
  const mustAttack = b[pid].zones.field
    .filter(u => u._must_attack_on === b.turn_number && attackable.includes(u.iid)
              && (attack_targets[u.iid].gigs || attack_targets[u.iid].unit_iids.length > 0))
    .map(u => u.iid);
  return waiting(b, {
    step: 'main_phase',
    owner: pid,
    spend_activatable_iids: collectSpendOpportunities(b, pid, 'Anytime', {}),
    attackable,
    attack_targets,
    must_attack_iids: mustAttack,
  });
}


// 11.4.2: compute powers, declare loser(s)/winner (fight triggers become pending),
// defeat the losers, then resolve every pending effect — turn player's first
// (10.15) — and only then end the attack (9.17).
const FIGHT_CHAIN = [
  { action: '_FightInit' },
  { action: '_FightDeclare' },
  { action: '_ResolveFightPending' },
  { action: '_EndAttack' },
];

function runChain(b, chain, owner) {
  const res = resolveEffects(chain, b, { bindings: {} });
  if (res.halted) return haltToWaiting(b, 'resume_effects', res, owner);
  return afterChain(b);
}

// 9.6 / 9.13 / 9.21 — before (and throughout) the React Step, an attack whose
// attacker or target Unit left the field, or whose target became invalid, ends.
function endAttackIfInvalid(b) {
  const atk = b.current_attack;
  if (!atk || !['declared', 'attacker_interrupt', 'defensive'].includes(atk.step)) return null;
  if (attackStillValid(b)) return null;
  const res = resolveEffects([{ action: '_EndAttack' }], b, { bindings: {} });
  if (res.halted) return haltToWaiting(b, 'resume_effects', res, b.active_player);
  return afterChain(b);
}

function afterChain(b) {
  if (b.winner) return ended(b);
  const atk = b.current_attack;
  if (atk) {
    const ended_ = endAttackIfInvalid(b);
    if (ended_) return ended_;
    if (atk.step === 'declared' || atk.step === 'attacker_interrupt') return attWaiting(b);
    if (atk.step === 'defensive') return defWaiting(b);
  }
  return mainWaiting(b);
}

function declareAttack(b, attacker_iid, target) {
  const pid  = b.active_player;
  const p    = act(b);
  const oppP = def(b);

  const attacker = p.zones.field.find(u => u.iid === attacker_iid);
  if (!attacker || attacker.state !== 'ready') throw new Error('Invalid attacker');
  if (!canUnitAttack(attacker, b, pid))
    throw new Error('This unit cannot attack'); 

  delete attacker._must_attack_on;

  if (!target || (target.kind !== 'unit' && target.kind !== 'gigs'))
    throw new Error('Attack target must be a unit or the Gig area');
  target = target.kind === 'unit' ? { kind: 'unit', iid: target.iid } : { kind: 'gigs' };

  const legal = legalAttackTargets(b, attacker, pid);

  if (target.kind === 'unit') {
    const defUnit = oppP.zones.field.find(u => u.iid === target.iid);
    if (!defUnit) throw new Error('Target unit not on field');
    if (!legal.unit_iids.includes(target.iid))
      throw new Error(defUnit.state === 'ready'
        ? 'Can only attack spent units'
        : 'This unit can only attack the Gig area the turn it enters play');
  }

  if (target.kind === 'gigs' && !legal.gigs) {
    const kw = effectiveKeywords(b, pid, attacker);
    throw new Error(
      oppP.zones.gigs.length === 0           ? 'The rival Gig area is empty — not a valid attack target' :
      kw.includes('CANNOT_ATTACK_GIGS')      ? 'This unit can only attack rival Units' :
                                               'This unit can only attack spent units the turn it enters play');
  }

  // A one-shot "attack ready Units" grant is consumed below; remember that the
  // ready target was legal so attackStillValid doesn't end the attack (9.21.3).
  const readyTargetOk = target.kind === 'unit' &&
    oppP.zones.field.find(u => u.iid === target.iid)?.state === 'ready';

  const hadReadyGrant = (attacker._temp_keywords || [])
    .some(k => String(k).toUpperCase() === 'ATTACK_READY_UNITS');
  attacker.state = 'spent';
  // ATTACK_READY_UNITS is a one-shot grant ("the next time this Unit attacks
  // this turn") — the targets above were already resolved, so drop it now.
  if (attacker._temp_keywords?.length)
    attacker._temp_keywords = attacker._temp_keywords
      .filter(k => String(k).toUpperCase() !== 'ATTACK_READY_UNITS');
  b.current_attack = { attacker_iid, target, step: 'declared' };
  if (readyTargetOk && hadReadyGrant) b.current_attack.ready_target_ok = true;

  // 9.6 / 11.25.2.1 — spend triggers and {Attack} triggers become pending at the
  // same time; all resolve (owner ordering them) before the React Step.
  return runChain(b, [{ action: '_FireTogether', events: [
    { event: 'OnSpent',
      sub_ctx: { source_pid: pid, source_iid: attacker_iid, source_card_id: attacker.card_id } },
    { event: 'OnCardAttacks',
      sub_ctx: { source_pid: pid, source_iid: attacker_iid, source_card_id: attacker.card_id,
                 event_data: { target } } },
  ] }], pid);
}

function handleAttackerInterrupt(b, input) {
  const attPid = b.active_player;

  if (!input) return attWaiting(b);

  switch (input.step) {
    case 'pass_attacker_interrupt': {
      b.current_attack.step = 'defensive';
      return defWaiting(b);
    }

    case 'activate_asset_spend':
      return resolveSpendActivated(b, input, attPid, {
        eventCtx: _attackEventCtx(b),
        window:   'OnCardAttacks',
      });

    default:
      throw new Error(`Unexpected attacker-interrupt input: ${input.step}`);
  }
}

function _findOwnedAsset(b, pid, iid) {
  const p = b[pid];
  for (const u of p.zones.field) {
    if (u.iid === iid) return { ref: u, kind: 'unit' };
    for (const g of (u.equipped_gear || [])) if (g.iid === iid) return { ref: g, kind: 'gear', host: u };
  }
  for (const l of p.zones.legends) {
    if (l.iid === iid) return { ref: l, kind: 'legend' };
    for (const g of (l.equipped_gear || [])) if (g.iid === iid) return { ref: g, kind: 'gear', host: l };
  }
  return null;
}

function resolveSpendActivated(b, input, casterPid, opts) {
  const iid        = input.iid;
  const abilityIdx = input.ability_idx;
  if (iid == null || abilityIdx == null) throw new Error('iid and ability_idx required');

  const found = _findOwnedAsset(b, casterPid, iid);
  if (!found) throw new Error('Asset not in play under your control');
  const { ref } = found;
  const spender = found.kind === 'gear' ? found.host : ref;   // a gear has no state: its ability's {Spend} cost is paid by the host

  const script = SCRIPTS[ref.card_id];
  const ab = script?.abilities?.[abilityIdx];
  if (!ab || ab.kind !== 'spend_activated' || !ab.trigger) {
    throw new Error('Not a spend-activated ability');
  }

  if (opts.window) {
    const baseOk  = ab.trigger.event === opts.window;
    const quickOk = !!opts.allowQuick && ab.quick === true && opts.window === 'OnCardAttacks';
    if (!baseOk && !quickOk) throw new Error('Ability not activatable in this window');
  }

  const eventCtx = opts.eventCtx || {};

  const ctx = {
    ...eventCtx, event: ab.trigger.event,
    self_pid: casterPid, self_iid: ref.iid, self_card_id: ref.card_id,
    bindings: {},
  };
  if (!matchTrigger(ab.trigger, ab.trigger.event, b, ctx)) {
    throw new Error('Spend-activated ability no longer applicable');
  }
  if (ab.condition && !evalCondition(ab.condition, b, ctx)) {
    throw new Error('Spend-activated condition no longer holds');
  }
  if (ab.cost?.spend?.from_self && spender.state !== 'ready') {
    throw new Error('Asset is already spent');
  }
  if (lagBlocksActivation(b, spender, ab)) throw new Error('Lagging Units can\'t activate effects');
  const eddieCost = abilityEddieCost(ab, b, ctx);
  if (eddieCost && P.readyPool(b[casterPid], ref.iid) < eddieCost) {
    throw new Error('Not enough eddies for ability');
  }

  const spentForCost = [];
  if (ab.cost?.spend?.from_self) { spender.state = 'spent'; spentForCost.push(spender); }
  if (eddieCost) spentForCost.push(...(P.spendEddies(b[casterPid], eddieCost, ref.iid) || []));

  const rl = ab.trigger.rate_limit;
  if (rl === 'first_per_turn') {
    const scopeId = P.rateLimitScopeId(ab.trigger, ref);
    P.markTriggered(b, casterPid, scopeId, ab.trigger.event);
  }

  // Paying the {Spend}/€$ cost triggers "when spent" effects: they go pending NOW
  // (so they survive the effect moving or removing their source) and resolve
  // only after the activated effect finishes (10.20.6-7; FAQ Zetatech Faceplate).
  const { collectPending } = require('./events');
  const spendPending = spentForCost.flatMap(r => collectPending(b, 'OnSpent',
    { source_pid: casterPid, source_iid: r.iid, source_card_id: r.card_id }));
  const effectChain = [
    ...(ab.effect || []),
    ...(spendPending.length ? [{ action: '_RunPending', entries: spendPending }] : []),
  ];

  const res = resolveEffects(effectChain, b, ctx);
  if (res.halted) return haltToWaiting(b, 'resume_effects', res, casterPid);
  return afterChain(b);
}

function playProgram(b, pid, ref, spentLegends) {
  b[pid]._played_program_this_turn = true;   // read by PlayedProgramThisTurn; cleared in clearTransients
  const cardScript = SCRIPTS[ref.card_id];
  const subCtx = { source_pid: pid, source_iid: ref.iid, source_card_id: ref.card_id };
  const ctx = {
    event: 'OnPlay',
    source_pid: pid, source_iid: ref.iid, source_card_id: ref.card_id,
    self_pid:   pid, self_iid:   ref.iid, self_card_id:   ref.card_id,
    bindings: {},
  };
  // Legends/Eddies spent to pay: their "when spent" triggers go pending now and
  // resolve after the Program's own effect (FAQ Zetatech Faceplate).
  const { collectPending } = require('./events');
  const spendPending = spentLegends.flatMap(r => collectPending(b, 'OnSpent',
    { source_pid: pid, source_iid: r.iid, source_card_id: r.card_id }));
  const chain = [
    ...(cardScript?.onPlay || []),
    { action: '_FireSubEvent', event: 'OnPlay',       sub_ctx: subCtx, opts: { skipSelf: true } },
    { action: '_FireSubEvent', event: 'OnCardPlayed', sub_ctx: subCtx },
    { action: '_PlaceInZone',  pid, ref: { iid: ref.iid, card_id: ref.card_id }, zone: 'trash' },
    ...(spendPending.length ? [{ action: '_RunPending', entries: spendPending }] : []),
  ];
  const res = resolveEffects(chain, b, ctx);
  if (res.halted) return haltToWaiting(b, 'resume_effects', res, pid);
  return null;
}

function _resolveInterruptCast(b, input, casterPid, casterP) {
  const cardIdx = casterP.zones.hand.findIndex(c => c.iid === input.iid);
  if (cardIdx === -1) throw new Error('Card not in hand');
  const ref        = casterP.zones.hand[cardIdx];
  const c          = getCard(ref.card_id);
  const cardScript = SCRIPTS[ref.card_id];
  if (cardScript?.quick !== true) throw new Error('Card cannot be played as a quick reaction');

  const effCost = effectivePlayCost(b, casterPid, ref, c);
  let spentLegends = [];
  if (effCost > 0) {
    spentLegends = P.spendEddies(casterP, effCost);
    if (!spentLegends) throw new Error('Not enough resources to play this Program');
  }
  consumeNextPlayDiscount(b, casterPid, c);

  casterP.zones.hand.splice(cardIdx, 1);

  const w = playProgram(b, casterPid, ref, spentLegends);
  if (w) return w;

  return afterChain(b);
}

function handleDefensive(b, input) {
  const opp  = P.opponent(b.active_player);
  const oppP = def(b);
  const atk  = b.current_attack;

  if (!input) {
    return defWaiting(b);
  }

  switch (input.step) {
    case 'call_legend_defensive': {
      // One Call per turn (5.7.3) — shared with main-phase and card-effect Calls.
      if (oppP.called_legend_this_turn) throw new Error('Already called a legend this turn');
      const leg = oppP.zones.legends.find(l => l.iid === input.iid);
      if (!leg || leg.face === 'face_up') throw new Error('Invalid legend');
      // Same cost as the main-phase action, so a LegendCallDiscount applies here too.
      // The defender chooses what pays (11.11.1): `pay_iids` = ready Eddies and/or
      // spendable Legends. It may be omitted only when there is exactly one way to pay.
      const callCost = legendCallCost(b, opp);
      let payIids = input.pay_iids;
      if (callCost > 0 && payIids == null) {
        const payable = P.payableIids(oppP);
        if (payable.length !== callCost)
          throw new Error(`call_legend_defensive needs pay_iids: choose ${callCost} of ${payable.join(', ')}`);
        payIids = payable;
      }
      const spentLegends = callCost > 0 ? P.spendChosen(oppP, payIids, callCost) : [];
      leg.face = 'face_up';
      oppP.called_legend_this_turn = true;
      const legCtx = { source_pid: opp, source_iid: leg.iid, source_card_id: leg.card_id };

      return runChain(b, [
        ...spentLegends.map(r => ({ action: '_FireSubEvent', event: 'OnSpent',
          sub_ctx: { source_pid: opp, source_iid: r.iid, source_card_id: r.card_id } })),
        { action: '_FireSubEvent', event: 'OnCall', sub_ctx: legCtx },
        { action: '_FireSubEvent', event: 'OnFlip', sub_ctx: legCtx },
      ], opp);
    }

    case 'blocker': {
      const attU = act(b).zones.field.find(u => u.iid === atk.attacker_iid);
      if (attU && effectiveKeywords(b, b.active_player, attU).includes('UNBLOCKABLE'))
        throw new Error('Attacker cannot be blocked');
      const blocker = oppP.zones.field.find(u => u.iid === input.iid);
      if (!blocker || !hasBlocker(blocker, b, opp)) throw new Error('Not a BLOCKER unit');
      if (blocker.state !== 'ready') throw new Error('Blocker is not ready');
      if (isLagging(blocker, b)) throw new Error('Lagging Units can\'t use Blocker');   // 11.3.1.2
      if (atk.target.kind === 'unit' && atk.target.iid === blocker.iid)
        throw new Error('A Unit can\'t redirect an attack to itself');            // 11.28.3.1
      // Spending the blocker is BLOCKER's cost, so it lands before OnBlock —
      // same order as declareAttack's OnSpent-then-OnCardAttacks.
      // The redirect is one reaction (9.10): the React Step continues afterwards,
      // so the defender may keep reacting (or redirect again) until they pass.
      blocker.state   = 'spent';
      atk.blocker_iid = input.iid;
      atk.target      = { kind: 'unit', iid: input.iid };
      delete atk.ready_target_ok;
      return runChain(b, [
        { action: '_FireSubEvent', event: 'OnSpent',
          sub_ctx: { source_pid: opp, source_iid: blocker.iid, source_card_id: blocker.card_id } },
        { action: '_FireSubEvent', event: 'OnBlock',
          sub_ctx: { source_pid: opp, source_iid: blocker.iid, source_card_id: blocker.card_id } },
      ], opp);
    }

    case 'pass_defensive': {
      const ended_ = endAttackIfInvalid(b);   // 9.21 — e.g. the target was readied
      if (ended_) return ended_;
      if (atk.target.kind === 'unit') {
        atk.step = 'fight';
        return runChain(b, [...FIGHT_CHAIN], b.active_player);
      }
      atk.step = 'steal';
      return runSteal(b);
    }

    case 'play_card_interrupt_cast':
      return _resolveInterruptCast(b, input, opp, oppP);

    case 'activate_asset_spend':
      return resolveSpendActivated(b, input, opp, {
        eventCtx:   _attackEventCtx(b),
        window:     'OnCardAttacks',
        allowQuick: true,
      });

    default:
      throw new Error(`Unexpected defensive input: ${input.step}`);
  }
}

function runSteal(b) {
  const pid  = b.active_player;
  const p    = act(b);
  const oppP = def(b);
  const atk  = b.current_attack;

  const attU = p.zones.field.find(u => u.iid === atk.attacker_iid);
  const pw   = attU ? applyStaticPower(b, pid, attU, { role: 'attacker', during_fight: false }) : 0;
  const mod  = attU?._steal_mod || 0;   
  const n    = pw <= 0 ? 0 : Math.max(0, 1 + Math.floor(pw / 10) + mod);

  // Steal limits (Chrome Fang / Westbrook Netrunner): each active entry
  // protecting the victim, whose attacker filter matches the raider's card def,
  // narrows the stealable pool. An empty pool means the steal takes nothing.
  const opp = P.opponent(pid);
  const { matchCard } = require('./filters');
  const limits = (b._steal_power_limits || []).filter(e =>
    e.protected_pid === opp && b.turn_number < e.until_turn &&
    matchCard(DB[attU?.card_id] || {}, e.attacker || null, b, null));
  let pool = oppP.zones.gigs;
  for (const e of limits)
    pool = pool.filter(g => e.forbid === 'below_power' ? g.value >= pw : g.value <= pw);
  const count = Math.min(n, pool.length);

  // Stealing 0 Gigs (power 0, empty pool, or the attacker is gone) is not a
  // steal: no "when ... steals" trigger fires (FAQ: Gorilla Arms).
  if (count === 0 || !attU) return runChain(b, [{ action: '_EndAttack', steal: true }], pid);

  atk.step = 'choosing_gig';
  atk.steal_count = count;
  atk.steal_pool  = pool.map(g => g.iid);
  return waiting(b, {
    step: 'choose_gig_to_steal',
    owner: pid,
    available_iids: pool.map(g => g.iid),
    count,
  });
}

function handleStealChoice(b, input) {
  const pid  = b.active_player;
  const p    = act(b);
  const atk  = b.current_attack;
  const count = atk.steal_count;

  // Distinct gigs, each from the pool that was offered (steal limits narrow it).
  const chosenIids = [...new Set(input?.iids || [])].slice(0, count);
  if (chosenIids.length !== count)
    throw new Error(`Must choose exactly ${count} gig(s) to steal`);
  for (const iid of chosenIids)
    if (!(atk.steal_pool || []).includes(iid)) throw new Error(`Gig ${iid} not available to steal`);


  const attU = p.zones.field.find(u => u.iid === atk.attacker_iid);
  b._steal_pending = {
    pid, victim: P.opponent(pid),
    attacker_iid: atk.attacker_iid, attacker_card_id: attU?.card_id || null,
    taken: [],
  };
  return runChain(b, [
    ...chosenIids.map(iid => ({ action: '_MaybeStealGig', gig_iid: iid })),
    { action: '_FinishSteal' },
  ], pid);
}

module.exports = {
  mainWaiting,
  attWaiting,
  afterChain,
  declareAttack,
  handleDefensive,
  handleAttackerInterrupt,
  playProgram,
  handleStealChoice,
  collectSpendOpportunities,
  resolveSpendActivated,
};
