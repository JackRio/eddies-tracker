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
