# PUNKSIM engine audit (cyber-sim-engine, commit 39f1dc0, Oct 19 2026)

## Status: fixed in `src/engine/` (Nov 5 2026)

Every issue below is fixed in the patched copy at `src/engine/`, plus these found later:
- Reaper + Rita Wheeler: a triggered effect that went pending still resolves after its card
  leaves the field (rule 10.16); triggers are now matched at event time.
- Zetatech Faceplate / Sketchy Ripper FAQ cases (6 of them).
- Turn player's pending effects resolve first everywhere (10.15), and a player chooses the order
  of their own pending effects (10.14.1, new `choose_pending_order` choice).
- Rebecca: Having a Moment (promo, no text) is rejected by deck validation as not legal.

50 tests in `src/engine/test/cases/`, each failing on the upstream engine and passing on the
fork; 240-game self-play fuzz over the 4 meta decks has no issues.

Engine API changes callers must know: a `mulligan_decision` step before turn 1
(`opts.mulligan:false` skips it), `setupGame` throws on illegal decks (`opts.skipValidation`),
defensive Call takes `pay_iids`, Blocker keeps the React Step open (the fight starts on
`pass_defensive`), new `choose_pending_order` choice, new events `OnTurnStart` and `OnStealGig`.

Ordering gaps closed later: every event raised during an effect now resolves after that effect
(only engine-level chains and "would ..." replacement windows resolve on the spot), and playing or
Calling a card puts its cost-spend triggers and its play triggers into one pending set. 50 tests.

Rule ambiguities left as-is: effect sells vs the
once-per-turn sell flag, raising/lowering a Gig past its range, Gear on a Go Solo Legend that
leaves (goes to removed).

---

Original audit (before fixes):

Checked against the Comprehensive Rules (Oct 29 2026 PDF) and the Rules FAQ PDF.
Every bug marked **confirmed** has a test script that sets up a position on the real
engine and shows the wrong result. Test scripts are in the session scratchpad
(`audit-core/`, `audit-combat/`, `audit-cards-a/`, `audit-cards-b/`, `harness/`).

## Overall

- **Stable:** 240 random games across your 4 meta decks (all pairings): no crashes,
  no stuck games, no lost cards, Gig dice always consistent, every game ended with a winner.
  Every card in the 4 decks was played at least once.
- **Repeatable:** the same seed + same moves gives the identical game (30/30).
- **Card data:** all 151 cards match the official database on cost, power, RAM, color and
  sell tag. One card's text is incomplete (Alt Cunningham, below).
- **Rules:** 35 issues: 29 confirmed with a test, 5 suspected from reading the code, 1 missing
  feature (mulligan). Many come from 11 shared root causes (section A), so one fix covers
  several cards.

`[deck]` = affects a card in your 4 meta decks.

## A. Shared root causes (fix once, fixes many)

| # | Bug | Rule / FAQ | Status | Cards affected |
|---|-----|-----------|--------|----------------|
| A1 | "Once per turn" limits reset only at the start of the owner's own turn, so they carry into the rival's turn. Hits "first time each turn" triggers and the Call-a-Legend limit. | 11.14.2 once per turn; Johnny FAQ | confirmed | Johnny Silverhand: Never Stop Fighting `[deck]`, Arasaka Emergency Radioport `[deck]`, Rita Wheeler, Rogue: Queen of the Afterlife, T-Bug, Tyger's Whisper |
| A2 | A defensive Call uses a separate flag, so a defensive Call + an effect Call can both happen in one turn. | 11.14.2 | confirmed | any deck with Call effects |
| A3 | "At the start of your turn" effects fire after Ready, Draw and the Gig roll instead of before. | 8.6.2 | confirmed | Hanako: Daughter of the Emperor `[deck]` (draws off the new Gig) |
| A4 | Lagging Units (entered this turn) can use {Spend} abilities and Blocker. | 11.3.1.2 | confirmed | Kerry, Blockers played at Quick speed, Go Solo Legends |
| A5 | A steal of 0 Gigs still fires "when this steals" triggers. | Gorilla Arms FAQ | confirmed | Gorilla Arms `[deck]` (steals an extra Gig), Evelyn Parker: Beautiful Enigma, Wraith Marauders (suspected) |
| A6 | Stealing several Gigs fires a "per Gig" trigger once, and some read only the first Gig. | 6th Street + Goons FAQ | confirmed | 6th Street Recruits `[deck]`, Maelstrom Goons, V: Roamer, Rogue: Preem Solo |
| A7 | Filters check the printed card type, so a Legend played with Go Solo isn't treated as a Unit. | MaxTac + Jackie FAQ | confirmed | MaxTac Suppression Team `[deck]` (solo Legends can attack the turn they enter), Jackie: Pour One Out |
| A8 | "Face-up Legends" counts only the Legends area, not solo Legends on the field. | Synapse + Panam FAQ | confirmed | Synapse Burnout `[deck]`, Panam: Strength Through Family, Zetatech Berserk |
| A9 | Units leaving the field to hand/deck take their Gear along instead of the Gear going to trash. | 11.9.1.2, Relic FAQ | confirmed for Relic, suspected for the rest | The Relic, Les Élémens `[deck]`, Towerfall `[deck]`, Pyramid Song `[deck]`, Unlikely Bond |
| A10 | Mandatory effects can be declined (target marked optional / no minimum). | Wild in the Streets, Unlikely Bond, Three Mouths FAQ | confirmed | Three Mouths, One Desire `[deck]`, Wild in the Streets, Unlikely Bond, The Heist, The Reaper, Les Élémens (ties) `[deck]` |
| A11 | "Can't ready" only stops the Ready step, not effects that ready. | card text "can't ready" | confirmed | Memory Relapse `[deck]`, Pacifica Netrunner |

