// Replay data for cyberpunk-tcg-sim replay files (format "cyberpunk-tcg-replay", schemaVersion 2).
// A replay is an initial snapshot plus one patch list per action. Replay.load() replays every patch
// once and keeps the full state after each action, so the viewer can jump anywhere instantly.
'use strict';
window.Replay = (() => {
  const at = (o, path) => { for (const k of path) o = o[k]; return o; };

  function applyPatch(st, p) {
    const parent = at(st, p.path.slice(0, -1)), last = p.path[p.path.length - 1];
    if (p.op === 'set') parent[last] = p.value;
    else if (p.op === 'delete') delete parent[last];
    else if (p.op === 'splice') at(st, p.path).splice(p.index, p.deleteCount, ...(p.values || []));
    else throw new Error(`Unknown patch op "${p.op}"`);
  }

  function load(json) {
    if (json?.format !== 'cyberpunk-tcg-replay' || !json.timeline) throw new Error('Not a cyberpunk-tcg-sim replay file');
    const me = json.match.perspective?.playerId || 'player1';
    const rival = json.match.players.find(p => p.playerId !== me)?.playerId || (me === 'player1' ? 'player2' : 'player1');
    const labels = Object.fromEntries(json.match.players.map(p => [p.playerId, p.label]));

    let st = structuredClone(json.timeline.initialSnapshot);
    const seenLog = new Set((st.history || []).map(h => h.id));
    const steps = [{ state: structuredClone(st), action: null, newLog: [], turn: st.game.turnNumber || 0 }];
    for (const f of json.timeline.frames) {
      for (const p of f.patch) applyPatch(st, p);
      const newLog = (st.history || []).filter(h => !seenLog.has(h.id)).reverse();   // history is newest-first
      newLog.forEach(h => seenLog.add(h.id));
      steps.push({ state: structuredClone(st), action: f.action, at: f.at, elapsed: f.elapsedMs, newLog, turn: st.game.turnNumber || 0 });
    }

    // full log in play order, each entry tagged with the step that produced it
    const log = [];
    steps.forEach((s, i) => s.newLog.forEach(h => log.push({ ...h, step: i })));
    // first step of each turn, for turn jumps
    const turnStarts = [];
    steps.forEach((s, i) => { if (!turnStarts.length || turnStarts[turnStarts.length - 1].turn !== s.turn) turnStarts.push({ turn: s.turn, step: i }); });

    return { match: json.match, me, rival, labels, steps, log, turnStarts };
  }

  return { load, applyPatch };
})();
