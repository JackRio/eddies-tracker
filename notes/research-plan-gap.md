# Research plan vs. what we have (Nov 6 2026)

Source: "TCG Bot: Search + Learning Research Plan" (docx, Nov 6 2026). The plan's two new ideas
(A: learned beliefs, B: learned strategy modes) are left for later, by request.

Yes = done, Partly = something close exists, No = not started.

## Phase 0 - engine
| Plan | Here | Status |
|---|---|---|
| clone + seeded RNG | `src/engine/lib/clone.js` (3.4x faster than structuredClone), seeded games, exact replays | Yes |
| observation(state, player) kept separate | `botView()` re-deals everything hidden from the belief before any bot sees the board | Partly - no unit test that nothing leaks |
| legal actions + explicit end turn | `policy.moves` macro moves (a play plus its taps) | Yes (flat list, not step by step) |
| determinize with a pluggable sampler | `determinize()` + `belief.js` (posterior over known decklists + a "custom deck") | Yes |
| event log | `b._trace` | Yes |
| throughput target | never measured as transitions/second | No |
| vertical slice first | greedy -> tuned greedy -> search -> value net -> policy net -> league loop | Yes |

## Phase 1 - card encoding
Cards are IDs: 13 zone "bags" of counts over the 150 legal cards + 45 hand-made features
(`vfeatures.js`). No mechanics encoding, no history encoding. Coverage decks
(`src/bot/train-decks/coverage-*`) make sure every card is seen, but a new card means retraining.
**Status: No.** The engine already has every card's effects as primitives (`card_scripts.json`),
which is what the plan says to export.

## Phase 2 - actions
`menc.js` encodes each whole macro move (type, acting card, target, picked cards, taps) and the
policy net scores every legal move. Not an autoregressive head. With this game's small move lists
that works; not worth changing now. **Status: Partly, fine for now.**

## Phase 3 - search
`strong.js` is flat PIMC: the policy/greedy prior shortlists k moves, each is played in 8 re-dealt
worlds, then one turn of tuned greedy and the value net at the leaf. No tree (no PUCT, no reuse
within a turn, no transpositions), no separate opponent tree (the opponent's reply is greedy inside
the playout), fixed worlds per move (no sequential halving). **Status: Partly.**
No tactics puzzle suite (the engine tests check rules, not play).

## Phase 4 - learning loop
| Plan | Here | Status |
|---|---|---|
| ExIt: policy on search targets, value on outcomes | policy net on softmax(search value / 0.03), value net on game results | Yes |
| regularized / Gumbel policy target | softmax of values, close in spirit | Partly |
| TD(lambda) value mix | outcome only | No |
| auxiliary heads | none | No |
| replay buffer | rounds 2+3 trained together | Yes |
| Reanalyse (re-search old positions with the new net) | games replay exactly from seeds (`league-check.js`), never re-searched for training | No |
| gating | `pilot-arena.js`: paired Bo3, 95% CI, Elo | Yes |
| SPRT instead of a fixed game count | fixed 40 pairs | No |
| playout cap randomization | the teacher (deeper search on 15%) is the same idea the other way round | Partly |
| policy-surprise weighting | train only on teacher + "informative" decisions | Partly |

## Phase 5 - league
Pilots vs each other, mirrors and ~70 field decks, Bo3 with sideboards, D20 + first/second
learning. No past checkpoints in the pool, no exploiters, no prioritized opponent choice, gating
against one previous net only. **Status: Partly.**

## Phase 6 - deckbuilding
One-card challenger vs champion per pilot (Thompson sampling) = a small local search.
No MAP-Elites. **Status: Partly (early).**

## Evaluation
Paired games, confidence intervals and Elo: yes. Fixed ladder (random, greedy, vanilla search,
past checkpoints): partly (arena bot specs exist, no standing ladder). Held-out decks / cards:
no. Exploiter test: no.

## What would help us most, in order
1. **SPRT gating** in `pilot-arena.js`: stop as soon as the result is clear. Small change; most
   gates should finish in well under the current 25 min.
2. **Sequential halving at the root** in `strong.js`: start all k moves on a few worlds, drop the
   worse half, give the survivors more worlds. Same time per decision, more of it spent on the
   moves that matter. Measure with the arena.
3. **Tactics puzzle suite**: real positions with a known best line (Johnny Silverhand + Adrenaline
   steal, must-block, lethal through blockers, Gear before attacking). Take them from the teacher's
   "mistake" records and from games the user flagged. Catches regressions in minutes instead of a
   league round.
4. **Reanalyse**: replay stored league games (exact from seeds) and re-search their positions with
   the newest nets, so old games keep giving fresh targets without playing new ones.
5. **Past nets in the league + gate against two or three past nets**, against rock-paper-scissors
   cycling between rounds.
6. **Leak test for `botView()`**: assert no real hidden card identity or order survives the re-deal.
7. **Value targets**: mix outcome with a TD(lambda) bootstrap; add a cheap "turns left" head.
8. **Card encoding from `card_scripts.json` primitives** (Phase 1). The largest job, and the one
   that matters when a new set arrives: today every new card needs fresh data before the nets know it.

## Decision (Nov 6 2026)
Doing now, in this order: #6 leak test, #4 Reanalyse and #7 value targets (before the round 3
training), then #2 sequential halving and #5 past nets (before the next league round).
Not now: #1 SPRT, #3 puzzle set.

**#8 (card encoding from engine primitives) - to study later.** It changes the networks' inputs,
so new nets are trained from scratch instead of fine-tuned, and it needs a new JS forward pass and
probably more data. Nothing we do now blocks it. To keep old games usable for it, every league game
now also stores its full move list, so any position can be rebuilt with the engine alone (replaying
from seeds only works while the bot code is unchanged). Questions to study first: which primitives
`card_scripts.json` covers and how uniformly; tree encoder vs flat token list; whether a small
entity transformer still runs fast enough in plain JS at ~0.1 ms per position (the leaf calls
dominate search time); a held-out-card test to prove it generalises.

## Progress (Nov 6 2026, evening)
- #6 leak test: done, no leaks (shuffles made order-independent); found and fixed a play-page leak
  (the bot's sold card was named / shown to the human).
- #4 Reanalyse: `scripts/reanalyse.js`, replays verified exact on rounds 2 and 3.
- #7 value targets: `--mix` result/search target + turns-left auxiliary head.
- #5 past bots: `league.js --past`; the gate now also plays the original Bot A.
- #2 sequential halving: `sh=1`, arena test queued after training.
- Move lists recorded per game (keeps #8 possible).
