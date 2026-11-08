# Bot & coach roadmap

Ideas and findings from the Nov 5 2026 discussion about making the bot strong and the Replay Coach
"think like a player". Nothing here is built unless it says so. Code lives in `src/bot/` (separate
from `src/coach/`, which is unchanged); measure every change with the arena before keeping it.

## Where things stand

**Arena** (`node scripts/arena.js <botA> <botB> [--pairs N]`): bot-vs-bot on the 8 ChoomBattler meta
decks in `board/meta-decks/`. Games are played in pairs (same seed, decks and seats, bots swapped) so
deck strength and luck cancel; 50% = equal. Prints score, 95% interval and Elo difference.

**Baseline** = `greedy`, the coach's rollout bot: tries each move once, scores the board with the
hand-written formula in `coach/policy.js` `sideScore()`, takes the best. Never looks at the Rival's reply.

| Bot | What it does | vs greedy |
|---|---|---|
| `noisy` | greedy with random slips (harness sanity check) | greedy wins 81% |
| `strong` (plan mode) | drafts ~6 whole-turn plans, plays each against the Rival's reply on 4-6 re-dealt hidden hands | 57-60% (+50-70 Elo, not significant) |
| `strong:ev=fit` | same, board scored by the formula fitted to 4,000 games | 57%, no better |
| `greedyfit` | greedy using the fitted formula | **2%**: formula values a card in hand above the same card on the table, so the bot stops playing cards |
| `strong:mode=mc:deals=4:k=4` | **every** decision: top-4 options + end turn, each played out through the rest of the turn and the Rival's whole reply on 4 re-dealt worlds, best average wins | **74%, +180 Elo [+100, +284]**, 0.25 s/decision |

The strong bot is honest: before searching it re-deals what it can't see (`determinize()` in
`strong.js`: Rival hand + deck, its own deck order, engine dice seed).

**Engine speed-up (done):** `src/engine/lib/clone.js` replaces `structuredClone` in `step()` (it was
72% of all CPU). Plain copy when the effect stack is empty; alias-preserving copy otherwise (the only
shared references live inside a halted effect stack). Identical results: 50/50 tests, 3,200-game fuzz
clean, greedy makes the same decisions. 3.4x faster overall.

**Fitted evaluation** (`scripts/bot-data.js` -> `scripts/fit-eval.js` -> `src/bot/eval-weights.json`):
logistic regression on self-play outcomes. Held-out log loss 0.571 -> 0.504, winner predicted 73% vs
69%. Lesson: a score fitted on whole-game outcomes only works for comparing positions at the same
point in a turn (the search's leaf: start of the bot's next turn), never for in-turn move choice.
`bot-data.js` now records only turn-start positions for that reason; refit before using it again.

