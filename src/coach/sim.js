// Reading cyberpunk-tcg-sim replay files in Node (the browser copy is board/replay.js).
// A replay is an initial snapshot plus one patch list per action; walk() yields the full
// state after every frame. States are shared objects - clone anything you keep.
'use strict';
const fs = require('fs');

const at = (o, path) => { for (const k of path) o = o[k]; return o; };

function applyPatch(st, p) {
  const parent = at(st, p.path.slice(0, -1)), last = p.path[p.path.length - 1];
  if (p.op === 'set') parent[last] = p.value;
  else if (p.op === 'delete') delete parent[last];
  else if (p.op === 'splice') at(st, p.path).splice(p.index, p.deleteCount, ...(p.values || []));
  else throw new Error(`Unknown patch op "${p.op}"`);
}

function loadReplay(file) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (json?.format !== 'cyberpunk-tcg-replay' || !json.timeline) throw new Error(`${file}: not a cyberpunk-tcg-sim replay`);
  const me = json.match.perspective?.playerId || 'player1';
  const rival = json.match.players.find(p => p.playerId !== me)?.playerId || (me === 'player1' ? 'player2' : 'player1');
  return { json, me, rival, labels: Object.fromEntries(json.match.players.map(p => [p.playerId, p.label])) };
}

// Every state in order: frames[i] = { step: i + 1 (board step index), action, state } where
// state is a deep copy. Step 0 is the initial snapshot. Memory: ~15 MB per replay, fine.
function allStates(json) {
  let st = structuredClone(json.timeline.initialSnapshot);
  const seen = new Set((st.history || []).map(h => h.id));
  const out = [{ step: 0, action: null, state: structuredClone(st), newLog: [] }];
  json.timeline.frames.forEach((f, i) => {
    for (const p of f.patch) applyPatch(st, p);
    const newLog = (st.history || []).filter(h => !seen.has(h.id)).reverse();
    newLog.forEach(h => seen.add(h.id));
    out.push({ step: i + 1, action: f.action, state: structuredClone(st), newLog });
  });
  return out;
}

// Every card instance id -> what it is, learned from any frame where it was face up.
// Ids are stable across zones (hand -> field -> trash), so a card seen once is known everywhere.
function cardKnowledge(states) {
  const byId = new Map();
  const note = (c, pid) => {
    if (!c || !c.id) return;
    if (c.cardId && !byId.has(c.id)) byId.set(c.id, { cardId: c.cardId, name: c.name, type: c.type, owner: c.ownerId || pid });
    for (const g of c.attachments || []) note(g, pid);
  };
  for (const { state } of states)
    for (const [pid, P] of Object.entries(state.players))
      for (const z of ['hand', 'field', 'trash', 'legends', 'deck', 'eddies']) for (const c of P[z] || []) note(c, pid);
  return byId;
}

module.exports = { loadReplay, allStates, cardKnowledge, applyPatch };
