// Loadout (docs/loadout.html) - the web version of the desktop Deck Builder's
// Prep List. Visitors add any number of decks (pasted Text List or one of the
// site's published decks), each checked against the construction rules; the
// combined list needs the MAX copies any one deck uses (you only ever play
// one deck at a time and reuse cards between them), not the sum. Two PNGs:
// the prep list itself, and a switch guide from the chosen main deck to each
// other deck. Rule helpers are small ports of deckbuilder.js's
// computeCeilings()/checkCardLegality()/computeDeckWarnings() - duplicated,
// per this repo's no-shared-code convention. Nothing leaves the browser; the
// deck list is kept in localStorage only so a refresh doesn't lose it.

const el = (id) => document.getElementById(id);

const LEGEND_SLOTS = 3;
const MAIN_DECK_MIN = 40;
const MAIN_DECK_MAX = 50;
const SIDEBOARD_SIZE = 7;
const MAX_COPIES = 3;
// Safeguards against pasted junk or tampered storage breaking the page. Only
// the deck limit is ever surfaced, and only when someone hits it.
const MAX_DECKS = 10;
const MAX_TEXT = 20000; // characters in one pasted list
const MAX_LINES = 300;
const MAX_QTY = 99; // a bigger "N Card" line is treated as unknown
const MAX_NAME = 60;
const MAX_UNKNOWN = 50;
const IMG_TIMEOUT_MS = 8000;
const MAX_CANVAS_H = 30000; // Chrome's hard limit is ~32k px
const MAX_CANVAS_AREA = 16000000; // iOS Safari refuses canvases over ~16.7M px
const COLOR_ORDER = ['Red', 'Blue', 'Green', 'Yellow'];
const TYPE_ORDER = ['Unit', 'Gear', 'Program'];
const COLOR_HEX = { Red: '#e8465a', Blue: '#3d8bfd', Green: '#3ecf6e', Yellow: '#e8c93a' };
const TYPE_COLORS = { Unit: 'var(--type-unit)', Gear: 'var(--type-gear)', Program: 'var(--type-program)' };
const DECK_COLOR_VARS = { Red: 'var(--color-red)', Blue: 'var(--color-blue)', Green: 'var(--color-green)', Yellow: 'var(--color-yellow)' };
// One marker color per deck slot (A-D), used on the page and in both PNGs.
const DECK_MARKS = ['#1de1e1', '#ff5fa8', '#4dff88', '#b866ff', '#ff9f43', '#4da6ff', '#e8465a', '#ffffff'];
const RARITY_RANK = ['Common', 'Uncommon', 'Rare', 'Epic', 'Secret', 'Iconic Other', 'Iconic Legend', 'Iconic Secret', 'Nova Rare'];
const STORE_KEY = 'eddies_loadout';
const PACKED_KEY = 'eddies_loadout_packed';
const COLLAPSED_KEY = 'eddies_loadout_collapsed';
// The Record page keeps the site owner's GitHub token here - its presence
// is how "Missing" (vs. the owner's own collection) knows to show.
const OWNER_TOKEN_KEY = 'eddies_gh_token';
const NETDECK_API = 'https://api.netdeck.gg/api/cyberpunk/decks/';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let cards = new Map(); // cardId -> { cardId, name, subname, displayName, color, cardType, ram, cost, isEddiable, imgId }
let nameIndex = new Map(); // normalised name -> card
let publishedDecks = [];
let decks = []; // [{ id, name, legends: [cardId], cards: {cardId: qty}, sideboard: {...}, unknown: [line] }]
let mainDeckId = null;
let pending = null; // deck being previewed, not added yet
let editingId = null; // re-previewing an already-added deck
let sortMode = 'name';
let query = ''; // card list search
let packed = new Set(); // cardIds ticked off on the card list
let collapsed = new Set(); // card list groups folded shut (Legends, Red, ...)
let owned = new Map(); // cardId -> copies the site owner has (all buckets, as of last publish)
let isOwner = false;
let step = 1;

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : str;
  return div.innerHTML;
}

const imageUrl = (printingId) => `images/${printingId}.webp`;
const letterOf = (i) => (i < 26 ? String.fromCharCode(65 + i) : `${i + 1}`);
const markOf = (i) => DECK_MARKS[i % DECK_MARKS.length];
const deckIndex = (id) => decks.findIndex((d) => d.id === id);

// --- Data -------------------------------------------------------------------

