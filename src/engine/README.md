> **Eddies fork.** A patched copy of PUNKSIM's cyber-sim-engine (MIT, upstream commit 39f1dc0,
> Oct 19 2026), fixed against the Comprehensive Rules (Oct 29 2026) and the official Rules FAQ.
> The audit and fix list are in `notes/engine-audit.md` at the Eddies repo root. Run the tests
> with `node test/run.js [filter] [--fuzz N]` (each case fails on the upstream engine and passes
> here; the fuzz plays the meta decks in `test/decks/` against each other with rule checks).

Note (upstream): This repo is a push from PUNKSIM/engine folder. There is no GIT history. PR's will not work, please raise an issue instead.

# Open Punksim Core Engine Stepper

PUNKSIM is an unofficial simulation of the Cyberpunk Trading Card Game. 

Game is live at https://punksim.net

Companion SDK (bots + CLI runner): [cyber-sim-sdk](https://github.com/orzdk/cyber-sim-sdk)

## Core Engine

Rules engine and card data for the Cyberpunk TCG simulator (PUNKSIM).

The engine takes a board state and a player action, returns the new board
state plus the next halt (what choice the engine is waiting on). 

## Quick start

The engine ships without bots — grab one from the companion SDK
(`cyber-sim-sdk`). Clone both side-by-side:

```bash
git clone https://github.com/orzdk/cyber-sim-engine
git clone https://github.com/orzdk/cyber-sim-sdk
```

`runtime/play.js` runs a full game between two bots — no server, no HTTP —
and prints the winner:

```bash
cd cyber-sim-engine
node runtime/play.js \
  --deck1 decks/JUN06_RRG_Arasaka_Onslaught.deck \
  --deck2 decks/JUN06_BBY_Voodoo_Heist.deck
```

Windows: double-click `runtime/play.bat`.

Flags:
- `--bot1 <path>` / `--bot2 <path>` — bot file paths
- `--first p1|p2` — pin starting player (default random)
- `--turn-cap N` — abort runaway games (default 200)
- `--step-cap N` — abort a game stuck inside one turn (default 10000). A loop that
  never advances `turn_number` is invisible to `--turn-cap`; both report as errors.
- `--runcount N` — play N games and aggregate stats (default 1)
- `--seed N` — integer seed for the mulberry32 PRNG (also pins first player deterministically)
- `--trace` — dump engine trace to stdout (single-game only)

Every run also writes first game to `runtime/play.trace.jsonl`. The format is described in
**Walkthrough** below. If you need more statistics, you need to implement in play.js. 

---

## Walkthrough

This section walks through the first three exchanges of an actual game,
straight out of `runtime/play.trace.jsonl`. It's the quickest way to see
the protocol end-to-end before reading the reference.

### Step 1 — engine prompts p1 to pick a fixer die

Right after `setupGame`, the engine fires the first `step()` and immediately
halts because p1 has rollable dice in their fixer zone. The bot sees:

```json
{
  "kind": "recv", "n": 1, "turn": 1, "phase": "ready", "owner": "p1",
  "waitingFor": {
    "step": "choose_gig_die",
    "owner": "p1",
    "available": [4, 6, 8, 10, 12]
  },
  "board": { /* full game state */ }
}
```

**What the bot evaluates:** `waitingFor.step` tells the bot the question
shape; `waitingFor.available` lists the legal answers (one of the d4 / d6 /
d8 / d10 / d12 in p1's `zones.fixer`). The bot reads its own hand from
`board.p1.zones.hand`, its legends from `board.p1.zones.legends`, etc.

**What the bot sends back:**

```json
{
  "kind": "send", "n": 1, "owner": "p1",
  "action": { "step": "choose_gig_die", "sides": 4 },
  "source": "bot"
}
```

The action object's `step` always matches the prompt's `step`. The bot picks
the d4. Engine rolls it, moves the rolled die from `zones.fixer` to
`zones.gigs`, and fires the next halt.

### Step 2 — engine prompts p1 to take a main-phase action

```json
{
  "kind": "recv", "n": 2, "turn": 1, "phase": "main", "owner": "p1",
  "waitingFor": {
    "step": "main_phase",
    "owner": "p1",
    "spend_activatable_iids": [],
    "attackable": []
  }
}
```

The board has changed — `p1.zones.gigs` now contains the d4 that was rolled
(`{ iid: "p1_d4", sides: 4, value: 1, origin_pid: "p1" }`), `p1.zones.fixer`
is one die shorter, and `p1.took_gig_this_turn = true`.

`spend_activatable_iids` lists `spend_activated` abilities the bot can
trigger right now — empty here because no asset is in play yet.

**What the bot evaluates:** which (if any) card to play, resource to tap,
legend to call, unit to attack with, or whether to end the turn. The minimum
bot picks "end turn" immediately:

```json
{
  "kind": "send", "n": 2, "owner": "p1",
  "action": { "step": "end_turn" },
  "source": "bot"
}
```

Control swaps to p2. (On turn 1, `attackable` is empty anyway — attacks are
only available from turn 3 on.)

### Step 3 — engine prompts p2 to pick a fixer die

```json
{
  "kind": "recv", "n": 3, "turn": 2, "phase": "start", "owner": "p2",
  "waitingFor": {
    "step": "choose_gig_die",
    "owner": "p2",
    "available": [4, 6, 8, 10, 12]
  }
}
```

`board.turn_number` is now 2, `board.active_player` is `"p2"`. The driver
notices `waitingFor.owner === "p2"` and routes the next `selectAction` call
to bot2 instead of bot1.

### The pattern

Every exchange follows the same shape:

1. Engine returns `{ board, waitingFor }`.
2. Driver dispatches to `bots[waitingFor.owner].selectAction(waitingFor, board)`.
3. Bot returns an action object whose `step` matches `waitingFor.step` (or
   matches the expected response shape for the halt — see **Reference §6** below).
4. Driver calls `step(board, action)` → new `{ board, waitingFor }`.
5. Loop until `board.winner` is set.

Bot fallbacks: if `selectAction` returns `null`, the driver auto-fills safe
defaults for `main_phase` (`end_turn`), `defensive_step` (`pass_defensive`),
and `attacker_interrupt_step` (`pass_attacker_interrupt`). For any other halt
(notably `effect_choice`), returning `null` is a bot bug — the bot must
implement the response.

### Reading the trace file

`runtime/play.trace.jsonl` is one JSON object per line:

| `kind` | Meaning |
|---|---|
| `config` | First line — bots, decks, firstPlayer, runcount, turnCap |
| `recv` | What the bot received: `n`, `turn`, `phase`, `owner`, `waitingFor`, `board` |
| `send` | What the bot sent: `n`, `owner`, `action`, `source` (`"bot"` or `"fallback"`) |
| `error` | Halt the bot couldn't handle (engine throw, no fallback, etc.) |
| `game_end` | Last line — winner, turns, steps, error |

## Public API

```js
const { setupGame, step, validateDeck, evalExpr,
        cleanBoardForExternal, disableTrace, defaultPassAction,
        CARDS, CARD_SCRIPTS, CHOICE_TYPES } = require('cyber-sim-engine');
```

- `setupGame(deckA, deckB, firstPlayer, opts?)` — build a fresh game.
  Returns the initial board. `firstPlayer` is `'p1'` or `'p2'`.
  `opts.seed` (optional integer) seeds the mulberry32 PRNG — same seed + same
  action sequence produces an identical game.
  `opts.preShuffled` (optional) lets a caller supply pre-shuffled decks +
  legends (used by the replayer).
  `opts.skipValidation` (optional) — by default `setupGame` throws
  `Illegal pN deck: …` for a deck that fails `validateDeck`/`deckIsIllegal`
  (with `preShuffled`, the hand+deck+legends given there are validated).
  `opts.mulligan === false` (optional) skips the pre-game mulligan step; by
  default the first `step(board, undefined)` returns `mulligan_decision`.
- `step(board, action)` — advance one step. Returns
  `{ status, board, waitingFor }` where `status` is `'waiting'` or
  `'ended'`; `waitingFor` is `null` when `status === 'ended'`.
- `validateDeck(deckDef)` — check deck legality. Returns
  `{ errors, warnings, total }`. A deck is legal when `errors.length === 0`.
  Copies are counted per name + subtitle across all entries (max 3); RAM/color
  violations are listed in `errors`.
- `evalExpr(expr, board, ctx)` — evaluate a card-script expression against a
  board state (used for cost modifiers, conditional triggers, etc.).
- `cleanBoardForExternal(board)` — return a shallow copy of `board` with
  engine-internal fields stripped (`_trace`, `_rngMap`, `_rng_seq`, `_rngState`),
  for handing to clients / serializers.
- `disableTrace(board)` — set `board._trace = null` so subsequent `trace()`
  calls are no-ops. Useful for high-throughput batch runs (the arena worker
  enables this automatically).
- `defaultPassAction(waitingFor)` — safe-default action for a given
  `waitingFor`. Returns an action object or `null`. The driver in
  `runtime/play.js` uses this when a bot returns `null`.
- `CARDS` / `CARD_SCRIPTS` — arrays of card definitions and script
  definitions. Build your own `card_id` → entry index if you need O(1)
  lookup; the package doesn't ship a pre-built map.
- `CHOICE_TYPES` — spec of all halt kinds with display hints.

## Determinism and replay

Engine randomness flows through a single internal function `randFloat(b, tag)`.
It has three modes:

**Default (non-deterministic)** — no RNG fields set on the board → uses
`Math.random()`. Fine for one-off play; not reproducible.

**Seeded PRNG** — pass `opts.seed` to `setupGame` (or set `board._rngState`
directly before calling `step`). The engine runs a mulberry32 PRNG seeded by
that value. Same seed + same action sequence = identical game every time. The
`--seed N` flag on `runtime/play.js` exercises this path.

```js
const { board } = step(setupGame(d1, d2, 'p1', { seed: 42 }), undefined);
```

**Named map** — set `board._rngMap = {}` before playing. The engine writes
each named outcome into the map as it goes (`tag → float`). To replay, set
that same map on a fresh board; `randFloat` returns the recorded value instead
of rolling again. Tags are stable across engine versions for the same sequence
of actions, so this is load-bearing for snapshot/replay systems.

```js
// record
board._rngMap = {};
// ... play game; board._rngMap accumulates { 'd.p1_d4.t1': 0.73, ... }

// replay
replayBoard._rngMap = { ...recordedMap };
// engine consumes named values instead of rolling fresh
```

## Testing

The test suite lives in the upstream repo at
[github.com/orzdk/cyber-sim](https://github.com/orzdk/cyber-sim) under
`server/test/`. The engine is verified by the author against the full card
pool before each release.

## License

MIT. See `LICENSE`.

---

# Reference

Flat reference for everything the public API exposes — board, halt protocol,
card-script DSL, evaluators. Every fact is read directly from source; if
behavior drifts from this doc, the source wins.

## 1. Entry Point

`step(board, input)` — exported from the package root (`require('cyber-sim-engine').step`).

- Always deep-clones the incoming board before mutating.
- Returns `{ status: 'waiting', board, waitingFor }` or `{ status: 'ended', board, waitingFor: null }`.
- Card data (`cards.json` / `card_scripts.json`) is bundled and deep-frozen; the
  engine reads it internally — callers never pass it. `CARDS` / `CARD_SCRIPTS`
  are exported for the caller's own lookups (bots, UI).

---

## 2. Board Shape

Produced by `createBoard()` and `setupGame()`.

```
board = {
  p1: PlayerState,
  p2: PlayerState,
  turn_number: 0,
  active_player: 'p1' | 'p2',
  first_player:  'p1' | 'p2',
  phase: 'between_turns' | 'start' | 'main',
  current_attack: null | AttackState,
  effect_stack:   [],
  scheduled_effects: [],
  rate_limits: { p1: {}, p2: {} },
  overtime: false,
  winner: null | 'p1' | 'p2',
  _next_iid: 1,
  _trace: [],
}
```

### PlayerState

```
{
  id: 'p1' | 'p2',
  zones: Zones,
  called_legend_this_turn: false,   // ONE Call per turn: main-phase, defensive and card-effect Calls
                                    // share it; both players' flags reset at every turn start
  sold_card_this_turn: false,
  tapped: [],              // iids of resources tapped but not yet spent
  took_gig_this_turn: false,
}
```

### Zones

```
{
  hand:    [CardRef],
  deck:    [CardRef],
  trash:   [CardRef],
  removed: [CardRef],
  legends: [LegendRef],
  eddies:  [EddieRef],
  field:   [UnitRef],
  fixer:   [Fixer],        // 6 entries: d4,d6,d8,d10,d12,d20
  gigs:    [GigRef],
}
```

### Ref shapes

**CardRef** (hand / deck / trash / removed): `{ iid, card_id }`

**UnitRef** (field):
```
{ iid, card_id, state: 'ready'|'spent', equipped_gear: [GearRef],
  entered_play_turn: number,
  _temp_power?: number, _temp_keywords?: string[], _peeked?: true }
```

**LegendRef** (legends):
```
{ iid, card_id, state: 'ready'|'spent', face: 'face_up'|'face_down',
  equipped_gear: [GearRef] }
```

**GearRef** (inside `equipped_gear`): `{ iid, card_id }`

**EddieRef** (eddies, created when a card is sold): `{ iid, card_id, state: 'ready'|'spent' }`

**GigRef** (gigs / fixer):
```
{ iid, sides: 4|6|8|10|12|20, value: number, origin_pid: 'p1'|'p2' }
```
Fixer starts as `{ iid: '<pid>_d<sides>', sides, value: 0 }` without origin_pid.

---

## 3. setupGame Initial State

- Both decks shuffled; both hands deal `OPENING_HAND_SIZE` (6) cards from top of deck.
- Legends shuffled, all start `face_down`, `state: 'ready'`.
- First player starts with `legends[0]` and `legends[1]` in `state: 'spent'`.
- `turn_number` = 0; phase = `'mulligan'` with `board.mulligan = { order: [first, second], next, taken }`
  (or `'between_turns'` when `opts.mulligan === false`).
- `setupGame` throws on an illegal deck unless `opts.skipValidation`.
- `_next_iid` starts at 1 and increments for every new game object.

---

## 4. Phase Flow

```
mulligan  (pre-game, rule 7.9.2)
  └─ stepMulligan(): waitingFor mulligan_decision (first player, then second);
       input { step:'mulligan', mulligan: bool } — true = hand back, shuffle, draw 6.
       After the second decision → between_turns → beginTurn() (turn 1).

between_turns
  └─ beginTurn()
       ├─ turn_number += 1
       ├─ reset BOTH players' once-per-turn flags (Call, Sell) and all rate_limits
       ├─ 7-Gig win check (8.6.1)
       ├─ expire "until your next turn" effects, fire OnTurnStart (8.6.2; may halt → effect_choice in phase 'start')
       ├─ readyAll (turn 2+ only) + draw card (deck-out loses)
       ├─ if fixer has non-d20 dice → phase='start', waitingFor: choose_gig_die
       └─ else → phase='main', fires OnPlayPhaseStart, waitingFor: main_phase

start
  └─ stepStart()
       ├─ input: choose_gig_die → rolls die, pushes to gigs, removes from fixer
       └─ → phase='main', fires OnPlayPhaseStart, waitingFor: main_phase

main
  └─ stepMain()  (play and attack interleave freely)
       ├─ input: tap_resource | untap_resource | sell_card | call_legend | play_card
       │    all return waitingFor: main_phase
       ├─ input: declare_attack (turn 3+) → declares, fires OnCardAttacks, waitingFor: defensive_step
       │    combat resolves → back to waitingFor: main_phase
       ├─ input: end_turn | null → endTurn() → next player's turn
       ├─ defensive_step (React Step): blocker | call_legend_defensive | quick cast/ability,
       │    any number, any order — each returns to defensive_step — then pass_defensive
       │    The attack ends (no React Step / no fight / no steal) whenever the attacker
       │    or the target Unit leaves the field or the target becomes invalid (9.6, 9.21).
       ├─ pass_defensive → fight: powers → loser(s)/winner declared (fight triggers become
       │    pending) → losers defeated ({Defeated} pending) → pending resolve, turn player
       │    first → attack ends.  Or steal: choose_gig_to_steal → handleStealChoice
       └─ effect_choice_response → resume, dispatch by pending_resume
```

---

## 5. waitingFor Objects

All include `{ step, owner }`. `owner` is the pid that must act.

### `mulligan_decision`
```js
{ step: 'mulligan_decision', owner, hand_iids: [iid, ...] }
```
Pre-game (rule 7.9.2). First player decides first, then the second player; each may
mulligan once. `defaultPassAction` keeps.

### `choose_gig_die`
```js
{ step: 'choose_gig_die', owner, available: [4|6|8|10|12|20, ...] }
```
Available = non-d20 fixer sides if any; falls back to [20] if only d20 remains.

### `main_phase`
```js
{ step: 'main_phase', owner,
  spend_activatable_iids: [{ iid, card_id, ability_idx, kind, host_iid?, prompt? }, ...],
  attackable: [iid, ...],
  must_attack_iids: [iid, ...] }
```
`spend_activatable_iids` lists Anytime `spend_activated` abilities the owner can fire right now.
`attackable` = iids of ready units that `canUnitAttack()` AND have at least one valid target
(an empty rival Gig area is not a target — rule 9.3.2.2). Plays and attacks
interleave freely; `declare_attack` is one of the available actions (see §6) and combat returns here.
`must_attack_iids` = compelled units (`CompelAttack`); `end_turn` is rejected while one of them
can still legally attack.

### `attacker_interrupt_step`
```js
{ step: 'attacker_interrupt_step', owner,
  attacker_iid, target,
  interrupt_castable_iids: [iid, ...],
  interrupt_spendable_iids: [{ iid, card_id, ability_idx, ... }, ...] }
```
Fired after `declare_attack` when the attacker has interrupt cards in hand or spend-activated abilities reacting to `OnCardAttacks`.

### `defensive_step`
```js
{ step: 'defensive_step', owner, attacker_iid, target,
  can_call_legend: bool, call_legend_cost: n, call_legend_payable_iids: [iid, ...],
  blocker_iids: [iid, ...],
  interrupt_castable_iids: [iid, ...],
  interrupt_spendable_iids: [{ iid, card_id, ability_idx, ... }, ...] }
```
`can_call_legend` is false if the defender already Called a Legend this turn (one Call per
turn, shared with main-phase and card-effect Calls). `call_legend_payable_iids` = the
defender's ready Eddies + spendable Legends; pay with `pay_iids`.
`blocker_iids` = ready, non-lagging units with BLOCKER keyword (a unit that entered the field
this turn can't use Blocker — rule 11.3.1.2), excluding the current target Unit (11.28.3.1);
blocking spends the chosen unit (firing `OnSpent`, then `OnBlock`), makes it the target, and
RETURNS to `defensive_step` — the React Step goes on (another redirect, a Call, quick
cards) until `pass_defensive`. Empty if the attacker is currently
UNBLOCKABLE — computed live each time this step renders (covers mid-attack Street Cred
changes) and applies to both gig and unit attacks. `interrupt_castable_iids` = quick
Programs the defender can cast at normal cost; `interrupt_spendable_iids` = quick
spend-activated abilities offered as a reaction.

### `choose_gig_to_steal`
```js
{ step: 'choose_gig_to_steal', owner, available_iids: [iid, ...], count: n }
```

### `effect_choice`
```js
{ step: 'effect_choice', owner, choice_needed: ChoiceNeeded }
```
Includes `choose_pending_order` (§7): the owner orders their simultaneous pending effects.

---

## 6. Input Shapes

### mulligan_decision
```js
{ step: 'mulligan', mulligan: true | false }
```

### choose_gig_die
```js
{ step: 'choose_gig_die', sides: 4|6|8|10|12|20 }
```

### main_phase actions
```js
{ step: 'tap_resource',          iid } 
{ step: 'untap_resource',        iid }
{ step: 'sell_card',             iid } 
{ step: 'call_legend',           iid } 
{ step: 'play_card',             iid, equip_to? }  
{ step: 'play_legend_solo',      iid }
{ step: 'play_legend',           iid }
{ step: 'activate_anytime_spend', iid, ability_idx }
{ step: 'declare_attack', attacker_iid, target: { kind: 'gigs' } }
{ step: 'declare_attack', attacker_iid, target: { kind: 'unit', iid: targetIid } }
{ step: 'end_turn' }
```
`declare_attack` is only valid from turn 3 on, for an iid in `attackable`.
Only spent units can be attacked as `kind: 'unit'`.
`HASTE_VS_SPENT` units entering that turn cannot target `kind: 'gigs'`.

### defensive_step
```js
{ step: 'blocker',              iid } 
{ step: 'call_legend_defensive', iid, pay_iids? }   // pay_iids: exactly call_legend_cost iids
                                                    // from call_legend_payable_iids; may be omitted
                                                    // only when there is exactly one way to pay
{ step: 'play_card_interrupt_cast', iid }
{ step: 'activate_asset_spend', iid, ability_idx }
{ step: 'pass_defensive' }
```

### attacker_interrupt_step
```js
{ step: 'play_card_interrupt_cast', iid }
{ step: 'activate_asset_spend', iid, ability_idx }
{ step: 'pass_attacker_interrupt' }
```

### choose_gig_to_steal
```js
{ step: 'choose_gig_to_steal', iids: [iid, ...] }
```
Must provide exactly `count` iids, all from `available_iids`. Each chosen Gig gets its
`OnWouldStealGig` prevention window, then every unprevented Gig moves at once (11.5.1.6.1),
then `OnStealGig` fires once per Gig and `OnStealGigs` once for the batch. A steal of 0
Gigs (power 0, nothing left, all prevented, attacker gone) fires neither.

### effect_choice_response
```js
{ step: 'effect_choice_response', response: Response }
```
Response shape depends on `choice_needed.kind` — see section 7
(`choose_pending_order`: `{ iid }` = resolve next, or `{ order: [ids] }`).

---

## 7. effect_choice.choice_needed Variants

### `confirm_optional`
```js
{ kind: 'confirm_optional', bind_pid, prompt, pending_body: [...effects], optional: true }
// response:
{ accept: true }   // executes pending_body
{ accept: false }  // skips pending_body
```

### `choose_amount`
```js
{ kind: 'choose_amount', bind_pid, bind_to: bindingName, prompt, min, max, exclude_zero: bool }
// response:
{ amount: n }      // n must be in [min, max]; non-zero if exclude_zero
```

### `choose_unit`
```js
{ kind: 'choose_unit', bind_pid, bind_to, prompt, available_iids: [iid,...], optional: bool }
// response:
{ iid }            // must be in available_iids; null allowed if optional
```

### `choose_gig`
```js
{ kind: 'choose_gig', bind_pid, bind_to, prompt, available_iids: [iid,...], optional: bool }
// response: { iid }
```

### `choose_legend`
```js
{ kind: 'choose_legend', bind_pid, bind_to, prompt, available_iids: [iid,...], optional: bool }
// response: { iid }
```

### `choose_gear`
```js
{ kind: 'choose_gear', bind_pid, bind_to, prompt, available_iids: [iid,...], optional: bool }
// response: { iid }
```

### `choose_card_in_hand`
```js
{ kind: 'choose_card_in_hand', bind_pid, bind_to, prompt, available_iids: [...], optional: bool }
// response: { iid }
```

### `choose_card_in_trash`
```js
{ kind: 'choose_card_in_trash', bind_pid, bind_to, prompt, available_iids: [...], optional: bool }
// response: { iid }
```

### `choose_card_in_deck`
```js
{ kind: 'choose_card_in_deck', bind_pid, bind_to, prompt, available_iids: [...], optional: bool }
// response: { iid }
```

### `choose_from_top_n`
```js
{ kind: 'choose_from_top_n', bind_pid, prompt,
  available_refs: [CardRef,...],   // all cards revealed
  eligible_iids: [iid,...],        // which ones pass the filter
  take_up_to: n,
  take_min?: n,                    // ScryTrash with min_take — selecting fewer is rejected
  trash_remainder?: bool,
  scry_trash?: bool }              // selected → trash, unselected → back on TOP in order
// response:
{ selected_iids: [iid,...] }       // subset of eligible_iids, take_min <= length <= take_up_to
```

### `choose_in_play`
```js
{ kind: 'choose_in_play', bind_pid, bind_to, prompt, available_iids: [...], optional: bool }
// response: { iid }
```
Virtual zone spanning field units + face-up legends (e.g. gear equip destinations).

### `choose_units`
```js
{ kind: 'choose_units', bind_pid, chooser_pid, bind_to, prompt,
  available_iids: [iid,...],
  take_up_to: n,
  optional: bool }
// response:
{ selected_iids: [iid,...] }       // must be subset of available_iids, length <= take_up_to
```
Used when an effect target has `quantifier: 'upto_n'` over Units in the field with `chooser: 'controller'`.

### `choose_pending_order`
```js
{ kind: 'choose_pending_order', bind_pid, chooser_pid, prompt,
  available_iids: [id,...],                 // pending-effect ids, e.g. 'pe42'
  options: [{ id, card_id, name, source_iid }],
  optional: false }
// response, either:
{ iid: id }                 // resolve this one next (asked again while 2+ differing remain)
{ order: [id, id, ...] }    // full order: every id in available_iids exactly once; no more prompts
```
Rule 10.14.1: the owner of 2+ simultaneous pending effects picks their order. Offered
only when the order can matter (not for one effect, nor for identical copies of the
same ability). The rival's pending effects wait until all of these are resolved
(turn player's set first, 10.15).

---

## 8. Events Fired by the Engine

| Event | When fired |
|-------|-----------|
| `OnTurnStart` | Rule 8.6.2 "at the start of your turn": after the 7-Gig check, BEFORE the ready step, draw and Gig roll-in (`source_pid` = active player; use `by:'controller'`). Hanako: Daughter of the Emperor |
| `OnPlayPhaseStart` | Start of every main phase (after the Gig roll-in) — only for effects that genuinely mean the Main phase / "each turn" (Viktor Vektor: Drop Your Illusions' first-Cyberware discount) |
| `OnPlay` | Card enters play (Unit, Program, Gear) |
| `OnCardPlayed` | After OnPlay for same card |
| `OnCall` | Legend flips face_up (main or defensive) |
| `OnFlip` | After OnCall for same legend |
| `OnCardAttacks` | Attacker declared |
| `OnBlock` | A unit is declared as blocker (source = the blocking unit) |
| `OnDefeated` | A unit is defeated — combat, `Defeat` effects, or scheduled end-of-turn defeats (`event_data.gear_count`) |
| `OnWinFight` | A Unit (attacker or defender) wins a fight. Pending from the moment the winner is declared — resolves even if the winner has since left the field |
| `OnLoseFight` | A Unit loses a fight (`event_data.opposing`). Also pending, like `OnWinFight` and the fight's `OnDefeated` |
| `OnSpent` | Card transitions ready → spent — attacking, paying a cost (tapped legends, ability spend/eddies), or Spend/SpendSelf effects |
| `OnStealGig` | Once PER Gig stolen ("when ... steals a Gig"); `stolen_gigs` holds just that Gig |
| `OnStealGigs` | Once per steal of 1+ Gigs ("steals 1 or more Gigs"), after the `OnStealGig`s — combat steal or a cross-player `TransferGig`; `stolen_gigs` holds them all. Never fires for a 0-Gig steal |
| `OnGigValueChanged` | A gig's value changes (any direction) and the changer is not its owner (`source_pid` = the effect's controller) |
| `OnEndTurn` | End of the active player's turn, before scheduled cleanup (`source_pid` = active player; use `by:'controller'`) |

### Event context fields
```js
{ source_pid, source_iid, source_card_id, event_data? }
```
`event_data.stolen_gigs` is set on OnStealGig / OnStealGigs; `gear_count` and `equipped_gear`
(the Gear it had on the field) on OnDefeated — that Gear's `by: 'host'` triggers still hear
the event (rule 11.23.3, The Relic);
`gig_iid` / `gig_pid` / `old_value` / `new_value` on OnGigValueChanged.

### Listener semantics

Pending resolution (rule 10). When an event happens, everything it triggers
becomes PENDING at that moment (`collectPending()` in `events.js`): the card's
own self block (`onDefeated`, `onSpent`, …), every in-play listener whose trigger,
rate limit and condition match, and matching badges (consumed then). Cards
entering play afterwards don't react to it. Pending effects then resolve via
`runPending()`:
- **Turn player first** (10.15): all of the turn player's pending effects, then the rival's.
- **Owner picks the order** of their own (10.14.1): with 2+ pending effects of
  different cards/abilities the owner gets a `choose_pending_order` choice (§7).
  No prompt for a single effect or for identical copies of one ability.
- **Survives leaving play** (10.16): an entry resolves even if its source has left
  the field (or its Gear moved), using last known information. A trigger's own
  `condition` is re-checked at resolution while the source is still in play.

Events raised in the middle of an effect (Spend, Defeat, Gig changes) collect
their pending set immediately and resolve after that effect finishes. A
{Spend}/€$ cost paid for an activated ability or a Program makes its "when
spent" triggers pending; they resolve after the ability/Program. Spending the
attacker and its {Attack} triggers are one pending set (`_FireTogether`).
Fight triggers and fight {Defeated} effects are one pending set (see §4).

---

## 9. effect_stack Frame Types

```js
{ kind: 'resume_fire_event', halted_state }
{ kind: 'resume_effects',    halted_state }
```
Stack is LIFO. Top frame popped on `effect_choice_response`.

### Sub-event halts inside effect chains

When an effect action fires a sub-event (e.g. `CallLegend` → OnCall, `PlayFromZone` → OnPlay) via the internal `_FireSubEvent` action, and the sub-event halts mid-resolution, the action returns `{ continue: false, fire_event_halt: result }`. `resolveEffects` wraps this into an outer halted state with `sub_halted: true` and the inner `fire_event_halt` attached. `resumeEffects` detects `sub_halted`, dispatches the response to `fireEventResume` first; if the inner halts again, re-bubbles; if it completes, continues the outer chain's `pending_effects`. Halt nesting depth is arbitrary.

### pending_resume.kind values

Set when a halt occurs mid-multi-stage sequence. The full set lives in
`engine/lib/constants.js` `PENDING_KINDS`:

| kind | Continuation |
|------|-------------|
| `'fight'` | `runFight()` — combat stages |
| `'steal_finish'` | `finishSteal()` — after OnStealGigs |
| `'defensive_chain'` | `runDefensiveChain()` — OnCall+OnFlip queue |
| `'endturn'` | `endTurn()` — end-of-turn scheduled defeats |
| `'interrupt_cast_in_attacker'` | `continueInterruptCastInAttacker()` — return to attacker-interrupt step |
| `'interrupt_cast_in_defensive'` | `continueInterruptCastInDefensive()` — return to defensive step |

---

## 10. Win / End Conditions

- `board.winner !== null` + `status: 'ended'`
- Active player has ≥ 7 gigs at the start of their turn (before start-of-turn effects) → wins.
- `board.overtime === true`: any player with ≥ 7 gigs wins immediately — checked after every
  resolved effect (steals, TransferGig, swaps…), at turn start, and when overtime begins (1.12).
- Drawing from an empty deck → that player loses, immediately and wherever the draw
  happens. An empty deck is not itself a loss: milling and searching never deck you out.

---

## 11. Unit Attack Eligibility

`canUnitAttack(u, b, pid)` returns true when:
- `u.state === 'ready'`
- Does NOT have `CANNOT_ATTACK` keyword
- If `u.entered_play_turn === b.turn_number` (summoning sickness), must have `GO_SOLO`, `HASTE_VS_SPENT`, or `ADRENALINE`

Keyword lookups go through `effectiveKeywords()` — conditional `SelfKeyword`s
and `AuraKeyword`s (e.g. gear-granted) are honored.

`HASTE_VS_SPENT` units entering this turn can only attack spent units (not the player).

Lag (rule 11.3) also stops activation: a unit with `entered_play_turn === turn_number`
(Go Solo Legends included) is not offered its spend-activated abilities (gear abilities paid by
it included) and can't use Blocker (`isLagging` / `lagBlocksActivation` in `rules.js`). A unit's
own `{Attack}` trigger scripted as `spend_activated` on `OnCardAttacks` with `by:'self'` is exempt.

Known rule ambiguities left as-is: card-effect sells (`SellTopCard`) ignore the once-per-turn
Sell flag (rules 5.8.2.3 vs 11.12.2.2 conflict); raising/lowering a Gig past its range makes
the whole adjustment fail rather than going as far as possible; Gear on a Go Solo Legend
leaving the field goes to `removed` with it (rule 4.12.2 vs Go Solo's own text).

---

## 12. Street Cred

`streetCred(playerState)` = sum of `gig.value` across `zones.gigs`.

---

## 13. Spending Resources

A player's spendable pool = ready eddies + ready face-up legends.

Tap model: `tap_resource` moves an iid into `p.tapped` (or back out — the
action toggles). `spendTapped(p, n)` moves `n` from tapped to spent. Called
automatically on `play_card` (costs `card.cost`) and `call_legend` (costs 1).
Legend defensive call and quick-Program casts use `spendEddies(p, n)` (direct
spend, no tap step); `spendEddies(p, n, excludeIid)` skips a specific iid
(used by `spend_activated` ability costs so the ability's own card isn't
counted toward its eddie cost).

---

## 14. Keywords

All stored and compared as uppercase strings.

| Keyword | Effect |
|---------|--------|
| `GO_SOLO` | Can attack turn it enters play (also lets a face-up Legend be played as a Unit). A solo-played legend is tagged `from_solo` and is removed from the game — with its gear — on any leave-field path (defeat, bounce, bottom-deck) |
| `ADRENALINE` | Can attack the turn it enters play (haste only; no Legend-solo meaning) |
| `BLOCKER` | Can be chosen as blocker during defensive_step |
| `CANNOT_ATTACK` | Cannot declare attacks |
| `UNBLOCKABLE` | Attack bypasses blockers (condition-gated) |
| `HASTE_VS_SPENT` | Can attack spent units on entry turn only |

Source (via `effectiveKeywords(b, pid, unit)`): unit's
`_temp_keywords` + `_until_keywords` + own `SelfKeyword` statics (with
conditions evaluated against the live board) + any `AuraKeyword` from
in-play sources whose `affects` filter matches this unit (e.g. α027's
gear-→-host BLOCKER aura).

`_temp_keywords` is cleared by `clearTransients` (end of every turn) and `readyAll` (start of active player's turn). `_until_keywords` survives both — each entry is `{ kw, until_pid, until_turn }` and is cleared by `clearExpiredUntilKeywords` at the start of `until_pid`'s turn when `turn_number >= until_turn`. Granted via `GrantTempKeyword` with `until: "controller_next_turn"` (or explicit `{ pid, turn }`).

---

## 15. card_scripts.json Structure

```js
{
  "card_id": "xxx",
  "statics":           [Static, ...],
  "onPlay":            [Effect, ...],
  "onCall":            [Effect, ...],
  "onFlip":            [Effect, ...],
  "onDefeated":        [Effect, ...],
  "onSpent":           [Effect, ...],
  "abilities":         [Ability, ...],
  "quick":             true?,                          
  "playCostModifier":  { discount: <expr>, min: 1 }? 
}
```

The `onX` arrays run as the source card's self-reaction during the
matching engine event (Phase A of `fireEvent`). Only events listed in
`SELF_KEYS` (currently `OnPlay`/`OnCall`/`OnFlip`/`OnDefeated`/`OnSpent`)
have this shortcut; for other events, write a listener in `abilities`.

### Static kinds

| kind | Fields | Meaning |
|------|--------|---------|
| `SelfKeyword` | `keyword`, `condition?` | Grants keyword to self |
| `SelfPower` | `expr`, `when?` | Adds computed power to self |
| `Aura` | `affects`, `expr`, `when?` | Power bonus to matching friendly units |
| `AuraKeyword` | `affects`, `keyword` | Grants keyword to equipped host or other |
| `PowerMultiplier` | `factor`, `when?` | Multiplies total power |
| `FirstOfTurnPlayDiscount` | `filter`, `amount`, `min?` | Controller's first matching play each turn (either player's turn) costs `amount` less, floored at `min` (cost.js). "First" = the card's own marker ability (triggered `OnCardPlayed`, `rate_limit: first_per_turn`, scope `controller`, empty effect), recorded even before the card is in play (Viktor Vektor: Drop Your Illusions) |

### when clause fields
- `active_player: 'self'` — only on controller's turn
- `during_fight: true` — only during combat resolution
- `role: 'attacker' | 'defender'` — only in that fight role

### Ability (triggered / spend_activated)
```js
{
  "kind": "triggered" | "spend_activated",
  "trigger": {
    "event": EventName,          // spend_activated: 'Anytime' (main phase) or 'OnCardAttacks'
    "by": "any" | "self" | "controller" | "opponent" | "host",
    "card": CardFilter?,         // filter on source card
    "rate_limit": "first_per_turn"?,
    "rate_limit_scope": "iid" | "card_id" | "controller"?,
    "also_when_leaving": true?   // also heard by the event's own source card after it left play
  },
  "condition": ConditionSpec?,   // gates the trigger after match
  "cost": { spend: { from_self: true }?, eddies: n? }?,  // spend_activated only
  "quick": true?,                // spend_activated only — also offered to the DEFENDER during a rival attack
  "prompt": "..."?,
  "effect": [Effect, ...]
}
```
`rate_limit_scope: 'controller'` is keyed per card_id, so different cards with
controller-scoped limits on the same event don't suppress each other.
A controller-scoped `first_per_turn` limit means "the first time X happens each
turn": every fired event is stamped with a token and recorded for each player it
would qualify for, **even with no copy of the card in play** — so a Legend flipped
face-up after the first Blue play / ARASAKA attack doesn't trigger on the second
(FAQ: Jackie Welles: Pour One Out For Me, Yorinobu Arasaka). Listeners of the very
event that set the record still fire. `also_when_leaving` lets a card react to an
event about itself after it left play (Yorinobu: Steel Dragon's own defeat).

---

## 16. Effect Actions

### Control flow
| Action | Key fields |
|--------|-----------|
| `Optional` | `body: [...]`, `prompt` |
| `ChooseAmount` | `min`, `max`, `exclude_zero`, `bind_to`, `chooser`, `prompt` |
| `If` | `cond`, `then: [...]`, `else?: [...]` |

### Card flow
| Action | Key fields |
|--------|-----------|
| `Draw` | `n` |
| `Discard` | `n`, `target?` (if no target, top of own hand) |
| `Mill` | `n`, `side?`, `bind?` — binds the milled refs as an array; pair with `filter.in_binding` for "from among them" picks |
| `SellTopCard` | — sells the top card of own deck into a ready eddie; ignores the eddie tag and `sold_card_this_turn` |
| `RecoverFromTrash` | `target` — Legend-type cards are excluded unless the script names a type itself |
| `SelectTarget` | `target` (only binds; no mutation) |
| `SearchTopN` | `n`, `take_up_to`, `take_min?` (must take at least this many, capped by eligible), `filter?`, `trash_remainder?`, `auto_take_all?` |
| `AddBadge` | `trigger`, `condition?`, `effect`, `for_unit?` (binding) — one-shot "the next time ..." listener for this turn; `for_unit` ties it to the chosen Unit (only that Unit's event fires it, and a `TransferGig` in it steals AS that Unit — Safety Override, Appetite for Destruction) |
| `ScryTrash` | `n`, `trash_up_to`, `min_take?`, `filter?` — look at top n, trash some, rest back on TOP in order |
| `RivalDiscards` | `n`, `filter?`, `bind?` (binding carries the card's `cost`) |
| `RevealTop` | `n`, `bind` — peek + bind the top N of own deck; pair with `TakeFromBound` |
| `TakeFromBound` | `from`, `filter?`, `trash_remainder?`, `choose?`, `prompt?` — pull matching cards from a bound array into hand; `choose: true` ("any number") asks via `choose_from_top_n` (0..all matching), the rest go to the bottom |

### Gig mutations
| Action | Key fields |
|--------|-----------|
| `IncreaseGig` | `target`, `amount` |
| `DecreaseGig` | `target`, `amount` |
| `AdjustGig` | `target`, `amount` (signed) |
| `SetGigValue` | `target`, `amount` |
| `TransferGig` | `target`, `to: 'controller'` — a cross-player transfer fires `OnStealGig` then `OnStealGigs`. A stealing Unit under `ModifyStealCount` (Take Control) steals 1 + mod Gigs, so -1 cancels it |

Gig mutations re-bind the target with its new state plus `prev_value` (value
before the change), so downstream conditions can express "became X".

### Field mutations
| Action | Key fields |
|--------|-----------|
| `Defeat` | `target` |
| `DefeatGear` | `target` |
| `ReturnToHand` | `target` — the unit goes to hand; its Gear goes to the trash (rule 11.9.1.2) |
| `BottomDeckFromField` | `target` — the unit goes to the deck bottom; its Gear goes to the trash |
| `RemoveFromGame` | `target` — the card is removed; its Gear goes to the trash (FAQ Rogue Amendiares) |
| `BottomDeckSource` | — bottom-decks the trigger's source card from the field or the trash (The Relic: "Then, bottom-deck this Unit") |
| `AddBoundToHand` | `from` (binding) — moves the bound card(s) from deck/trash to hand; not a draw, so an empty deck never loses (Judy Álvarez: Nothing to Doubt) |

### State
| Action | Key fields |
|--------|-----------|
| `Spend` | `target` |
| `Ready` | `target` |
| `SpendSelf` | — |
| `ReadyEddie` | `n` — readies up to n of the controller's spent eddies |

### Modifiers
| Action | Key fields |
|--------|-----------|
| `GrantTempPower` | `target`, `amount`, `when?`, `live?` — with `when`, `live: true` keeps `amount` as an expression re-evaluated at every power read (Synapse Burnout counts Legends at the fight) |
| `GrantTempKeyword` | `target`, `keyword`, `until?` (`"controller_next_turn"` or `{ pid, turn }`) |
| `DiscountNextPlay` | `amount`, `filter?`, `min?`, `stack?` — one-shot discount on the controller's next matching play this turn (amount fixed at resolution); kept in `b._next_play_discounts`, applied in order by the pure `effectivePlayCost` (cost.js; each floored at `min`, never raising a cheaper card), consumed at play-commit (covers play_card, quick casts, PlayFromZone pay_cost). Without `stack` it replaces a pending discount with the same filter; `stack: true` adds (Alt Cunningham) |

### Equipment / scheduling / misc
| Action | Key fields |
|--------|-----------|
| `Equip` | `source` (gear), `dest` (host) |
| `PlayGearFromZone` | `target` (gear; `target.zone` picks the source — `'hand'` default, `'trash'`), `dest?` — play a Gear free WITH equip; dest may use the `in_play` virtual zone (units + face-up legends) |
| `ScheduleDefeat` | `target`, `condition?` (re-evaluated at end of turn against the unit) |
| `MarkPeeked` | `target` (sets `_peeked: true` on legend) |
| `CompelAttack` | `target` — the unit must attack on its controller's next turn if able |
| `CallLegend` | `target?` (defaults to friendly face_down legend); flips + marks called + fires OnCall+OnFlip; no-op if already called this turn (gate prompts with the `CanCallLegend` condition) |
| `PlayFromZone` | `target`, `to?` (`'trash'` default, `'removed'`, `'field'`, `'deck'` = bottom), `pay_cost?` (charges the card's EFFECTIVE cost); splices card, fires OnPlay+OnCardPlayed, places in destination |
| `_FireSubEvent` | internal — `event`, `sub_ctx`, `opts?`; fires event with halt propagation (used by CallLegend / PlayFromZone / the unified program-play chain) |
| `_PlaceInZone` | internal — `pid`, `ref`, `zone`; pushes ref into zone (final step of PlayFromZone / program trash) |

Script-authoring rule: a chain that splices cards out of zones (`RevealTop`,
`SearchTopN`) must re-place every card by the end of the chain
(`TakeFromBound` or explicit placement) — cards left in bindings when the
chain ends are silently lost. The engine watches for this: the total ref
count is invariant after setup, and a drop between quiescent steps leaves a
`card-count drift` warning line in `board._trace`.

Unknown actions / conditions / expression ops never throw: the engine
skips (or reads false / 0) and leaves a warning line in `board._trace`.

---

## 17. Target Resolution

A `target` object in an effect is resolved in this order:

1. `from_self: true` — acting card's iid/pid
2. `from_binding: name` — previously bound in `ctx.bindings[name]`
3. `from_host: true` — host unit of this gear
4. `from_trigger_source: true` — card that fired the trigger
5. `from_event: field` — field from `event_data`
6. Otherwise: `selectTarget()` with `{ type, side, zone, filter, chooser, quantifier, bind, optional, face, color, auto }`

### selectTarget fields
| Field | Values / notes |
|-------|---------------|
| `type` | `'Unit'` `'Gear'` `'Legend'` `'Gig'` `'CardRef'` |
| `side` | `'friendly'`/`'self'` (default = self_pid), `'opponent'`, or `'both'` |
| `zone` | explicit zone; default from type. Special virtual zone `'in_play'` = field units + face-up legends |
| `filter` | MatchFilter object |
| `chooser` | `'auto'` (default) or `'controller'` or `'opponent'` |
| `quantifier` | `'one'` (default) `'all'` `'upto_n'` (with `n`: Expr) |
| `optional` | if true: empty pool skips instead of halting, and the chooser may decline with `{ iid: null }` |
| `face` | for Legend: `'face_up'` or `'face_down'` |
| `equipped_to` | for Gear: `{ from_self: true }` restricts to pieces on a specific host |
| `auto` | sort hint: `'first'` `'cheapest'` `'highest_value'` `'lowest_value'` `'highest_power'` `'lowest_power'` |
| `bind` | name to store result in `ctx.bindings` |

### choice_needed kind by type+zone

| type / zone | kind |
|-------------|------|
| Gig | `choose_gig` |
| zone=in_play | `choose_in_play` |
| Gear | `choose_gear` |
| Legend | `choose_legend` |
| CardRef, zone=hand | `choose_card_in_hand` |
| CardRef, zone=trash | `choose_card_in_trash` |
| CardRef, zone=deck | `choose_card_in_deck` |
| Unit | `choose_unit` |

Responses are validated on resume: an `iid` outside `available_iids`
(or an amount outside `[min, max]`) is rejected with a throw — the action
fails, the prior board stands.

---

## 18. MatchFilter Fields

Applied to card refs in zones. All fields are optional (AND semantics).

| Field | Type | Meaning |
|-------|------|---------|
| `color` | string | card.color (case-insensitive) |
| `type` | string | card.type match; a Legend on the field also matches `'Unit'` (rule 4.2.1 — also for `type_in`/`type_not`/`type_eq`, aura `affects.filter`, trigger `card`, `BoundMatches`) |
| `type_in` | string[] | card.type in list |
| `type_not` | string | card.type ≠ value |
| `faction` | string | hasFaction(card, faction) |
| `subtype_has` | string | subtype string contains this value |
| `cost_lte` | number | card.cost <= value |
| `cost_eq` | number / expr | card.cost === value |
| `cost_in` | number[] / expr | card.cost in list (expr may resolve to an array, e.g. `gig_values`) |
| `power_lte` / `power_gte` | number | power bound |
| `power_eq` | number / expr | power === value |
| `state` | `'ready'`/`'spent'` | unit state |
| `gear_count` | number | unit.equipped_gear.length === value |
| `value` | number / expr / number[] | gig.value matches (expr is evaluated; array = `includes`) |
| `value_not_in` | number[] / expr | gig.value NOT in list |
| `value_gte` / `value_lte` | number | gig.value bound |
| `value_parity` | `'even'`/`'odd'` | gig.value parity |
| `value_eq_sides` | true | gig is at its max roll (`value === sides`) |
| `sides` | number / expr / number[] | gig.sides matches |
| `has_equipped_gear` | bool | unit has ≥1 gear |
| `power_lt_friendly_max` | true | ref power < max power in self's field |
| `exclude_self` | true | excludes acting card iid |
| `exclude_source` | true | excludes the triggering event's source card ("another Unit" — The Relic) |
| `exclude_binding` | string | excludes the card currently bound under this name |
| `in_binding` | string | only cards in the array bound under this name (by iid) |
| `any_of` | filter[] | OR of sub-filters |

Power filters (`power_lte/gte/eq`, `power_lt_friendly_max`) use EFFECTIVE
power (statics, gear, temp boosts) for refs on the board; printed power for
refs in hand / deck / trash.

---

## 19. evalExpr Operators

| op | Meaning |
|----|---------|
| `lit` | constant value |
| `add` / `sub` / `mul` | arithmetic over args array |
| `ref` | dotted path into `ctx.bindings` |
| `gig_value` | `ctx.bindings[ref].value` |
| `gig_sides` | `ctx.bindings[ref].sides` |
| `street_cred` | sum of gig values for side |
| `gig_count` | gigs zone length for side |
| `gig_values` | array of a side's gig values (feeds `cost_in` / `value_not_in`) |
| `value_pair_count` | number of same-value pairs among a side's gigs |
| `count` | count cards in zone matching filter |
| `gear_count` | equipped_gear length on ref or self |
| `legend_face_count` | count legends with given face for side |
| `event_field` | read from `ctx.event_data` (`'key'`, `'key[n]'`, `'key[*].sub'`) |
| `self_pid` / `opp_pid` | the controller's / opponent's pid |

---

## 20. evalCondition Operators

| cond | Meaning |
|------|---------|
| `True` / `False` | literals |
| `And` / `Or` / `Not` | boolean over args / arg |
| `Compare` | compare two exprs with op (`>` `>=` `<` `<=` `==` `!=`) |
| `StreetCred` | streetCred(side) op value |
| `GigAtMaxValue` | gig.value === gig.sides |
| `GigValueExists` | any of side's gigs equals the evaluated value |
| `HasSidedPair` | two gigs in zone with same sides value |
| `HasValuePair` | two of side's gigs share the same value |
| `DistinctGigValueCount` | distinct rolled values across side's gigs, compared with op/value |
| `HasInZone` | any card in zone matches filter |
| `HasInZoneN` | ≥ n cards in zone match filter |
| `CanCallLegend` | controller hasn't called a legend this turn AND has a face-down legend |
| `SelfIsReady` / `SelfIsSpent` | acting card state |
| `SelfDidCombat` | acting unit stole or fought this turn; from a ScheduleDefeat, only fights/steals AFTER it was scheduled count (Cyberpsychosis FAQ) |
| `SelfEquipsSource` | self (gear) is equipped on source unit |
| `HostEquipsSelf` | self has at least one gear equipped |
| `SourceIsSelf` | source_iid === self_iid |
| `SourceIsController` | source_pid === self_pid |
| `SourceIsOpponent` | source_pid !== self_pid |
| `BindingSet` | ctx.bindings[name] is set and non-null (declined optional picks read as NOT set) |

---

## 21. Trigger `by` Values

| by | Meaning |
|----|---------|
| `any` | any source |
| `self` | source_iid === self_iid |
| `controller` | source_pid === self_pid |
| `opponent` | source_pid !== self_pid |
| `host` | source is unit that has self (gear) equipped |

