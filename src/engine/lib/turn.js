'use strict';

const { fireEventResume, fireOrHalt, fireEventChain, effectiveKeywords, goSoloCost, legendCallCost } = require('./events');
const { resolveEffects, resumeEffects } = require('./effects');
const { trace } = require('./trace');
const { randFloat } = require('./rng');
const { cloneBoard } = require('./clone');
const { effectivePlayCost, consumeNextPlayDiscount } = require('./cost');
const P = require('./primitives');
const { applyMulligan } = require('./setup');

const {
  act, def, waiting, ended, haltToWaiting,
  availDice, getCard,
} = require('./board');
const { checkWin, canUnitAttack, hasAttackTarget } = require('./rules');
const { FIRST_READY_TURN } = require('./constants');

const {
  mainWaiting, afterChain, declareAttack, handleDefensive, handleAttackerInterrupt,
  handleStealChoice, resolveSpendActivated, playProgram,
} = require('./combat');

const rollDie = (b, die) => 1 + (0 | randFloat(b, `d.${die.iid}.t${b.turn_number}`) * die.sides);

// ─── MAIN-PHASE HELPERS ──────────────────────────────────────────────────────

function _resolveAnytimeSpend(b, input) {
  return resolveSpendActivated(b, input, b.active_player, { window: 'Anytime' });
}

// Paying a cost and playing/calling the card happen together: the "when spent"
// triggers of whatever paid and the card's play/call triggers are ONE pending set
// (turn player first, owner orders them — rule 10.14.1 / 10.15).
function _fireEventsWithSpends(b, pid, spentLegends, events, ctx) {
  const chain = [{ action: '_FireTogether', events: [
    ...(spentLegends || []).map(r => ({ event: 'OnSpent',
      sub_ctx: { source_pid: pid, source_iid: r.iid, source_card_id: r.card_id } })),
    ...events.map(event => ({ event, sub_ctx: ctx })),
  ] }];
  const res = resolveEffects(chain, b, { bindings: {} });
  if (res.halted) return haltToWaiting(b, 'resume_effects', res, pid);
  return null;
}

function _resolveChoiceResponse(b, input, defaultOwner) {
  if (!input.response || typeof input.response !== 'object')
    throw new Error('effect_choice_response needs a response object');
  const frame = b.effect_stack.pop();
  if (!frame) throw new Error('No halted effect to resume');

  if (b._trace) trace(b, `T${b.turn_number}/choice ${defaultOwner} ${JSON.stringify(input.response)}`);

  const result = frame.kind === 'resume_fire_event'
    ? fireEventResume(frame.halted_state, input.response, b)
    : resumeEffects(frame.halted_state, input.response, b);

  if (!result?.halted) return null;
  return haltToWaiting(b, frame.kind, result, defaultOwner);
}

// ─── START PHASE ─────────────────────────────────────────────────────────────
function beginTurn(b) {
  b.turn_number += 1;
  b.phase = 'start';
  act(b).took_gig_this_turn = false;

  // "Once per turn" limits are per TURN (rules 5.7.3 / 11.14.2), so both players'
  // Call / Sell flags and every first-per-turn rate limit reset at every turn start —
  // a Call or a "first time each turn" trigger on the rival's turn is its own turn.
  for (const pid of ['p1', 'p2']) {
    b[pid].called_legend_this_turn = false;
    b[pid].sold_card_this_turn = false;
  }
  b.rate_limits = { p1: {}, p2: {} };

  // 8.6.1 — the 7-Gig check comes before anything else in the Start Phase.
  const winner = checkWin(b);
  if (winner) { b.winner = winner; return ended(b); }

  // 8.6.2 — start-of-turn effects: expire "until your next turn" effects, then
  // resolve "at the start of your turn" triggers (OnTurnStart), THEN 8.6.3 ready
  // and 8.6.4 draw. The ready/draw run as chain actions so a halted start-of-turn
  // choice resumes into them.
  P.clearExpiredUntilKeywords(b, b.active_player);
  const res = resolveEffects([
    { action: '_FireSubEvent', event: 'OnTurnStart', sub_ctx: { source_pid: b.active_player } },
    { action: '_StartReady' },
    { action: '_StartDraw' },
  ], b, { bindings: {} });
  if (res.halted) return haltToWaiting(b, 'resume_effects', res, b.active_player);
  return afterStartChain(b);
}

