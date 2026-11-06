// Plain-English names for macro moves (coach/policy.js `moves`), for the play page and data logs.
'use strict';
const { describePlan } = require('../coach/search');
const { nm } = require('../coach/policy');

// drop subtitles: "River Ward: Detective on the Hunt" -> "River Ward" (exact full names, longest first,
// so a subtitle containing " on " is never cut in the middle)
const { CARDS } = require('../engine');
const FULL = [...new Set(CARDS.map(c => c.name).filter(n => n.includes(': ')))].sort((a, b) => b.length - a.length);
const cardName = s => { for (const n of FULL) if (s.includes(n)) s = s.split(n).join(n.split(': ')[0]); return s; };

function findName(b, iid) {
  for (const p of ['p1', 'p2']) {
    const Z = b[p].zones;
    for (const z of Object.keys(Z)) {
      if (!Array.isArray(Z[z])) continue;
      for (const r of Z[z]) {
        if (r.iid === iid) return nm(r.card_id).split(':')[0];
        for (const g of r.equipped_gear || []) if (g.iid === iid) return nm(g.card_id).split(':')[0];
      }
    }
  }
  return null;
}

// Legend "call" prompts read "X: do <effect>? (No = draw 1)" - say what each answer actually does
function yesNo(a, prompt) {
  if (!prompt || a.step !== 'effect_choice_response' || typeof a.response?.accept !== 'boolean') return null;
  const m = prompt.match(/^(?:[^:]+:\s*)?(.*?)\??\s*(?:\(No = ([^)]+)\))?$/);
  const effect = cardName(m ? m[1] : prompt), alt = m && m[2];
  if (a.response.accept) return `Yes: ${effect}`;
  return alt ? `${alt[0].toUpperCase()}${alt.slice(1)} (instead of: ${effect})` : `No (skip: ${effect})`;
}

// short names of every card, to tell "Zetatech Faceplate: adjust..." (a source card) from "Choose: ..."
const SHORT = new Set(CARDS.map(c => c.name.split(':')[0]));
const shortOf = id => (CARDS.find(c => c.number === id)?.name || String(id)).split(':')[0];
const signed = n => (n > 0 ? `+${n}` : String(n));

// where an effect choice comes from: the engine's source card, else the prompt's "Card: ..." prefix,
// else cn._src (play.js carries the last known source over follow-up prompts like "Increase by how much?")
function sourceOf(cn) {
  if (!cn) return { src: null, what: '' };
  const prompt = cn.prompt || '';
  const m = prompt.match(/^([^:?]+?):\s*(.*)$/);
  const pre = m && SHORT.has(cardName(m[1]).split(':')[0]) ? cardName(m[1]).split(':')[0] : null;
  const src = (cn.source_card_id && shortOf(cn.source_card_id)) || pre || cn._src || null;
  return { src, what: pre ? m[2] : prompt };
}

// a card / die / pending effect named by iid, using what the choice itself reveals (top-of-deck looks)
function choiceName(b, cn, iid, pid) {
  const ref = (cn?.available_refs || []).find(x => x.iid === iid);
  if (ref) return shortOf(ref.card_id);
  const pe = (cn?.options || []).find(o => o.id === iid);
  if (pe) return cardName(pe.name);
  for (const p of ['p1', 'p2']) {
    const g = b[p].zones.gigs.find(x => x.iid === iid);
    if (g) { const o = (String(g.iid).match(/^(p[12])/) || [])[1] || p; return `${o === pid ? 'own' : "opponent's"} d${g.sides} (${g.value})`; }
  }
  const n = findName(b, iid);
  if (n) return n;
  return 'a hidden card';
}

