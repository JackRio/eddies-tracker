// Shared by scripts/batch.js (this machine: league + training + gate) and scripts/remote-league.js (any other
// machine: league games only). Both must play the SAME league for the same champion, so the settings live here.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STATE = path.join(ROOT, 'notes', 'league', 'batches.json');
const REMOTE = path.join(ROOT, 'notes', 'league', 'remote');

const defaultState = () => ({
  // the Daemon as of Nov 8 2026: round 3 nets + search fixes
  champion: { name: 'r3', value: 'src/bot/value-net-r3.json', policy: 'src/bot/policy-net-r3.json', opts: '' },   // opts: extra search options (e.g. ':after=1')
  // earlier bots the league keeps playing (unrecorded): Daemon before the search fixes, round 2
  past: ['strong:vnet=src/bot/value-net-r3.json:pnet=src/bot/policy-net-r3.json:prior=mix', 'strong:vnet=src/bot/value-net-r2.json:pnet=src/bot/policy-net-r2.json:prior=mix'],
  // league data used for value training as results only (searched before the fixes)
  oldData: ['notes/league/data-2001-re.jsonl', 'notes/league/data-3001-re.jsonl', 'notes/league/data-3301-re.jsonl', 'notes/league/data-3302-re.jsonl', 'notes/league/data-4001.jsonl', 'notes/league/data-5101.jsonl'],
  batches: [],
});
const loadState = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : defaultState());

const spec = (champ, v, p, extra = '') => `strong:vnet=${v}:pnet=${p}:prior=mix:gb=1:alt=1:tb=1${champ.opts || ''}${extra}`;

// league.js arguments for one self-play league of the champion.
// Player: the champion + explore=2 (2 random extra moves searched per decision, so lines it would never try still
// get tested and recorded; it still plays its best move). Teacher: the FULL search - plays out the Rival's reply,
// no champion options like after=1 - deeper (24 worlds, 10 moves), so it doesn't share the player's blind spots;
// its values replace the player's on 15% of undecided decisions.
function leagueArgs(state, matches, seed, outDir) {
  const champ = state.champion;
  const bot = spec(champ, champ.value, champ.policy, ':explore=2');
  const teacher = `strong:vnet=${champ.value}:pnet=${champ.policy}:prior=mix:gb=1:alt=1:tb=1:deals=24:k=10`;
  return ['--matches', matches, '--record', '--teach', 0.15, '--general', 0.75, '--past', state.past.join(','), '--past-share', 0.15,
    '--bot', bot, '--teacher', teacher, '--seed', seed, '--out', outDir].map(String);
}

module.exports = { ROOT, STATE, REMOTE, defaultState, loadState, spec, leagueArgs };
