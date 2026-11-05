// Coach panel: shows the Replay Coach's grade for each of your turns (from node scripts/coach.js,
// served at /api/coach/<replay>). Marks flagged turns on the timeline; the turn you're looking at
// opens in detail - your win chance, the best line the coach found, and why it's better.
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pct = p => `${Math.round(p * 100)}%`;
  const VERDICT = { good: 'Good turn', inaccuracy: 'Small slip', mistake: 'Mistake', blunder: 'Big mistake' };

  let C = null, steps = 0, shown = null;

  function reset() {
    C = null; shown = null;
    $('coach-box').hidden = true;
    $('coach').innerHTML = ''; $('coach-detail').innerHTML = ''; $('coach-marks').innerHTML = '';
  }

  // the graded turn a step belongs to: from its Gig roll until the next graded turn starts
  function turnAt(step) {
    if (!C) return null;
    let hit = null;
    for (const t of C.turns) if (step >= t.stepA - 1) hit = t;
    return hit && step <= hit.stepB + 2 ? hit : null;
  }

  function listHtml() {
    return C.turns.map(t => {
      const best = t.options[0];
      const gain = best && !best.sameAsYours && t.verdict !== 'good' ? ` → <b>${pct(best.p)}</b>` : '';
      const tip = gain ? `Turn ${t.turn}: you won ${pct(t.actual.p)} of playouts, the coach's line ${pct(best.p)}. Click to jump there.` : `Turn ${t.turn}: you won ${pct(t.actual.p)} of playouts. Click to jump there.`;
      return `<li class="ct ${t.verdict}" data-step="${t.stepA}" title="${esc(tip)}">
        <span class="tn">T${t.turn}</span><span class="vd">${VERDICT[t.verdict]}</span><span class="wp">${pct(t.actual.p)}${gain} to win</span></li>`;
    }).join('');
  }

  // "7 in 10 games" reads easier than "68%"
  const tenths = p => `${Math.round(p * 10)} in 10`;

  // one plain sentence on what's different about the coach's line
  function headline(t, best) {
    const yours = t.youDid.join(' ');
    const youAttacked = /declared .*attack|declared .* against/i.test(yours);
    const attacks = best.moves.filter(m => m.startsWith('Attack'));
    if (attacks.length && !youAttacked) return `You didn't attack this turn. The coach would: ${attacks[0].replace(/^Attack/, 'attack').replace(/: [^,]*$/, '')}.`;
    if (!attacks.length && youAttacked) return 'You attacked this turn. The coach would hold back instead.';
    if (attacks.length && youAttacked && best.outcome.gigs > t.actual.outcome.gigs) return 'You attacked, but the coach finds attacks that take more Gigs.';
    return 'The coach plays this turn differently.';
  }

  function sureness(best) {
    const z = best.gainSe > 0 ? best.gain / best.gainSe : 0;
    if (z >= 3) return 'The coach is confident about this one.';
    if (z >= 2) return 'Fairly likely, but not certain.';
    return 'Only a hint: the difference is close to the noise in the playouts.';
  }

  function compareHtml(a, b) {
    const rows = [['Your Gigs', 'gigs', 1], ["Rival's Gigs", 'rivalGigs', -1], ['Your Units', 'units', 1], ["Rival's Units", 'rivalUnits', -1],
      ['Cards in hand', 'hand', 1], ['Unspent Eddies + Legends', 'unspent', 0]];
    return `<table class="cd-cmp"><tr><th></th><th>You</th><th>Coach</th></tr>${rows.map(([label, k, good]) => {
      const d = b[k] - a[k], cls = !d || !good ? '' : (d * good > 0 ? 'up' : 'down');
      return `<tr><td>${label}</td><td>${a[k]}</td><td class="${cls}">${b[k]}</td></tr>`;
    }).join('')}</table>`;
  }

  function detailHtml(t) {
    const best = t.options[0];
    const flagged = t.verdict !== 'good' && best && !best.sameAsYours;
    const rows = [];
    rows.push(`<div class="cd-h ${t.verdict}">Turn ${t.turn} · ${VERDICT[t.verdict]}</div>`);
    if (flagged) {
      rows.push(`<div class="cd-lead">${esc(headline(t, best))}</div>`);
      rows.push(`<div class="cd-p">You won about <b>${tenths(t.actual.p)}</b> of the coach's playouts from where you ended this turn; about <b>${tenths(best.p)}</b> with the line below. ${esc(sureness(best))}</div>`);
      rows.push(`<span class="cd-k">What the coach would do</span><ol class="cd-moves">${best.moves.map(m => `<li class="${m.startsWith('  ') ? 'sub' : ''}">${esc(m.trim())}</li>`).join('')}<li class="sub">End the turn</li></ol>`);
      if (t.why?.length) rows.push(`<div class="cd-why"><span>Why it's better</span><ul>${t.why.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>`);
      rows.push(`<details class="cd-alt"><summary>End of turn: yours vs the coach's</summary>${compareHtml(t.actual.outcome, best.outcome)}</details>`);
    } else {
      rows.push(`<div class="cd-lead">Nothing the coach tried did clearly better than your turn.</div>`);
      rows.push(`<div class="cd-p">You won about <b>${tenths(t.actual.p)}</b> of the coach's playouts from where you ended it.</div>`);
    }
    const others = t.options.filter(o => o !== (flagged ? best : null)).slice(0, 3);
    if (others.length) rows.push(`<details class="cd-alt"><summary>Other lines the coach tried</summary>${others.map(o =>
      `<div class="alt"><b>${tenths(o.p)}</b>${o.sameAsYours ? ' <small>(same as yours)</small>' : ''}<div>${o.moves.filter(m => !m.startsWith('  ')).map(esc).join(' · ') || 'End the turn'}</div></div>`).join('')}</details>`);
    return rows.join('');
  }

  function footHtml() {
    const s = C.settings;
    return `<details class="cd-foot"><summary>How the coach works</summary>
      <p>For each of your turns the coach tries a few other ways to play it, then plays every option, and the position you actually reached, to the end of the game ${s.samples} times with a simple bot on both sides. Each playout deals the hidden cards (the Rival's hand, both decks) differently. "7 in 10" means you won 7 of every 10 of those playouts.</p>
      <p><b>Good turn</b>: nothing clearly better found. <b>Small slip</b>: a little better line exists. <b>Mistake</b> / <b>Big mistake</b>: a line won clearly more often (8+ / 18+ more games in 100).</p>
      <p>The bot is simple, so treat this as a second opinion, not the truth. Your deck: ${esc(C.decks.you.source)}. Rival's deck: ${esc(C.decks.rival.source)}; cards they only revealed later count from turn 1.</p></details>`;
  }

  function show(step) {
    if (!C) return;
    const t = turnAt(step);
    for (const li of $('coach').querySelectorAll('.ct')) li.classList.toggle('now', !!t && +li.dataset.step === t.stepA);
    if (t === shown && shown !== null) return;
    shown = t;
    $('coach-detail').innerHTML = (t ? detailHtml(t) : '<div class="cd-p dim">Step into one of your turns to see its review.</div>') + footHtml();
  }

  function load(json) {
    C = json;
    const flagged = C.turns.filter(t => t.verdict === 'mistake' || t.verdict === 'blunder').length;
    $('coach-sum').textContent = flagged ? `· ${flagged} of your ${C.turns.length} turns to look at` : `· all ${C.turns.length} of your turns look fine`;
    $('coach').innerHTML = listHtml();
    $('coach-marks').innerHTML = C.turns.map(t =>
      `<i class="${t.verdict}" style="left:${(100 * t.stepA / Math.max(1, steps - 1)).toFixed(2)}%" title="Turn ${t.turn}: ${VERDICT[t.verdict]}"></i>`).join('');
    $('coach-box').hidden = false;
    shown = undefined;
  }

  document.addEventListener('board:open', e => {
    reset();
    steps = e.detail.steps;
    const name = e.detail.name;
    if (!name || !/^cyberpunk-tcg-sim-replay-.*\.json$/.test(name)) return;
    fetch(`/api/coach/${encodeURIComponent(name)}`).then(r => (r.ok ? r.json() : null)).then(j => {
      if (j && (!j.matchId || j.matchId === e.detail.matchId)) { load(j); show(+$('scrub').value); }
    }).catch(() => {});
  });
  document.addEventListener('board:step', e => show(e.detail.step));
  $('coach').addEventListener('click', e => { const li = e.target.closest('.ct'); if (li) window.BoardNav.go(+li.dataset.step); });
})();