// 8.6.5 — after ready + draw, roll in a Gig (or go straight to Main if the fixer is empty).
function afterStartChain(b) {
  if (b.winner) return ended(b);
  const avail = availDice(act(b));
  if (!avail.length) {
    b.phase = 'main';
    const w = fireOrHalt(b, 'OnPlayPhaseStart', { source_pid: b.active_player }, b.active_player);
    if (w) return w;
    return mainWaiting(b);
  }
  return waiting(b, { step: 'choose_gig_die', owner: b.active_player, available: avail });
}

function stepStart(b, input) {
  if (input?.step === 'effect_choice_response') {   // a start-of-turn trigger halted for a choice
    const halted = _resolveChoiceResponse(b, input, b.active_player);
    if (halted) return halted;
    return afterStartChain(b);
  }
  if (b.effect_stack.length > 0)
    throw new Error('Resolve the pending choice before taking another action');
  if (!input)
    return waiting(b, { step: 'choose_gig_die', owner: b.active_player, available: availDice(act(b)) });
  if (input.step !== 'choose_gig_die') throw new Error(`Unexpected start input: ${input.step}`);

  const p   = act(b);

  if (!availDice(p).includes(input.sides)) throw new Error(`d${input.sides} not available in fixer`);
  const idx = p.zones.fixer.findIndex(d => d.sides === input.sides);

  const [die] = p.zones.fixer.splice(idx, 1);
  die.value = rollDie(b, die);
  die.origin_pid = b.active_player;
  p.zones.gigs.push(die);
  p.took_gig_this_turn = true;

  b.phase = 'main';

  const chain = [
    { action: '_FireSubEvent', event: 'OnGigRolled',
      sub_ctx: { source_pid: b.active_player,
                 event_data: { gig_iid: die.iid, gig_pid: b.active_player, sides: die.sides, value: die.value } } },
    { action: '_FireSubEvent', event: 'OnPlayPhaseStart',
      sub_ctx: { source_pid: b.active_player } },
  ];
  const res = resolveEffects(chain, b, { bindings: {} });
  if (res.halted) return haltToWaiting(b, 'resume_effects', res, b.active_player);
  return mainWaiting(b);
}

// ─── MAIN PHASE ──────────────────────────────────────────────────────────────