// effect choices: "<source card>: <what was chosen>"
function effectText(b, pid, a, cn) {
  const r = a.response || {};
  const { src, what } = sourceOf(cn);
  const pre = src ? `${src}: ` : '';
  // the engine's prompt often repeats its card ("Jackie: choose a Gig to decrease"): drop that prefix
  const q = what.replace(/\?$/, '').replace(/^([^:]{1,30}):\s*/, (m, w) => (src && src.toLowerCase().includes(w.trim().toLowerCase()) ? '' : m)).replace(/^(swap|copy|set):\s*/i, '');
  if (r.acknowledge) return `${pre}OK`;
  if (cn?.kind === 'choose_pending_order') return `Resolve ${choiceName(b, cn, r.iid || r.selected_iids?.[0], pid)} first`;
  if (cn?.kind === 'choose_from_top_n') {
    const look = (cn.available_refs || []).length;
    const took = (r.selected_iids || []).map(i => choiceName(b, cn, i, pid));
    // the prompt says what happens to the picked cards: River Ward trashes, others take to hand
    const verb = /trash/i.test(cn.prompt || '') ? 'trashes' : /bottom/i.test(cn.prompt || '') ? 'bottom-decks' : 'takes';
    return `${pre}looks at the top ${look}, ${verb} ${took.length ? took.join(', ') : 'nothing'}`;
  }
  if (r.amount !== undefined) {
    const v = cn?.bind_to === 'delta' ? signed(r.amount) : r.amount;
    const m = q.match(/^(increase|decrease|adjust)\b/i);   // "Decrease by 1 or 2" -> "decreases by 2", "adjust the Gig by up to 1" -> "adjusts by +1"
    if (m && /^adjust/i.test(m[1])) return `${pre}adjusts by ${r.amount > 0 ? '+' : ''}${r.amount}`;
    return m ? `${pre}${m[1].toLowerCase()}s by ${Math.abs(r.amount)}` : `${pre}${q || 'amount'} → ${v}`;
  }
  if (r.card_type) return `${pre}name ${r.card_type}`;
  if (r.accept === false) return `${pre}skip (${q})`;
  if (r.accept === true) return `${pre}yes (${q})`;
  const ids = r.iid ? [r.iid] : r.selected_iids;
  if (ids) {
    const names = ids.length ? ids.map(i => choiceName(b, cn, i, pid)).join(', ') : 'nothing';
    // "choose a Gig to decrease" -> "picks own d12 (3) to decrease"
    // Peace Offering / Padre: "Copy value FROM" -> "copies the value of X"; "Set value ON" -> "picks X to set"
    if (/\bplay\b.*\bfrom (your |the )?trash\b/i.test(cn?.prompt || '')) return `${pre}plays ${names} from the trash`;
    if (/^(to )?copy (the )?value from/i.test(q) || /\bto copy the value from$/i.test(q)) return `${pre}copies the value of ${names}`;
    if (/^set (the )?value on/i.test(q)) return `${pre}picks ${names} to set`;
    if (!q || /^(choose|click|pick|select)\b/i.test(q)) {
      if (/\bto copy the value from$/i.test(q)) return `${pre}copies the value of ${names}`; const why = q.replace(/\s*\([^)]*\)\s*$/, '').match(/\b(to \w.*)$/i); return `${pre}picks ${names}${why ? ` ${why[1]}` : ''}`; }
    return `${pre}${q} → ${names}`;
  }
  return `${pre}${q || 'choice'}`;
}

// one macro move -> short text; cn = the decision's choice_needed (effect choices) or its prompt
function describe(b, pid, seq, cn) {
  if (typeof cn === 'string') cn = { prompt: cn };
  const prompt = cn?.prompt;
  const a = seq[seq.length - 1];
  const yn = yesNo(a, prompt);
  if (yn) { const { src } = sourceOf(cn); return src && !yn.includes(src) ? `${src}: ${yn}` : yn; }
  if (a.step === 'effect_choice_response') return effectText(b, pid, a, cn);
  if (a.step === 'activate_asset_spend') return `Use ${findName(b, a.iid) || 'an ability'}`;
  if (a.step === 'choose_gig_die') return `Roll the d${a.sides}`;
  if (a.step === 'call_legend' || a.step === 'call_legend_defensive') {
    // a Call flips a random face-down Legend; only the last one is known (by elimination)
    const down = b[pid].zones.legends.filter(l => l.face !== 'face_up');
    const when = a.step === 'call_legend_defensive' ? ' (as a reaction)' : '';
    return down.length === 1 ? `Call ${nm(down[0].card_id).split(':')[0]} - last face-down Legend${when}` : `Call a Legend - random of ${down.length} face-down${when}`;
  }
  const w = describePlan([{ owner: pid, seq, before: b, prompt: null }], pid).map(s => s.trim()).join('; ');
  // neutral wording: these lines are read by both players ("your d12" from the bot's side is its own)
  if (a.step === 'play_card' && !a.equip_to) {
    const c = CARDS.find(x => x.number === b[pid].zones.hand.find(h => h.iid === a.iid)?.card_id);
    if (c) return `Play ${c.type === 'Program' ? 'Program' : c.type === 'Unit' ? 'Unit' : c.type} ${c.name.split(':')[0]}`;
  }
  if (w) return cardName(w.replace(/^pick /, 'Pick ').replace(/^steal /, 'Steal ').replace(/\byour d(\d)/g, 'own d$1').replace(/the Rival's/g, "opponent's"));
  return { end_turn: 'End turn', pass_defensive: "Don't block / don't respond", pass_attacker_interrupt: "Don't interrupt",
    mulligan: a.mulligan ? 'Mulligan (redraw)' : 'Keep this hand' }[a.step] || (a.response?.acknowledge ? 'OK' : a.step.replace(/_/g, ' '));
}

// how many resources a macro move taps
const taps = seq => seq.filter(x => x.step === 'tap_resource').length;

module.exports = { describe, cardName, taps, findName };
