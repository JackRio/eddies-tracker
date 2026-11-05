// Turns the sim's prose log lines into one short, fixed format per kind of action:
//   Verb [Card] → [Card] · detail · via [Card]
// e.g. "JackRio played Meredith Stout — Stone Cold Corpo by spending 1 Eddie and 3 Legends."
//   → Play [Meredith Stout] · 1 Eddie + 3 Legends
// Lines that only narrate the UI ("must roll a Gig die…", "must lock a legal target…") are dropped.
'use strict';
window.LogFmt = (() => {
  const CARD = '(⟦\\d+⟧|[A-Z][^.]*?)';   // a known-name token, or plain text (names the sim didn't expose)
  const PLAYER = '⟪(\\d+)⟫';
  const NUM = '(\\d+)';
  const R = src => new RegExp('^' + src.split('{C}').join(CARD).split('{P}').join(PLAYER).split('{N}').join(NUM) + '\\.?$');

  // "by spending 1 Eddie and 3 Legends" → "1 Eddie + 3 Legends"
  const cost = s => !s ? '' : /free/.test(s) ? 'free' : s.replace(/^by spending\s+/, '').replace(/\s+and\s+/g, ' + ').replace(/\.$/, '');
  const cards = n => `${n} card${n === '1' ? '' : 's'}`;

  // [regex, groups → { v: verb, a: [cards / text], d: detail, via: card }]; null drops the line
  const RULES = [
    [R('{P} begins turn {N} and must roll a Gig die to finish the Start Phase'), null],
    [R('{P} chose {C} to attack and must lock a legal target before spending it'), null],
    [R('{P} must choose {N} Gigs? to steal from {P}'), null],
    [R('{C} made a Gig attack on {P} and will steal {N} Gigs? if the defender cannot stop it'), null],
    [R('{P} must choose whether to go first or second'), null],
    [R('{P} may play a cheap (?:Unit|Program) from hand or trash for free with {C}'), null],
    [R("{P} triggered {C}'s PLAY ability"), null],

    // ── added for the Nov 2026 replays (server r-20261031+) ──
    [/^Both players began each of the last two consecutive turns with empty Fixer areas\. Overtime is now active\..*$/, () => ({ v: 'Overtime', d: '7 Gigs on your own turn wins · clocks capped at 7:30' })],
    [R('{P} attacked with {C} and is searching the top {N} cards for (\\w+)'), m => ({ v: 'Search', d: `top ${m[3]} for ${m[4]}`, via: m[2] })],
    [R('{P} attacked with {C}, revealed the top {N} cards, and found no (\\w+)'), m => ({ v: 'Search', d: `top ${m[3]} · no ${m[4]}`, via: m[2] })],
    [R("{P} finished {C}'s search without taking an? (\\w+)"), m => ({ v: 'Search', d: 'took nothing', via: m[2] })],
    [R('{C} made a Gig attack on {P}, but did not have enough power to steal a Gig'), m => ({ v: 'Steal', a: [m[1]], d: 'not enough power' })],
    [R('{P} revealed {C} and {C} with {C} and added them to hand'), m => ({ v: 'Add', a: [m[2], m[3], '→ hand'], via: m[4] })],
    [R('{P} had no (\\w+) to defeat with {C}'), m => ({ v: 'No target', d: `no ${m[2]} to defeat`, via: m[3] })],
    [R('{P} sold the top card of their deck into Eddies with {C}'), m => ({ v: 'Sell', d: 'top card of deck', via: m[2] })],
    [R('{P} controls .*? and drew {N} cards? with {C}'), m => ({ v: 'Draw', d: cards(m[2]), via: m[3] })],
    [R('{P} controls .*? and drew (.+) with {C}'), m => ({ v: 'Draw', a: m[2].split(/,\s*|\s+and\s+/), via: m[3] })],
    [R('{P} drew (.+, .+) with {C}'), m => ({ v: 'Draw', a: m[2].split(/,\s*/), via: m[3] })],
    [R("{P} drew a card from {C}'s \\w+ trigger"), m => ({ v: 'Draw', d: '1 card', via: m[2] })],
    [R('{C} readied after winning its first fight this turn'), m => ({ v: 'Ready', a: [m[1]], d: 'won its first fight' })],
    [R("{P} cancelled {C}'s \\w+ ability"), m => ({ v: 'Cancel', a: [m[2]], d: 'ability' })],
    [R('{P} declined {C}'), m => ({ v: 'Decline', a: [m[2]] })],
    [R('{C} was defeated, entered trash, and was removed from the game because Legends cannot remain there(?:; its {N} Gear cards? remains? in trash)?\\..*'),
      m => ({ v: 'Defeated', a: [m[1]], d: `Legend removed${m[2] ? ` · +${m[2]} Gear` : ''}` })],
    [R("{C} was defeated and sent to trash\\. {C}'s PLAY effect defeated it"), m => ({ v: 'Defeated', a: [m[1]], via: m[2] })],
    [R('{P} kept Gig values unchanged for {C}'), m => ({ v: 'Gig', d: 'unchanged', via: m[2] })],
    [R('{P} used {C} to stop {C} from attacking until .+'), m => ({ v: 'No attack', a: [m[3]], d: 'until their next turn', via: m[2] })],
    [R('{P} trashed {C} from the top of their deck with {C}'), m => ({ v: 'Trash top', a: [m[2]], via: m[3] })],
    [R('{P} gave {N} rival Units (-{N}) power this turn with {C}'), m => ({ v: 'Power', d: `${m[2]} rival Units ${m[3]} this turn`, via: m[5] })],
    [R("{C} was returned to the bottom of {P}'s deck with {N} attached Gear cards?\\. {C}'s PLAY trigger bottom-decked it"), m => ({ v: 'Bottom-deck', a: [m[1]], d: `+${m[3]} Gear`, via: m[4] })],
    [R('{P} readied an Eddie with {C}'), m => ({ v: 'Ready', d: 'an Eddie', via: m[2] })],
    [R('{P} spent {C} to give {C} (-{N}) power this turn'), m => ({ v: 'Power', a: [m[3]], d: `${m[4]} this turn`, via: m[2] })],
    [R('{P} used {C} to make {C} attack next turn if able'), m => ({ v: 'Must attack', a: [m[3]], via: m[2] })],
    [R('{P} used {C} to give {C} \\+{N} power until end of turn\\. It will be defeated at end of turn if it steals or fights'), m => ({ v: 'Power', a: [m[3]], d: `+${m[4]} · defeated at end of turn if it fights or steals`, via: m[2] })],
    [R('{P} called {C}, had no friendly Gear to defeat, and drew a card'), m => ({ v: 'Call', a: [m[2]], d: 'no Gear to defeat · drew 1' })],
    [R('{C} gave {C} BLOCKER and \\+{N} power for the turn'), m => ({ v: 'Power', a: [m[2]], d: `+${m[3]} and Blocker this turn`, via: m[1] })],
    [R('{P} triggered {C} and may decrease a friendly Gig by up to {N}'), null],
    [R('{P} finished resolving {C} without calling a Legend'), null],
    [R("{P} may discard {N} Programs for {C}'s PLAY trigger"), null],

    [R('{P} drew {N} opening cards'), m => ({ v: 'Opening hand', d: cards(m[2]) })],
    [R('{P} kept the opening hand'), () => ({ v: 'Keep hand' })],
    [R('{P} mulliganed and redrew {N} cards'), m => ({ v: 'Mulligan', d: `redrew ${m[2]}` })],
    [/^⟪(\d+)⟫ chose to go (first|second)\..*$/, m => ({ v: `Go ${m[2]}` })],
    [R('{P} rolled d{N} for {N} and finished the Start Phase'), m => ({ v: 'Roll', a: [`d${m[2]}`, `→ ${m[3]}`] })],
    [R('{P} has no fixer dice left to roll and moves straight into the Main Phase'), () => ({ v: 'Roll', d: 'no dice left' })],

    [R('{P} drew a card'), () => ({ v: 'Draw', d: '1 card' })],
    [R('{P} drew a card with {C}'), m => ({ v: 'Draw', d: '1 card', via: m[2] })],
    [R('{P} drew {N} cards with {C}'), m => ({ v: 'Draw', d: cards(m[2]), via: m[3] })],
    [R('{P} drew {C} with {C}'), m => ({ v: 'Draw', a: [m[2]], via: m[3] })],
    [R('{P} drew {C}'), m => ({ v: 'Draw', a: [m[2]] })],
    [R('{P} used {C} to draw (.+)'), m => ({ v: 'Draw', a: m[3].split(/,\s*/), via: m[2] })],
    [R('{P} controlled .*? with {C} and drew a card'), m => ({ v: 'Draw', d: '1 card', via: m[2] })],
    [R('{P} controlled .*? with {C} and drew {C}'), m => ({ v: 'Draw', a: [m[3]], via: m[2] })],
    [R('{P} controlled .*? after {C} and drew a card'), m => ({ v: 'Draw', d: '1 card', via: m[2] })],
    [R('{P} controlled .*? and drew a card'), () => ({ v: 'Draw', d: '1 card' })],
    [R('{P} controlled .*? and drew {C}'), m => ({ v: 'Draw', a: [m[2]] })],
    [R('{P} controls .*? and drew a card with {C}'), m => ({ v: 'Draw', d: '1 card', via: m[2] })],
    [R('{P} made d{N} a min Gig and drew a card'), m => ({ v: 'Draw', d: `1 card · d${m[2]} is a min Gig` })],
    [R('{C} won the fight with {C} equipped and {P} drew {N} cards?'), m => ({ v: 'Draw', d: cards(m[4]), via: m[2] })],
    [R('{C} won the fight with {C} equipped and {P} drew {C}'), m => ({ v: 'Draw', a: [m[4]], via: m[2] })],

    [R('{P} sold {C} into Eddies'), m => ({ v: 'Sell', a: [m[2]] })],
    [R('{P} called a Legend (by spending .+?)\\. {C} was revealed'), m => ({ v: 'Call', a: [m[3]], d: cost(m[2]) })],
    [R('{P} played {C} (by spending .+|for free)'), m => ({ v: 'Play', a: [m[2]], d: cost(m[3]) })],
    [R('{P} sent {C} GO SOLO onto the field'), m => ({ v: 'Go Solo', a: [m[2]] })],
    [R('{P} equipped {C} to {C} (by spending .+|for free)'), m => ({ v: 'Equip', a: [m[2], '→', m[3]], d: cost(m[4]) })],

    [R('{P} declared a Gig attack with {C}\\..*'), m => ({ v: 'Attack', a: [m[2], '→ Gigs'] })],
    [R('{P} declared {C} against {C}\\..*'), m => ({ v: 'Attack', a: [m[2], '→', m[3]] })],
    [R('{C} \\({N}\\) fought {C} \\({N}\\) and (won|lost|traded)'), m => ({ v: 'Fight', a: [m[1], `${m[2]} vs ${m[4]}`, m[3]], d: m[5] === 'traded' ? 'trade' : m[5] })],
    [R('{C} made a Gig attack on {P}, but no rival Gigs could be stolen'), m => ({ v: 'Steal', a: [m[1]], d: 'nothing to steal' })],
    [R('{P} stole d{N} \\({N}\\) from {P}\\. {P} now has {N} Gig dice'), m => ({ v: 'Steal', a: [`d${m[2]} (${m[3]})`], d: `now ${m[6]} Gigs` })],

    [R('{C} was defeated and sent to trash with {N} attached Gear cards?\\..*'), m => ({ v: 'Defeated', a: [m[1]], d: `+${m[2]} Gear` })],
    [R("{C} was defeated\\. {C}'s (?:PLAY effect|attack) .*"), m => ({ v: 'Defeated', a: [m[1]], via: m[2] })],
    [R('{C} was defeated\\..*'), m => ({ v: 'Defeated', a: [m[1]] })],
    [R('{P} used {C} to defeat {C}'), m => ({ v: 'Defeat', a: [m[3]], via: m[2] })],
    [R("{C} was returned to the bottom of {P}'s deck\\. {C} bottom-decked it"), m => ({ v: 'Bottom-deck', a: [m[1]], via: m[3] })],
    [R("{C} returned to {P}'s hand\\..*"), m => ({ v: 'Return', a: [m[1], '→ hand'] })],
    [R('{P} returned {C} from trash to hand\\. Recovered with {C}'), m => ({ v: 'Return', a: [m[2], '→ hand'], via: m[3] })],
    [R('{P} added {C} to hand with {C}'), m => ({ v: 'Add', a: [m[2], '→ hand'], via: m[3] })],
    [R("{P} discarded {C}\\. Discarded for {C}(?:'s \\w+ trigger)?"), m => ({ v: 'Discard', a: [m[2]], via: m[3] })],
    [R('{P} triggered {C}, discarded {N} cards from the top of the deck.*'), m => ({ v: 'Trash top', d: cards(m[3]), via: m[2] })],
    [R('{P} trashed the top {N} cards with {C}.*'), m => ({ v: 'Trash top', d: cards(m[2]), via: m[3] })],
    [R("{P} trashed {C} from {C}'s search"), m => ({ v: 'Trash', a: [m[2]], via: m[3] })],
    [R('{P} searched the top {N} cards with {C}'), m => ({ v: 'Search', d: `top ${m[2]}`, via: m[3] })],
    [R('{P} flipped {C} and is searching the top {N} cards for (\\w+)'), m => ({ v: 'Search', d: `top ${m[3]} for ${m[4]}`, via: m[2] })],
    [R('{P} added {N} cards? to hand with {C}'), m => ({ v: 'Add', d: `${cards(m[2])} → hand`, via: m[3] })],
    [R('{P} revealed {C} with {C} and added it to hand'), m => ({ v: 'Add', a: [m[2], '→ hand'], via: m[3] })],
    [R('{C} made the next Program this turn cost {N} less \\(total discount {N}\\).*'), m => ({ v: 'Discount', d: `next Program −${m[2]}`, via: m[1] })],
    [R('{P} readied {C} with {C}'), m => ({ v: 'Ready', a: [m[2]], via: m[3] })],

    [R("{P} used {C} to (increase|decrease|adjust|set) {P}'s d{N} from {N} to {N}"), m => ({ v: 'Gig', a: [`⟪${m[4]}⟫'s d${m[5]}`, `${m[6]} → ${m[7]}`], via: m[2] })],
    [R('{P} used {C} to (increase|decrease|adjust|set) d{N} from {N} to {N}'), m => ({ v: 'Gig', a: [`d${m[4]}`, `${m[5]} → ${m[6]}`], via: m[2] })],
    [R('{P} used {C} to give {C} \\+{N} power this turn'), m => ({ v: 'Power', a: [m[3]], d: `+${m[4]} this turn`, via: m[2] })],
    [R('{P} marked {C}, which must attack on its next turn if it can'), m => ({ v: 'Must attack', a: [m[2]] })],
    [R('{C} marked {C}, which must attack on its next turn if it can'), m => ({ v: 'Must attack', a: [m[2]], via: m[1] })],
    [R("{P}'s {C} had no (.+) to defeat"), m => ({ v: 'No target', a: [m[2]] })],
    [R('{C} was bottom-decked after it resolved'), m => ({ v: 'Bottom-deck', a: [m[1]] })],
    [R("{P} used {C} to spend {C} and prevent it from readying until .+"), m => ({ v: 'Spend', a: [m[3]], d: "can't ready", via: m[2] })],
    [R('{P} used {C} to give {C} (-{N}) power this turn'), m => ({ v: 'Power', a: [m[3]], d: `${m[4]} this turn`, via: m[2] })],
    [R("{P} drew {C} from {C}'s \\w+ trigger"), m => ({ v: 'Draw', a: [m[2]], via: m[3] })],
    [R('{P} used {C} to make {C} steal {N} fewer Gigs? this turn'), m => ({ v: 'Steal', a: [m[3]], d: `−${m[4]} this turn`, via: m[2] })],
    [R("{C} was returned to the bottom of {P}'s deck\\. {C}'s PLAY trigger bottom-decked it"), m => ({ v: 'Bottom-deck', a: [m[1]], via: m[3] })],
    [R("{C} entered the bottom of {P}'s deck and was removed because Legends cannot remain there;.*{C} bottom-decked it"), m => ({ v: 'Removed', a: [m[1]], d: 'Legend left the field', via: m[3] })],
    [R("{P}'s last action was undone by agreement"), () => ({ v: 'Undo', d: 'last action' })],
    [R('{P} inspected a face-down Legend with {C}'), m => ({ v: 'Peek', d: 'a face-down Legend', via: m[2] })],
    [R('{P} made the next Program this turn cost {N} less \\(total discount {N}\\).*'), m => ({ v: 'Discount', d: `next Program −${m[3]}` })],
    [R('{P} used {C}; (.+)'), m => ({ v: 'Effect', d: m[3], via: m[2] })],

    [R('{P} wins\\. {P} conceded the match'), () => ({ v: 'Win', d: 'rival conceded' })],
    [R('{P} wins\\. {P} had {N} Gig dice when overtime would begin'), m => ({ v: 'Win', d: `${m[3]} Gigs at overtime` })],
    [R('{P} wins\\. {P} reached {N} Gig dice'), m => ({ v: 'Win', d: `${m[3]} Gigs` })],
    [R('{P} wins\\. Overtime {N} Gig threshold was reached'), m => ({ v: 'Win', d: `${m[2]} Gigs in overtime` })],
    [R('{P} wins\\. {P} forfeited after disconnecting'), () => ({ v: 'Win', d: 'rival disconnected' })],
    [R('{P} wins\\. (.+?)\\.?'), m => ({ v: 'Win', d: m[2] })],
  ];

  // Known names are swapped for tokens first (longest first), so names with spaces/punctuation can't
  // confuse the patterns. Plain-text card names (not exposed by the sim) still match {C}.
  function makeFormatter(cardNames, playerLabels) {
    // whole names only (a short name like "V" must not match inside "Viktor" or "Voodoo")
    const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const names = [...new Set(cardNames)].filter(n => n && n.length >= 3).sort((a, b) => b.length - a.length)
      .map(n => [n, new RegExp(`(?<![\\w'])${reEsc(n)}(?![\\w])`, 'g')]);
    const players = Object.entries(playerLabels);   // [[pid, label], …]
    return function format(msg) {
      let t = String(msg).trim();
      const found = [];
      for (const [i, [, label]] of players.entries()) t = t.split(label).join(`⟪${i}⟫`);
      for (const [n, re] of names) if (t.includes(n)) { const tok = `⟦${found.push(n) - 1}⟧`; t = t.replace(re, tok); }
      const text = s => String(s).replace(/⟪(\d+)⟫/g, (_, i) => players[+i][1]).replace(/⟦(\d+)⟧/g, (_, i) => found[+i]);
      const part = s => {
        const k = String(s).match(/^⟦(\d+)⟧$/);
        if (k) return { card: found[+k[1]] };
        if (/^[A-Z]/.test(s) && !/→|^\d/.test(s)) return { card: text(s) };   // plain-text card name
        return text(s);
      };
      const actor = (t.match(/^⟪(\d+)⟫/) || [])[1];
      for (const [re, fn] of RULES) {
        const m = t.match(re);
        if (!m) continue;
        if (!fn) return null;
        const out = fn(m);
        return {
          v: out.v, actor: actor != null ? players[+actor][0] : null,
          a: (out.a || []).map(s => (s === '→' || /→/.test(s) || /^\d+ vs \d+$/.test(s) || /^d\d|'s d\d/.test(s)) ? text(s) : part(s)),
          d: text(out.d || ''), via: out.via ? part(out.via) : null,
        };
      }
      return { v: null, raw: text(t), actor: actor != null ? players[+actor][0] : null };
    };
  }
  return { makeFormatter };
})();