## B. Combat

| # | Bug | Rule | Status |
|---|-----|------|--------|
| B1 | An empty rival Gig area is a legal attack target (lets you attack just to trigger {Attack} effects). | 9.3.2.2 | confirmed |
| B2 | Blocking ends the React Step at once: the defender can't then Call a Legend or play Quick cards. | 9.7 | confirmed — hits Secondhand Bombus / Augmented Negotiators / Mandibular Upgrade `[deck]` |
| B3 | The attack's own target can "block" itself (spends it, fires its block trigger). | 11.28.3.1 | confirmed |
| B4 | Fight triggers resolve during the fight, defender first, instead of after the fight with the turn player first. | 11.4.2.2.1, 10.15 | confirmed |
| B5 | The attack doesn't end if the target becomes ready mid-attack. | 9.21.3 | confirmed (board edit; no current card does this) |
| B6 | A React Step is still offered after the attacker/defender left during {Attack} triggers. | 9.6 | suspected |

## C. Core flow

| # | Bug | Rule | Status |
|---|-----|------|--------|
| C1 | **No mulligan.** Opening hands are always kept. | 7.9.2 | not implemented |
| C2 | Overtime: reaching 7 Gigs wins immediately only via a Gig-attack steal, not via fights or effects. Overtime test is "more than half of all Gigs", not "7+". | 1.11 | confirmed |
| C3 | Deck validator counts copies per list line, not per card name; RAM errors set a flag but no message; `setupGame` never validates. | 7.3.4 | confirmed |
| C4 | Gear on a Go Solo Legend that leaves goes to "removed", not trash. | 4.12.2 / 11.6.3 | confirmed, rules partly unclear |
| C5 | Defensive Call auto-picks which Eddies/Legends pay. | 11.11.1 | suspected |

## D. Single-card bugs

| Card | Card says / FAQ | Engine does | Status |
|------|-----------------|-------------|--------|
| **Alt Cunningham: Soulkiller Architect** `[deck]` | Two abilities; first: "{Spend} Your next Program this turn plays for -1 €$ per friendly min Gig" | First ability missing from text and script | confirmed |
| **Trust No One** `[deck]` | Decrease *a* Gig (either player's) | Only your own Gigs | confirmed |
| **Industrial Assembly** `[deck]` | Increase a Gig, rival's allowed (FAQ) | Only your own Gigs (same for La Llorona) | confirmed (script) |
| **Peace Offering** `[deck]` | "You may set... Then, if value-pair, draw 1" | Declining the set also skips the draw | confirmed |
| **Field Operator** `[deck]` | Street Cred 0 is not even (FAQ) | Draws at 0 | confirmed |
| **Yorinobu Arasaka: Steel Dragon** `[deck]` | Any Arasaka Unit defeated, including itself (FAQ) | Only your other Arasaka Units | confirmed |
| **Take Control** `[deck]` | Also reduces effect steals by that Unit (FAQ) | Only attack steals | confirmed (code) |
| **Safety Override** `[deck]` / Appetite for Destruction | Choose a friendly Unit on resolve (FAQ) | Applies to whichever Unit fights next | suspected |
| **Kiroshi Optics** | Look at all face-down Legends (FAQ) | Looks at one, optional | confirmed (script) |
| **Cyberpsychosis** | Doesn't defeat a Unit that fought before it was played (FAQ) | Does | confirmed |
| **Hanako: In a Gilded Cage** | Take any number | Takes all matching | confirmed (script) |
| **Viktor Vektor: Drop Your Illusions** | Discount works on rival's turn too (FAQ) | Own turn only | suspected |
| **Judy: Nothing to Doubt** | "Add it to your hand" | Scripted as Draw 1 (loses on empty deck) | suspected |

## Correct (checked)

Setup (6-card hands, 3 Legends, first player's 2 Legends spent), draw every turn incl. turn 1,
empty-deck loss, d20 only when the fixer area is otherwise empty, selling (once per turn, sell tag,
from hand), paying with Eddies + Legends, Call cost, Go Solo basics, Lag for attacks, Adrenaline,
attack targets (spent Units only), Unblockable, fight results (ties, power 0, clamped negatives),
steal counts by power, Gear to trash with a defeated host, 7-Gig win check at start of turn,
end-of-turn cleanup, no hand limit. ~100 card scripts read and found correct, including most
of the meta-deck cards (Lizzy Wizzy, Maman Brigitte, Placide, Chrome Reverie, Adam Smasher,
Meredith Stout, Satori, Zetatech Faceplate, River Ward, Viktor: Sit Down and Relax, Carnage,
Muamar Reyes, Padre, Dexter: Off the Grid, Adrenaline Converter, Nocturne, Detonate, Pyramid Song,
Jacked-In Voodoo Boy, Augmented Negotiators, Live with the Aftermath, Towerfall, MaxTac AV).

## What this means for the Replay Coach

- The engine is solid enough to build on, but it's not trustworthy out of the box for your decks:
  ~20 of the bugs touch cards you actually play.
- Fixing root causes A1–A11 plus B1–B3, C1 and Alt Cunningham covers nearly all of the
  game-changing ones. Since the engine is MIT, we can keep a patched copy (and offer the fixes upstream).