function stepMain(b, input) {
  const pid = b.active_player;
  const p   = act(b);

  if (input?.step === 'effect_choice_response') {
    const halted = _resolveChoiceResponse(b, input, pid);
    if (halted) return halted;
    if (b.winner) return ended(b);
    if (b.phase === 'between_turns') return step(b, undefined);   // turn ended mid-chain
    return afterChain(b);
  }

  // A pending choice frame means the only legal input is an effect_choice_response
  // (handled above). Anything else — a combat sub-step included — would bypass
  // the choice and orphan its frame, so it is rejected first.
  if (b.effect_stack.length > 0)
    throw new Error('Resolve the pending choice before taking another action');

  if (b.current_attack) {
    if (b.current_attack.step === 'attacker_interrupt') return handleAttackerInterrupt(b, input);
    if (b.current_attack.step === 'defensive')          return handleDefensive(b, input);
    if (b.current_attack.step === 'choosing_gig')       return handleStealChoice(b, input);
  }

  if (!input || input.step === 'end_turn') return endTurn(b);

  switch (input.step) {

    case 'declare_attack':
      return declareAttack(b, input.attacker_iid, input.target);

    case 'tap_resource': {
      const { iid } = input;
      const isEddie  = p.zones.eddies.some(e => e.iid === iid && e.state === 'ready');
      const isLegend = p.zones.legends.some(l => l.iid === iid && l.state === 'ready' && P.legendSpendable(l));
      if (!isEddie && !isLegend) throw new Error('That card cannot be tapped');
      const idx = p.tapped.indexOf(iid);
      if (idx === -1) p.tapped.push(iid);
      else            p.tapped.splice(idx, 1);
      return mainWaiting(b);
    }

    case 'untap_resource': {
      p.tapped = p.tapped.filter(id => id !== input.iid);
      return mainWaiting(b);
    }

    case 'sell_card': {
      if (p.sold_card_this_turn) throw new Error('Already sold a card this turn');
      const idx = p.zones.hand.findIndex(c => c.iid === input.iid);
      if (idx === -1) throw new Error('Card not in hand');
      const c = getCard(p.zones.hand[idx].card_id);
      if (!c.eddie) throw new Error(`${c.name} has no sell tag`);
      const [ref] = p.zones.hand.splice(idx, 1);
      // sold from hand: revealed, then face down - both players know which card it is (seen)
      p.zones.eddies.push({ iid: ref.iid, card_id: ref.card_id, state: 'ready', seen: true });
      p.sold_card_this_turn = true;
      return mainWaiting(b);
    }

    case 'call_legend': {
      if (p.called_legend_this_turn) throw new Error('Already called a legend this turn');
      const callCost = legendCallCost(b, pid);
      const spentLegends = callCost > 0 ? P.spendTapped(p, callCost) : [];
      const leg = p.zones.legends.find(l => l.iid === input.iid);
      if (!leg || leg.face === 'face_up') throw new Error('Invalid legend target');
      leg.face = 'face_up';
      p.called_legend_this_turn = true;
      const _legCtx = { source_pid: pid, source_iid: leg.iid, source_card_id: leg.card_id };
      const w = _fireEventsWithSpends(b, pid, spentLegends, ['OnCall', 'OnFlip'], _legCtx);
      if (w) return w;
      return mainWaiting(b);
    }

    case 'play_card': {
      const idx = p.zones.hand.findIndex(c => c.iid === input.iid);
      if (idx === -1) throw new Error('Card not in hand');
      const ref = p.zones.hand[idx];
      const c   = getCard(ref.card_id);
      const effCost = effectivePlayCost(b, pid, ref, c);
      const spentLegends = effCost > 0 ? P.spendTapped(p, effCost) : [];
      consumeNextPlayDiscount(b, pid, c);   // play committed — the one-shot discount is used
      p.zones.hand.splice(idx, 1);

      if (c.type === 'Unit') {
        const unit = { iid: ref.iid, card_id: ref.card_id, state: 'ready', equipped_gear: [], entered_play_turn: b.turn_number };
        p.zones.field.push(unit);
        const _uCtx = { source_pid: pid, source_iid: unit.iid, source_card_id: unit.card_id };
        const w = _fireEventsWithSpends(b, pid, spentLegends, ['OnPlay', 'OnCardPlayed'], _uCtx);
        if (w) return w;

      } else if (c.type === 'Program') {
        const w = playProgram(b, pid, ref, spentLegends);
        if (w) return w;

      } else if (c.type === 'Gear') {
        if (!input.equip_to) throw new Error('Gear requires equip_to');

        const host = p.zones.field.find(u => u.iid === input.equip_to) ||
                     p.zones.legends.find(l => l.iid === input.equip_to && l.face === 'face_up');
        if (!host) throw new Error('Host unit/legend not found or not face-up');
        host.equipped_gear = host.equipped_gear || [];
        host.equipped_gear.push({ iid: ref.iid, card_id: ref.card_id });
        const _gCtx = { source_pid: pid, source_iid: ref.iid, source_card_id: ref.card_id };
        const w = _fireEventsWithSpends(b, pid, spentLegends, ['OnPlay', 'OnCardPlayed'], _gCtx);
        if (w) return w;
      }

      return mainWaiting(b);
    }


    case 'play_legend':
    case 'play_legend_solo': {
      const solo = input.step === 'play_legend_solo';
      const leg = p.zones.legends.find(l => l.iid === input.iid);
      if (!leg)                      throw new Error('Legend not found');
      if (leg.face !== 'face_up')    throw new Error('Legend must be face-up to play');
      const kw = effectiveKeywords(b, pid, leg);
      if (!kw.includes('GO_SOLO'))   throw new Error('Legend does not have GO SOLO');

      const c = getCard(leg.card_id);
      const cost = solo ? goSoloCost(b, pid, leg) : (c.cost || 0);   // solo: printed + SoloCostTax − discount
      const spentLegends = cost > 0 ? P.spendTapped(p, cost) : [];

      const lidx = p.zones.legends.indexOf(leg);
      p.zones.legends.splice(lidx, 1);
      const unit = {
        iid:               leg.iid,
        card_id:           leg.card_id,
        state:             solo ? 'ready' : leg.state,   // read after payment: a self-paid plain play arrives spent
        equipped_gear:     leg.equipped_gear || [],
        entered_play_turn: b.turn_number,
        from_solo:         true
      };
      if (!solo) unit._temp_keywords = ['NO_HASTE'];   // overrides the GO_SOLO haste; cleared at end of turn
      p.zones.field.push(unit);

      const _sCtx = { source_pid: pid, source_iid: unit.iid, source_card_id: unit.card_id };
      const w = _fireEventsWithSpends(b, pid, spentLegends, ['OnPlay', 'OnCardPlayed'], _sCtx);
      if (w) return w;
      return mainWaiting(b);
    }

    case 'activate_anytime_spend':
      return _resolveAnytimeSpend(b, input);

    default:
      throw new Error(`Unexpected main input: ${input.step}`);
  }
}