function nameKey(s) {
  return s.toLowerCase().replace(/[’‘`]/g, "'").replace(/[“”]/g, '"').replace(/\s*[-–—]\s*/g, ': ').replace(/\s+/g, ' ').trim();
}

// catalog.json is per printing; collapse to one card per cardId with the
// art of its most common English printing that the site has an image for.
function buildCards(catalog) {
  const byCard = new Map();
  for (const p of catalog) {
    owned.set(p.cardId, (owned.get(p.cardId) || 0) + (p.main || 0) + (p.reserve || 0) + (p.extras || 0));
    if (!byCard.has(p.cardId)) byCard.set(p.cardId, []);
    byCard.get(p.cardId).push(p);
  }
  const artScore = (p) => (p.img ? 0 : 1000) + (/-fr$/.test(p.set.code) ? 500 : 0) + (RARITY_RANK.indexOf(p.rarity) + 1 || 50) * 2 + (/beta/i.test(p.set.code) ? 1 : 0);
  for (const [cardId, list] of byCard) {
    const best = [...list].sort((a, b) => artScore(a) - artScore(b))[0];
    cards.set(cardId, {
      cardId,
      name: best.name,
      subname: best.subname,
      displayName: best.displayName || (best.subname ? `${best.name}: ${best.subname}` : best.name),
      color: best.color,
      cardType: best.cardType,
      ram: best.ram,
      cost: best.cost,
      power: best.power,
      isEddiable: best.isEddiable,
      imgId: best.id
    });
  }
  // Full "Name: Subtitle" always wins; a bare name only resolves when it
  // belongs to exactly one card.
  const bare = new Map();
  for (const c of cards.values()) {
    nameIndex.set(nameKey(c.displayName), c);
    const k = nameKey(c.name);
    bare.set(k, bare.has(k) && bare.get(k) !== c ? null : c);
  }
  for (const [k, c] of bare) if (c && !nameIndex.has(k)) nameIndex.set(k, c);
}

function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ decks, mainDeckId }));
  } catch {}
}

function savePacked() {
  try {
    localStorage.setItem(PACKED_KEY, JSON.stringify([...packed]));
  } catch {}
}

function saveCollapsed() {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {}
}

function loadCollapsed() {
  try {
    const list = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]');
    if (Array.isArray(list)) collapsed = new Set(list.filter((k) => typeof k === 'string').slice(0, 10));
  } catch {}
}

function loadPacked() {
  try {
    const list = JSON.parse(localStorage.getItem(PACKED_KEY) || '[]');
    if (Array.isArray(list)) packed = new Set(list.filter((id) => typeof id === 'string' && cards.has(id)).slice(0, 500));
  } catch {}
}

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!s || !Array.isArray(s.decks)) return;
    const seen = new Set();
    decks = s.decks
      .map(sanitizeDeck)
      .filter((d) => d && !seen.has(deckSignature(d)) && seen.add(deckSignature(d)))
      .slice(0, MAX_DECKS);
    mainDeckId = decks.some((d) => d.id === s.mainDeckId) ? s.mainDeckId : decks[0]?.id || null;
  } catch {}
}

// Rebuilds a stored deck from scratch, keeping only known cards and sane
// quantities - anything else (old format, hand-edited storage) is dropped.
function sanitizeDeck(d) {
  if (!d || typeof d !== 'object' || typeof d.id !== 'string') return null;
  const qtyMap = (m) => {
    const out = {};
    if (m && typeof m === 'object') {
      for (const [id, q] of Object.entries(m)) {
        const n = Math.floor(Number(q));
        if (cards.has(id) && n > 0) out[id] = Math.min(n, MAX_QTY);
      }
    }
    return out;
  };
  return {
    id: d.id.slice(0, 40),
    name: String(d.name || 'Untitled Deck').slice(0, MAX_NAME),
    legends: (Array.isArray(d.legends) ? d.legends : []).filter((id) => cards.has(id)).slice(0, 10),
    legendInSide: !!d.legendInSide,
    cards: qtyMap(d.cards),
    sideboard: qtyMap(d.sideboard),
    unknown: (Array.isArray(d.unknown) ? d.unknown : []).map((u) => String(u).slice(0, 100)).slice(0, MAX_UNKNOWN)
  };
}

// --- Parsing ----------------------------------------------------------------

const HEADER_RE = /^(legends?|main( deck)?|deck|units?|gears?|programs?|side ?board|sb)\b[^a-z0-9]*(\(\d+\))?\s*:?\s*$/i;

function parseDeckText(text) {
  const deck = { id: newId(), name: '', legends: [], cards: {}, sideboard: {}, unknown: [] };
  let inSide = false;
  for (const raw of text.split(/\r?\n/).slice(0, MAX_LINES)) {
    const line = raw.trim().slice(0, 120);
    if (!line) continue;
    if (line.startsWith('#')) {
      if (!deck.name) deck.name = line.replace(/^#+\s*/, '').trim().slice(0, MAX_NAME);
      continue;
    }
    if (line.startsWith('//') || HEADER_RE.test(line)) {
      inSide = /side ?board|^sb\b/i.test(line.replace(/^\/\/\s*/, ''));
      continue;
    }
    let qty = 1;
    let name = line;
    let m = line.match(/^(\d+)\s*x?\s+(.+)$/i);
    if (m) {
      qty = parseInt(m[1], 10);
      name = m[2];
    } else if ((m = line.match(/^(.+?)\s+x\s*(\d+)$/i))) {
      name = m[1];
      qty = parseInt(m[2], 10);
    }
    const card = nameIndex.get(nameKey(name));
    if (!card || !(qty > 0) || qty > MAX_QTY) {
      if (deck.unknown.length < MAX_UNKNOWN) deck.unknown.push(line);
      continue;
    }
    if (card.cardType === 'Legend') {
      for (let i = 0; i < qty && deck.legends.length < 10; i++) deck.legends.push(card.cardId);
      if (inSide) deck.legendInSide = true;
      continue;
    }
    const map = inSide ? deck.sideboard : deck.cards;
    map[card.cardId] = Math.min(MAX_QTY, (map[card.cardId] || 0) + qty);
  }
  return deck;
}

// A cyberpunktcg.com / netdeck.gg deck link (or bare deck id). Public decks
// are readable cross-origin from netdeck's API. Cards map by their id (same
// ids as our catalog), falling back to the display name.
function deckLinkId(text) {
  if (text.includes('\n')) return null;
  const m = text.match(UUID_RE);
  return m && (/^https?:\/\//i.test(text) ? /\/decks?\//i.test(text) : text.length === m[0].length) ? m[0] : null;
}

async function fetchLinkedDeck(id) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  let res;
  try {
    res = await fetch(NETDECK_API + encodeURIComponent(id), { signal: ctrl.signal, credentials: 'omit' });
  } catch {
    throw new Error("Couldn't load that deck.");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(res.status === 404 || res.status === 401 || res.status === 403 ? 'Deck not found or private.' : "Couldn't load that deck.");
  const data = await res.json();
  const src = data.deck || data;
  const deck = { id: newId(), name: String(src.name || 'Linked deck').slice(0, MAX_NAME), legends: [], cards: {}, sideboard: {}, unknown: [] };
  for (const zone of Array.isArray(src.zones) ? src.zones : []) {
    for (const e of Array.isArray(zone.cards) ? zone.cards : []) {
      const qty = Math.floor(Number(e.quantity));
      const card = cards.get(e.card_entity_id) || nameIndex.get(nameKey(String(e.card?.display_name || '')));
      if (!card || !(qty > 0) || qty > MAX_QTY) {
        if (deck.unknown.length < MAX_UNKNOWN) deck.unknown.push(String(e.card?.display_name || 'Unknown card').slice(0, 100));
        continue;
      }
      if (card.cardType === 'Legend') {
        if (zone.zone_code === 'sideboard') deck.legendInSide = true;
        for (let i = 0; i < qty && deck.legends.length < 10; i++) deck.legends.push(card.cardId);
        continue;
      }
      const map = zone.zone_code === 'sideboard' ? deck.sideboard : deck.cards;
      map[card.cardId] = Math.min(MAX_QTY, (map[card.cardId] || 0) + qty);
    }
  }
  return deck;
}

function fromPublished(d) {
  const clean = (map) => Object.fromEntries(Object.entries(map || {}).filter(([id, q]) => q > 0 && cards.has(id)));
  return {
    id: newId(),
    name: d.name || 'Untitled Deck',
    legends: (d.legendCardIds || []).filter((id) => id && cards.has(id)),
    cards: clean(d.cards),
    sideboard: clean(d.sideboard),
    unknown: []
  };
}

function newId() {
  return 'd' + Math.random().toString(36).slice(2, 10);
}

// --- Rules ------------------------------------------------------------------

function ceilingsOf(deck) {
  const out = {};
  for (const id of deck.legends) {
    const l = cards.get(id);
    if (l?.color) out[l.color] = (out[l.color] || 0) + (l.ram || 0);
  }
  return out;
}

const sumOf = (map) => Object.values(map || {}).reduce((s, q) => s + q, 0);

// { legal, errors: [text], warnings: [text], bad: {cardId: reason} }
function checkDeck(deck) {
  const errors = [];
  const warnings = [];
  const bad = {};
  const nLeg = deck.legends.length;
  if (nLeg < LEGEND_SLOTS) errors.push(`${nLeg}/${LEGEND_SLOTS} Legends.`);
  if (nLeg > LEGEND_SLOTS) errors.push(`${nLeg}/${LEGEND_SLOTS} Legends.`);
  const seen = new Map();
  for (const id of deck.legends) {
    const n = cards.get(id)?.name;
    if (seen.has(n)) {
      errors.push(`Two Legends named ${n}.`);
      bad[id] = 'Duplicate Legend name';
    }
    seen.set(n, id);
  }
  if (deck.legendInSide) errors.push('Legend in sideboard.');

  const total = sumOf(deck.cards);
  if (total < MAIN_DECK_MIN) errors.push(`${total} cards (min ${MAIN_DECK_MIN}).`);
  if (total > MAIN_DECK_MAX) errors.push(`${total} cards (max ${MAIN_DECK_MAX}).`);

  const ceil = ceilingsOf(deck);
  const ids = new Set([...Object.keys(deck.cards), ...Object.keys(deck.sideboard)]);
  for (const id of ids) {
    const c = cards.get(id);
    const n = (deck.cards[id] || 0) + (deck.sideboard[id] || 0);
    if (n > MAX_COPIES) {
      errors.push(`${c.displayName}: ${n} copies (max ${MAX_COPIES}).`);
      bad[id] = `${n} copies`;
    }
    if (c.color && nLeg) {
      const cap = ceil[c.color] || 0;
      if (!cap) {
        errors.push(`${c.displayName}: no ${c.color} Legend.`);
        bad[id] = `No ${c.color} Legend`;
      } else if ((c.ram || 0) > cap) {
        errors.push(`${c.displayName}: needs ${c.ram} ${c.color} RAM, has ${cap}.`);
        bad[id] = `Needs ${c.ram} RAM`;
      }
    }
  }
  const side = sumOf(deck.sideboard);
  if (side && side !== SIDEBOARD_SIZE) warnings.push(`Sideboard: ${side}/${SIDEBOARD_SIZE}.`);
  if (deck.unknown.length) errors.push(`Unknown: ${deck.unknown.slice(0, 4).join(', ')}${deck.unknown.length > 4 ? '…' : ''}`);
  return { legal: !errors.length, errors, warnings, bad };
}

function deckStats(deck) {
  const typeCounts = {};
  const colorCounts = {};
  const costCounts = {};
  let sellable = 0;
  let costSum = 0;
  let costN = 0;
  for (const [id, qty] of Object.entries(deck.cards)) {
    const c = cards.get(id);
    typeCounts[c.cardType] = (typeCounts[c.cardType] || 0) + qty;
    if (c.color) colorCounts[c.color] = (colorCounts[c.color] || 0) + qty;
    const k = c.cost == null ? '?' : Math.min(c.cost, 7);
    costCounts[k] = (costCounts[k] || 0) + qty;
    if (c.isEddiable) sellable += qty;
    if (c.cost != null) {
      costSum += c.cost * qty;
      costN += qty;
    }
  }
  const total = sumOf(deck.cards);
  return { total, typeCounts, colorCounts, costCounts, sellable, avg: costN ? costSum / costN : 0 };
}

// --- Step 1: import + preview ----------------------------------------------

function showImportError(text) {
  const box = el('import-error');
  box.textContent = text;
  box.hidden = !text;
}

const atLimit = () => decks.length >= MAX_DECKS;

// Same Legends + main deck + sideboard = same deck, whatever it's called.
function deckSignature(d) {
  const m = (map) => Object.entries(map).filter(([, q]) => q > 0).sort(([a], [b]) => a.localeCompare(b)).map(([id, q]) => `${id}:${q}`).join(',');
  return [[...d.legends].sort().join(','), m(d.cards), m(d.sideboard)].join('|');
}
// Two different decks sharing a name would look identical in the list, the
// A/B/C key and the PNGs, so a clash gets a number: "Name (2)".
function uniqueName(name, exceptId) {
  const base = (name.trim() || 'Untitled Deck').slice(0, MAX_NAME - 4);
  const taken = new Set(decks.filter((d) => d.id !== exceptId).map((d) => d.name.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let n = 2;
  while (taken.has(`${base} (${n})`.toLowerCase())) n++;
  return `${base} (${n})`;
}

const duplicateOf = (deck) => decks.find((d) => d.id !== deck.id && deckSignature(d) === deckSignature(deck));
const LIMIT_MSG = `Max ${MAX_DECKS} decks. Remove one to add another.`;

let checking = false;

async function onCheck() {
  if (checking) return;
  showImportError('');
  if (atLimit()) return showImportError(LIMIT_MSG);
  const pick = el('import-pick').value;
  let deck;
  if (pick) {
    const d = publishedDecks.find((x) => x.id === pick);
    if (!d) return;
    deck = fromPublished(d);
  } else {
    const text = el('import-text').value.trim();
    if (!text) return showImportError('Paste a decklist or pick a deck.');
    if (text.length > MAX_TEXT || text.split(/\r?\n/).length > MAX_LINES) return showImportError('Decklist too long.');
    const linkId = deckLinkId(text);
    if (linkId) {
      checking = true;
      el('import-check').disabled = true;
      el('import-check').textContent = 'Loading…';
      try {
        deck = await fetchLinkedDeck(linkId);
      } catch (err) {
        return showImportError(err.message);
      } finally {
        checking = false;
        el('import-check').disabled = false;
        el('import-check').textContent = 'Check';
      }
      if (atLimit()) return showImportError(LIMIT_MSG);
    } else deck = parseDeckText(text);
    if (!deck.legends.length && !Object.keys(deck.cards).length && !Object.keys(deck.sideboard).length) {
      return showImportError('No cards found.');
    }
    if (!deck.name) deck.name = `Deck ${letterOf(decks.length)}`;
  }
  const dup = duplicateOf(deck);
  if (dup) return showImportError(`Already added as ${dup.name}.`);
  pending = deck;
  editingId = null;
  renderPreview();
  el('preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function tileHtml(card, qty, extraClass, title, badge) {
  const n = Math.min(Math.max(1, qty), 4);
  const raise = 12;
  const layers = Array.from({ length: n }, (_, i) => `<img class="deck-tile-layer" style="top:${i * raise}px;z-index:${i + 1}" src="${imageUrl(card.imgId)}" alt="${i === n - 1 ? escapeHtml(card.displayName) : ''}" loading="lazy" />`).join('');
  return `<div class="deck-tile ${extraClass || ''}" title="${escapeHtml(title || card.displayName)}" style="padding-bottom:calc(${(88 / 63) * 100}% + ${(n - 1) * raise}px)">${layers}${badge || ''}</div>`;
}

function costCurveHtml(costCounts) {
  const buckets = [0, 1, 2, 3, 4, 5, 6, 7];
  const max = Math.max(1, ...buckets.map((b) => costCounts[b] || 0));
  return `<div class="ram-curve">${buckets
    .map((b) => {
      const n = costCounts[b] || 0;
      return `<div class="ram-curve-col"><div class="ram-curve-bar" style="height:${(n / max) * 100}%">${n ? `<span class="ram-curve-bar-count">${n}</span>` : ''}</div><div class="ram-curve-label">${b === 7 ? '7+' : b}</div></div>`;
    })
    .join('')}</div>`;
}

function donutHtml(title, segments) {
  const total = segments.reduce((s, x) => s + x.count, 0);
  const vis = segments.filter((s) => s.count > 0);
  let acc = 0;
  const stops = vis.map((s) => `${s.color} ${(acc / (total || 1)) * 100}% ${((acc += s.count) / (total || 1)) * 100}%`).join(', ');
  const top = vis[0] || { label: 'None', count: 0 };
  return `<div class="donut-block"><h4>${escapeHtml(title)}</h4><div class="donut" style="background:${vis.length ? `conic-gradient(${stops})` : 'var(--bg-card)'}"><div class="donut-hole"><div class="donut-pct">${total ? Math.round((top.count / total) * 100) : 0}%</div><div class="donut-sublabel">${escapeHtml(top.label)}</div></div></div><div class="donut-chips">${vis.map((s) => `<div class="donut-chip"><span class="donut-dot" style="background:${s.color}"></span>${escapeHtml(s.label)} <b>${s.count}</b></div>`).join('')}</div></div>`;
}

function sortedEntries(map) {
  return Object.entries(map)
    .map(([id, qty]) => ({ card: cards.get(id), qty }))
    .sort((a, b) => COLOR_ORDER.indexOf(a.card.color) - COLOR_ORDER.indexOf(b.card.color) || a.card.displayName.localeCompare(b.card.displayName));
}

function deckViewHtml(deck, check) {
  const s = deckStats(deck);
  const badTile = (id) => (check.bad[id] ? 'is-bad' : '');
  const badBadge = (id) => (check.bad[id] ? `<div class="prep-bad-badge">${escapeHtml(check.bad[id])}</div>` : '');
  const legends = deck.legends.map((id) => tileHtml(cards.get(id), 1, badTile(id), null, badBadge(id))).join('');
  const emptyLegends = Array.from({ length: Math.max(0, LEGEND_SLOTS - deck.legends.length) }, () => '<div class="deck-tile-empty">No Legend</div>').join('');
  const ceil = ceilingsOf(deck);
  const ram = COLOR_ORDER.filter((c) => ceil[c]).map((c) => `<span class="pill"><span class="donut-dot" style="background:${COLOR_HEX[c]}"></span> ${c} RAM <b>${ceil[c]}</b></span>`).join('');

  const entries = sortedEntries(deck.cards);
  const sections = TYPE_ORDER.map((t) => ({ t, list: entries.filter((e) => e.card.cardType === t) }))
    .filter((g) => g.list.length)
    .map((g) => `<div class="deck-section"><h3>${g.t}s <span class="count-badge">${g.list.reduce((n, e) => n + e.qty, 0)}</span></h3><div class="tile-grid">${g.list.map((e) => tileHtml(e.card, e.qty, badTile(e.card.cardId), `${e.card.displayName} x${e.qty}`, badBadge(e.card.cardId))).join('')}</div></div>`)
    .join('');
  const side = sortedEntries(deck.sideboard);
  const sideHtml = side.length
    ? `<div class="deck-section"><h3>Sideboard <span class="count-badge">${sumOf(deck.sideboard)}/${SIDEBOARD_SIZE}</span></h3><div class="tile-grid">${side.map((e) => tileHtml(e.card, e.qty, badTile(e.card.cardId), `${e.card.displayName} x${e.qty}`, badBadge(e.card.cardId))).join('')}</div></div>`
    : '';

  const issues = [...check.errors.map((t) => `<li class="err">${escapeHtml(t)}</li>`), ...check.warnings.map((t) => `<li class="warn">${escapeHtml(t)}</li>`)].join('');

  const t = (k) => s.typeCounts[k] || 0;
  // Compact first: status, Legends and the key numbers, so Add stays in view.
  // The full card list and charts sit behind a toggle (open when the deck
  // has problems, so the red-marked cards are visible).
  return `
    <div class="deck-status ${check.legal ? '' : 'invalid'}">
      <div class="deck-status-sub">${deck.legends.length} Legends · ${s.total} cards${sumOf(deck.sideboard) ? ` · ${sumOf(deck.sideboard)} sideboard` : ''}</div>
      <div class="deck-status-badge">${check.legal ? 'Legal' : 'Not legal'}</div>
    </div>
    ${issues ? `<ul class="prep-issues">${issues}</ul>` : ''}
    <div class="prep-summary">
      <div class="tile-grid prep-summary-legends">${legends}${emptyLegends}</div>
      <div class="stat-row prep-summary-stats">
        ${ram}
        <span class="pill"><b>${t('Unit')}</b> Units · <b>${t('Gear')}</b> Gear · <b>${t('Program')}</b> Programs</span>
        <span class="pill">avg cost <b>${s.avg.toFixed(1)}</b></span>
        <span class="pill"><b>${s.total ? Math.round((s.sellable / s.total) * 100) : 0}%</b> sellable</span>
      </div>
    </div>
    <details class="prep-more" ${check.legal ? '' : 'open'}>
      <summary>Show cards &amp; stats</summary>
      <div class="detail-layout">
        <aside class="detail-side">
          <div class="deck-section"><h3>Eddie Cost Curve</h3>${costCurveHtml(s.costCounts)}</div>
          <div class="donut-row">
            ${donutHtml('Sellable vs Unsellable', [{ label: 'Sellable', count: s.sellable, color: 'var(--green)' }, { label: 'Unsellable', count: s.total - s.sellable, color: 'var(--red)' }])}
            ${donutHtml('Card Types', TYPE_ORDER.map((k) => ({ label: k + 's', count: s.typeCounts[k] || 0, color: TYPE_COLORS[k] })))}
            ${donutHtml('Colors', COLOR_ORDER.map((c) => ({ label: c, count: s.colorCounts[c] || 0, color: DECK_COLOR_VARS[c] })))}
          </div>
        </aside>
        <div class="detail-main">${sections}${sideHtml}</div>
      </div>
    </details>`;
}

function renderPreview() {
  const box = el('preview');
  if (!pending) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  const check = checkDeck(pending);
  box.hidden = false;
  box.innerHTML = `
    <div class="prep-preview-head">
      <input class="prep-name" id="preview-name" value="${escapeHtml(pending.name)}" aria-label="Deck name" maxlength="60" />
      <div class="prep-preview-btns">
        ${editingId ? '' : `<button class="btn" id="preview-discard">Discard</button>`}
        <button class="btn btn-primary" id="preview-add" ${!editingId && !check.legal ? 'disabled title="Fix the issues above to add this deck"' : ''}>${editingId ? 'Done' : 'Add'}</button>
      </div>
    </div>
    ${deckViewHtml(pending, check)}`;
  el('preview-name').addEventListener('input', (e) => {
    pending.name = e.target.value;
    if (editingId) {
      saveState();
      renderAdded();
    }
  });
  // Settle a renamed (already added) deck's name once typing is done.
  el('preview-name').addEventListener('change', (e) => {
    if (!editingId || !pending) return;
    pending.name = e.target.value = uniqueName(e.target.value, pending.id);
    saveState();
    renderAdded();
  });
  el('preview-discard')?.addEventListener('click', () => {
    pending = null;
    renderPreview();
  });
  el('preview-add').addEventListener('click', () => {
    if (!pending) return; // double click
    if (!editingId && !checkDeck(pending).legal) return; // illegal decks can't be added
    if (!editingId && duplicateOf(pending)) return;
    if (!editingId && atLimit()) {
      pending = null;
      renderPreview();
      showImportError(LIMIT_MSG);
      return;
    }
    if (!editingId) {
      pending.name = uniqueName(pending.name.trim() || `Deck ${letterOf(decks.length)}`, pending.id);
      decks.push(pending);
      if (!mainDeckId) mainDeckId = pending.id;
      el('import-text').value = '';
      el('import-pick').value = '';
    }
    pending = null;
    editingId = null;
    saveState();
    renderPreview();
    renderStep1();
    el('added').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

// Total swaps to go from `main` to every other deck (main deck + Legends and
// sideboard, each counted as the larger of its out/in side).
function swapCost(main) {
  return decks.reduce((sum, d) => {
    if (d === main) return sum;
    const { deck, side } = switchDiff(main, d);
    return sum + Math.max(deck.outN, deck.inN) + Math.max(side.outN, side.inN);
  }, 0);
}

// The deck with the fewest total swaps; only meaningful with 3+ decks (with
// two, both directions cost the same).
function recommendedMainId() {
  if (decks.length < 3) return null;
  const costs = decks.map((d) => swapCost(d));
  const best = Math.min(...costs);
  return costs.filter((c) => c === best).length === 1 ? decks[costs.indexOf(best)].id : null;
}

function renderAdded() {
  const wrap = el('added');
  wrap.hidden = !decks.length;
  const recId = recommendedMainId();
  el('rec-note').hidden = !recId;
  el('added-list').innerHTML = decks
    .map((d, i) => {
      const check = checkDeck(d);
      const thumbs = d.legends.slice(0, 3).map((id) => `<img src="${imageUrl(cards.get(id).imgId)}" alt="${escapeHtml(cards.get(id).displayName)}" title="${escapeHtml(cards.get(id).displayName)}" loading="lazy" />`).join('');
      const isMain = d.id === mainDeckId;
      return `
        <div class="prep-deck ${isMain ? 'is-main' : ''}" style="--mark:${markOf(i)}">
          <span class="prep-letter prep-handle" title="Drag to reorder" tabindex="0" role="button" aria-label="Move ${escapeHtml(d.name)} (arrow keys)" data-move="${d.id}">${letterOf(i)}</span>
          <div class="prep-deck-legends">${thumbs}</div>
          <div class="prep-deck-info">
            <b>${escapeHtml(d.name || 'Untitled Deck')}</b>
            <span class="muted">${sumOf(d.cards)} cards${sumOf(d.sideboard) ? ` + ${sumOf(d.sideboard)} sideboard` : ''}</span>
            <span class="prep-legal ${check.legal ? 'ok' : 'bad'}">${check.legal ? '✓ Legal' : '✕ Not legal'}</span>
          </div>
          <div class="prep-deck-actions">
          <div class="prep-main-col">
            <label class="prep-main-pick"><input type="radio" name="main-deck" value="${d.id}" ${isMain ? 'checked' : ''} aria-label="Make ${escapeHtml(d.name)} the main deck" /> Main</label>
          ${d.id === recId ? `<span class="prep-rec" title="Fewest swaps: ${swapCost(d)}">Recommended</span>` : ''}
          </div>
          <div class="prep-deck-btns">
            <button class="btn" data-view="${d.id}">View</button>
            <button class="btn" data-remove="${d.id}" aria-label="Remove ${escapeHtml(d.name)}">Remove</button>
          </div>
          </div>
        </div>`;
    })
    .join('');

  el('added-list').querySelectorAll('input[name="main-deck"]').forEach((r) =>
    r.addEventListener('change', () => {
      mainDeckId = r.value || null;
      saveState();
      renderAdded();
    })
  );
  el('added-list').querySelectorAll('[data-view]').forEach((b) =>
    b.addEventListener('click', () => {
      pending = decks.find((d) => d.id === b.dataset.view);
      editingId = pending.id;
      renderPreview();
      el('preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
    })
  );
  el('added-list').querySelectorAll('[data-remove]').forEach((b) =>
    b.addEventListener('click', () => {
      const index = decks.findIndex((d) => d.id === b.dataset.remove);
      if (index < 0) return;
      const removed = decks[index];
      const wasMain = mainDeckId === removed.id;
      decks = decks.filter((d) => d.id !== b.dataset.remove);
      if (mainDeckId === b.dataset.remove) mainDeckId = decks[0]?.id || null;
      showUndo(`Removed ${removed.name}`, () => {
        if (atLimit() || duplicateOf(removed)) return; // the list moved on since
        decks.splice(Math.min(index, decks.length), 0, removed);
        if (wasMain) mainDeckId = removed.id;
        saveState();
        renderStep1();
      });
      if (editingId === b.dataset.remove) {
        pending = null;
        editingId = null;
        renderPreview();
      }
      saveState();
      renderStep1();
    })
  );
}

// Drag a deck by its letter to reorder (letters follow the order). Pointer
// events, so it works with touch too; other rows slide out of the way.
function setupReorder() {
  const list = el('added-list');
  // Keyboard: focus a deck's letter, then Arrow Up / Down moves it.
  list.addEventListener('keydown', (e) => {
    const handle = e.target.closest('[data-move]');
    if (!handle || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const from = decks.findIndex((d) => d.id === handle.dataset.move);
    const to = from + (e.key === 'ArrowUp' ? -1 : 1);
    if (from < 0 || to < 0 || to >= decks.length) return;
    const [d] = decks.splice(from, 1);
    decks.splice(to, 0, d);
    saveState();
    renderStep1();
    list.querySelector(`[data-move="${d.id}"]`)?.focus();
  });
  // A native image/text drag would cancel our pointer events mid-drag.
  list.addEventListener('dragstart', (e) => e.preventDefault());
  list.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.prep-handle');
    if (!handle || decks.length < 2) return;
    e.preventDefault();
    const rows = [...list.querySelectorAll('.prep-deck')];
    const row = handle.closest('.prep-deck');
    const from = rows.indexOf(row);
    if (from < 0) return;
    const step = row.offsetHeight + 10;
    const startY = e.clientY;
    let to = from;
    row.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const dy = ev.clientY - startY;
      row.style.transform = `translateY(${dy}px)`;
      to = Math.max(0, Math.min(rows.length - 1, from + Math.round(dy / step)));
      rows.forEach((r, k) => {
        if (r === row) return;
        const shift = from < to && k > from && k <= to ? -step : to < from && k >= to && k < from ? step : 0;
        r.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };
    const end = (ev) => {
      if (ev.type === 'pointerup') move(ev); // a quick drag may skip pointermove
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      rows.forEach((r) => (r.style.transform = ''));
      row.classList.remove('dragging');
      if (to !== from) {
        const [d] = decks.splice(from, 1);
        decks.splice(to, 0, d);
        saveState();
      }
      renderStep1();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
}

function clearAll() {
  if (!decks.length || !window.confirm('Remove all decks?')) return;
  decks = [];
  mainDeckId = null;
  pending = null;
  editingId = null;
  packed = new Set();
  saveState();
  savePacked();
  renderPreview();
  renderStep1();
}

// "Removed X · Undo" toast. One at a time; a new one replaces the old.
let undoTimer = null;
function showUndo(text, undo) {
  const box = el('undo-toast');
  clearTimeout(undoTimer);
  box.innerHTML = `<span>${escapeHtml(text)}</span><button type="button" class="prep-undo-btn">Undo</button>`;
  box.hidden = false;
  const hide = () => {
    clearTimeout(undoTimer);
    box.hidden = true;
  };
  box.querySelector('button').addEventListener('click', () => {
    hide();
    undo();
  });
  undoTimer = setTimeout(hide, 7000);
}

// Only legal decks go into a loadout. Decks saved before this rule (or edited
// storage) can still be illegal, so Next is blocked until they're removed.
const allLegal = () => decks.every((d) => checkDeck(d).legal);

function renderStep1() {
  renderAdded();
  const ok = allLegal();
  el('to-step-2').disabled = !ok;
  el('next-error').hidden = ok;
}

// --- Step 2: combined prep list --------------------------------------------

// Per card: copies each deck uses (main + sideboard - you bring both), the
// max of those (what to pull), and the main deck's own count.
function computePrep() {
  const rows = new Map();
  const row = (id) => {
    if (!rows.has(id)) rows.set(id, { card: cards.get(id), per: Array(decks.length).fill(0), need: 0, main: 0 });
    return rows.get(id);
  };
  decks.forEach((d, i) => {
    for (const id of d.legends) row(id).per[i] = 1;
    for (const [id, q] of Object.entries(d.cards)) row(id).per[i] += q;
    for (const [id, q] of Object.entries(d.sideboard)) row(id).per[i] += q;
  });
  const mi = deckIndex(mainDeckId);
  for (const r of rows.values()) {
    r.need = Math.max(...r.per);
    r.main = mi >= 0 ? r.per[mi] : 0;
  }
  const list = [...rows.values()];
  const byName = (a, b) => a.card.displayName.localeCompare(b.card.displayName);
  // RAM / cost / power: low to high, cards without the stat last.
  const byStat = (k) => (a, b) => (a.card[k] ?? 99) - (b.card[k] ?? 99) || byName(a, b);
  const cmp = sortMode === 'qty' ? (a, b) => b.need - a.need || byName(a, b) : ['ram', 'cost', 'power'].includes(sortMode) ? byStat(sortMode) : byName;
  const groups = [{ key: 'Legend', title: 'Legends', color: '#ffb833', list: list.filter((r) => r.card.cardType === 'Legend') }]
    .concat(COLOR_ORDER.map((c) => ({ key: c, title: c, color: COLOR_HEX[c], list: list.filter((r) => r.card.cardType !== 'Legend' && r.card.color === c) })))
    .concat([{ key: 'none', title: 'Colorless', color: '#9494a3', list: list.filter((r) => r.card.cardType !== 'Legend' && !COLOR_ORDER.includes(r.card.color)) }])
    .filter((g) => g.list.length);
  groups.forEach((g) => g.list.sort(cmp));
  return { groups, unique: list.length, copies: list.reduce((n, r) => n + r.need, 0) };
}

function usageHtml(r) {
  return r.per
    .map((q, i) => (q ? `<span class="prep-use ${decks[i].id === mainDeckId ? 'is-main' : ''}" style="--mark:${markOf(i)}" title="${escapeHtml(decks[i].name)}: ${q}">${letterOf(i)}<b>${q}</b></span>` : ''))
    .join('');
}

function renderStep2() {
  const { groups, unique, copies } = computePrep();
  const all = groups.flatMap((g) => g.list);
  // Forget ticks for cards no longer in any deck.
  const inList = new Set(all.map((r) => r.card.cardId));
  for (const id of packed) if (!inList.has(id)) packed.delete(id);
  const packedCopies = all.filter((r) => packed.has(r.card.cardId)).reduce((n, r) => n + r.need, 0);
  const missingOf = (r) => (isOwner ? Math.max(0, r.need - (owned.get(r.card.cardId) || 0)) : 0);
  const missingCopies = all.reduce((n, r) => n + missingOf(r), 0);
  el('list-stats').innerHTML =
    `<span class="pill"><b>${unique}</b> cards</span><span class="pill ok"><b>${copies}</b> copies</span>` +
    `<span class="pill ${packedCopies === copies ? 'ok' : ''}"><b>${packedCopies}/${copies}</b> packed</span>` +
    (packed.size ? '<button class="chip prep-reset" id="unpack-all">Reset</button>' : '') +
    (missingCopies ? `<span class="pill prep-missing-pill"><b>${missingCopies}</b> missing</span>` : '');
  el('unpack-all')?.addEventListener('click', () => {
    packed = new Set();
    savePacked();
    renderStep2();
  });
  const q = query.trim().toLowerCase();
  const shown = groups.map((g) => ({ ...g, list: q ? g.list.filter((r) => r.card.displayName.toLowerCase().includes(q)) : g.list })).filter((g) => g.list.length);
  el('deck-key').innerHTML =
    decks.map((d, i) => `<span class="prep-key-item"><span class="prep-use ${d.id === mainDeckId ? 'is-main' : ''}" style="--mark:${markOf(i)}">${letterOf(i)}</span> ${escapeHtml(d.name)}${d.id === mainDeckId ? ' <em>(main)</em>' : ''}</span>`).join('<span class="sep"></span>') +
    '';
  const tile = (r) => `
    <button type="button" class="prep-card ${r.main ? 'in-main' : ''} ${packed.has(r.card.cardId) ? 'is-packed' : ''}" data-pack="${r.card.cardId}" aria-pressed="${packed.has(r.card.cardId)}" aria-label="${escapeHtml(r.card.displayName)} ×${r.need}">
      <div class="prep-card-art">
        <img src="${imageUrl(r.card.imgId)}" alt="" loading="lazy" />
        <span class="prep-qty">×${r.need}</span>
        ${missingOf(r) ? `<span class="prep-missing" title="You own ${owned.get(r.card.cardId) || 0}">Missing ${missingOf(r)}</span>` : ''}
        <span class="prep-check" aria-hidden="true">✓</span>
      </div>
      <div class="prep-card-name" title="${escapeHtml(r.card.displayName)}">${escapeHtml(r.card.displayName)}</div>
      <div class="prep-card-use">${usageHtml(r)}</div>
    </button>`;
  el('prep-groups').innerHTML = (shown.length ? '' : '<p class="prep-hint">No cards match.</p>') + shown
    .map(
      (g) => `
      <section class="prep-group ${collapsed.has(g.key) ? 'is-collapsed' : ''}" style="--group:${g.color}">
        <h3><button type="button" class="prep-group-toggle" data-group="${g.key}" aria-expanded="${!collapsed.has(g.key)}">${escapeHtml(g.title)} <span class="count-badge">${g.list.reduce((n, r) => n + r.need, 0)}</span>${packedIn(g.list)}</button></h3>
        <div class="prep-group-body">
          ${typeSubgroups(g)
            .map((sg) => `${sg.title ? `<h4 class="prep-sub">${sg.title} <span>${sg.list.reduce((n, r) => n + r.need, 0)}</span></h4>` : ''}<div class="prep-grid">${sg.list.map(tile).join('')}</div>`)
            .join('')}
        </div>
      </section>`
    )
    .join('');
}

// Colour groups split into Units / Gear / Programs (keeping the chosen sort
// inside each); Legends stay one block.
function typeSubgroups(g) {
  if (g.key === 'Legend') return [{ title: null, list: g.list }];
  return TYPE_ORDER.map((t) => ({ title: t === 'Gear' ? 'Gear' : `${t}s`, list: g.list.filter((r) => r.card.cardType === t) })).filter((sg) => sg.list.length);
}

// "3/12 packed" next to a group's count once anything in it is ticked.
function packedIn(list) {
  const total = list.reduce((n, r) => n + r.need, 0);
  const done = list.filter((r) => packed.has(r.card.cardId)).reduce((n, r) => n + r.need, 0);
  return done ? `<span class="prep-group-packed ${done === total ? 'all' : ''}">${done}/${total} packed</span>` : '';
}

// Tap a card to tick it off while packing (all its copies at once); tap a
// group heading to fold it.
function onPackClick(e) {
  const toggle = e.target.closest('[data-group]');
  if (toggle) {
    const key = toggle.dataset.group;
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    saveCollapsed();
    renderStep2();
    return;
  }
  const card = e.target.closest('[data-pack]');
  if (!card) return;
  const id = card.dataset.pack;
  if (packed.has(id)) packed.delete(id);
  else packed.add(id);
  savePacked();
  renderStep2();
}

// --- Step 3: PNG export (drawn straight onto a canvas) ---------------------

const W = 1600;
const PAD = 48;
const FONT = '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const imgCache = new Map();

function loadImg(id) {
  if (!imgCache.has(id)) {
    imgCache.set(
      id,
      new Promise((resolve) => {
        const img = new Image();
        const timer = setTimeout(() => resolve(null), IMG_TIMEOUT_MS);
        img.onload = () => {
          clearTimeout(timer);
          resolve(img);
        };
        img.onerror = () => {
          clearTimeout(timer);
          resolve(null);
        };
        img.src = imageUrl(id);
      })
    );
  }
  return imgCache.get(id);
}

async function preload(ids) {
  const out = new Map();
  await Promise.all([...new Set(ids)].map(async (id) => out.set(id, await loadImg(id))));
  return out;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fitText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

function pillText(ctx, x, y, text, bg, fg, size) {
  ctx.font = `800 ${size}px ${FONT}`;
  const w = ctx.measureText(text).width + size * 0.9;
  const h = size * 1.6;
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + size * 0.45, y + h / 2 + 1);
  ctx.textBaseline = 'alphabetic';
  return w;
}

// One card: art, a big ×N badge, a yellow bar under it when it's in the
// main deck, then the name and per-deck chips.
function drawCard(ctx, imgs, x, y, w, card, opts) {
  const h = Math.round((w * 88) / 63);
  const img = imgs.get(card.imgId);
  ctx.save();
  roundRect(ctx, x, y, w, h, 8);
  ctx.clip();
  if (img) ctx.drawImage(img, x, y, w, h);
  else {
    ctx.fillStyle = '#15151e';
    ctx.fillRect(x, y, w, h);
  }
  ctx.restore();
  roundRect(ctx, x, y, w, h, 8);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = opts.border || '#3a3a4d';
  ctx.stroke();

  if (opts.qty != null) {
    const size = Math.round(w * 0.2);
    ctx.font = `900 ${size}px ${FONT}`;
    const label = `×${opts.qty}`;
    const bw = ctx.measureText(label).width + size * 0.6;
    const bh = size * 1.35;
    // Bottom-center, so it never covers cost/power in the corners.
    const bx = x + (w - bw) / 2;
    const by = y + h - bh - 6;
    roundRect(ctx, bx, by, bw, bh, 6);
    ctx.fillStyle = opts.qtyBg || '#f5e400';
    ctx.fill();
    ctx.fillStyle = '#0a0a0f';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx + size * 0.3, by + bh / 2 + 1);
    ctx.textBaseline = 'alphabetic';
  }
  if (opts.main) {
    ctx.save();
    ctx.shadowColor = 'rgba(245,228,0,.8)';
    ctx.shadowBlur = 10;
    ctx.fillStyle = '#f5e400';
    roundRect(ctx, x + 6, y + h + 3, w - 12, 5, 2.5);
    ctx.fill();
    ctx.restore();
  }

  let cy = y + h + 26;
  ctx.font = `700 ${Math.round(w * 0.092)}px ${FONT}`;
  ctx.fillStyle = '#ececf1';
  ctx.fillText(fitText(ctx, card.displayName, w), x, cy);
  if (opts.per) {
    cy += 8;
    let ux = x;
    const us = Math.round(w * 0.085);
    opts.per.forEach((q, i) => {
      if (!q) return;
      ux += pillText(ctx, ux, cy, `${letterOf(i)} ${q}`, decks[i].id === mainDeckId ? '#f5e400' : 'rgba(255,255,255,.08)', decks[i].id === mainDeckId ? '#0a0a0f' : markOf(i), us) + 4;
    });
  }
  return h;
}

function drawBackground(ctx, h) {
  ctx.fillStyle = '#07070b';
  ctx.fillRect(0, 0, W, h);
  ctx.strokeStyle = 'rgba(255,255,255,.035)';
  ctx.lineWidth = 1;
  for (let gx = 0; gx < W; gx += 40) {
    ctx.beginPath();
    ctx.moveTo(gx + 0.5, 0);
    ctx.lineTo(gx + 0.5, h);
    ctx.stroke();
  }
  for (let gy = 0; gy < h; gy += 40) {
    ctx.beginPath();
    ctx.moveTo(0, gy + 0.5);
    ctx.lineTo(W, gy + 0.5);
    ctx.stroke();
  }
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, '#f5e400');
  grad.addColorStop(0.55, '#1de1e1');
  grad.addColorStop(1, 'rgba(29,225,225,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, 6);
}

function drawHeader(ctx, title, sub) {
  ctx.fillStyle = '#f5e400';
  ctx.font = `900 54px ${FONT}`;
  ctx.fillText(title, PAD, PAD + 46);
  ctx.fillStyle = '#9494a3';
  ctx.font = `600 22px ${FONT}`;
  ctx.fillText(sub, PAD, PAD + 84);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#9494a3';
  ctx.font = `800 22px ${FONT}`;
  ctx.fillText(siteHost() + '/loadout.html', W - PAD, PAD + 46);
  ctx.textAlign = 'left';
  return PAD + 110;
}

function drawDeckKey(ctx, y) {
  let x = PAD;
  decks.forEach((d, i) => {
    const isMain = d.id === mainDeckId;
    const w = pillText(ctx, x, y, letterOf(i), isMain ? '#f5e400' : 'rgba(255,255,255,.08)', isMain ? '#0a0a0f' : markOf(i), 20);
    ctx.font = `700 20px ${FONT}`;
    ctx.fillStyle = '#ececf1';
    const label = fitText(ctx, d.name + (isMain ? ' (main)' : ''), 300);
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + w + 8, y + 16);
    ctx.textBaseline = 'alphabetic';
    x += w + 8 + ctx.measureText(label).width + 28;
  });
  return y + 52;
}

function siteHost() {
  return location.host && !/^(localhost|127\.)/.test(location.host) ? location.host : 'eddies.help';
}

function groupHeading(ctx, y, title, color, count) {
  ctx.fillStyle = color;
  ctx.fillRect(PAD, y, 6, 30);
  ctx.font = `900 28px ${FONT}`;
  ctx.fillStyle = '#ececf1';
  ctx.fillText(title.toUpperCase(), PAD + 18, y + 26);
  if (count != null) {
    const tw = ctx.measureText(title.toUpperCase()).width;
    pillText(ctx, PAD + 30 + tw, y + 2, String(count), 'rgba(255,255,255,.08)', '#ececf1', 17);
  }
  return y + 50;
}

// Builds the canvas twice: a measuring pass (no drawing, ctx calls go to a
// throwaway 1px canvas) to get the height, then the real one.
async function renderCanvas(drawFn, ids) {
  const imgs = await preload(ids);
  const probe = document.createElement('canvas').getContext('2d');
  const height = drawFn(probe, imgs, false);
  const scale = Math.min(1, MAX_CANVAS_H / height, Math.sqrt(MAX_CANVAS_AREA / (W * height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(W * scale);
  canvas.height = Math.floor(height * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  drawBackground(ctx, Math.ceil(height));
  drawFn(ctx, imgs, true);
  return canvas;
}

function drawPrepPng(ctx, imgs) {
  const { groups, copies } = computePrep();
  let y = drawHeader(ctx, 'LOADOUT', `${copies} copies`);
  y = drawDeckKey(ctx, y);
  const cols = 9;
  const gap = 18;
  const cw = Math.floor((W - PAD * 2 - gap * (cols - 1)) / cols);
  const ch = Math.round((cw * 88) / 63) + 58;
  for (const g of groups) {
    y = groupHeading(ctx, y + 8, g.title, g.color, g.list.reduce((n, r) => n + r.need, 0));
    for (const sg of typeSubgroups(g)) {
      if (sg.title) {
        ctx.font = `800 18px ${FONT}`;
        ctx.fillStyle = '#9494a3';
        ctx.fillText(`${sg.title.toUpperCase()}  ${sg.list.reduce((n, r) => n + r.need, 0)}`, PAD, y + 16);
        y += 30;
      }
      sg.list.forEach((r, i) => {
        const cx = PAD + (i % cols) * (cw + gap);
        const cy = y + Math.floor(i / cols) * (ch + gap);
        drawCard(ctx, imgs, cx, cy, cw, r.card, { qty: r.need, main: r.main, per: decks.length > 1 ? r.per : null });
      });
      y += Math.ceil(sg.list.length / cols) * (ch + gap) + 6;
    }
    y += 4;
  }
  return y + PAD;
}

// Physical copies (main + sideboard) and Legends for one deck.
function physicalCounts(d) {
  const m = {};
  for (const id of d.legends) m[id] = 1;
  for (const [id, q] of Object.entries(d.cards)) m[id] = (m[id] || 0) + q;
  for (const [id, q] of Object.entries(d.sideboard)) m[id] = (m[id] || 0) + q;
  return m;
}

// Main deck (+ Legends) and sideboard are diffed separately, so with two
// 40-card decks "take out" and "put in" always match; a sideboard that
// differs gets its own block instead of skewing those numbers.
function mapDiff(a, b) {
  const out = [];
  const inn = [];
  let keep = 0;
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = (b[id] || 0) - (a[id] || 0);
    keep += Math.min(a[id] || 0, b[id] || 0);
    if (d < 0) out.push({ card: cards.get(id), qty: -d });
    if (d > 0) inn.push({ card: cards.get(id), qty: d });
  }
  const ord = (x, y) => (x.card.cardType === 'Legend' ? 0 : 1) - (y.card.cardType === 'Legend' ? 0 : 1) || COLOR_ORDER.indexOf(x.card.color) - COLOR_ORDER.indexOf(y.card.color) || x.card.displayName.localeCompare(y.card.displayName);
  out.sort(ord);
  inn.sort(ord);
  return { out, inn, keep, outN: out.reduce((n, e) => n + e.qty, 0), inN: inn.reduce((n, e) => n + e.qty, 0) };
}

const deckMap = (d) => {
  const m = { ...d.cards };
  for (const id of d.legends) m[id] = 1;
  return m;
};

function switchDiff(from, to) {
  return { deck: mapDiff(deckMap(from), deckMap(to)), side: mapDiff(from.sideboard, to.sideboard) };
}

function drawSwitchPng(ctx, imgs) {
  const main = decks.find((d) => d.id === mainDeckId);
  const others = decks.filter((d) => d !== main);
  let y = drawHeader(ctx, 'SWITCH GUIDE', `From ${main.name}`);
  y = drawDeckKey(ctx, y);
  const colW = (W - PAD * 2 - 40) / 2;
  const cols = 6;
  const gap = 14;
  const cw = Math.floor((colW - gap * (cols - 1)) / cols);
  const ch = Math.round((cw * 88) / 63) + 30;

  // One Take out | Put in pair of columns; returns the new y.
  const drawInOut = (top, diff, label) => {
    let maxH = 0;
    [
      { title: `OUT${label}`, color: '#ff4d4d', list: diff.out, x: PAD },
      { title: `IN${label}`, color: '#4dff88', list: diff.inn, x: PAD + colW + 40 }
    ].forEach((c) => {
      ctx.font = `900 22px ${FONT}`;
      ctx.fillStyle = c.color;
      ctx.fillText(`${c.title}  (${c.list.reduce((n, e) => n + e.qty, 0)})`, c.x, top + 20);
      if (!c.list.length) {
        ctx.font = `600 20px ${FONT}`;
        ctx.fillStyle = '#9494a3';
        ctx.fillText('-', c.x, top + 60);
        maxH = Math.max(maxH, 80);
        return;
      }
      c.list.forEach((e, k) => {
        const cx = c.x + (k % cols) * (cw + gap);
        const cy = top + 38 + Math.floor(k / cols) * (ch + gap);
        drawCard(ctx, imgs, cx, cy, cw, e.card, { qty: e.qty, qtyBg: c.color, border: c.color });
      });
      maxH = Math.max(maxH, 38 + Math.ceil(c.list.length / cols) * (ch + gap));
    });
    return top + maxH + 24;
  };

  for (const d of others) {
    const i = decks.indexOf(d);
    const { deck, side } = switchDiff(main, d);
    roundRect(ctx, PAD, y, W - PAD * 2, 64, 10);
    ctx.fillStyle = '#101018';
    ctx.fill();
    ctx.strokeStyle = markOf(i);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = `900 28px ${FONT}`;
    ctx.fillStyle = '#ececf1';
    ctx.textBaseline = 'middle';
    ctx.fillText(fitText(ctx, `${main.name}  →  ${d.name}`, W - PAD * 2 - 480), PAD + 20, y + 33);
    ctx.textAlign = 'right';
    ctx.font = `700 20px ${FONT}`;
    ctx.fillStyle = '#9494a3';
    const sizes = sumOf(main.cards) !== sumOf(d.cards) ? ` · ${sumOf(main.cards)} → ${sumOf(d.cards)} cards` : '';
    ctx.fillText(`${deck.outN === deck.inN ? `${deck.outN} swaps` : `${deck.outN} out · ${deck.inN} in`} · ${deck.keep} stay${sizes}`, W - PAD - 20, y + 33);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    y = drawInOut(y + 84, deck, '');
    if (side.out.length || side.inn.length) y = drawInOut(y, side, ' · SIDEBOARD');
    y += 12;
  }
  return y + PAD - 20;
}

function allImageIds() {
  const ids = [];
  for (const d of decks) for (const id of Object.keys(physicalCounts(d))) ids.push(cards.get(id).imgId);
  return ids;
}

const canvases = {};

// Step 3's on-page switch guide: pick any two decks (From starts on the main
// deck), see Out / In, tap a card to tick it off (ticks reset on a change).
let switchFrom = null;
let switchTarget = null;
let switchDone = new Set(); // `${section}:${out|in}:${cardId}`

function switchTileHtml(e, key, kind) {
  const done = switchDone.has(key);
  return `<button type="button" class="prep-card ${done ? 'is-packed' : ''}" data-switch="${key}" aria-pressed="${done}" aria-label="${escapeHtml(e.card.displayName)} ×${e.qty}">
    <div class="prep-card-art"><img src="${imageUrl(e.card.imgId)}" alt="" loading="lazy" /><span class="prep-qty prep-qty-${kind}">×${e.qty}</span><span class="prep-check" aria-hidden="true">✓</span></div>
    <div class="prep-card-name" title="${escapeHtml(e.card.displayName)}">${escapeHtml(e.card.displayName)}</div>
  </button>`;
}

function switchColsHtml(diff, section) {
  const col = (kind, title, list) => `
    <div class="prep-switch-col">
      <h3 class="prep-switch-${kind}">${title} <span class="count-badge">${list.reduce((n, e) => n + e.qty, 0)}</span></h3>
      ${list.length ? `<div class="prep-grid">${list.map((e) => switchTileHtml(e, `${section}:${kind}:${e.card.cardId}`, kind)).join('')}</div>` : '<p class="prep-hint">-</p>'}
    </div>`;
  return `<div class="prep-switch-cols">${col('out', 'Out', diff.out)}${col('in', 'In', diff.inn)}</div>`;
}

function renderSwitch() {
  const panel = el('switch-panel');
  panel.hidden = decks.length < 2;
  if (panel.hidden) return;
  const ids = decks.map((d) => d.id);
  if (!ids.includes(switchFrom)) switchFrom = ids.includes(mainDeckId) ? mainDeckId : ids[0];
  if (!ids.includes(switchTarget)) {
    switchTarget = ids.find((id) => id !== switchFrom);
    switchDone = new Set();
  }
  const from = decks.find((d) => d.id === switchFrom);
  const target = decks.find((d) => d.id === switchTarget);
  const opts = (selected) =>
    decks.map((d, i) => `<option value="${d.id}" ${d.id === selected ? 'selected' : ''}>${letterOf(i)} · ${escapeHtml(d.name)}${d.id === mainDeckId ? ' (main)' : ''}</option>`).join('');
  el('switch-from').innerHTML = opts(switchFrom);
  el('switch-to').innerHTML = opts(switchTarget);
  if (switchFrom === switchTarget) {
    el('switch-body').innerHTML = '<p class="prep-same-deck">Same deck selected</p>';
    return;
  }

  const { deck, side } = switchDiff(from, target);
  const total = deck.outN + deck.inN + side.outN + side.inN;
  const done = [...deck.out.map((e) => ['deck:out', e]), ...deck.inn.map((e) => ['deck:in', e]), ...side.out.map((e) => ['side:out', e]), ...side.inn.map((e) => ['side:in', e])]
    .filter(([k, e]) => switchDone.has(`${k}:${e.card.cardId}`))
    .reduce((n, [, e]) => n + e.qty, 0);
  el('switch-body').innerHTML =
    `<div class="stat-row"><span class="pill">${deck.outN === deck.inN ? `<b>${deck.outN}</b> swaps` : `<b>${deck.outN}</b> out · <b>${deck.inN}</b> in`}</span><span class="pill"><b>${deck.keep}</b> stay</span>${total ? `<span class="pill ${done === total ? 'ok' : ''}"><b>${done}/${total}</b> done</span>` : ''}</div>` +
    switchColsHtml(deck, 'deck') +
    (side.out.length || side.inn.length ? `<h3 class="prep-switch-sub">Sideboard</h3>${switchColsHtml(side, 'side')}` : '');
}

function onSwitchSelect(which, value) {
  if (which === 'from') switchFrom = value;
  else switchTarget = value;
  switchDone = new Set();
  renderSwitch();
}

function onSwitchClick(e) {
  if (e.target.closest('#switch-flip')) {
    [switchFrom, switchTarget] = [switchTarget, switchFrom];
    switchDone = new Set();
    renderSwitch();
    return;
  }
  const tile = e.target.closest('[data-switch]');
  if (!tile) return;
  const key = tile.dataset.switch;
  if (switchDone.has(key)) switchDone.delete(key);
  else switchDone.add(key);
  renderSwitch();
}

let renderToken = 0;

async function renderStep3() {
  renderSwitch();
  const token = ++renderToken;
  canvases.prep = null;
  canvases.switch = null;
  const canSwitch = mainDeckId && decks.length > 1;
  el('dl-switch').disabled = !canSwitch;
  el('dl-switch-hint').hidden = canSwitch;
  el('dl-switch-hint').textContent = decks.length < 2 ? 'Needs 2+ decks.' : 'Pick a main deck.';
  el('dl-prep-preview').innerHTML = '<div class="skeleton-block"></div>';
  el('dl-switch-preview').innerHTML = canSwitch ? '<div class="skeleton-block"></div>' : '';
  const ids = allImageIds();
  const prep = await renderCanvas(drawPrepPng, ids);
  if (token !== renderToken) return; // decks changed while drawing
  canvases.prep = prep;
  showPreview('dl-prep-preview', prep);
  if (canSwitch) {
    const sw = await renderCanvas(drawSwitchPng, ids);
    if (token !== renderToken) return;
    canvases.switch = sw;
    showPreview('dl-switch-preview', sw);
  } else canvases.switch = null;
}

function showPreview(id, canvas) {
  const img = new Image();
  img.src = canvas.toDataURL('image/png');
  img.alt = 'Preview';
  el(id).innerHTML = '';
  el(id).appendChild(img);
}

function download(canvas, name) {
  if (!canvas) return;
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
}

const fileSafe = (s) => (s || 'deck').replace(/[<>:"/\\|?*]+/g, '_').trim().slice(0, 40);

// --- Steps ------------------------------------------------------------------

function goStep(n) {
  if (n > 1 && (!decks.length || !allLegal())) n = 1;
  step = n;
  [1, 2, 3].forEach((i) => (el(`step-${i}`).hidden = i !== n));
  el('prep-steps').querySelectorAll('li').forEach((li) => {
    const s = +li.dataset.step;
    li.classList.toggle('active', s === n);
    li.classList.toggle('done', s < n);
    li.classList.toggle('reachable', s < n || (s > n && decks.length > 0 && allLegal()));
  });
  if (n === 1) renderStep1();
  if (n === 2) renderStep2();
  if (n === 3) renderStep3();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function init() {
  renderBuildInfo();
  try {
    const [catalog, published] = await Promise.all([
      fetch('data/catalog.json').then((r) => r.json()),
      fetch('data/published-decks.json').then((r) => r.json()).catch(() => [])
    ]);
    buildCards(catalog);
    publishedDecks = (Array.isArray(published) ? published : []).filter((d) => d && d.id);
  } catch (err) {
    showImportError(`Couldn't load cards: ${err.message}`);
    return;
  }
  el('import-pick').insertAdjacentHTML(
    'beforeend',
    [...publishedDecks].sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name || 'Untitled Deck')}</option>`).join('')
  );
  loadState(); // after buildCards(): sanitizeDeck() drops unknown cards
  loadPacked();
  loadCollapsed();
  try {
    isOwner = !!localStorage.getItem(OWNER_TOKEN_KEY);
  } catch {}
  setupReorder();
  el('clear-all').addEventListener('click', clearAll);
  el('switch-panel').addEventListener('click', onSwitchClick);
  el('switch-from').addEventListener('change', (e) => onSwitchSelect('from', e.target.value));
  el('switch-to').addEventListener('change', (e) => onSwitchSelect('to', e.target.value));
  el('prep-groups').addEventListener('click', onPackClick);
  el('card-search').addEventListener('input', (e) => {
    query = e.target.value.slice(0, 60);
    renderStep2();
  });

  el('import-check').addEventListener('click', onCheck);
  el('import-pick').addEventListener('change', () => {
    if (el('import-pick').value) onCheck();
  });
  el('import-text').addEventListener('input', () => {
    el('import-pick').value = '';
  });
  el('to-step-2').addEventListener('click', () => goStep(2));
  el('back-to-1').addEventListener('click', () => goStep(1));
  el('to-step-3').addEventListener('click', () => goStep(3));
  el('back-to-2').addEventListener('click', () => goStep(2));
  el('prep-steps').addEventListener('click', (e) => {
    const li = e.target.closest('li.reachable');
    if (li) goStep(+li.dataset.step);
  });
  document.querySelectorAll('[data-sort]').forEach((b) =>
    b.addEventListener('click', () => {
      sortMode = b.dataset.sort;
      document.querySelectorAll('[data-sort]').forEach((x) => x.classList.toggle('active', x === b));
      renderStep2();
    })
  );
  el('dl-prep').addEventListener('click', () => download(canvases.prep, `loadout-${fileSafe(decks.map((d) => d.name).join('+'))}.png`));
  el('dl-switch').addEventListener('click', () => download(canvases.switch, `switch-guide-${fileSafe(decks.find((d) => d.id === mainDeckId)?.name)}.png`));
  goStep(1);
}

init();