**Unfinished:** three MC variants were queued and cut off by a session end - `mode=mc:deals=8:k=6`,
`mode=mc:deals=4:k=4:ev=fit`, `mode=mc:deals=4:k=4:horizon=2` (score after the bot's *next* turn).
Re-run them. **Update (16:30):** SPSA-tuned greedy (`greedyt`) beats original greedy **78.1% (+221 Elo,
[+195, +250], 400 held-out pairs)** at no extra cost - an Eddie 2.6 -> 13.4, a Gig 11 -> 19, Rival's
board weighed 1.25x. But the search bot on top of the tuned policy only **matches** tuned greedy
(48.5%): one Rival turn of look-ahead added nothing once the weights were good. Next being tested:
win-probability leaf, longer horizon, full playouts to game end. The fitted-score greedy bots
(`greedyfit`/`noisyfit`) are being removed as a dead end; self-play data + features stay for the
future value net.

In parallel, another chat is **SPSA-tuning the greedy bot's hand-written weights on win rate**
(`scripts/tune-greedy.js` -> `src/bot/tuned.js` / `tuned-weights.json`, bot `greedyt`; validate
with `node scripts/arena.js greedyt greedy --pairs 400`). Unlike the outcome-fitted formula (which
broke greedy), SPSA optimises the thing we care about - games won - so it keeps the formula usable for
in-turn choices. A better greedy also makes the MC bot's playouts better.

## The kinds of player thinking we want, and how to get each

### 1. Hidden resources (search can already find these)
- *Muamar save:* leave 1 Eddie unspent with Muamar Reyes as the only uncalled Legend; the Rival
  attacks your blocker; you call Muamar during the attack and the blocker survives.
- *River Ward:* attach Gear on the Rival's turn to win a fight, make a unit a blocker, play Quick.

Per-decision search discovers these without card-specific rules: in the playouts where you spent the
Eddie the blocker dies, where you kept it the defensive call saves it, so keeping it scores higher.
The engine knows every card's rules, so this scales to all interactions. Weak spot: the bot's
decisions *inside* the playouts (blocks, defensive calls) are greedy one-ply. Better playout policy =
better discovery.

### 2. Bluffing (the current bot cannot do this - fix known)
- *Leave River Ward up with no Gear in hand* so the Rival doubts attacking your unit or Gigs.

Why it fails today: in the bot's imagined Rival turns the Rival plays on a fully dealt board and
sees whether you hold a Gear, so it is never fooled and a bluff is worth nothing.
**Fix - two-sided determinization:** when simulating the Rival's decisions, re-deal *our* hidden hand
(and face-down Legends if hidden from them) from the Rival's point of view, using our likely
decklist. Then in many of the Rival's worlds we hold a Gear, it hesitates, and holding River open has
value whether or not we have one. True equilibrium bluffing (right bluff frequency) needs CFR-style
methods (poker AIs: Libratus, Pluribus, ReBeL) - only if the cheap version isn't enough.

### 3. Strategic judgment (needs a longer horizon + learning)
- Keep a blocker home to stop a 2-Gig steal instead of attacking for 1.
- Blockers matter more as overtime approaches (both players skipped a Gig; 7+ Gigs at any point
  wins in overtime). Normal win = 7 Gigs at the start of your own turn.
- Gig-race timing, dice left in the fixer.

Search can't see to the end of the game, so this needs (a) a longer horizon (`horizon=2`) and
(b) a learned value network (below). Add inputs the current features lack: overtime on/near (each
player's `_skipped_gig_last_turn`), fixer dice left per player, ready blockers, unspent Eddies at end
of turn, uncalled Legends and their call costs, Legends with defensive / Rival-turn abilities.

## Role of machine learning
Search did the +180 Elo; ML so far only gave the fitted formula. ML's job is to replace the guesses
search still makes:
1. **Value network** - "you win 64% from here". Trained on positions from strong-bot self-play.
   Better leaf score = better and faster search. GPU available on this machine (PyTorch, export
   ONNX -> onnxruntime-node).
2. **Policy network** - which moves a strong player would consider; search spends time on 3-4
   moves instead of all. Today greedy picks the top-k, a weak filter.
3. **Loop (expert iteration / AlphaZero):** search plays itself -> train nets on its choices and the
   winners -> search with the new nets is stronger -> repeat.
4. **Human model (Maia-style):** train on real simulator replays so the coach's Rival behaves like a
   person - e.g. do real Rivals respect an open River / open Eddies? Enables advice that works
   against people, not bots. More replays needed.

## Coach explanations ("if you do X, the Rival does Y")
The search's own playouts are the evidence. Compare your line with the better line across the same
worlds and tag what happened with small **pattern detectors** over the playout logs (like chess
tools tagging "fork"/"pin"):
- held Eddie -> defensive Legend call saved a unit
- blocker kept home -> Rival's steal blocked (Gigs lost: yours vs best line)
- attack with blocker -> Rival stole N Gigs back
- open River / open Eddies -> Rival declined to attack (needs fix #2 to mean anything)
- overtime triggered / avoided

Example output: "You spent your last Eddie. In 78% of Rival replies they attacked Pepe and you
couldn't call Muamar. Keeping 1 Eddie up kept Pepe alive in 71%." Claude can phrase the facts (as AI
Draft does) but the facts must come from the playouts. Also: show the Rival-deck guess as odds over
meta decks ("70% they're on Adam/Dexter/Saburo") instead of one picked list.

## Suggested order
1. Finish the MC variant runs; pick defaults.
2. Two-sided determinization (bluffs and threats count). Measure in the arena.
3. Overtime / threat features + horizon test.
4. Pattern detectors and counterfactual lines in the coach (only after the bot is settled).
5. Self-play value network on the GPU; then a policy network.
6. **Play mode** (requested): you vs the strongest bot on the strongest meta deck, you pick your deck.
   The board is a replay viewer today, so this needs an interactive UI on the engine.

## Status 2026-11-06 (end of desktop session - continue on the laptop)
What happened, in order:
- Built the bots (arena, tuned greedy +221 Elo, Monte Carlo `strong`, value net, deck guessing,
  coverage decks, intuition net round 1/2). Details and numbers: CLAUDE.md "Game bot".
- Checked the training data with readable game logs: it was bad (greedy playouts snowball early
  leads; the value net learned that selling is bad; only 44% of decisions informative).
- **All training datasets deleted.** No new training or new bots until the bots are verified by hand.
  The trained nets are kept (`src/bot/*.json`); Bot A needs `value-net.json`.
- **Play page** `board/play.html` (`node scripts/serve-board.js` -> localhost:4181/play.html): play
  Bot A (Net Searcher, `strong`) or Bot B (Playout Searcher, `strong:leaf=prob:horizon=99:deals=6:k=4`),
  or watch them play each other, with each bot decision's options and win-chance estimates.
  Defaults: you Adam/River/Viktor (Y4/R2), Bot A Dexter/Padre/V (R4/G2), Bot B Alt/Hanako/Jackie (B4/G2).
- Fixes from the user's first games:
  1. **Legend calls are a random pick.** Face-down Legends are hidden from their owner too, so
     `policy.moves` offers ONE call option (first face-down slot; setup shuffles them), main phase and
     defensive. Bots get a board with their own face-down Legends shuffled (`hideOwnLegends()` in
     strong.js; also inside every determinized world), so they only decide WHEN to call. The board
     shows your face-down Legends as backs, except the last one (known by elimination). The bot can
     still plan around a known last Legend (e.g. Muamar Reyes as a reaction).
  2. **Clearer log.** Effect choices name their source card ("Zetatech Faceplate: pick own d8 (4)",
     "Viktor Vektor: look at top 5, take Satori, Satori"); plays say the type ("Play Program X");
     Calls show the result ("Call a Legend - random of 3 face-down -> flips Padre"); defeated Units
     are listed.
  3. **Revealed cards are shown.** Choices from the top of the deck list the real cards (named
     buttons + a row of the looked-at cards, marking which can't be taken).
  4. **Card art:** `node scripts/fetch-card-art.js` downloads one image per card from the official
     database (api.netdeck.gg) into `board/card-art/` (gitignored, ~18 MB); the board server uses it
     when the Eddies image cache is missing.

Next (on the user's go-ahead only):
- User plays/watches games and reports what the bots miss. Not yet done: a full game to the end on
  the play page; animations for played cards (the replay board's pop/FLIP animations should already
  apply to live steps - verify); choosing which Eddies/Legends pay (taps are automatic).
- Arena results predate the random-call change (greedy used to peek at which Legend it called);
  re-measure before quoting Elo again.
- Then: a few bot-vs-bot matches -> regenerate data (fix the snowballing first: informative
  decisions only / stronger playouts) -> retrain the nets.

## Status 2026-11-06 (laptop session) - archetype pilots + league

Full write-up in CLAUDE.md "Archetype pilots and the league". Short version:
- Four pilots (YYR, BBG, RRG, RGB) on ChoomBattler lists play Bo3 (D20 roll-off, winner picks
  first/second) in a league against each other, mirrors and ~70 field decks. Pilots learn go-first per
  opponent and one-card deck changes (Thompson sampling). Sideboarding is on hold (too noisy).
- Round 2 nets (league data + 15% teacher relabels) beat the old Bot A: 62.5% of Bo3 matches
  [53.4, 71.6], +89 Elo. Promoted: `src/bot/value-net-r2.json`, `policy-net-r2.json`, now Bot A.
- Round 3 data: `notes/league/data-3001.jsonl` (~100 matches, partial) and `data-3301.jsonl` (running,
  400 matches, full bot + teacher settings). `data-3101` / `data-3201` were made with lightened
  settings - exclude them from training.
- CUDA works in `D:/Codebase/venv/nitorch` (torch 2.6.0+cu124).

Next:
1. Run 3301 stopped at 160/400 (restarted to add per-game log lines); 3302 plays the other 240.
   When it ends: train value + policy on rounds 2+3 (data-2001, 3001, 3301, 3302) with the Python
   trainers on GPU (`--init` from the r2 nets; policy `--teach-only`/`--informative-only`).
2. Gate with `scripts/pilot-arena.js` vs the r2 Bot A (40 pairs); promote only if better.
3. Next league round with the winner; repeat.
4. Later: sideboard via card-vs-card values (`scripts/card-review.js`), more pilots for other decks.

## Next (agreed Nov 6 2026, start after the round 3 training + gate finish): payment as part of the move
Found in a user game: Bot A attacked with Pepe Najarro (ready 2 Merc Legends if value-pair) BEFORE spending
its Merc Legends, wasting 2 €$, because bots never choose how to pay (policy.taps: Eddies first, Legends last).
General fix (no card-specific rules - user asked for general, not Pepe detection):
1. Payment classes: ready Eddies (interchangeable), face-down Legends (interchangeable), each face-up Legend
   (distinct: abilities, Merc/Netrunner tags). Each distinct way to pay a costed move = its own option.
2. Merge options that produce the same board (hash the resulting board) - usually 1-3 versions per play.
3. Drop do-nothing plays: the only change is losing the card + the payment (turn-1 Synapse Burnout with no Unit).
4. Playouts use the same move list, so "pay with Mercs, then attack with Pepe" scores higher on its own; the
   policy net then learns it from league data. Covers River Ward (keep her for her ability), Call timing, etc.
5. Arena-test vs current Bot A before switching (more options thin the search: sh=1 + net prior help).
Also pending: update the play page's Bot A description text after the gate (it describes the old bot).
Also (same change, user-found Nov 7 2026): Bot A often attacks first and plays Gear after (Adrenaline
Converter / Gorilla Arms on Johnny AFTER his attacks). Cause: the search shortlist (greedy top 5 + net top 3)
rarely includes Gear while an attack is available, because the one-ply score rewards an immediate steal.
Fix: shortlist always includes the best move of EACH kind (attack, equip, program, unit, call, sell...),
affordable with sh=1. Not card-specific.

## Results Nov 7 2026 (round 3)
- r3 nets (re-searched round 2 + round 3 data) vs r2: 51.2% of Bo3 matches [42.3, 60.2], +9 Elo (tie).
  vs the original Bot A: 72.9% [62.7, 83.1], +172 Elo (r2 got 62.5%, +89). Promoted (user's call) - Daemon.
- sh=1 (sequential halving, same budget) vs plain: 46.9% [37.2, 56.5], -22 Elo - kept off. Likely cause: ~2
  worlds per move in round 1 drops good moves on noise; retest with a minimum of 4-6 worlds per move once the
  shortlist is wider.
- Next priorities: search quality (Rival reply in playouts is greedy; payment automatic; narrow shortlist),
  then a general (not pilot-centred) league.

## OVERNIGHT PLAN (started Nov 7 2026 ~02:30; user asleep, "go ham": GPU, data, training)
Status log at the bottom of this section - append a line after every step (time, result, next).
New search options in src/bot/strong.js (all default off; D = Daemon = r3 nets spec):
  pay=1 (alternative payments per costed move), noop=1 (drop do-nothing Programs), kinds=1 (shortlist has
  the best move of every kind), opp=net|look (smarter Rival inside playouts; look = top `ol` options played
  to the end of the turn). Verified by hand: pay=1 finds "pay with Jackie (Merc), then attack with Pepe";
  noop=1 drops turn-1 Synapse Burnout but keeps it with Jacked-In Voodoo Boy on the field.
Steps:
 1. Arena (pilot-arena, 40 pairs each, vs D): pay+noop; pay+noop+kinds  -> notes/league/arena-moves.log
 2. Arena: opp=net vs D; opp=look vs D (on top of the best of step 1)  -> notes/league/arena-opp.log
 3. Daemon spec = D + the winners (play.js BOTS 'A', league.js default --bot, teacher = same + deals=24:k=10)
 4. General league (round 4): matchmaking from the WHOLE pool (netdeck 1,600 weighted by likes + coverage +
    meta), pilots a small share; --past r2 nets; record + teach 0.15; ~400 matches -> data-4001.jsonl,
    games-4001.jsonl (move lists)
 5. Train r4 on GPU (D:/Codebase/venv/nitorch): value + policy, --init r3, data = 2001-re + 3001/3301/3302 + 4001
 6. General gate: r4 vs r3 on random pool decks (pilot-arena --pool) + the pilot decks; promote if better
 7. Deck guesser over netdeck lists (belief.js candidates) - arena test before switching
Status:
- 02:50 built: pay/noop/kinds/opp=net|look/bpool options, league --general, pilot-arena --pool. Arena pay+noop & +kinds running (notes/league/arena-moves.log). Next: opp + bpool arena tests, then league round 4.
- 02:33 pay+noop 45.0% [38.2,51.8] -35 Elo; +kinds 47.5% [37.6,57.4] - both off. Cause guess: payment variants filled the shortlist. Fixed: variants added AFTER the shortlist (and listed in lastSearch.ranked for training). Queued: pay2+noop, opp=look, opp=net, bpool(--pool) -> notes/league/arena-opp.log
- [04:25] Arena (40 pairs vs Daemon): pay2+noop 47.5% [38.9,56.1]; opp=look 49.4% [41.8,56.9]; opp=net 43.8% [35.0,52.5]; bpool (--pool decks) 51.2% [44.7,57.8]. None better -> Daemon spec unchanged. bpool=1 kept for the general league only (no cost, better guesses on community decks). Launched league r4: seed 4001, 400 matches, --general 0.75, --past r2 0.15, bot+teacher = r3+bpool -> notes/league/run-4001.log
- [04:45] League r4 running (~60/400 at 04:41, ETA ~06:20). Waiter re-armed on '400/400 matches'.
- [06:26] League r4 done: 400 matches/969 games, 77,335 decisions, 7,093 teacher, 271 mistakes (3.8%). Training r4 (init r3, value --mix 0.5 on 2001re/3001re/3301re/3302re/4001; policy --informative-only).
- [06:32] r4 trained: value held-out 0.4651 / 76.6%; policy best-move 69.9% (greedy 62.2%), regret 2.48 vs 3.13; JS checks OK; copied to src/bot/*-r4.json. Gating r4 vs r3 (pilot 40 pairs seed 1100000, pool 40 pairs seed 1120000) -> notes/league/gate-r4.log
- [07:14] Gate r4 vs r3: pilot 45.0% [35.8,54.2] -35 Elo; pool 51.2% [43.0,59.5] +9. Not promoted - Daemon stays r3. Testing split nets (r4 value+r3 policy, r3 value+r4 policy; 40 pairs each, pool decks) -> notes/league/gate-r4-split.log
- [08:01] Split nets vs r3 (pool, 40 pairs): r4 value+r3 policy 50.0% [43.0,57.0]; r3 value+r4 policy 56.3% [51.1,61.4] +44 Elo. Confirming the latter on fresh seeds (pilot 40 pairs seed 1180000, pool 40 pairs seed 1200000) -> notes/league/gate-r4-confirm.log
- [08:43] Confirm (fresh seeds) r3 value + r4 policy vs r3: pilot 50.0% [45.0,55.0]; pool 42.5% [35.9,49.1] -53 Elo. The 56.3% was luck (4th test in a row). NOTHING PROMOTED - Daemon stays r3. r4 nets kept in src/bot/*-r4.json for reference.
- CONCLUSION (overnight): r3 -> r4 better offline metrics (value 0.470->0.465, policy regret 2.2->2.5 pts on a harder mix) but no strength gain in 5 gates; search options pay/noop/kinds/opp=look/opp=net/bpool all neutral. Nets are no longer the limit. Next ideas need the user: (a) much more data per round (league ~2h = 1k games; r3->r4 added only ~1/3 new positions), (b) stronger playouts (a cheap net-driven Rival tried as opp=net was -44 Elo - maybe needs its own small fast net), (c) more worlds/options per decision at play time (costs speed). Stopped here rather than burn more GPU/CPU on the same loop.

## GIG LANGUAGE (Nov 7 2026, afternoon)
- User: Gigs have their own language (even/odd, pairs, high/low, count, specific dice). r3 nets saw only Gig count + sum. Added src/bot/gigfeatures.js (78 value inputs), menc Gig move slots (650-685), scripts/gig-value-rows.js, train-value.py --dense, train-policy.py --gig-moves.
- value-net-gig1 (round-4 games): held-out Gig positions 0.474 vs no-Gig control 0.481 - inconclusive. League round 5 (seed 5101, 400 matches, 12 workers) running -> then retrain both nets and gate vs r3.
- [16:52] League r5 (seed 5101) done: 400 matches / 958 games, 73,470 decisions (no teacher this round). Value rows with Gig inputs from 4001 + 5101 + aborted 5001: 1,943 games, 23,003 positions (notes/league/value-rows-gig-45.jsonl; no-Gig control = value-rows-nogig-45.jsonl).
- value-net-gig2 (r3 rows + Gig rows, --dense 123, init r3): held-out Gig positions 0.4175 / 79.6% vs no-Gig control (nogig2) 0.4186 / 79.2% vs r3 0.4461 / 78.5%. Gig inputs barely matter offline; most of the gain is the new data.
- policy-net-gig2 (2001re/3001re/3301re/3302re/4001/5101, --informative-only --gig-moves, init r3): best-move 69.5% (greedy 61.2%), regret 2.55 vs 3.26; steals 69.4% vs greedy 62.3%, die choices 83.8% vs 72.6%. JS checks OK.
- Gating gig2 vs r3 (pilot 40 pairs seed 1300000, pool 40 pairs seed 1320000) -> notes/league/gate-gig2.log
- [18:05] Gate gig2 vs r3: pilot 48.8% [42.2, 55.3] -9 Elo (games 46.7%); pool 52.5% [44.7, 60.3] +17 (games 55.4%). A tie - not promoted, Daemon stays r3. gig2 nets kept in src/bot for reference. Same pattern as r4: better offline, no measurable play gain -> the limit is the search (greedy Rival reply in playouts, end-of-turn ties, 1-turn horizon), not what the nets can read.

## SEARCH FIXES (Nov 7 2026 evening, user: "fix the search")
- Found: greedy (eval.js / coach policy.js chooseMove) scores non-main-phase choices BEFORE they play out. A block is
  scored before the fight, and that looks slightly worse than passing, so greedy (almost) never blocks. Inside every
  playout the Rival never blocked, so attacks into a ready blocker looked free (flags "Bad attack", Bombus into Meredith).
  Fix: eval.js `opts.resolve` (settle every choice); strong option `gb=1` turns it on in playouts + shortlist ranking.
  Plain greedy / greedyw / greedyt unchanged (Gonk and the coach rollouts still block blind - follow-up).
- `alt=1`: own-turn moves are also scored with a no-more-attacks continuation (greedy filtered), max of the two means.
  `tb=1`: near-ties (< 0.3 pts) go to a non-attack move. On the flagged positions these rarely change the pick; gb=1 does
  (Dexter +2 power now chosen 94.7 vs 61.0; Bombus no longer developed into Meredith; no Mantis Blades on spent Wrecker).
- `node scripts/flag-decide.js [--id X] <spec>...` re-searches flagged positions with any specs.
- Gate (pilot, 40 pairs, seed 1400000): gb=1 and gb=1:alt=1:tb=1 vs r3 -> notes/league/gate-search.log

Gate (seed 1400000, pilot decks, 40 pairs vs Daemon r3): gb=1 alone 55.0% [45.8, 64.2] (+35, n.s.);
gb=1:alt=1:tb=1 60.0% [52.0, 68.0], +70 Elo, games 56.7%. Confirming on fresh seeds (pilot 1500000,
pool 1600000) -> notes/league/gate-search-confirm.log before promoting.
- Gate vs r3 Daemon (40 pairs, pilot decks, seed 1400000, notes/league/gate-search.log): gb=1 55.0% [45.8, 64.2];
  gb=1:alt=1:tb=1 60.0% [52.0, 68.0], +70 Elo, games 56.7%. Confirming on fresh seeds (pilot 2600000 + pool 2700000,
  notes/league/gate-search-confirm.log): pilot 60.0% [49.4, 70.6], pool 58.1% [51.5, 64.8], +57 Elo -> PROMOTED
  (Nov 8 2026) to Daemon (play.js) and the league bot + teacher (league.js). Game Review (review.js NETOPTS) now uses it too. Greedy alone with it is worse (greedy:gb=1 42.1%, greedyt:gb=1
  48.1%, gb=2 fight-only the same; 400 pairs): one-ply greedy can't see the spent blocker being attacked next. Gonk and
  coach rollouts unchanged.
Confirmation (fresh seeds): pilot 60.0% [49.4, 70.6] +70 Elo (games 57.9%); pool 57.5% [49.2, 65.8] +53 Elo
(games 52.5%). All three runs point the same way (~59% over 120 pairs); not yet promoted.

## NO-GREEDY SELF-PLAY (Nov 8 2026, user: "get rid of greedy", "improve by playing itself")
- Speed: Daemon 593 -> ~400 ms/decision (in-place multi-step moves, cheaper copies with a halted effect, no trace
  strings when off, AuraKeyword-only keyword scan, shared deck cards). scripts/bench-bot.js = speed + move hash.
- after=1 (score at the Rival's turn start with 1 - value(Rival); no imagined reply): 3.9x faster, lost to Daemon
  26.7% [15.4, 37.9] (pilot, 30 pairs, seq). Gate 2 (after=1:deals=16:k=8) stopped - moving to nogreedy.
- policy-net-nog.json: r3 policy retrained without greedy's rank input (rounds 2-5 data, --informative-only):
  best move 67.1% vs greedy 61.2%.
- nogreedy=1 (policy net plays every playout decision, after=1 leaf): 140 ms -> 98 ms (skip-zero/ordered JS net)
  -> 53 ms (wasm SIMD nets, src/bot/nnwasm.js). Daemon ~400 ms.
- Experiment started 05:15: scripts/experiment.js --baseline --rounds 3 (log notes/league/exp-nogreedy.log).
  Question: does its score vs the fixed Daemon rise round over round? Flat after 3 rounds = not at this scale.
- RESULT (07:07, ~2 h): flat. vs Daemon (pilot decks, seq, 30 pairs each): round 0 11.7% [?], ng1 8.3% [1.6, 15.1],
  ng2 10.0% [2.7, 17.3], ng3 11.7% [4.0, 19.4] (~-350 to -420 Elo). ~970 recorded games per round. Policy picks the
  search's best move 57.0 -> 55.6 -> 54.3% and value held-out loss 0.445 -> 0.466 -> 0.470 (measured on its own,
  harder data each round, so not directly comparable). Conclusion: at 400 matches/round the nets don't lift a
  greedy-free bot; it starts ~350 Elo below Daemon and stays there. Nets ng1-ng3 kept in src/bot for reference.
  Batch 1 (scripts/batch.js, Daemon + teacher, greedy kept) not started yet.