// ─── END OF TURN ─────────────────────────────────────────────────────────────

function endTurn(b) {

  const compelled = b[b.active_player].zones.field.find(
    u => u._must_attack_on === b.turn_number && canUnitAttack(u, b, b.active_player)
      && hasAttackTarget(b, u, b.active_player));
  if (compelled) throw new Error('A compelled unit must attack before you can end your turn');

  const res = resolveEffects([
    { action: '_FireSubEvent', event: 'OnEndTurn', sub_ctx: { source_pid: b.active_player } },
    { action: '_EndTurnCleanup' },
    { action: '_EndTurnFinish' },
  ], b, { bindings: {} });
  if (res.halted) return haltToWaiting(b, 'resume_effects', res, b.active_player);
  return step(b, undefined);
}

// ─── DISPATCHER ──────────────────────────────────────────────────────────────

function _checkCardConservation(b) {
  if (!b._trace || b.effect_stack.length !== 0) return;
  const n = P.countBoardRefs(b);
  if (b._card_count === undefined) { b._card_count = n; return; }
  if (n !== b._card_count) {
    trace(b, `T${b.turn_number}/warn card-count drift ${b._card_count}->${n}`);
    b._card_count = n;
  }
}

// inPlace: mutate `board` instead of copying it first - only for a board nobody else holds (the
// in-between boards of a multi-step move in coach/policy.js apply(); a throw leaves it half-changed)
function step(board, input, inPlace) {
  const b = inPlace ? board : cloneBoard(board);
  _checkCardConservation(b);
  if (b.phase === 'between_turns') return beginTurn(b);
  switch (b.phase) {
    case 'mulligan': return stepMulligan(b, input);
    case 'start': return stepStart(b, input);
    case 'main':  return stepMain(b, input);
  }
  return ended(b);
}

// ─── PRE-GAME MULLIGAN (7.9.2 / 7.9.3) ───────────────────────────────────────
// First player declares (and executes) first, then the second player; one each.
function stepMulligan(b, input) {
  const m = b.mulligan;
  const owner = m.order[m.next];
  if (!input)
    return waiting(b, { step: 'mulligan_decision', owner, hand_iids: b[owner].zones.hand.map(c => c.iid) });
  if (input.step !== 'mulligan') throw new Error(`Unexpected pre-game input: ${input.step} (expected 'mulligan')`);
  if (typeof input.mulligan !== 'boolean') throw new Error('mulligan input needs mulligan: true|false');
  if (input.mulligan) {
    applyMulligan(b, owner);
    m.taken[owner] = true;
  }
  trace(b, `T0/mulligan ${owner} ${input.mulligan ? 'mulligan' : 'keep'}`);
  m.next += 1;
  if (m.next < m.order.length) return stepMulligan(b, undefined);
  delete b.mulligan;
  b.phase = 'between_turns';
  return beginTurn(b);
}

function defaultPassAction(waitingFor) {
  switch (waitingFor?.step) {
    case 'mulligan_decision':       return { step: 'mulligan', mulligan: false };
    case 'main_phase':              return { step: 'end_turn' };
    case 'defensive_step':          return { step: 'pass_defensive' };
    case 'attacker_interrupt_step': return { step: 'pass_attacker_interrupt' };
    default:                        return null;
  }
}

module.exports = { step, defaultPassAction };
