let allCards = [];
let collection = {};
let decks = {};
let uniqueCards = []; // one entry per cardId (a "card"), not per printing

let view = 'list'; // 'list' | 'builder' | 'view'
let draft = null;
let viewingDeck = null; // the deck object shown in the read-only Deck View
let faqData = {};
// hand: printings currently drawn. deckPool: shuffled printings not yet
// drawn (excludes hand). mulliganUsed: the real game only allows one
// mulligan per hand - "shuffle your whole hand back in, draw a fresh 6".
let testHandState = { hand: [], deckPool: [], mulliganUsed: false };
let cardDetailPrintings = []; // whatever list is currently being paged through in the card detail popup
let cardDetailIndex = -1;
let listUiState = { confirmDeleteId: null, selectedIds: new Set(), search: '', ownership: 'all', sort: 'updated', color: '', archetype: '' };
let publishState = { deckIds: [], publishedAt: null }; // which decks are currently live on the website
let builderState = {
  search: '',
  colors: new Set(),
  types: new Set(),
  rarities: new Set(),
  set: 'all',
  ownership: 'owned',
  legalOnly: true,
  decklistOnly: false // "Decklist" toggle: only cards in the main deck or sideboard
};
let deckMessage = null; // { text, error }
let legendPicker = { open: false, slotIndex: null, search: '', ownership: 'owned', variantFor: null };

const el = (id) => document.getElementById(id);

const COLOR_ORDER = ['Red', 'Blue', 'Green', 'Yellow'];
const TYPE_ORDER = ['Unit', 'Gear', 'Program'];
const RARITY_ORDER = [
  'Common',
  'Uncommon',
  'Rare',
  'Epic',
  'Nova Rare',
  'Iconic Legend',
  'Iconic Other',
  'Secret',
  'Iconic Secret'
];

const MAIN_DECK_MIN = 40;
const MAIN_DECK_MAX = 50;
const LEGEND_SLOTS = 3;
const SIDEBOARD_SIZE = 7; // official Tournament Rules: exactly 7, no Legends
const MAX_COPIES = 3; // per card, main deck + sideboard combined

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : str;
  return div.innerHTML;
}

function rarityClass(rarity) {
  return 'rarity-' + String(rarity || '').toLowerCase().replace(/\s+/g, '-');
}

// Card rulesText comes from the API with {Keyword} tokens standing in for
// the game's official badge icons - duplicated from renderer.js/
// collection.js, see CLAUDE.md's note on why this is copied rather than
// shared via a module.
function renderRulesText(text) {
  if (!text) return '';
  return text
    .split(/(\{[^}]+\})/g)
    .map((part) => {
      const m = part.match(/^\{([^}]+)\}$/);
      if (!m) return escapeHtml(part);
      const slug = m[1].toLowerCase().replace(/\s+/g, '-');
      const label = escapeHtml(m[1]);
      return `<img class="keyword-icon" src="assets/keywords/${slug}.svg" alt="${label}" title="${label}">`;
    })
    .join('');
}

function faqHtml(slug) {
  const entry = faqData[slug];
  if (!entry || !entry.faqs.length) return '';
  const items = entry.faqs
    .map((f) => `<div class="faq-item"><div class="faq-q">${renderRulesText(f.q)}</div><div class="faq-a">${renderRulesText(f.a)}</div></div>`)
    .join('');
  return `<div class="popped-faq"><h4>Rules FAQ</h4>${items}</div>`;
}

async function init() {
  allCards = (await window.api.getCards())?.cards || [];
  collection = await window.api.getCollection();
  decks = await window.api.getDecks();
  publishState = await window.api.getDeckPublishState();
  tagDb = await window.api.getTags();
  ({ groups, siteBase } = await window.api.getGroups());
  try {
    faqData = await fetch('faq-data.json').then((r) => r.json());
  } catch {
    faqData = {};
  }
  buildUniqueCards();

  if (!allCards.length) {
    el('view-list').innerHTML = '<div class="empty-state">No card data yet - open the main Eddies window and click "Refresh Card Data" first.</div>';
  }

  attachControls();
  attachTagControls();
  renderList();
}

// Collapses printings down to one row per card (grouped by cardId), since
// deckbuilding's copy-limit and Legend-uniqueness rules operate on the card
// itself (name/subtitle), not the specific art/printing - see CLAUDE.md's
// "Printings, not cards" note. The representative printing is whichever one
// you actually own copies of (falls back to the first printing otherwise),
// purely for picking which art to display - `sets` (every distinct set
// across ALL of that card's printings, not just the representative one) is
// what the Set filter/dropdown actually uses, since a card owned via e.g.
// its "Box Toppers" printing should still show up under a "Box Toppers"
// Set filter even though a different printing was picked for display art.
function buildUniqueCards() {
  const byCardId = new Map();
  for (const c of allCards) {
    if (!byCardId.has(c.cardId)) byCardId.set(c.cardId, []);
    byCardId.get(c.cardId).push(c);
  }
  uniqueCards = [...byCardId.entries()].map(([cardId, printings]) => {
    const ownedMain = printings.reduce((sum, p) => sum + getMainCount(p.id), 0);
    const rep = printings.find((p) => getMainCount(p.id) > 0) || printings[0];
    const sets = [...new Map(printings.map((p) => [p.set?.code, p.set])).values()].filter(Boolean);
    return { ...rep, cardId, ownedMain, sets };
  });
}

function getMainCount(printingId) {
  return collection[printingId]?.main || 0;
}

function cardById(cardId) {
  return uniqueCards.find((c) => c.cardId === cardId);
}

function printingById(printingId) {
  return allCards.find((p) => p.id === printingId);
}

function ownedPrintingsFor(cardId) {
  return allCards.filter((p) => p.cardId === cardId && getMainCount(p.id) > 0);
}

// Which printing's art represents a filled Legend slot: the one explicitly
// chosen via the art-variant picker (see openLegendVariants), falling back
// to the uniqueCards representative if none was recorded (e.g. an older
// saved deck from before legendPrintingIds existed).
function legendPrintingForDeck(deck, index) {
  const cardId = deck.legendCardIds[index];
  if (!cardId) return null;
  const printingId = deck.legendPrintingIds?.[index];
  return (printingId && printingById(printingId)) || cardById(cardId);
}

// A card's N deck copies don't all have to be the same printing/rarity -
// e.g. 1 Epic + 1 Iconic Other copy of the same named card. Greedily fills
// from owned printings (in whatever order allCards lists them) until `qty`
// is reached - this is just the *default* split; `getPrintingSplit` below
// lets a user-edited one (from the split picker) override it.
function defaultPrintingSplit(cardId, qty) {
  const split = {};
  let remaining = qty;
  for (const p of ownedPrintingsFor(cardId)) {
    if (remaining <= 0) break;
    const take = Math.min(getMainCount(p.id), remaining);
    if (take > 0) {
      split[p.id] = take;
      remaining -= take;
    }
  }
  return split;
}

// Returns `deck.cardPrintings[cardId]`, a {printingId: count} map that
// always sums to exactly `deck.cards[cardId]` using only printings you
// still own enough copies of - recomputing (and writing back) the default
// split whenever the stored one has gone stale (e.g. the deck quantity
// changed via the normal +/- stepper, or a printing's owned count dropped
// below what was assigned to it).
function getPrintingSplit(deck, cardId) {
  const qty = deck.cards[cardId] || 0;
  const existing = deck.cardPrintings?.[cardId];
  if (existing) {
    const sum = Object.values(existing).reduce((s, n) => s + n, 0);
    const stillValid = Object.entries(existing).every(([pid, n]) => n > 0 && n <= getMainCount(pid));
    // Copies you don't own have no printing to assign, so the split only ever
    // covers the owned ones.
    const ownedTotal = cardById(cardId)?.ownedMain || 0;
    if (stillValid && sum === Math.min(qty, ownedTotal)) return existing;
  }
  const fresh = defaultPrintingSplit(cardId, qty);
  if (!deck.cardPrintings) deck.cardPrintings = {};
  deck.cardPrintings[cardId] = fresh;
  return fresh;
}

// Expands a {printingId: count} split into an ordered array of N printing
// objects (one per physical copy) for the stacked-card tile to render -
// falls back to padding with the plain card representative if the split is
// missing/short (an older saved deck from before cardPrintings existed).
function printingsForCardEntry(deck, cardId, qty) {
  const split = getPrintingSplit(deck, cardId);
  const list = [];
  for (const [pid, n] of Object.entries(split)) {
    const p = printingById(pid);
    if (p) for (let i = 0; i < n; i++) list.push(p);
  }
  while (list.length < qty) list.push(cardById(cardId));
  return list.slice(0, qty);
}

// Which printing is "front-facing" (fully visible, on top of the stack) is
// just whichever printing's entry comes LAST in the split object -
// printingsForCardEntry() appends each printing's copies in Object.entries
// order, and viewDeckTileHtml() renders later array entries in front. So
// "make X front-facing" is normally just deleting and re-inserting X's
// entry (JS objects preserve string-key insertion order, no separate field
// needed) - but if X isn't in the split at all yet (e.g. the deck only
// runs 1 copy, currently assigned to a printing you're not looking at),
// there's nothing to reorder: instead move one copy over from whichever
// printing is currently front, onto X.
function setFrontPrinting(deck, cardId, printingId) {
  const split = getPrintingSplit(deck, cardId);
  if (printingId in split) {
    const count = split[printingId];
    delete split[printingId];
    split[printingId] = count;
  } else {
    const keys = Object.keys(split);
    const currentFrontId = keys[keys.length - 1];
    if (!currentFrontId) return;
    split[currentFrontId] -= 1;
    if (split[currentFrontId] <= 0) delete split[currentFrontId];
    split[printingId] = (split[printingId] || 0) + 1;
  }
  deck.cardPrintings[cardId] = split;
}

function legendDisplayPrinting(index) {
  return legendPrintingForDeck(draft, index);
}

function setDeckMessage(text, error) {
  deckMessage = text ? { text, error: !!error } : null;
  renderDeckMessage();
}

function renderDeckMessage() {
  const box = el('deck-message');
  if (!deckMessage) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.textContent = deckMessage.text;
  box.className = 'deck-message' + (deckMessage.error ? ' deck-message-error' : '');
}

// --- Deck legality --------------------------------------------------------

// Sums each selected Legend's printed RAM per color - that sum is the RAM
// ceiling a non-Legend card of that color must fit under (see CLAUDE.md's
// Deck Builder section / the game's official RAM rule).
function computeCeilings(deck) {
  const ceilings = {};
  for (const cardId of deck.legendCardIds) {
    if (!cardId) continue;
    const legend = cardById(cardId);
    if (!legend || !legend.color) continue;
    ceilings[legend.color] = (ceilings[legend.color] || 0) + (legend.ram || 0);
  }
  return ceilings;
}

function legendNameConflict(deck, slotIndex, candidate) {
  return deck.legendCardIds.some((id, i) => {
    if (i === slotIndex || !id) return false;
    const existing = cardById(id);
    return existing && existing.name === candidate.name;
  });
}

// Shared by the hard-block add check and the "Legal for current Legends"
// pool filter, so the two can never disagree about what counts as legal.
function cardFitsCeilings(deck, card) {
  if (!card.color) return true;
  const ceiling = computeCeilings(deck)[card.color] || 0;
  return ceiling > 0 && card.ram <= ceiling;
}

function sideQtyOf(deck, cardId) {
  return deck.sideboard?.[cardId] || 0;
}

function sideboardTotal(deck) {
  return Object.values(deck.sideboard || {}).reduce((sum, q) => sum + q, 0);
}

// Rejection reasons shared by main-deck and sideboard adds. `mainQty`/
// `sideQty` are the quantities the card WOULD have after the change, because
// the copy limit and your ownership both apply to main + sideboard combined.
function checkCardLegality(deck, card, mainQty, sideQty) {
  const total = mainQty + sideQty;
  if (total <= 0) return { ok: true };
  // Owning fewer copies than the deck uses is allowed on purpose: the deck is
  // just flagged with how many cards are missing (see deckMissing()).
  if (total > MAX_COPIES) return { ok: false, reason: `Max ${MAX_COPIES} copies of "${card.name}" across main deck + sideboard combined.` };
  if (card.color && !cardFitsCeilings(deck, card)) {
    const ceiling = computeCeilings(deck)[card.color] || 0;
    if (ceiling === 0) return { ok: false, reason: `None of your Legends provide ${card.color} RAM, so "${card.name}" can't be included.` };
    return { ok: false, reason: `"${card.name}" needs ${card.ram} ${card.color} RAM, but your Legends only provide ${ceiling}.` };
  }
  return { ok: true };
}

function canSetCardQty(deck, card, nextQty) {
  if (nextQty <= 0) return { ok: true };
  return checkCardLegality(deck, card, nextQty, sideQtyOf(deck, card.cardId));
}

function canSetSideQty(deck, card, nextQty) {
  if (nextQty <= 0) return { ok: true };
  if (card.cardType === 'Legend') return { ok: false, reason: 'Legends can\'t go in the sideboard.' };
  const others = sideboardTotal(deck) - sideQtyOf(deck, card.cardId);
  if (others + nextQty > SIDEBOARD_SIZE) return { ok: false, reason: `The sideboard is capped at ${SIDEBOARD_SIZE} cards.` };
  return checkCardLegality(deck, card, deck.cards[card.cardId] || 0, nextQty);
}

// Cards a deck uses that your Main collection doesn't cover. Main deck +
// sideboard share your owned copies; each Legend needs one. Returns
// { total, items: [{ cardId, name, need, owned, missing }] }.
function deckMissing(deck) {
  const need = {};
  for (const id of deck.legendCardIds || []) if (id) need[id] = (need[id] || 0) + 1;
  for (const [id, q] of Object.entries(deck.cards || {})) need[id] = (need[id] || 0) + q;
  for (const [id, q] of Object.entries(deck.sideboard || {})) need[id] = (need[id] || 0) + q;
  const items = [];
  for (const [cardId, n] of Object.entries(need)) {
    const card = cardById(cardId);
    if (!card) continue;
    const missing = Math.max(0, n - card.ownedMain);
    if (missing > 0) items.push({ cardId, name: card.name, need: n, owned: card.ownedMain, missing });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return { total: items.reduce((sum, i) => sum + i.missing, 0), items };
}

const missingTitle = (m) => 'Not in your Main collection: ' + m.items.map((i) => `${i.missing}x ${i.name}`).join(', ');

function deckMainCount(deck) {
  return Object.values(deck.cards).reduce((sum, q) => sum + q, 0);
}

// --- Sideboard swap plans ---------------------------------------------------
// deck.swapPlans: [{ id, name, swaps: [{ out: cardId, in: cardId, qty }] }].
// Every swap is 1-for-1 (N copies of a main-deck card out, N copies of a
// sideboard card in), so a plan can never change the deck's size - which is
// exactly how the real game works between games of a match.

function planById(deck, planId) {
  return (deck.swapPlans || []).find((p) => p.id === planId) || null;
}

// Copies of `cardId` already committed as "out" / "in" by a plan's swaps,
// optionally ignoring one swap row (the one being edited).
function planUsed(plan, kind, cardId, exceptIndex) {
  return plan.swaps.reduce((sum, s, i) => (i !== exceptIndex && s[kind] === cardId ? sum + s.qty : sum), 0);
}

// Clamps/drops swaps that no longer fit after a main-deck or sideboard
// quantity changed, so a plan can never reference copies you no longer have.
function normalizePlans(deck) {
  for (const plan of deck.swapPlans || []) {
    const outLeft = { ...deck.cards };
    const inLeft = { ...(deck.sideboard || {}) };
    plan.swaps = plan.swaps
      .map((s) => {
        const qty = Math.min(s.qty, outLeft[s.out] || 0, inLeft[s.in] || 0);
        if (qty > 0) {
          outLeft[s.out] -= qty;
          inLeft[s.in] -= qty;
        }
        return { ...s, qty };
      })
      .filter((s) => s.qty > 0);
  }
}

// The deck as it stands after a plan's swaps: new `cards` map plus per-card
// in/out counts for badges. `cardPrintings` is deep-copied because
// getPrintingSplit() writes regenerated splits back onto the deck it's given.
function applyPlan(deck, plan) {
  const cards = { ...deck.cards };
  const side = { ...(deck.sideboard || {}) };
  const inMap = {};
  const outMap = {};
  for (const s of plan?.swaps || []) {
    cards[s.out] = (cards[s.out] || 0) - s.qty;
    if (cards[s.out] <= 0) delete cards[s.out];
    cards[s.in] = (cards[s.in] || 0) + s.qty;
    // The two cards physically trade places: the swapped-out copies go to
    // the sideboard, the swapped-in copies leave it.
    side[s.in] = (side[s.in] || 0) - s.qty;
    if (side[s.in] <= 0) delete side[s.in];
    side[s.out] = (side[s.out] || 0) + s.qty;
    outMap[s.out] = (outMap[s.out] || 0) + s.qty;
    inMap[s.in] = (inMap[s.in] || 0) + s.qty;
  }
  const cardPrintings = Object.fromEntries(Object.entries(deck.cardPrintings || {}).map(([k, v]) => [k, { ...v }]));
  return { deck: { ...deck, cards, sideboard: side, cardPrintings }, inMap, outMap };
}

function computeDeckWarnings(deck) {
  const warnings = [];
  const filled = deck.legendCardIds.filter(Boolean).length;
  if (filled < LEGEND_SLOTS) warnings.push(`Missing ${LEGEND_SLOTS - filled} Legend${LEGEND_SLOTS - filled === 1 ? '' : 's'}.`);
  const total = deckMainCount(deck);
  if (total < MAIN_DECK_MIN) warnings.push(`${MAIN_DECK_MIN - total} card${MAIN_DECK_MIN - total === 1 ? '' : 's'} short of the ${MAIN_DECK_MIN}-card minimum.`);
  if (total > MAIN_DECK_MAX) warnings.push(`${total - MAIN_DECK_MAX} card${total - MAIN_DECK_MAX === 1 ? '' : 's'} over the ${MAIN_DECK_MAX}-card maximum.`);
  const side = sideboardTotal(deck);
  if (side !== SIDEBOARD_SIZE) warnings.push(`Sideboard has ${side}/${SIDEBOARD_SIZE} cards - tournament rules require exactly ${SIDEBOARD_SIZE}.`);
  return warnings;
}

function computeDeckStats(deck) {
  const entries = Object.entries(deck.cards).map(([cardId, qty]) => ({ card: cardById(cardId), qty })).filter((e) => e.card);
  const total = entries.reduce((sum, e) => sum + e.qty, 0);
  const colorCounts = {};
  const typeCounts = {};
  const ramCounts = {};
  const costCounts = {};
  let sellable = 0;
  for (const { card, qty } of entries) {
    if (card.color) colorCounts[card.color] = (colorCounts[card.color] || 0) + qty;
    typeCounts[card.cardType] = (typeCounts[card.cardType] || 0) + qty;
    const ramKey = card.ram == null ? '?' : card.ram;
    ramCounts[ramKey] = (ramCounts[ramKey] || 0) + qty;
    const costKey = card.cost == null ? '?' : Math.min(card.cost, 7);
    costCounts[costKey] = (costCounts[costKey] || 0) + qty;
    if (card.isEddiable) sellable += qty;
  }
  const filled = deck.legendCardIds.filter(Boolean).length;
  const isValid = filled === LEGEND_SLOTS && total >= MAIN_DECK_MIN && total <= MAIN_DECK_MAX;
  return {
    total,
    colorCounts,
    typeCounts,
    ramCounts,
    costCounts,
    sellable,
    unsellable: total - sellable,
    sellablePct: total ? Math.round((sellable / total) * 100) : 0,
    legendsFilled: filled,
    isValid,
    warnings: computeDeckWarnings(deck)
  };
}

// --- "My Decks" list view --------------------------------------------------

// The decks the My Decks list currently shows (search + ownership filter + sort).
function visibleDecks() {
  const q = listUiState.search.trim().toLowerCase();
  const list = Object.values(decks).filter((d) => {
    if (q) {
      const legends = (d.legendCardIds || []).map((id) => (id && cardById(id)?.displayName) || '').join(' ');
      if (!`${d.name || ''} ${legends} ${deckTagSearchText(d)}`.toLowerCase().includes(q)) return false;
    }
    if (!deckMatchesTagFilters(d)) return false;
    if (listUiState.ownership !== 'all') {
      const missing = deckMissing(d).total;
      if (listUiState.ownership === 'owned' ? missing > 0 : missing === 0) return false;
    }
    return true;
  });
  const by = {
    updated: (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''),
    name: (a, b) => (a.name || '').localeCompare(b.name || ''),
    missing: (a, b) => deckMissing(a).total - deckMissing(b).total || (b.updatedAt || '').localeCompare(a.updatedAt || '')
  };
  return list.sort(by[listUiState.sort] || by.updated);
}

function renderList() {
  const container = el('deck-grid');
  updateListFilters();
  const list = visibleDecks();
  const total = Object.keys(decks).length;
  el('deck-list-empty').hidden = list.length !== 0;
  el('deck-list-empty').textContent = total
    ? 'No decks match these filters.'
    : 'No decks saved yet. Click "New Deck" to build one from your Main set.';
  el('list-count').textContent = total ? (list.length === total ? `${total} deck${total === 1 ? '' : 's'}` : `${list.length} of ${total} decks`) : '';
  container.innerHTML = groupedListHtml(list, deckCardHtml);
  renderAiQueueBar();

  container.querySelectorAll('[data-view-deck]').forEach((btn) => {
    btn.addEventListener('click', () => openDeckView(btn.dataset.viewDeck));
  });
  container.querySelectorAll('[data-open-deck]').forEach((btn) => {
    btn.addEventListener('click', () => openDeckForEdit(btn.dataset.openDeck));
  });
  container.querySelectorAll('[data-duplicate-deck]').forEach((btn) => {
    btn.addEventListener('click', () => duplicateDeck(btn.dataset.duplicateDeck));
  });
  container.querySelectorAll('[data-ask-delete]').forEach((btn) => {
    btn.addEventListener('click', () => {
      listUiState.confirmDeleteId = btn.dataset.askDelete;
      renderList();
    });
  });
  container.querySelectorAll('[data-confirm-delete]').forEach((btn) => {
    btn.addEventListener('click', () => onDeleteDeck(btn.dataset.confirmDelete));
  });
  container.querySelectorAll('[data-cancel-delete]').forEach((btn) => {
    btn.addEventListener('click', () => {
      listUiState.confirmDeleteId = null;
      renderList();
    });
  });
  container.querySelectorAll('[data-select-deck]').forEach((checkbox) => {
    checkbox.addEventListener('click', (e) => e.stopPropagation());
    checkbox.addEventListener('change', () => {
      const id = checkbox.dataset.selectDeck;
      if (checkbox.checked) listUiState.selectedIds.add(id);
      else listUiState.selectedIds.delete(id);
      updateListToolbar();
    });
  });
  updateListToolbar();
}

function updateListToolbar() {
  const n = listUiState.selectedIds.size;
  el('prep-list-btn').disabled = n < 1;
  el('prep-list-btn').textContent = n ? `Prep List (${n})` : 'Prep List';
  el('publish-decks-btn').disabled = Object.keys(decks).length === 0;
  // "Select all" checkbox: checked = every deck, dash = some, empty = none.
  // Works on the decks currently shown, so "Fully owned" + Select all picks
  // exactly the decks you can build right now.
  const shown = visibleDecks().map((d) => d.id);
  const shownSelected = shown.filter((id) => listUiState.selectedIds.has(id)).length;
  const filtered = shown.length !== Object.keys(decks).length;
  const all = el('select-all-decks');
  all.disabled = shown.length === 0;
  all.checked = shown.length > 0 && shownSelected === shown.length;
  all.indeterminate = shownSelected > 0 && shownSelected < shown.length;
  el('select-all-label').textContent = shown.length ? `${filtered ? 'Select all shown' : 'Select all'} (${shownSelected}/${shown.length})` : 'Select all';
  el('deck-publish-status').textContent = publishState.publishedAt
    ? `Last published: ${new Date(publishState.publishedAt).toLocaleString()} · ${publishState.deckIds.length} deck${publishState.deckIds.length === 1 ? '' : 's'} live`
    : 'Nothing published yet';
}

// Publishing always replaces the whole published set with every saved deck.
async function publishDecks() {
  el('publish-decks-btn').disabled = true;
  const prevLabel = el('publish-decks-btn').textContent;
  el('publish-decks-btn').textContent = 'Publishing...';
  try {
    publishState = await window.api.publishDecks(Object.keys(decks));
    renderList();
  } catch (err) {
    alert(`Publishing decks failed: ${err.message}`);
    updateListToolbar();
  } finally {
    el('publish-decks-btn').textContent = prevLabel;
  }
}

function deckCardHtml(deck) {
  const stats = computeDeckStats(deck);
  const legendCards = Array.from({ length: LEGEND_SLOTS }, (_, i) => {
    const cardId = deck.legendCardIds[i];
    return cardId ? cardById(cardId) : null;
  });
  const legendThumbs = legendCards.map((card, i) => {
    if (!card) return '<div class="deck-card-legend-empty"></div>';
    const printing = (deck.legendPrintingIds?.[i] && printingById(deck.legendPrintingIds[i])) || card;
    return `<img class="deck-card-legend-thumb" src="${printing.imageUrl}" alt="${escapeHtml(printing.displayName)}" title="${escapeHtml(card.name)}" />`;
  }).join('');
  // "Johnny Silverhand · Judy Alvarez · ..." - first names are enough to scan by.
  const legendNames = legendCards.filter(Boolean).map((c) => c.name.split(':')[0]).join(' · ');

  const colorTotal = Object.values(stats.colorCounts).reduce((s, v) => s + v, 0) || 1;
  const colorBar = COLOR_ORDER.filter((c) => stats.colorCounts[c])
    .map((c) => `<div class="color-bar ${c}" style="flex: ${stats.colorCounts[c] / colorTotal}"></div>`)
    .join('');

  // The sideboard shows as a chip (orange when it isn't the required size)
  // instead of a red warning line (the full warning still shows in the Builder).
  const sideCount = sideboardTotal(deck);
  const sideChip =
    sideCount === 0
      ? '<span class="deck-chip deck-chip-warn" title="This deck has no sideboard yet">No Sideboard</span>'
      : sideCount !== SIDEBOARD_SIZE
        ? `<span class="deck-chip deck-chip-warn" title="Tournament rules require exactly ${SIDEBOARD_SIZE}">Side ${sideCount}/${SIDEBOARD_SIZE}</span>`
        : `<span class="deck-chip">Side ${sideCount}/${SIDEBOARD_SIZE}</span>`;
  const listWarnings = stats.warnings.filter((w) => !w.startsWith('Sideboard'));

  // Ownership tag: how many cards the deck uses that aren't in your Main set.
  const missing = deckMissing(deck);
  const hasCards = stats.total > 0 || stats.legendsFilled > 0;
  const ownFlag = missing.total
    ? `<span class="deck-flag deck-flag-missing" title="${escapeHtml(missingTitle(missing))}">&#9888; ${missing.total} not owned</span>`
    : hasCards
      ? '<span class="deck-flag deck-flag-owned" title="Every card is in your Main collection">&#10003; Fully owned</span>'
      : '';

  const isConfirming = listUiState.confirmDeleteId === deck.id;
  const isSelected = listUiState.selectedIds.has(deck.id);

  return `
    <div class="deck-card${isSelected ? ' is-selected' : ''}" data-deck-id="${deck.id}" draggable="true">
      <div class="deck-card-top">
        <input type="checkbox" class="deck-card-select" data-select-deck="${deck.id}" ${isSelected ? 'checked' : ''} title="Select for Prep List" />
        <div class="deck-card-name" title="${escapeHtml(deck.name || 'Untitled Deck')}">${escapeHtml(deck.name || 'Untitled Deck')}</div>
      </div>
      <div class="deck-card-legends">${legendThumbs}</div>
      <div class="deck-card-legend-names" title="${escapeHtml(legendNames)}">${escapeHtml(legendNames) || '&nbsp;'}</div>
      <div class="deck-card-color-bar">${colorBar}</div>
      <div class="tag-chips">${deckChipsHtml(deck)}</div>
      <div class="deck-card-meta">
        <span class="deck-chip">${stats.total}/${MAIN_DECK_MAX} cards</span>
        <span class="deck-chip">${stats.sellablePct}% sellable</span>
        ${sideChip}
      </div>
      <div class="deck-card-flags">
        ${ownFlag}
        ${aiFillButtonHtml(deck)}
        ${listWarnings.length ? `<span class="deck-card-warning">${escapeHtml(listWarnings[0])}</span>` : ''}
      </div>
      <div class="deck-card-actions">
        ${
          isConfirming
            ? `<button data-confirm-delete="${deck.id}" class="deck-danger deck-confirm">Yes, delete</button><button data-cancel-delete="${deck.id}">Cancel</button>`
            : `<button data-view-deck="${deck.id}" class="deck-primary">View</button><button data-open-deck="${deck.id}">Edit</button><button data-tags-deck="${deck.id}" title="Tags and group">Tags</button><button data-duplicate-deck="${deck.id}">Duplicate</button><button data-ask-delete="${deck.id}" class="deck-danger" title="Delete this deck">Delete</button>`
        }
      </div>
    </div>
  `;
}

async function onDeleteDeck(deckId) {
  decks = await window.api.deleteDeck(deckId);
  listUiState.confirmDeleteId = null;
  renderList();
}

function blankDraft() {
  return {
    id: `d${Date.now()}${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    description: '',
    descSections: {},
    legendCardIds: [null, null, null],
    legendPrintingIds: [null, null, null],
    sideboard: {},
    swapPlans: [],
    cards: {},
    cardPrintings: {},
    links: [],
    tags: { archetype: [], creator: [], misc: [] },
    groupId: null
  };
}

function newDeck() {
  draft = blankDraft();
  switchToBuilder();
}

function openDeckForEdit(deckId) {
  const deck = decks[deckId];
  if (!deck) return;
  draft = {
    id: deck.id,
    name: deck.name || '',
    description: deck.description || '',
    descSections: { ...(deck.descSections || {}) },
    legendCardIds: [0, 1, 2].map((i) => deck.legendCardIds?.[i] || null),
    legendPrintingIds: [0, 1, 2].map((i) => deck.legendPrintingIds?.[i] || null),
    sideboard: { ...(deck.sideboard || {}) },
    swapPlans: (deck.swapPlans || []).map((p) => ({ ...p, swaps: p.swaps.map((s) => ({ ...s })) })),
    cards: { ...(deck.cards || {}) },
    cardPrintings: Object.fromEntries(Object.entries(deck.cardPrintings || {}).map(([cardId, split]) => [cardId, { ...split }])),
    links: (deck.links || []).map((l) => ({ ...l })),
    tags: { archetype: [], creator: [], misc: [], ...JSON.parse(JSON.stringify(deck.tags || {})) },
    groupId: deck.groupId || null
  };
  switchToBuilder();
}

async function duplicateDeck(deckId) {
  const deck = decks[deckId];
  if (!deck) return;
  const copy = {
    ...blankDraft(),
    name: `${deck.name || 'Untitled Deck'} (Copy)`,
    description: deck.description || '',
    descSections: { ...(deck.descSections || {}) },
    legendCardIds: [0, 1, 2].map((i) => deck.legendCardIds?.[i] || null),
    legendPrintingIds: [0, 1, 2].map((i) => deck.legendPrintingIds?.[i] || null),
    sideboard: { ...(deck.sideboard || {}) },
    swapPlans: (deck.swapPlans || []).map((p) => ({ ...p, id: `p${Date.now()}${Math.random().toString(36).slice(2, 6)}`, swaps: p.swaps.map((s) => ({ ...s })) })),
    cards: { ...(deck.cards || {}) },
    cardPrintings: Object.fromEntries(Object.entries(deck.cardPrintings || {}).map(([cardId, split]) => [cardId, { ...split }])),
    links: (deck.links || []).map((l) => ({ ...l })),
    // a copy is never the Featured deck
    tags: JSON.parse(JSON.stringify({ archetype: [], creator: [], misc: [], ...(deck.tags || {}) })),
    groupId: deck.groupId || null
  };
  copy.tags.misc = copy.tags.misc.filter((id) => id !== FEATURED_ID);
  decks = await window.api.saveDeck(copy);
  renderList();
}

// Every top-level view (My Decks / Builder / read-only Deck View) and its
// matching header action group is toggled together through here, so adding
// a view later only means adding one more branch instead of touching every
// existing switch* function's hide/show list.
function showView(name) {
  view = name;
  el('view-list').hidden = name !== 'list';
  el('view-builder').hidden = name !== 'builder';
  el('view-deck').hidden = name !== 'view';
  el('view-prep').hidden = name !== 'prep';
  el('db-list-actions').hidden = name !== 'list';
  el('db-builder-actions').hidden = name !== 'builder';
  el('db-view-actions').hidden = name !== 'view';
  el('db-prep-actions').hidden = name !== 'prep';
}

function switchToBuilder() {
  deckMessage = null;
  showView('builder');
  buildBuilderFilterOptions();
  renderBuilder();
  takeSnapshot(); // after the first render, which lazily fills in printing splits
}

// --- Unsaved-changes tracking ------------------------------------------------
// The draft counts as dirty when it differs from how it looked when the
// Builder opened / last saved, or when it's a brand-new deck that was never
// saved but already has content (e.g. just imported).
let savedSnapshot = null;

function takeSnapshot() {
  savedSnapshot = JSON.stringify(draft);
}

function isDirty() {
  if (view !== 'builder' || !draft) return false;
  if (!decks[draft.id]) {
    const hasContent = draft.name.trim() || Object.keys(draft.cards).length || Object.keys(draft.sideboard).length || draft.legendCardIds.some(Boolean);
    return !!hasContent;
  }
  return JSON.stringify(draft) !== savedSnapshot;
}

// Resolves true when it's fine to leave the Builder (clean, saved, or the
// user chose to discard); false when they cancelled or the save failed.
async function confirmLeave() {
  if (!isDirty()) return true;
  const choice = await window.api.confirmUnsaved(draft.name);
  if (choice === 'cancel') return false;
  if (choice === 'save') return saveDraft();
  return true;
}

// Called by the main process before the whole window closes.
window.__deckBuilderDirty = () => (isDirty() ? { name: draft.name } : null);
window.__deckBuilderSave = () => saveDraft();

function backToList() {
  draft = null;
  viewingDeck = null;
  showView('list');
  renderList();
}

async function saveDraft() {
  if (!draft.name.trim()) {
    setDeckMessage('Give the deck a name before saving.', true);
    return false;
  }
  decks = await window.api.saveDeck(draft);
  takeSnapshot();
  setDeckMessage('Saved.', false);
  return true;
}

// --- Prep List (combine several decks into one physical shopping list) ----
//
// You only ever play one deck at a time, physically moving shared cards
// between decks as needed - so the number that matters for packing isn't
// the sum across selected decks, it's the max any single one of them needs.
function computePrepList(deckIds) {
  const selected = deckIds.map((id) => decks[id]).filter(Boolean);

  const legendRows = [];
  const seenLegendNames = new Set();
  for (const deck of selected) {
    deck.legendCardIds.forEach((cardId, i) => {
      if (!cardId) return;
      const card = cardById(cardId);
      if (!card || seenLegendNames.has(card.name)) return;
      seenLegendNames.add(card.name);
      legendRows.push(legendPrintingForDeck(deck, i) || card);
    });
  }

  const maxQty = {};
  const breakdown = {};
  for (const deck of selected) {
    // Physically you need main + sideboard copies on the table.
    const needs = { ...(deck.cards || {}) };
    for (const [cardId, qty] of Object.entries(deck.sideboard || {})) needs[cardId] = (needs[cardId] || 0) + qty;
    for (const [cardId, qty] of Object.entries(needs)) {
      if (qty > (maxQty[cardId] || 0)) maxQty[cardId] = qty;
      (breakdown[cardId] = breakdown[cardId] || []).push({ name: deck.name || 'Untitled Deck', qty });
    }
  }

  const cardEntries = Object.entries(maxQty)
    .map(([cardId, qty]) => ({ cardId, card: cardById(cardId), qty, breakdown: breakdown[cardId] }))
    .filter((e) => e.card)
    .sort((a, b) => COLOR_ORDER.indexOf(a.card.color) - COLOR_ORDER.indexOf(b.card.color) || a.card.name.localeCompare(b.card.name));

  const grouped = TYPE_ORDER.map((t) => ({ type: t, entries: cardEntries.filter((e) => e.card.cardType === t) })).filter((g) => g.entries.length);

  return { legendRows, grouped };
}

function openPrepView() {
  showView('prep');
  renderPrepView();
}

function renderPrepView() {
  const { legendRows, grouped } = computePrepList([...listUiState.selectedIds]);

  el('prep-legends-count').textContent = `${legendRows.length}`;
  el('prep-legends').innerHTML =
    legendRows.map((p) => viewDeckTileHtml([p], `title="${escapeHtml(p.name)}"`)).join('') || '<div class="view-deck-tile-empty">No Legends</div>';

  el('prep-card-sections').innerHTML = grouped
    .map((g) => {
      const tiles = g.entries
        .map((e) => {
          const title = `${escapeHtml(e.card.name)} - ${e.breakdown.map((b) => `${escapeHtml(b.name)}: x${b.qty}`).join(', ')}`;
          // Every stacked layer here is the *same* art (unlike a mixed-
          // rarity Deck View stack), so the usual raise-and-peek effect
          // barely reads as "more than one" - an explicit count badge is
          // the only thing that actually communicates the prep quantity.
          const badge = e.qty > 1 ? `<div class="view-deck-tile-qty-badge">x${e.qty}</div>` : '';
          return viewDeckTileHtml(Array(e.qty).fill(e.card), `title="${title}"`, null, badge);
        })
        .join('');
      return `<div class="view-deck-section"><h3>${escapeHtml(g.type)}s <span class="deck-count-badge">${g.entries.length}</span></h3><div class="view-deck-tile-grid">${tiles}</div></div>`;
    })
    .join('');
}

// --- Export (Text List format, matching cyberpunktcg.com's own deck
// exporter - "# <name>" header, then a "// <Section> (<total copies>)"
// block per Legends/Units/Gears/Programs, each card as "<qty> <Name>" or
// "<qty> <Name>: <Subtitle>" when it has one) -------------------------------

const EXPORT_SECTION_NAMES = { Unit: 'Units', Gear: 'Gears', Program: 'Programs' };

function exportCardLine(qty, card) {
  return `${qty} ${card.name}${card.subname ? `: ${card.subname}` : ''}`;
}

function exportDeckText(deck) {
  const lines = [`# ${deck.name || 'Untitled Deck'}`, ''];

  const legendPrintings = (deck.legendCardIds || []).map((cardId, i) => (cardId ? legendPrintingForDeck(deck, i) : null)).filter(Boolean);
  lines.push(`// Legends (${legendPrintings.length})`);
  for (const p of legendPrintings) lines.push(exportCardLine(1, p));
  lines.push('');

  const cardEntries = Object.entries(deck.cards || {})
    .map(([cardId, qty]) => ({ card: cardById(cardId), qty }))
    .filter((e) => e.card)
    .sort((a, b) => COLOR_ORDER.indexOf(a.card.color) - COLOR_ORDER.indexOf(b.card.color) || a.card.name.localeCompare(b.card.name));

  for (const type of TYPE_ORDER) {
    const entries = cardEntries.filter((e) => e.card.cardType === type);
    if (!entries.length) continue;
    const total = entries.reduce((s, e) => s + e.qty, 0);
    lines.push(`// ${EXPORT_SECTION_NAMES[type]} (${total})`);
    for (const e of entries) lines.push(exportCardLine(e.qty, e.card));
    lines.push('');
  }

  const sideEntries = Object.entries(deck.sideboard || {})
    .map(([cardId, qty]) => ({ card: cardById(cardId), qty }))
    .filter((e) => e.card)
    .sort((a, b) => a.card.name.localeCompare(b.card.name));
  if (sideEntries.length) {
    lines.push(`// Sideboard (${sideEntries.reduce((s, e) => s + e.qty, 0)})`);
    for (const e of sideEntries) lines.push(exportCardLine(e.qty, e.card));
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

let exportingDeck = null;

function openExportModal(deck) {
  exportingDeck = deck;
  el('export-textarea').value = exportDeckText(deck);
  el('export-message').hidden = true;
  const overlay = el('export-overlay');
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add('open'));
}

function closeExportModal() {
  const overlay = el('export-overlay');
  overlay.classList.remove('open');
  setTimeout(() => {
    if (!overlay.classList.contains('open')) overlay.hidden = true;
  }, 150);
}

function showExportMessage(text) {
  const box = el('export-message');
  box.textContent = text;
  box.hidden = false;
}

async function copyExportText() {
  try {
    await navigator.clipboard.writeText(el('export-textarea').value);
    showExportMessage('Copied to clipboard.');
  } catch (err) {
    showExportMessage(`Couldn't copy: ${err.message}`);
  }
}

function downloadExportText() {
  const name = (exportingDeck?.name || 'Untitled Deck').replace(/[<>:"/\\|?*]/g, '_');
  const blob = new Blob([el('export-textarea').value], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  showExportMessage('Downloaded.');
}

// --- Import (parses the same Text List format Export writes) ---------------

function openImportModal() {
  el('import-textarea').value = '';
  el('import-message').hidden = true;
  const overlay = el('import-overlay');
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add('open'));
  el('import-textarea').focus();
}

function closeImportModal() {
  const overlay = el('import-overlay');
  overlay.classList.remove('open');
  setTimeout(() => {
    if (!overlay.classList.contains('open')) overlay.hidden = true;
  }, 150);
}

function showImportMessage(text) {
  const box = el('import-message');
  box.textContent = text;
  box.hidden = false;
}

function importNameKey(s) {
  return s.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
}

async function runImport() {
  const text = el('import-textarea').value;
  const byKey = new Map();
  for (const c of uniqueCards) {
    byKey.set(importNameKey(c.subname ? `${c.name}: ${c.subname}` : c.name), c);
  }
  // Also accept names in other languages (e.g. French); English wins on a clash.
  const btn = el('import-run-btn');
  btn.disabled = true;
  showImportMessage('Loading card names...');
  try {
    for (const a of await window.api.getAltCardNames()) {
      const card = cardById(a.cardId);
      if (!card) continue;
      const key = importNameKey(a.subname ? `${a.name}: ${a.subname}` : a.name);
      if (!byKey.has(key)) byKey.set(key, card);
    }
  } catch {}
  btn.disabled = false;
  el('import-message').hidden = true;

  const next = blankDraft();
  const notes = [];
  const unknown = [];
  let legendIdx = 0;
  let inSideboard = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      if (!next.name) next.name = line.replace(/^#+\s*/, '').trim();
      continue;
    }
    if (line.startsWith('//')) {
      inSideboard = /sideboard/i.test(line);
      continue;
    }
    const m = line.match(/^(\d+)\s*x?\s+(.+)$/i);
    if (!m) {
      unknown.push(line);
      continue;
    }
    const qty = parseInt(m[1], 10);
    const card = byKey.get(importNameKey(m[2]));
    if (!card) {
      unknown.push(line);
      continue;
    }

    if (card.cardType === 'Legend') {
      if (legendIdx >= 3) {
        notes.push(`${card.name}: more than 3 Legends`);
      } else if (next.legendCardIds.some((id, i) => id && cardById(id)?.name === card.name)) {
        notes.push(`${card.name}: duplicate Legend`);
      } else {
        next.legendCardIds[legendIdx] = card.cardId;
        const owned = ownedPrintingsFor(card.cardId);
        next.legendPrintingIds[legendIdx] = owned[0]?.id || card.id;
        legendIdx++;
      }
      continue;
    }

    const have = next.cards[card.cardId] || 0;
    const haveSide = next.sideboard[card.cardId] || 0;
    // Main + sideboard share the 3-copy limit and your owned copies.
    const allowed = MAX_COPIES - have - haveSide;
    let take = Math.max(0, Math.min(qty, allowed));
    if (inSideboard) take = Math.min(take, Math.max(0, SIDEBOARD_SIZE - sideboardTotal(next)));
    if (take < qty) notes.push(`${card.name}: wanted ${qty}, added ${take} (3-copy limit)`);
    if (take > 0) {
      if (inSideboard) next.sideboard[card.cardId] = haveSide + take;
      else next.cards[card.cardId] = have + take;
    }
  }

  if (!next.name) next.name = 'Imported Deck';
  if (!legendIdx && !Object.keys(next.cards).length) {
    showImportMessage(unknown.length ? `Nothing recognised. Unmatched: ${unknown.slice(0, 5).join('; ')}` : 'Nothing to import.');
    return;
  }

  draft = next;
  closeImportModal();
  switchToBuilder();
  const problems = [...notes, ...unknown.map((u) => `${u}: not found`)];
  if (problems.length) {
    const shown = problems.slice(0, 6).join(' | ') + (problems.length > 6 ? ` | +${problems.length - 6} more` : '');
    setDeckMessage(`Imported with ${problems.length} issue(s): ${shown}`, true);
  } else {
    setDeckMessage('Imported. Review and Save Deck.', false);
  }
}

// --- Deck View (read-only) -------------------------------------------------

let viewPlanId = null; // which swap plan Deck View is previewing (null = the main deck, i.e. game 1)

function openDeckView(deckId) {
  const deck = decks[deckId];
  if (!deck) return;
  viewingDeck = deck;
  viewPlanId = null;
  showView('view');
  renderDeckView();
}

// The deck as currently shown in Deck View: the saved main deck, or that
// deck after the selected swap plan has been applied.
function shownViewState() {
  const plan = viewPlanId ? planById(viewingDeck, viewPlanId) : null;
  return plan ? { plan, ...applyPlan(viewingDeck, plan) } : { plan: null, deck: viewingDeck, inMap: {}, outMap: {} };
}

function swapBadgeHtml(inQty, outQty) {
  const parts = [];
  if (inQty) parts.push(`<span class="swap-badge-in">+${inQty} IN</span>`);
  if (outQty) parts.push(`<span class="swap-badge-out">${outQty} OUT</span>`);
  return parts.length ? `<div class="view-deck-tile-swap-badge">${parts.join('')}</div>` : '';
}

function renderPlanBar(base, shown) {
  const bar = el('view-deck-plans');
  const plans = base.swapPlans || [];
  if (!plans.length) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const chips = [`<button class="plan-chip ${!viewPlanId ? 'active' : ''}" data-plan="">Game 1 &middot; Main</button>`]
    .concat(
      plans.map((p) => {
        const n = p.swaps.reduce((s, x) => s + x.qty, 0);
        return `<button class="plan-chip ${viewPlanId === p.id ? 'active' : ''}" data-plan="${p.id}">&#8646; ${escapeHtml(p.name || 'Plan')} <span class="plan-chip-n">${n}</span></button>`;
      })
    )
    .join('');
  const summary = shown.plan
    ? `<div class="plan-summary">${shown.plan.swaps
        .map((s) => `<span class="plan-pair"><span class="plan-out">${escapeHtml(cardById(s.out)?.name || '?')}</span> &#8644; <span class="plan-in">${escapeHtml(cardById(s.in)?.name || '?')}</span>${s.qty > 1 ? ` &times;${s.qty}` : ''}</span>`)
        .join('')}</div>`
    : '';
  bar.innerHTML = `<div class="plan-chips">${chips}</div>${summary}`;
  bar.querySelectorAll('[data-plan]').forEach((btn) => {
    btn.addEventListener('click', () => {
      viewPlanId = btn.dataset.plan || null;
      renderDeckView();
    });
  });
}

// Which printing shows front-facing is purely cosmetic (doesn't touch
// legality or counts), so it's the one thing this read-only view saves
// immediately on its own rather than requiring "Edit Deck" first.
async function switchFrontPrinting(cardId, printingId) {
  setFrontPrinting(viewingDeck, cardId, printingId);
  decks = await window.api.saveDeck(viewingDeck);
  viewingDeck = decks[viewingDeck.id];
  renderDeckView();
}

const SELL_SEGMENTS = [
  { key: 'sellable', label: 'Sellable', color: 'var(--green)' },
  { key: 'unsellable', label: 'Unsellable', color: 'var(--red)' }
];
const TYPE_COLORS = { Unit: 'var(--cyan)', Gear: 'var(--yellow)', Program: 'var(--purple)' };
const DECK_COLOR_VARS = { Red: 'var(--color-red)', Blue: 'var(--color-blue)', Green: 'var(--color-green)', Yellow: 'var(--color-yellow)' };

// A generic conic-gradient donut: `segments` is given in a fixed display
// order (not sorted by size) - the center label/percentage always reflects
// the FIRST non-zero segment in that order, not necessarily the largest,
// so e.g. a Colors donut with more Yellow than Blue cards still centers on
// Blue if Blue comes first in COLOR_ORDER. Zero-count segments are kept out
// of the gradient/chip list but don't shift what "first" means.
function donutBlockHtml(title, segments) {
  const total = segments.reduce((s, x) => s + x.count, 0);
  const visible = segments.filter((s) => s.count > 0);
  let acc = 0;
  const stops = visible
    .map((s) => {
      const start = (acc / (total || 1)) * 100;
      acc += s.count;
      const end = (acc / (total || 1)) * 100;
      return `${s.color} ${start}% ${end}%`;
    })
    .join(', ');
  const center = visible[0] || { label: 'None', count: 0 };
  const centerPct = total ? Math.round((center.count / total) * 100) : 0;
  const chips = visible
    .map((s) => `<div class="donut-chip"><span class="donut-dot" style="background:${s.color}"></span>${escapeHtml(s.label)} <b>${s.count}</b></div>`)
    .join('');

  return `
    <div class="db-panel-block donut-block">
      <h3>${escapeHtml(title)}</h3>
      <div class="donut" style="background: ${visible.length ? `conic-gradient(${stops})` : 'var(--bg-card)'}">
        <div class="donut-hole">
          <div class="donut-pct">${centerPct}%</div>
          <div class="donut-sublabel">${escapeHtml(center.label)}</div>
          <div class="donut-count">${center.count} card${center.count === 1 ? '' : 's'}</div>
        </div>
      </div>
      <div class="donut-chips">${chips}</div>
    </div>
  `;
}

// Same bar-chart markup as the builder's RAM curve, but bucketed by `cost`
// (an Eddies/€$ play-cost stat distinct from the RAM deckbuilding
// constraint) with a fixed 0-7+ axis so the chart's shape is comparable
// across decks instead of only showing whichever costs happen to appear.
function costCurveHtml(costCounts) {
  const buckets = [0, 1, 2, 3, 4, 5, 6, 7];
  const max = Math.max(1, ...buckets.map((b) => costCounts[b] || 0));
  const cols = buckets
    .map((b) => {
      const count = costCounts[b] || 0;
      const label = b === 7 ? '7+' : String(b);
      return `<div class="ram-curve-col"><div class="ram-curve-bar" style="height: ${(count / max) * 100}%">${count > 0 ? `<span class="ram-curve-bar-count">${count}</span>` : ''}</div><div class="ram-curve-label">${label}</div></div>`;
    })
    .join('');
  return `<div class="ram-curve cost-curve">${cols}</div>`;
}

function renderDeckView() {
  const shown = shownViewState();
  const deck = shown.deck; // main deck, or main deck after the selected swap plan
  const stats = computeDeckStats(deck);
  renderPlanBar(viewingDeck, shown);

  el('view-deck-title').textContent = deck.name || 'Untitled Deck';
  el('view-deck-description').innerHTML = deckDescriptionHtml(deck);
  el('view-deck-links').innerHTML = (deck.links || [])
    .map((l) => `<button class="view-deck-link-chip" data-open-link="${escapeHtml(l.url)}">&#128279; ${escapeHtml(l.label || l.url)}</button>`)
    .join('');
  el('view-deck-links').querySelectorAll('[data-open-link]').forEach((btn) => {
    btn.addEventListener('click', () => window.api.openExternalLink(btn.dataset.openLink));
  });

  const legendPrintings = deck.legendCardIds.map((cardId, i) => (cardId ? legendPrintingForDeck(deck, i) : null));
  el('view-deck-legends-count').textContent = `${legendPrintings.filter(Boolean).length}`;
  el('view-deck-legends').innerHTML = legendPrintings
    .map((printing, i) => (printing ? viewDeckTileHtml([printing], `data-detail-index="${i}"`) : '<div class="view-deck-tile view-deck-tile-empty">No Legend</div>'))
    .join('');

  const cardEntries = Object.entries(deck.cards)
    .map(([cardId, qty]) => ({ cardId, card: cardById(cardId), qty, printings: printingsForCardEntry(deck, cardId, qty) }))
    .filter((e) => e.card)
    .sort((a, b) => COLOR_ORDER.indexOf(a.card.color) - COLOR_ORDER.indexOf(b.card.color) || a.card.name.localeCompare(b.card.name));

  // Grouped into Unit/Gear/Program sections rather than one flat list - the
  // card detail popup still pages through everything in one sequence
  // (Legends first, then each type group in TYPE_ORDER), matching the
  // order they actually appear top-to-bottom on screen. Each stack's
  // detail entry is its front-most (fully visible) printing.
  const grouped = TYPE_ORDER.map((t) => ({ type: t, entries: cardEntries.filter((e) => e.card.cardType === t) })).filter((g) => g.entries.length);

  cardDetailPrintings = [...legendPrintings.filter(Boolean), ...grouped.flatMap((g) => g.entries.map((e) => e.printings[e.printings.length - 1]))];
  const legendCount = legendPrintings.filter(Boolean).length;
  let runningIndex = legendCount;

  const inPlan = !!shown.plan;
  const mainSections = grouped
    .map((g) => {
      const tiles = g.entries
        .map((e) =>
          viewDeckTileHtml(e.printings, `data-detail-index="${runningIndex++}"`, inPlan ? null : e.cardId, inPlan ? swapBadgeHtml(shown.inMap[e.cardId], 0) : '')
        )
        .join('');
      return `<div class="view-deck-section"><h3>${escapeHtml(g.type)}s <span class="deck-count-badge">${g.entries.reduce((s, e) => s + e.qty, 0)}</span></h3><div class="view-deck-tile-grid">${tiles}</div></div>`;
    })
    .join('');

  // Sideboard: with a plan selected this is the sideboard AFTER the swap -
  // i.e. the cards that just left the main deck show up here marked OUT.
  const sideEntries = Object.entries(deck.sideboard || {})
    .map(([cardId, qty]) => ({ cardId, card: cardById(cardId), qty }))
    .filter((e) => e.card)
    .sort((a, b) => COLOR_ORDER.indexOf(a.card.color) - COLOR_ORDER.indexOf(b.card.color) || a.card.name.localeCompare(b.card.name));
  const sideTotal = sideEntries.reduce((s, e) => s + e.qty, 0);
  cardDetailPrintings.push(...sideEntries.map((e) => e.card));
  const sideTiles = sideEntries
    .map((e) =>
      viewDeckTileHtml(Array(e.qty).fill(e.card), `data-detail-index="${runningIndex++}"`, null, inPlan ? swapBadgeHtml(0, shown.outMap[e.cardId]) : '')
    )
    .join('');
  const sideSection = sideTotal
    ? `<div class="view-deck-section view-deck-side-section"><h3>Sideboard <span class="deck-count-badge ${sideTotal === SIDEBOARD_SIZE ? '' : 'deck-count-bad'}">${sideTotal}/${SIDEBOARD_SIZE}</span></h3><div class="view-deck-tile-grid">${sideTiles}</div></div>`
    : '';
  el('view-deck-card-sections').innerHTML = mainSections + sideSection;

  el('view-deck-legends').querySelectorAll('[data-detail-index]').forEach((tile) => {
    tile.addEventListener('click', () => openCardDetail(Number(tile.dataset.detailIndex)));
  });
  el('view-deck-card-sections').querySelectorAll('[data-detail-index]').forEach((tile) => {
    tile.addEventListener('click', () => openCardDetail(Number(tile.dataset.detailIndex)));
  });
  el('view-deck-card-sections').querySelectorAll('[data-switch-front]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      switchFrontPrinting(btn.dataset.switchFront, btn.dataset.switchPrinting);
    });
  });

  const statusEl = el('view-deck-status');
  statusEl.classList.toggle('invalid', !stats.isValid);
  el('view-deck-status-sub').textContent = `${stats.legendsFilled}/${LEGEND_SLOTS} Legends · ${stats.total}/${MAIN_DECK_MIN}-${MAIN_DECK_MAX} Deck · ${sideboardTotal(deck)}/${SIDEBOARD_SIZE} Side`;
  el('view-deck-status-badge').textContent = stats.isValid ? 'Valid' : 'Invalid';

  el('view-deck-cost-curve').innerHTML = costCurveHtml(stats.costCounts);

  el('view-deck-donuts').innerHTML = [
    donutBlockHtml('Sellable vs Unsellable', [
      { label: 'Sellable', count: stats.sellable, color: 'var(--green)' },
      { label: 'Unsellable', count: stats.unsellable, color: 'var(--red)' }
    ]),
    donutBlockHtml(
      'Card Types',
      TYPE_ORDER.map((t) => ({ label: t + 's', count: stats.typeCounts[t] || 0, color: TYPE_COLORS[t] }))
    ),
    donutBlockHtml(
      'Colors',
      COLOR_ORDER.map((c) => ({ label: c, count: stats.colorCounts[c] || 0, color: DECK_COLOR_VARS[c] }))
    )
  ].join('');
}

// Instead of a single image + "x3" badge, a card you run 3 copies of is
// shown as 3 actual stacked copies - the front one fully visible, the ones
// behind it raised up so just their top edge peeks out, like a small pile
// of the physical card. TILE_RAISE_PX is how far each successive copy is
// nudged up; the container's reserved height (via padding-bottom, the
// classic responsive-aspect-ratio trick) has to grow by that same amount
// per extra copy or the front copy's bottom would overlap the grid row
// below it.
const TILE_RAISE_PX = 14;
const TILE_ASPECT_PCT = (88 / 63) * 100;

// `printings` is one entry per physical copy, back-most first - so a
// mixed-rarity stack (e.g. 2 Epic + 1 Iconic Other of the same card) shows
// each copy's *actual* art peeking out, rather than repeating one
// representative printing's art `qty` times and hiding the mix.
// `switchCardId` (the card's cardId, only passed for non-Legend entries)
// enables a hover-revealed row of mini swatches for picking which printing
// shows front-facing - built from every printing you *own* (not just the
// ones currently represented in this stack), so a card you're only
// running 1 copy of still lets you pick which of your owned printings
// that copy uses. A Legend slot never has more than 1 copy, so it never
// needs this.
function viewDeckTileHtml(printings, indexAttr, switchCardId, badgeHtml) {
  const n = printings.length;
  const extra = (n - 1) * TILE_RAISE_PX;
  const layers = printings
    .map((p, i) => `<img class="view-deck-tile-layer" style="top: ${i * TILE_RAISE_PX}px; z-index: ${i + 1}" src="${p.imageUrl}" alt="${escapeHtml(p.displayName)}" loading="lazy" />`)
    .join('');

  const ownedChoices = switchCardId ? ownedPrintingsFor(switchCardId) : [];
  const frontId = printings[n - 1].id;
  const switchHtml =
    ownedChoices.length > 1
      ? `<div class="view-deck-tile-switch" style="z-index: ${n + 1}">${ownedChoices
          .map((p) => {
            const active = p.id === frontId;
            return `<button class="view-deck-tile-switch-btn ${active ? 'active' : ''}" data-switch-front="${switchCardId}" data-switch-printing="${p.id}" title="Show ${escapeHtml(p.rarity || '')} in front"><img src="${p.imageUrl}" alt="" /></button>`;
          })
          .join('')}</div>`
      : '';

  return `
    <div class="view-deck-tile" ${indexAttr} style="padding-bottom: calc(${TILE_ASPECT_PCT}% + ${extra}px)">
      ${layers}
      ${switchHtml}
      ${badgeHtml || ''}
    </div>
  `;
}

// --- Card detail popup (read-only - image, rules text, FAQ; no bucket
// counters, unlike the main app's popup, since this is browsing a saved
// deck rather than editing collection ownership) ----------------------------

function openCardDetail(index) {
  const printing = cardDetailPrintings[index];
  if (!printing) return;
  cardDetailIndex = index;

  el('card-detail-img').src = printing.imageUrl;
  el('card-detail-img').alt = printing.displayName;
  el('card-detail-name').textContent = printing.name;
  el('card-detail-subname').textContent = printing.subname || '';
  el('card-detail-subname').hidden = !printing.subname;

  const meta = [
    printing.cost != null ? `Cost ${printing.cost}` : '',
    printing.power != null ? `Power ${printing.power}` : '',
    printing.ram != null ? `RAM ${printing.ram}` : '',
    printing.cardType
  ]
    .filter(Boolean)
    .join(' · ');
  el('card-detail-meta').textContent = meta;

  const rarityEl = el('card-detail-rarity');
  rarityEl.textContent = printing.rarity || '';
  rarityEl.className = `popped-rarity ${rarityClass(printing.rarity)}`;

  el('card-detail-rules').innerHTML = renderRulesText(printing.rulesText);
  el('card-detail-faq').innerHTML = faqHtml(printing.slug);

  const overlay = el('card-detail-overlay');
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add('open'));
}

function stepCardDetail(delta) {
  if (!cardDetailPrintings.length) return;
  const next = (cardDetailIndex + delta + cardDetailPrintings.length) % cardDetailPrintings.length;
  openCardDetail(next);
}

function closeCardDetail() {
  const overlay = el('card-detail-overlay');
  overlay.classList.remove('open');
  setTimeout(() => {
    if (!overlay.classList.contains('open')) overlay.hidden = true;
  }, 200);
}

// --- Test Hand --------------------------------------------------------

function buildDeckDrawPool(deck) {
  const pool = [];
  for (const [cardId, qty] of Object.entries(deck.cards)) {
    const card = cardById(cardId);
    if (!card) continue;
    for (let i = 0; i < qty; i++) pool.push(card);
  }
  return pool;
}

function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function openTestHand() {
  // Draws from whatever Deck View is showing - so picking a swap plan first
  // lets you goldfish the post-board deck.
  const pool = shuffled(buildDeckDrawPool(shownViewState().deck));
  const handSize = Math.min(6, pool.length);
  testHandState = { hand: pool.slice(0, handSize), deckPool: pool.slice(handSize), mulliganUsed: false };
  renderTestHand();
  const overlay = el('test-hand-overlay');
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add('open'));
}

function closeTestHand() {
  const overlay = el('test-hand-overlay');
  overlay.classList.remove('open');
  setTimeout(() => {
    if (!overlay.classList.contains('open')) overlay.hidden = true;
  }, 200);
}

// The real game allows exactly one mulligan: shuffle your whole hand back
// into what's left of the deck, then draw a fresh 6.
function mulliganTestHand() {
  if (testHandState.mulliganUsed) return;
  const combined = shuffled([...testHandState.hand, ...testHandState.deckPool]);
  const handSize = Math.min(6, combined.length);
  testHandState = { hand: combined.slice(0, handSize), deckPool: combined.slice(handSize), mulliganUsed: true };
  renderTestHand();
}

function drawOneTestHand() {
  if (!testHandState.deckPool.length) return;
  testHandState.hand.push(testHandState.deckPool.shift());
  renderTestHand();
}

function renderTestHand() {
  el('test-hand-count-hand').textContent = `${testHandState.hand.length} in hand`;
  el('test-hand-count-deck').textContent = `${testHandState.deckPool.length} in deck`;
  el('test-hand-grid').innerHTML = testHandState.hand
    .map((c) => `<img class="test-hand-card" src="${c.imageUrl}" alt="${escapeHtml(c.displayName)}" loading="lazy" />`)
    .join('');
  el('test-hand-mulligan-btn').disabled = testHandState.mulliganUsed;
  el('test-hand-draw-btn').disabled = testHandState.deckPool.length === 0;
}

// --- Deck description (structured, collapsible, @card tags) ---------------
// deck.descSections = { key: text }, where text may contain @[Card Name]
// tokens (a card's displayName). Duplicated read-only in docs/decks.js.
// A legacy free-form deck.description (raw HTML) still renders above them.

const DESC_SECTIONS = [
  { title: 'Overview', open: true, cls: '', fields: [{ key: 'overview', ph: 'Pitch: how the deck wins' }] },
  {
    title: 'Game Plan',
    cls: '',
    fields: [
      { key: 'early', label: 'Early', ph: 'Turns 1-3' },
      { key: 'mid', label: 'Mid', ph: 'Build the board' },
      { key: 'late', label: 'Late', ph: 'Close the game' }
    ]
  },
  { title: 'Key Cards', cls: 'dd-combo', fields: [{ key: 'combos', ph: '@Card: why it matters, @Card + @Card combos' }] },
  {
    title: 'Mulligan',
    cls: '',
    fields: [
      { key: 'mulligan', label: 'Keep / toss', ph: 'What makes an opening hand a keep' },
      { key: 'mulliganFirst', label: 'Going first', ph: 'What to look for / how the opening goes on the play' },
      { key: 'mulliganSecond', label: 'Going second', ph: 'What to look for / how the opening goes on the draw' }
    ]
  },
  { title: 'Sideboard', cls: 'dd-side', fields: [{ key: 'sideboard', ph: 'Swap @Card for @Card when...' }] },
  { title: 'Notes', cls: '', fields: [{ key: 'notes', ph: 'Anything else' }] }
];

function renderDescTags(text) {
  return escapeHtml(text).replace(/@\[([^\]|]+)(?:\|([^\]]+))?\]/g, (_, name, alias) => `<span class="card-tag" data-card-tag="${name}">${alias || name}</span>`);
}

// One line per idea: a single line is a paragraph, several become a bullet
// list. Sections with several fields (Game Plan, Mulligan) get a label column.
// Duplicated in docs/decks.js.
function ddLinesHtml(text) {
  const lines = String(text || '').split(/\n+/).map((l) => l.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean);
  if (!lines.length) return '';
  if (lines.length === 1) return `<p>${renderDescTags(lines[0])}</p>`;
  return `<ul>${lines.map((l) => `<li>${renderDescTags(l)}</li>`).join('')}</ul>`;
}

function ddBodyHtml(sec, s) {
  if (sec.fields.length === 1) return ddLinesHtml(s[sec.fields[0].key]);
  return sec.fields
    .filter((f) => (s[f.key] || '').trim())
    .map((f) => `<div class="dd-row"><span class="dd-label">${f.label}</span><div class="dd-text">${ddLinesHtml(s[f.key])}</div></div>`)
    .join('');
}

function deckDescriptionHtml(deck) {
  const s = deck.descSections || {};
  const sections = DESC_SECTIONS.map((sec, i) => {
    const body = ddBodyHtml(sec, s);
    if (!body.trim()) return '';
    return `<details class="${sec.cls}" ${sec.open ? 'open' : ''}><summary>${sec.title}</summary><div class="dd-body">${body}</div></details>`;
  }).join('');
  // Legacy raw-HTML description: the deck author's own markup in their own
  // local decks.json, so it's rendered as-is on purpose.
  return (deck.description ? `<div class="dd-legacy">${deck.description}</div>` : '') + sections;
}

function updateDescSummary() {
  const s = draft.descSections || {};
  const filled = DESC_SECTIONS.filter((sec) => sec.fields.some((f) => (s[f.key] || '').trim())).length;
  el('deck-description-summary').textContent = filled || draft.description ? `${filled}/${DESC_SECTIONS.length} sections filled` : 'Empty - click to add';
}

// Which description sections are expanded in the editor (indexes into
// DESC_SECTIONS, or 'legacy'). Kept across re-renders so filling a field or an
// AI draft doesn't snap panels shut.
const descOpen = new Set([0, 1]);

// Textareas grow with their content, so there's no resize handle to fight.
function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + 2}px`;
}

function descSectionFilled(sec) {
  const s = draft.descSections || {};
  return sec.fields.some((f) => (s[f.key] || '').trim());
}

// One-line preview shown on a collapsed panel header.
function descPreview(sec) {
  const s = draft.descSections || {};
  const text = sec.fields.map((f) => (s[f.key] || '').trim()).find(Boolean) || '';
  return text.replace(/@\[([^\]|]+)(?:\|([^\]]+))?\]/g, (_, n, a) => a || n).replace(/\s+/g, ' ').slice(0, 110);
}

function refreshDescHeads() {
  el('desc-fields').querySelectorAll('[data-desc-sec]').forEach((group) => {
    const sec = DESC_SECTIONS[Number(group.dataset.descSec)];
    if (!sec) return;
    group.querySelector('.desc-dot').classList.toggle('filled', descSectionFilled(sec));
    group.querySelector('.desc-preview').textContent = descPreview(sec);
  });
}

function setDescGroupOpen(group, open) {
  const key = group.dataset.descSec === 'legacy' ? 'legacy' : Number(group.dataset.descSec);
  if (open) descOpen.add(key);
  else descOpen.delete(key);
  group.classList.toggle('open', open);
  group.querySelector('.desc-group-head').setAttribute('aria-expanded', String(open));
  group.querySelector('.desc-group-body').hidden = !open;
  if (open) group.querySelectorAll('textarea').forEach(autoGrow);
}

function openDescEditor() {
  const s = draft.descSections;
  const legacy = draft.description
    ? `<div class="desc-group${descOpen.has('legacy') ? ' open' : ''}" data-desc-sec="legacy">
        <button type="button" class="desc-group-head" aria-expanded="${descOpen.has('legacy')}"><span class="desc-caret"></span><span class="desc-group-title">Legacy HTML (old format)</span><span class="desc-dot filled"></span><span class="desc-preview"></span></button>
        <div class="desc-group-body" ${descOpen.has('legacy') ? '' : 'hidden'}><div class="desc-field"><textarea data-desc-legacy class="desc-legacy-input" rows="4">${escapeHtml(draft.description)}</textarea></div></div>
      </div>`
    : '';
  el('desc-fields').innerHTML =
    legacy +
    DESC_SECTIONS.map((sec, i) => {
      const open = descOpen.has(i);
      const fields = sec.fields
        .map(
          (f) => `<div class="desc-field">${f.label ? `<label>${f.label}</label>` : ''}<textarea data-desc-key="${f.key}" placeholder="${escapeHtml(f.ph)}" rows="2">${escapeHtml(s[f.key] || '')}</textarea></div>`
        )
        .join('');
      return `<div class="desc-group${open ? ' open' : ''}" data-desc-sec="${i}">
        <button type="button" class="desc-group-head" aria-expanded="${open}"><span class="desc-caret"></span><span class="desc-group-title">${sec.title}</span><span class="desc-dot${descSectionFilled(sec) ? ' filled' : ''}" title="Filled in"></span><span class="desc-preview">${escapeHtml(descPreview(sec))}</span></button>
        <div class="desc-group-body" ${open ? '' : 'hidden'}>${fields}</div>
      </div>`;
    }).join('');

  el('desc-fields').querySelectorAll('.desc-group').forEach((group) => {
    group.querySelector('.desc-group-head').addEventListener('click', () => setDescGroupOpen(group, !group.classList.contains('open')));
  });
  el('desc-fields').querySelectorAll('textarea').forEach((ta) => {
    ta.addEventListener('input', () => {
      if ('descLegacy' in ta.dataset) draft.description = ta.value;
      else draft.descSections[ta.dataset.descKey] = ta.value;
      autoGrow(ta);
      updateDescSummary();
      refreshDescHeads();
      descAutocomplete(ta);
    });
    ta.addEventListener('keydown', (e) => descAcKey(e));
    ta.addEventListener('blur', () => setTimeout(() => (el('desc-ac').hidden = true), 150));
  });
  const overlay = el('desc-overlay');
  overlay.hidden = false;
  // Size the boxes once the overlay is laid out (scrollHeight is 0 while hidden).
  requestAnimationFrame(() => {
    overlay.classList.add('open');
    el('desc-fields').querySelectorAll('.desc-group.open textarea').forEach(autoGrow);
  });
}

function closeDescEditor() {
  const overlay = el('desc-overlay');
  el('desc-ac').hidden = true;
  overlay.classList.remove('open');
  setTimeout(() => {
    if (!overlay.classList.contains('open')) overlay.hidden = true;
  }, 150);
}

// --- AI draft ----------------------------------------------------------------
// The main process (src/ai.js) holds the API key and makes the call; this
// side only builds the payload from the draft and merges the result in.

function aiPayload(deck = draft) {
  const slim = (c, qty) => ({
    qty,
    cardId: c.cardId,
    displayName: c.displayName,
    cardType: c.cardType,
    color: c.color,
    cost: c.cost,
    power: c.power,
    ram: c.ram,
    isEddiable: c.isEddiable,
    classifications: c.classifications,
    rulesText: c.rulesText
  });
  const listOf = (map) =>
    Object.entries(map || {})
      .map(([cardId, qty]) => ({ card: cardById(cardId), qty }))
      .filter((e) => e.card && e.qty > 0)
      .map((e) => slim(e.card, e.qty));
  const nameOf = (cardId) => cardById(cardId)?.displayName || cardId;
  const stats = computeDeckStats(deck);
  return {
    id: deck.id,
    name: deck.name,
    legends: deck.legendCardIds.filter(Boolean).map((id) => slim(cardById(id), 0)),
    cards: listOf(deck.cards),
    sideboard: listOf(deck.sideboard),
    swapPlans: (deck.swapPlans || []).map((p) => ({ name: p.name, swaps: p.swaps.map((s) => ({ out: nameOf(s.out), in: nameOf(s.in), qty: s.qty })) })),
    stats: { total: stats.total, colors: stats.colorCounts, types: stats.typeCounts, ram: stats.ramCounts, cost: stats.costCounts }
  };
}

function setAiStatus(text, isError) {
  const s = el('ai-status');
  s.textContent = text;
  s.classList.toggle('error', !!isError);
}

async function refreshAiKeyUi() {
  const status = await window.api.aiKeyStatus();
  const has = status === 'ok';
  const badge = el('ai-key-badge');
  badge.className = `ai-key-badge ${status}`;
  badge.textContent = has ? 'API key saved' : status === 'unreadable' ? 'API key unreadable - re-enter' : 'No API key';
  el('ai-key-btn').textContent = has ? 'Change key' : 'Set API key';
  el('ai-key-clear').hidden = !has;
  el('ai-draft-btn').disabled = !has;
  el('ai-draft-btn').title = has ? '' : 'Set your Anthropic API key first';
  el('ai-build-btn').disabled = !has;
  const k = await window.api.aiKnowledgeStatus();
  const cardsDone = k.total > 0 && k.studied >= k.total;
  const done = cardsDone && k.playbook;
  const mark = (ok) => (ok ? '✓' : '✗');
  el('ai-knowledge').textContent = k.total
    ? `Cards ${mark(cardsDone)} ${k.studied}/${k.total}   |   Rules playbook ${mark(k.playbook)}`
    : 'No card data loaded yet';
  el('ai-knowledge').classList.toggle('ok', !!done);
  el('ai-build-btn').textContent = done ? 'Knowledge up to date' : !cardsDone && k.studied ? 'Continue studying cards' : cardsDone ? 'Build rules playbook' : 'Build knowledge';
  el('ai-build-btn').disabled = !has || done;
  return has;
}

async function runBuildKnowledge() {
  el('ai-build-btn').disabled = true;
  el('ai-draft-btn').disabled = true;
  setAiStatus('Starting...');
  const res = await window.api.buildAiKnowledge();
  setAiStatus(res.ok ? 'Knowledge built.' : res.error, !res.ok);
  await refreshAiKeyUi();
}

// Merges AI sections into a descSections map: empty sections only, unless
// `overwrite`. Returns how many sections were written.
function mergeAiSections(target, aiSections, overwrite) {
  let filled = 0;
  for (const [key, text] of Object.entries(aiSections)) {
    if (!text) continue;
    if (!overwrite && (target[key] || '').trim()) continue;
    target[key] = text;
    filled++;
  }
  return filled;
}

let aiBusy = false;

async function runAiDraft() {
  if (aiBusy) {
    setAiStatus('A draft is already running for another deck - wait for it to finish.', true);
    return;
  }
  if (draft.legendCardIds.filter(Boolean).length === 0 || Object.keys(draft.cards).length === 0) {
    setAiStatus('Add a Legend and some cards first.', true);
    return;
  }
  // The draft takes a while and you may leave this deck meanwhile, so remember
  // which deck it is for and what the checkbox said when you clicked.
  const target = draft;
  const targetId = draft.id;
  const overwrite = el('ai-overwrite').checked;
  const btn = el('ai-draft-btn');
  aiBusy = true;
  btn.disabled = true;
  setAiStatus('Starting...');
  let res;
  try {
    res = await window.api.analyzeDeck(aiPayload());
  } finally {
    aiBusy = false;
    btn.disabled = false;
  }
  if (!res.ok) {
    setAiStatus(res.error, true);
    return;
  }
  // Still on this deck (or reopened it): fill the editor you're looking at.
  if (draft && (draft === target || (targetId && draft.id === targetId))) {
    const filled = mergeAiSections(draft.descSections, res.sections, overwrite);
    DESC_SECTIONS.forEach((sec, i) => {
      if (sec.fields.some((f) => res.sections[f.key])) descOpen.add(i);
    });
    updateDescSummary();
    openDescEditor();
    setAiStatus(filled ? `Drafted ${filled} section${filled === 1 ? '' : 's'} - review and edit before saving.` : 'Nothing to fill (turn on "Overwrite filled sections" to replace).');
    return;
  }
  // You moved on. Never touch whatever deck is open now. A saved deck gets the
  // draft written onto its saved copy (so the work isn't lost); an unsaved new
  // deck has nowhere to keep it.
  const saved = targetId && decks[targetId];
  if (!saved) {
    setAiStatus('Draft finished, but that deck was never saved - open it again to redo.', true);
    return;
  }
  const sections = { ...(saved.descSections || {}) };
  if (!mergeAiSections(sections, res.sections, overwrite)) return;
  decks = await window.api.saveDeck({ ...saved, descSections: sections });
  if (view === 'list') renderList();
  setAiStatus(`Draft for "${saved.name || 'Untitled'}" finished in the background and was saved.`);
}

let descAc = { ta: null, start: 0, items: [], sel: 0 };

function descAutocomplete(ta) {
  const m = /@([^@\[\]\n]*)$/.exec(ta.value.slice(0, ta.selectionStart));
  const box = el('desc-ac');
  if (!m) {
    box.hidden = true;
    return;
  }
  const q = m[1].toLowerCase();
  const inDeck = (c) => (draft.cards[c.cardId] || 0) > 0 || draft.legendCardIds.includes(c.cardId);
  const items = uniqueCards
    .filter((c) => c.displayName.toLowerCase().includes(q))
    .sort((a, b) => inDeck(b) - inDeck(a) || a.displayName.localeCompare(b.displayName))
    .slice(0, 8);
  if (!items.length) {
    box.hidden = true;
    return;
  }
  descAc = { ta, start: ta.selectionStart - m[0].length, items, sel: 0 };
  const r = ta.getBoundingClientRect();
  box.style.left = `${r.left}px`;
  box.style.top = `${r.bottom + 2}px`;
  box.innerHTML = items.map((c, i) => `<div data-i="${i}" class="${i === 0 ? 'on' : ''}">${escapeHtml(c.displayName)}${inDeck(c) ? ' <span class="desc-ac-tag">in deck</span>' : ''}</div>`).join('');
  box.querySelectorAll('div').forEach((d) =>
    d.addEventListener('mousedown', (e) => {
      e.preventDefault();
      pickDescCard(Number(d.dataset.i));
    })
  );
  box.hidden = false;
}

function pickDescCard(i) {
  const { ta, start, items } = descAc;
  const pos = ta.selectionStart;
  ta.value = `${ta.value.slice(0, start)}@[${items[i].displayName}] ${ta.value.slice(pos)}`;
  const caret = start + items[i].displayName.length + 4;
  ta.setSelectionRange(caret, caret);
  draft.descSections[ta.dataset.descKey] = ta.value;
  el('desc-ac').hidden = true;
  updateDescSummary();
}

function descAcKey(e) {
  const box = el('desc-ac');
  if (box.hidden) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = descAc.items.length;
    descAc.sel = (descAc.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    box.querySelectorAll('div').forEach((d, i) => d.classList.toggle('on', i === descAc.sel));
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    pickDescCard(descAc.sel);
  } else if (e.key === 'Escape') {
    e.stopPropagation();
    box.hidden = true;
  }
}

function onCardTagHover(e) {
  const pop = el('card-tag-pop');
  const tag = e.target.closest?.('[data-card-tag]');
  const card = tag && uniqueCards.find((c) => c.displayName === tag.dataset.cardTag);
  if (!card) {
    pop.hidden = true;
    return;
  }
  const img = pop.querySelector('img');
  if (img.getAttribute('src') !== card.imageUrl) img.src = card.imageUrl;
  pop.hidden = false;
  pop.style.left = `${Math.min(e.clientX + 16, innerWidth - 250)}px`;
  pop.style.top = `${Math.max(8, Math.min(e.clientY - 150, innerHeight - 330))}px`;
}

// --- Builder view -----------------------------------------------------

function renderBuilder() {
  el('deck-name-input').value = draft.name;
  updateDescSummary();
  renderDeckMessage();
  renderLegendRow();
  renderCeilingStrip();
  renderCardPool();
  renderDeckCardsList();
  renderSideboardList();
  renderPlansEditor();
  renderLinksList();
  renderDeckStats();
  updateTagsSummary();
}

function renderLegendRow() {
  el('legend-row').innerHTML = draft.legendCardIds
    .map((cardId, i) => {
      const card = cardId && cardById(cardId);
      if (!card) {
        return `<div class="legend-slot" data-legend-slot="${i}"><span>+ Add Legend</span></div>`;
      }
      const printing = legendDisplayPrinting(i);
      const hasVariants = ownedPrintingsFor(cardId).length > 1;
      return `
        <div class="legend-slot filled">
          <img src="${printing.imageUrl}" alt="${escapeHtml(printing.displayName)}" />
          <button class="legend-slot-remove" data-remove-legend="${i}" title="Remove">&#10005;</button>
          ${hasVariants ? `<button class="legend-slot-change" data-change-legend="${i}" title="Choose a different art/printing you own">&#8635; Art</button>` : ''}
          <div class="legend-slot-name">${escapeHtml(card.name)}</div>
        </div>
      `;
    })
    .join('');

  el('legend-row').querySelectorAll('[data-legend-slot]').forEach((slot) => {
    slot.addEventListener('click', () => openLegendPicker(Number(slot.dataset.legendSlot)));
  });
  el('legend-row').querySelectorAll('[data-remove-legend]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const i = Number(btn.dataset.removeLegend);
      draft.legendCardIds[i] = null;
      draft.legendPrintingIds[i] = null;
      renderBuilder();
    });
  });
  el('legend-row').querySelectorAll('[data-change-legend]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openLegendVariantPicker(Number(btn.dataset.changeLegend));
    });
  });
}

function renderCeilingStrip() {
  const ceilings = computeCeilings(draft);
  el('ceiling-strip').innerHTML = COLOR_ORDER.map((c) => `<span>${c}: <span class="ceiling-pip color-text-${c}">${ceilings[c] || 0}</span> RAM</span>`).join('');
}

function buildBuilderFilterOptions() {
  const pool = uniqueCards.filter((c) => c.cardType !== 'Legend');
  const colors = [...new Set(pool.map((c) => c.color).filter(Boolean))].sort((a, b) => COLOR_ORDER.indexOf(a) - COLOR_ORDER.indexOf(b));
  const types = [...new Set(pool.map((c) => c.cardType).filter(Boolean))].sort((a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b));
  const rarities = [...new Set(pool.map((c) => c.rarity).filter(Boolean))].sort((a, b) => RARITY_ORDER.indexOf(a) - RARITY_ORDER.indexOf(b));
  const setMap = new Map();
  for (const c of pool) {
    for (const s of c.sets) setMap.set(s.code, s);
  }
  const sets = [...setMap.values()].sort((a, b) => a.name.localeCompare(b.name));

  renderChipGroup('db-color-filters', colors, builderState.colors);
  renderChipGroup('db-type-filters', types, builderState.types);
  renderChipGroup('db-rarity-filters', rarities, builderState.rarities);

  const setSelect = el('db-set-filter');
  setSelect.innerHTML = '<option value="all">All Sets</option>' + sets.map((s) => `<option value="${s.code}">${s.name}</option>`).join('');
  setSelect.value = builderState.set;
}

function renderChipGroup(containerId, values, activeSet) {
  const container = el(containerId);
  container.innerHTML = values.map((v) => `<div class="chip" data-value="${v}">${v}</div>`).join('');
  container.querySelectorAll('.chip').forEach((chip) => {
    if (activeSet.has(chip.dataset.value)) chip.classList.add('active');
    chip.addEventListener('click', () => {
      const val = chip.dataset.value;
      if (activeSet.has(val)) activeSet.delete(val);
      else activeSet.add(val);
      chip.classList.toggle('active');
      renderCardPool();
    });
  });
}

function getFilteredPoolCards() {
  return uniqueCards
    .filter((c) => c.cardType !== 'Legend')
    .filter((c) => {
      if (builderState.search) {
        const q = builderState.search.toLowerCase();
        if (!`${c.name} ${c.subname || ''}`.toLowerCase().includes(q)) return false;
      }
      if (builderState.colors.size && !builderState.colors.has(c.color)) return false;
      if (builderState.types.size && !builderState.types.has(c.cardType)) return false;
      if (builderState.rarities.size && !builderState.rarities.has(c.rarity)) return false;
      if (builderState.set !== 'all' && !c.sets.some((s) => s.code === builderState.set)) return false;
      if (builderState.decklistOnly) return (draft.cards[c.cardId] || 0) + sideQtyOf(draft, c.cardId) > 0;
      if (builderState.ownership === 'owned' && c.ownedMain === 0) return false;
      if (builderState.legalOnly && !cardFitsCeilings(draft, c)) return false;
      return true;
    })
    .sort((a, b) => COLOR_ORDER.indexOf(a.color) - COLOR_ORDER.indexOf(b.color) || TYPE_ORDER.indexOf(a.cardType) - TYPE_ORDER.indexOf(b.cardType) || a.name.localeCompare(b.name));
}

function renderCardPool() {
  const cards = getFilteredPoolCards();
  el('db-result-count').textContent = `${cards.length} card${cards.length === 1 ? '' : 's'}`;
  el('decklist-toggle').classList.toggle('active', builderState.decklistOnly);
  el('db-card-grid').innerHTML = cards.map(cardPoolTileHtml).join('');

  el('db-card-grid').querySelectorAll('[data-qty-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cardId = btn.dataset.cardId;
      const card = cardById(cardId);
      const current = draft.cards[cardId] || 0;
      const next = btn.dataset.qtyAction === 'inc' ? current + 1 : current - 1;
      applyQty(card, next);
    });
  });
  el('db-card-grid').querySelectorAll('[data-side-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = cardById(btn.dataset.cardId);
      const current = sideQtyOf(draft, card.cardId);
      applySideQty(card, btn.dataset.sideAction === 'inc' ? current + 1 : current - 1);
    });
  });
}

function cardPoolTileHtml(card) {
  const qty = draft.cards[card.cardId] || 0;
  const side = sideQtyOf(draft, card.cardId);
  const maxQty = Math.max(0, MAX_COPIES - side);
  const incCheck = canSetCardQty(draft, card, qty + 1);
  const sideInc = canSetSideQty(draft, card, side + 1);
  const sideMax = Math.max(0, MAX_COPIES - qty);
  const missingNow = Math.max(0, qty + side - card.ownedMain);
  return `
    <div class="db-card-tile">
      <img src="${card.imageUrl}" alt="${escapeHtml(card.displayName)}" loading="lazy" />
      <div class="db-card-tile-info">
        <div class="db-card-tile-name" title="${escapeHtml(card.name)}">${escapeHtml(card.name)}</div>
        <div class="db-card-tile-meta">
          <span>${card.color || ''} · RAM ${card.ram ?? '-'}</span>
          <span class="rarity-pip ${rarityClass(card.rarity)}">${card.rarity || ''}</span>
        </div>
        <div class="db-card-tile-owned">Owned: ${card.ownedMain}${missingNow ? ` <span class="db-missing-tag" title="Copies this deck uses that you don't own in Main">need ${missingNow} more</span>` : ''}</div>
        <div class="db-qty-row">
          <button data-qty-action="dec" data-card-id="${card.cardId}" ${qty <= 0 ? 'disabled' : ''}>-</button>
          <span class="db-qty-value">${qty} / ${maxQty || 0}</span>
          <button data-qty-action="inc" data-card-id="${card.cardId}" ${qty >= maxQty || !incCheck.ok ? 'disabled' : ''} title="${qty >= maxQty || !incCheck.ok ? escapeHtml(incCheck.ok ? 'Copy limit reached' : incCheck.reason) : ''}">+</button>
        </div>
        <div class="db-qty-row db-side-row" title="Sideboard copies (main + side share the 3-copy limit)">
          <button data-side-action="dec" data-card-id="${card.cardId}" ${side <= 0 ? 'disabled' : ''}>-</button>
          <span class="db-qty-value">Side ${side} / ${sideMax}</span>
          <button data-side-action="inc" data-card-id="${card.cardId}" ${!sideInc.ok || side >= sideMax ? 'disabled' : ''} title="${!sideInc.ok ? escapeHtml(sideInc.reason) : ''}">+</button>
        </div>
      </div>
    </div>
  `;
}

function applyQty(card, nextQty) {
  const clamped = Math.max(0, nextQty);
  const check = canSetCardQty(draft, card, clamped);
  if (!check.ok) {
    setDeckMessage(check.reason, true);
    return;
  }
  if (clamped === 0) {
    delete draft.cards[card.cardId];
    delete draft.cardPrintings[card.cardId];
  } else {
    draft.cards[card.cardId] = clamped;
  }
  normalizePlans(draft);
  setDeckMessage(null);
  renderBuilder();
}

function applySideQty(card, nextQty) {
  const clamped = Math.max(0, nextQty);
  const check = canSetSideQty(draft, card, clamped);
  if (!check.ok) {
    setDeckMessage(check.reason, true);
    return;
  }
  if (clamped === 0) delete draft.sideboard[card.cardId];
  else draft.sideboard[card.cardId] = clamped;
  normalizePlans(draft);
  setDeckMessage(null);
  renderBuilder();
}

// Moving a copy between main and sideboard never changes the combined count,
// so ownership / copy-limit / RAM legality are unchanged - only the
// sideboard's 7-card cap can block it.
function moveCopy(cardId, toSide) {
  const card = cardById(cardId);
  if (!card) return;
  if (toSide) {
    if (!(draft.cards[cardId] > 0)) return;
    if (sideboardTotal(draft) >= SIDEBOARD_SIZE) {
      setDeckMessage(`The sideboard is capped at ${SIDEBOARD_SIZE} cards.`, true);
      return;
    }
    draft.cards[cardId] -= 1;
    if (draft.cards[cardId] <= 0) {
      delete draft.cards[cardId];
      delete draft.cardPrintings[cardId];
    }
    draft.sideboard[cardId] = (draft.sideboard[cardId] || 0) + 1;
  } else {
    if (!(draft.sideboard[cardId] > 0)) return;
    draft.sideboard[cardId] -= 1;
    if (draft.sideboard[cardId] <= 0) delete draft.sideboard[cardId];
    draft.cards[cardId] = (draft.cards[cardId] || 0) + 1;
  }
  normalizePlans(draft);
  setDeckMessage(null);
  renderBuilder();
}

function renderDeckCardsList() {
  const entries = Object.entries(draft.cards)
    .map(([cardId, qty]) => ({ card: cardById(cardId), qty }))
    .filter((e) => e.card)
    .sort((a, b) => COLOR_ORDER.indexOf(a.card.color) - COLOR_ORDER.indexOf(b.card.color) || a.card.name.localeCompare(b.card.name));

  const total = entries.reduce((s, e) => s + e.qty, 0);
  const badge = el('deck-count-badge');
  badge.textContent = `${total}/${MAIN_DECK_MAX}`;
  badge.className = 'deck-count-badge ' + (total < MAIN_DECK_MIN || total > MAIN_DECK_MAX ? 'deck-count-bad' : 'deck-count-ok');

  const list = el('deck-cards-list');
  if (!entries.length) {
    list.innerHTML = '<div class="deck-cards-empty">No cards added yet.</div>';
    return;
  }
  list.innerHTML = entries
    .map((e) => {
      const hasVariants = ownedPrintingsFor(e.card.cardId).length > 1;
      const rarities = splitRarities(draft, e.card.cardId);
      return `
    <div class="deck-card-row">
      <div class="deck-card-row-color color-bar ${e.card.color || ''}"></div>
      <div class="deck-card-row-name" title="${escapeHtml(e.card.name)}">${escapeHtml(e.card.name)}</div>
      ${rarities.length > 1 ? `<div class="deck-card-row-mixed" title="${escapeHtml(rarities.join(' + '))}">${escapeHtml(rarities.join('+'))}</div>` : ''}
      ${(() => {
        const miss = Math.max(0, e.qty + sideQtyOf(draft, e.card.cardId) - e.card.ownedMain);
        return miss ? `<div class="deck-card-row-missing" title="You own ${e.card.ownedMain} in Main">need ${miss}</div>` : '';
      })()}
      <div class="deck-card-row-qty">x${e.qty}</div>
      ${hasVariants ? `<button class="deck-card-row-art" data-split-card="${e.card.cardId}" title="Choose which printing(s) represent these copies">&#8635;</button>` : ''}
      <button class="deck-card-row-move" data-to-side="${e.card.cardId}" title="Move one copy to the sideboard">&#8681; Side</button>
      <button data-dec-card="${e.card.cardId}" title="Remove one">-</button>
    </div>
  `;
    })
    .join('');

  list.querySelectorAll('[data-to-side]').forEach((btn) => {
    btn.addEventListener('click', () => moveCopy(btn.dataset.toSide, true));
  });
  list.querySelectorAll('[data-dec-card]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = cardById(btn.dataset.decCard);
      applyQty(card, (draft.cards[card.cardId] || 0) - 1);
    });
  });
  list.querySelectorAll('[data-split-card]').forEach((btn) => {
    btn.addEventListener('click', () => openPrintingSplit(btn.dataset.splitCard));
  });
}

function renderSideboardList() {
  const entries = Object.entries(draft.sideboard)
    .map(([cardId, qty]) => ({ card: cardById(cardId), qty }))
    .filter((e) => e.card)
    .sort((a, b) => COLOR_ORDER.indexOf(a.card.color) - COLOR_ORDER.indexOf(b.card.color) || a.card.name.localeCompare(b.card.name));
  const total = sideboardTotal(draft);
  const badge = el('side-count-badge');
  badge.textContent = `${total}/${SIDEBOARD_SIZE}`;
  badge.className = 'deck-count-badge ' + (total === SIDEBOARD_SIZE ? 'deck-count-ok' : 'deck-count-bad');

  const list = el('sideboard-list');
  if (!entries.length) {
    list.innerHTML = `<div class="deck-cards-empty">No sideboard yet. Use the Side +/- on a card, or "&#8681; Side" in the Deck List. Tournament rules: exactly ${SIDEBOARD_SIZE} cards, no Legends.</div>`;
    return;
  }
  list.innerHTML = entries
    .map(
      (e) => `
    <div class="deck-card-row">
      <div class="deck-card-row-color color-bar ${e.card.color || ''}"></div>
      <div class="deck-card-row-name" title="${escapeHtml(e.card.name)}">${escapeHtml(e.card.name)}</div>
      <div class="deck-card-row-qty">x${e.qty}</div>
      <button class="deck-card-row-move" data-to-main="${e.card.cardId}" title="Move one copy to the main deck">&#8679; Main</button>
      <button data-dec-side="${e.card.cardId}" title="Remove one">-</button>
    </div>`
    )
    .join('');
  list.querySelectorAll('[data-to-main]').forEach((btn) => btn.addEventListener('click', () => moveCopy(btn.dataset.toMain, false)));
  list.querySelectorAll('[data-dec-side]').forEach((btn) =>
    btn.addEventListener('click', () => applySideQty(cardById(btn.dataset.decSide), sideQtyOf(draft, btn.dataset.decSide) - 1))
  );
}

// --- Swap plans editor ----------------------------------------------------
// A plan is a named list of 1-for-1 swaps (e.g. "vs Blue": 2x Riot Shield in
// for 2x Mantis Blades out). Because every swap pairs equal quantities, a
// plan can't unbalance the deck - the editor only offers copies that are
// still unassigned in that plan.

function planOptionsHtml(cardIds, selected, leftFn) {
  return cardIds
    .map((id) => {
      const card = cardById(id);
      if (!card) return '';
      const left = leftFn(id);
      return `<option value="${id}" ${id === selected ? 'selected' : ''} ${left < 1 && id !== selected ? 'disabled' : ''}>${escapeHtml(card.name)} (${left} left)</option>`;
    })
    .join('');
}

function renderPlansEditor() {
  const box = el('swap-plans');
  const hasSide = sideboardTotal(draft) > 0;
  el('add-plan-btn').disabled = !hasSide;
  if (!draft.swapPlans.length) {
    box.innerHTML = `<div class="deck-cards-empty">${hasSide ? 'No swap plans yet. A plan is what you swap between games, e.g. "vs Blue".' : 'Add sideboard cards first, then build swap plans.'}</div>`;
    return;
  }
  const mainIds = Object.keys(draft.cards);
  const sideIds = Object.keys(draft.sideboard);
  box.innerHTML = draft.swapPlans
    .map((plan) => {
      const rows = plan.swaps
        .map((s, i) => {
          const outLeft = (id) => (draft.cards[id] || 0) - planUsed(plan, 'out', id, i);
          const inLeft = (id) => (draft.sideboard[id] || 0) - planUsed(plan, 'in', id, i);
          const maxQty = Math.max(1, Math.min(outLeft(s.out), inLeft(s.in)));
          return `
          <div class="swap-row" data-plan="${plan.id}" data-swap="${i}">
            <select class="swap-out" title="Leaves the main deck">${planOptionsHtml(mainIds, s.out, outLeft)}</select>
            <span class="swap-arrow">&#8644;</span>
            <select class="swap-in" title="Comes in from the sideboard">${planOptionsHtml(sideIds, s.in, inLeft)}</select>
            <input class="swap-qty" type="number" min="1" max="${maxQty}" value="${s.qty}" />
            <button data-del-swap title="Remove swap">&#10005;</button>
          </div>`;
        })
        .join('');
      const count = plan.swaps.reduce((sum, s) => sum + s.qty, 0);
      return `
      <div class="swap-plan" data-plan-id="${plan.id}">
        <div class="swap-plan-head">
          <input class="swap-plan-name" value="${escapeHtml(plan.name)}" placeholder="Plan name (e.g. vs Blue)" />
          <span class="swap-plan-count" title="Cards swapped (deck size stays the same)">&#8646; ${count}</span>
          <button data-del-plan title="Delete plan">&#10005;</button>
        </div>
        ${rows}
        <button class="btn btn-block swap-add-btn" data-add-swap>+ Add swap</button>
      </div>`;
    })
    .join('');

  box.querySelectorAll('.swap-plan').forEach((planEl) => {
    const plan = planById(draft, planEl.dataset.planId);
    planEl.querySelector('.swap-plan-name').addEventListener('input', (e) => {
      plan.name = e.target.value;
    });
    planEl.querySelector('[data-del-plan]').addEventListener('click', () => {
      draft.swapPlans = draft.swapPlans.filter((p) => p.id !== plan.id);
      renderPlansEditor();
    });
    planEl.querySelector('[data-add-swap]').addEventListener('click', () => addSwap(plan));
    planEl.querySelectorAll('.swap-row').forEach((rowEl) => {
      const i = Number(rowEl.dataset.swap);
      const s = plan.swaps[i];
      const commit = (patch) => {
        const next = { ...s, ...patch };
        const outLeft = (draft.cards[next.out] || 0) - planUsed(plan, 'out', next.out, i);
        const inLeft = (draft.sideboard[next.in] || 0) - planUsed(plan, 'in', next.in, i);
        const maxQty = Math.min(outLeft, inLeft);
        if (maxQty < 1) {
          setDeckMessage('No copies left to swap with that card in this plan.', true);
        } else {
          next.qty = Math.max(1, Math.min(next.qty, maxQty));
          plan.swaps[i] = next;
          setDeckMessage(null);
        }
        renderPlansEditor();
      };
      rowEl.querySelector('.swap-out').addEventListener('change', (e) => commit({ out: e.target.value }));
      rowEl.querySelector('.swap-in').addEventListener('change', (e) => commit({ in: e.target.value }));
      rowEl.querySelector('.swap-qty').addEventListener('change', (e) => commit({ qty: Number(e.target.value) || 1 }));
      rowEl.querySelector('[data-del-swap]').addEventListener('click', () => {
        plan.swaps.splice(i, 1);
        renderPlansEditor();
      });
    });
  });
}

function addSwap(plan) {
  const outId = Object.keys(draft.cards).find((id) => (draft.cards[id] || 0) - planUsed(plan, 'out', id) > 0);
  const inId = Object.keys(draft.sideboard).find((id) => (draft.sideboard[id] || 0) - planUsed(plan, 'in', id) > 0);
  if (!outId || !inId) {
    setDeckMessage('Every sideboard copy (or main-deck copy) is already used in this plan.', true);
    return;
  }
  plan.swaps.push({ out: outId, in: inId, qty: 1 });
  setDeckMessage(null);
  renderPlansEditor();
}

function addPlan() {
  const plan = { id: `p${Date.now()}${Math.random().toString(36).slice(2, 6)}`, name: `Plan ${draft.swapPlans.length + 1}`, swaps: [] };
  draft.swapPlans.push(plan);
  addSwap(plan);
  renderPlansEditor();
}

// Short label(s) for a card's current printing split, e.g. ["Epic"] for a
// uniform stack or ["Epic", "Iconic Other"] for a mixed one - used to flag
// mixed-rarity stacks in the Deck List instead of silently only showing one
// rarity for the whole group.
function splitRarities(deck, cardId) {
  const split = getPrintingSplit(deck, cardId);
  return [...new Set(Object.keys(split).map((pid) => printingById(pid)?.rarity).filter(Boolean))];
}

function renderLinksList() {
  const sel = el('link-creator-select');
  const keep = sel.value;
  sel.innerHTML = '<option value="">Channel: none</option>' + tagsInCat('creator').map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  sel.value = keep;
  const list = el('deck-links-list');
  if (!draft.links.length) {
    list.innerHTML = '<div class="deck-links-empty">No reference links yet.</div>';
    return;
  }
  list.innerHTML = draft.links
    .map(
      (l, i) => `
    <div class="deck-link-row">
      <a data-open-link="${escapeHtml(l.url)}" title="${escapeHtml(l.url)}">${l.creatorId && tagOf(l.creatorId) ? `&#9654; ${escapeHtml(tagOf(l.creatorId).name)} - ` : ''}${escapeHtml(l.label || l.url)}</a>
      <button data-remove-link="${i}" title="Remove">&#10005;</button>
    </div>
  `
    )
    .join('');

  list.querySelectorAll('[data-open-link]').forEach((a) => {
    a.addEventListener('click', () => window.api.openExternalLink(a.dataset.openLink));
  });
  list.querySelectorAll('[data-remove-link]').forEach((btn) => {
    btn.addEventListener('click', () => {
      draft.links.splice(Number(btn.dataset.removeLink), 1);
      renderLinksList();
      updateTagsSummary();
    });
  });
}

function addLink() {
  const label = el('link-label-input').value.trim();
  const url = el('link-url-input').value.trim();
  if (!/^https?:\/\//i.test(url)) {
    setDeckMessage('Reference links need a full http:// or https:// URL.', true);
    return;
  }
  draft.links.push({ label: label || url, url, ...(el('link-creator-select').value ? { creatorId: el('link-creator-select').value } : {}) });
  updateTagsSummary();
  el('link-label-input').value = '';
  el('link-url-input').value = '';
  setDeckMessage(null);
  renderLinksList();
}

function renderDeckStats() {
  const stats = computeDeckStats(draft);
  const colorTotal = Object.values(stats.colorCounts).reduce((s, v) => s + v, 0) || 1;
  const colorBar = COLOR_ORDER.filter((c) => stats.colorCounts[c])
    .map((c) => `<div class="deck-stat-bar-seg color-bar ${c}" style="flex: ${stats.colorCounts[c] / colorTotal}" title="${c}: ${stats.colorCounts[c]}"></div>`)
    .join('');

  const ramKeys = Object.keys(stats.ramCounts).sort((a, b) => Number(a) - Number(b));
  const maxRamCount = Math.max(1, ...Object.values(stats.ramCounts));
  const ramCurve = ramKeys
    .map((k) => `<div class="ram-curve-col"><div class="ram-curve-bar" style="height: ${(stats.ramCounts[k] / maxRamCount) * 100}%"><span class="ram-curve-bar-count">${stats.ramCounts[k]}</span></div><div class="ram-curve-label">${k}</div></div>`)
    .join('');

  const typeRows = TYPE_ORDER.filter((t) => stats.typeCounts[t])
    .map((t) => `<div class="deck-stat-row"><span>${t}</span><span>${stats.typeCounts[t]}</span></div>`)
    .join('');

  el('deck-stats').innerHTML = `
    <div class="deck-stat-row"><span>Main deck size</span><span>${stats.total} / ${MAIN_DECK_MIN}-${MAIN_DECK_MAX}</span></div>
    <div class="deck-stat-bar">${colorBar || ''}</div>
    ${typeRows}
    <div class="deck-stat-row"><span>Sellable (€$)</span><span>${stats.sellablePct}%</span></div>
    <div>
      <div class="deck-stat-row"><span>RAM curve</span><span></span></div>
      <div class="ram-curve">${ramCurve || ''}</div>
    </div>
    ${(() => {
      const m = deckMissing(draft);
      return m.total
        ? `<div class="deck-stat-missing" title="${escapeHtml(missingTitle(m))}">${m.total} card${m.total === 1 ? '' : 's'} not in your collection</div>`
        : stats.total ? '<div class="deck-stat-owned">Every card is in your collection</div>' : '';
    })()}
    ${stats.warnings.map((w) => `<div class="deck-stat-warning">${escapeHtml(w)}</div>`).join('')}
  `;
}

// --- Legend picker modal -------------------------------------------------

function openLegendPicker(slotIndex) {
  legendPicker = { open: true, slotIndex, search: '', ownership: 'owned', variantFor: null };
  el('legend-picker-search').value = '';
  el('legend-picker-ownership').value = 'owned';
  renderLegendPicker();
  const overlay = el('legend-picker-overlay');
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add('open'));
}

// Reopens the picker already zoomed into the art-variant view for the
// Legend already sitting in this slot, so "Change Art" doesn't force you
// to re-pick the same Legend from the full list first.
function openLegendVariantPicker(slotIndex) {
  const cardId = draft.legendCardIds[slotIndex];
  legendPicker = { open: true, slotIndex, search: '', ownership: 'owned', variantFor: cardId };
  el('legend-picker-search').value = '';
  el('legend-picker-ownership').value = 'owned';
  renderLegendPicker();
  const overlay = el('legend-picker-overlay');
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add('open'));
}

function closeLegendPicker() {
  const overlay = el('legend-picker-overlay');
  overlay.classList.remove('open');
  legendPicker.open = false;
  setTimeout(() => {
    if (!overlay.classList.contains('open')) overlay.hidden = true;
  }, 150);
}

function renderLegendPicker() {
  const filtersRow = el('legend-picker-filters');
  const variantHeader = el('legend-picker-variant-header');

  if (legendPicker.variantFor) {
    filtersRow.hidden = true;
    variantHeader.hidden = false;
    const card = cardById(legendPicker.variantFor);
    el('legend-picker-variant-title').textContent = card ? `Choose the printing of "${card.name}" to use` : '';

    const printings = ownedPrintingsFor(legendPicker.variantFor).sort((a, b) => (a.set?.name || '').localeCompare(b.set?.name || ''));
    el('legend-picker-grid').innerHTML = printings
      .map(
        (p) => `
      <div class="legend-picker-tile" data-pick-printing="${p.id}">
        <img src="${p.imageUrl}" alt="${escapeHtml(p.displayName)}" loading="lazy" />
        <div class="legend-picker-tile-name">${escapeHtml(p.rarity || '')}<br><span style="color:var(--text-dim);font-weight:400">${escapeHtml(p.set?.name || '')}</span></div>
      </div>
    `
      )
      .join('');

    el('legend-picker-grid').querySelectorAll('[data-pick-printing]').forEach((tile) => {
      tile.addEventListener('click', () => finalizeLegendSelection(legendPicker.variantFor, tile.dataset.pickPrinting));
    });
    return;
  }

  filtersRow.hidden = false;
  variantHeader.hidden = true;

  const pool = uniqueCards
    .filter((c) => c.cardType === 'Legend')
    .filter((c) => (legendPicker.ownership === 'owned' ? c.ownedMain > 0 : true))
    .filter((c) => (legendPicker.search ? `${c.name} ${c.subname || ''}`.toLowerCase().includes(legendPicker.search.toLowerCase()) : true))
    .sort((a, b) => a.name.localeCompare(b.name) || (a.subname || '').localeCompare(b.subname || ''));

  el('legend-picker-grid').innerHTML = pool
    .map(
      (c) => `
    <div class="legend-picker-tile" data-pick-legend="${c.cardId}">
      <img src="${c.imageUrl}" alt="${escapeHtml(c.displayName)}" loading="lazy" />
      <div class="legend-picker-tile-name">${escapeHtml(c.name)}${c.subname ? `<br><span style="color:var(--text-dim);font-weight:400">${escapeHtml(c.subname)}</span>` : ''}</div>
      ${ownedPrintingsFor(c.cardId).length > 1 ? '<div class="legend-picker-tile-variants">Multiple printings owned</div>' : ''}
    </div>
  `
    )
    .join('');

  el('legend-picker-grid').querySelectorAll('[data-pick-legend]').forEach((tile) => {
    tile.addEventListener('click', () => onLegendTileClick(tile.dataset.pickLegend));
  });
}

// Picking a Legend from the full list: checked for name-uniqueness first,
// then either finalized directly (one owned printing) or handed off to the
// art-variant view (multiple owned printings of the same card - e.g. an
// Epic Retail copy and a Nova Rare Box Toppers copy of the same Legend).
function onLegendTileClick(cardId) {
  const candidate = cardById(cardId);
  if (!candidate) return;
  if (legendNameConflict(draft, legendPicker.slotIndex, candidate)) {
    setDeckMessage(`You already have a Legend named "${candidate.name}" - Legends must have unique names.`, true);
    return;
  }
  const owned = ownedPrintingsFor(cardId);
  if (owned.length > 1) {
    legendPicker.variantFor = cardId;
    renderLegendPicker();
    return;
  }
  // Not owned: use the card's representative art; the deck is flagged as missing it.
  finalizeLegendSelection(cardId, owned[0]?.id || candidate.id);
}

function finalizeLegendSelection(cardId, printingId) {
  draft.legendCardIds[legendPicker.slotIndex] = cardId;
  draft.legendPrintingIds[legendPicker.slotIndex] = printingId;
  setDeckMessage(null);
  closeLegendPicker();
  renderBuilder();
}

// --- Printing split picker -------------------------------------------------
//
// Unlike a Legend (max 1 copy, so it's a single choice of art), a regular
// card can have up to 3 copies, and each copy can independently be a
// different owned printing (e.g. 2 Epic + 1 Iconic Other of the same
// card). This picker lets you redistribute the card's fixed deck quantity
// across its owned printings - each row's own stepper is capped at that
// printing's owned count, and the "+" buttons across the whole picker are
// capped so the total never exceeds the card's deck quantity (you free up
// room by decrementing another printing first, rather than the total
// silently growing past what you actually added to the deck).

let printingSplitCardId = null;

function openPrintingSplit(cardId) {
  printingSplitCardId = cardId;
  renderPrintingSplit();
  const overlay = el('printing-split-overlay');
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add('open'));
}

function closePrintingSplit() {
  const overlay = el('printing-split-overlay');
  overlay.classList.remove('open');
  setTimeout(() => {
    if (!overlay.classList.contains('open')) overlay.hidden = true;
  }, 150);
}

function renderPrintingSplit() {
  const cardId = printingSplitCardId;
  const card = cardById(cardId);
  const qty = draft.cards[cardId] || 0;
  const split = getPrintingSplit(draft, cardId);
  const owned = ownedPrintingsFor(cardId);
  const sum = Object.values(split).reduce((s, n) => s + n, 0);

  el('printing-split-title').textContent = `Choose printings for "${card.name}"`;
  el('printing-split-total').textContent = `Assigned: ${sum} / ${qty}`;

  el('printing-split-rows').innerHTML = owned
    .map((p) => {
      const count = split[p.id] || 0;
      const ownedCount = getMainCount(p.id);
      // Not blocked by `sum >= qty` - once every copy is already assigned,
      // "+" on a different printing borrows one from whichever printing
      // currently holds it (see adjustPrintingSplit), so switching a
      // single-copy card between printings is still a single click instead
      // of a hidden "decrement the other one first" step.
      const incDisabled = count >= ownedCount;
      return `
      <div class="printing-split-row">
        <img src="${p.imageUrl}" alt="${escapeHtml(p.displayName)}" />
        <div class="printing-split-row-info">
          <div>${escapeHtml(p.rarity || '')}</div>
          <div class="printing-split-row-set">${escapeHtml(p.set?.name || '')} · Owned: ${ownedCount}</div>
        </div>
        <div class="db-qty-row">
          <button data-split-dec="${p.id}" ${count <= 0 ? 'disabled' : ''}>-</button>
          <span class="db-qty-value">${count}</span>
          <button data-split-inc="${p.id}" ${incDisabled ? 'disabled' : ''}>+</button>
        </div>
      </div>`;
    })
    .join('');

  el('printing-split-rows').querySelectorAll('[data-split-inc]').forEach((btn) => {
    btn.addEventListener('click', () => adjustPrintingSplit(btn.dataset.splitInc, 1));
  });
  el('printing-split-rows').querySelectorAll('[data-split-dec]').forEach((btn) => {
    btn.addEventListener('click', () => adjustPrintingSplit(btn.dataset.splitDec, -1));
  });
}

function adjustPrintingSplit(printingId, delta) {
  const cardId = printingSplitCardId;
  const split = getPrintingSplit(draft, cardId);
  const qty = draft.cards[cardId] || 0;

  if (delta > 0) {
    const ownedCount = getMainCount(printingId);
    const current = split[printingId] || 0;
    if (current >= ownedCount) return;
    const sum = Object.values(split).reduce((s, n) => s + n, 0);
    if (sum >= qty) {
      // Every copy is already assigned somewhere, so freeing a slot means
      // taking one from an existing printing - with 3+ options, "which
      // one?" needs a deterministic answer. Same rule setFrontPrinting()
      // uses: take from whichever printing is currently front-facing (the
      // last key in the split), i.e. "the one you're currently looking at"
      // is what gets swapped out, not an arbitrary/insertion-order pick.
      const keys = Object.keys(split);
      const donorId = [...keys].reverse().find((pid) => pid !== printingId && split[pid] > 0);
      if (!donorId) return;
      split[donorId] -= 1;
      if (split[donorId] <= 0) delete split[donorId];
    }
    split[printingId] = current + 1;
  } else {
    const next = Math.max(0, (split[printingId] || 0) - 1);
    if (next === 0) delete split[printingId];
    else split[printingId] = next;
  }

  draft.cardPrintings[cardId] = split;
  renderPrintingSplit();
  renderDeckCardsList();
}

// --- Wiring ---------------------------------------------------------------

function attachControls() {
  el('win-minimize').addEventListener('click', () => window.api.windowMinimize());
  el('win-maximize').addEventListener('click', () => window.api.windowToggleMaximize());
  el('win-close').addEventListener('click', () => window.api.windowClose());
  el('close-btn').addEventListener('click', async () => {
    if (await confirmLeave()) window.api.overlayClose();
  });

  el('new-deck-btn').addEventListener('click', newDeck);
  el('import-deck-btn').addEventListener('click', openImportModal);
  el('import-close').addEventListener('click', closeImportModal);
  el('import-overlay').addEventListener('click', (e) => {
    if (e.target === el('import-overlay')) closeImportModal();
  });
  el('import-run-btn').addEventListener('click', runImport);
  el('back-to-list-btn').addEventListener('click', async () => {
    if (await confirmLeave()) backToList();
  });
  el('save-deck-btn').addEventListener('click', () => saveDraft());
  el('builder-export-btn').addEventListener('click', () => openExportModal(draft));

  el('export-close').addEventListener('click', closeExportModal);
  el('export-overlay').addEventListener('click', (e) => {
    if (e.target === el('export-overlay')) closeExportModal();
  });
  el('export-copy-btn').addEventListener('click', copyExportText);
  el('export-download-btn').addEventListener('click', downloadExportText);

  el('list-search').addEventListener('input', (e) => {
    listUiState.search = e.target.value;
    renderList();
  });
  el('list-ownership').addEventListener('change', (e) => {
    listUiState.ownership = e.target.value;
    renderList();
  });
  el('list-sort').addEventListener('change', (e) => {
    listUiState.sort = e.target.value;
    renderList();
  });
  el('select-all-decks').addEventListener('change', (e) => {
    for (const d of visibleDecks()) {
      if (e.target.checked) listUiState.selectedIds.add(d.id);
      else listUiState.selectedIds.delete(d.id);
    }
    renderList();
  });
  el('prep-list-btn').addEventListener('click', openPrepView);
  el('prep-back-to-list-btn').addEventListener('click', backToList);
  el('publish-decks-btn').addEventListener('click', publishDecks);

  el('deck-name-input').addEventListener('input', (e) => {
    draft.name = e.target.value;
  });
  el('add-plan-btn').addEventListener('click', addPlan);
  el('decklist-toggle').addEventListener('click', () => {
    builderState.decklistOnly = !builderState.decklistOnly;
    renderCardPool();
  });
  el('deck-description-btn').addEventListener('click', () => {
    setAiStatus('');
    el('ai-key-row').hidden = true;
    refreshAiKeyUi();
    openDescEditor();
  });
  el('ai-draft-btn').addEventListener('click', runAiDraft);
  el('ai-build-btn').addEventListener('click', runBuildKnowledge);
  window.api.onAiProgress((msg) => setAiStatus(msg));
  el('ai-key-btn').addEventListener('click', () => {
    el('ai-key-row').hidden = !el('ai-key-row').hidden;
    if (!el('ai-key-row').hidden) el('ai-key-input').focus();
  });
  el('ai-key-save').addEventListener('click', async () => {
    await window.api.setAiKey(el('ai-key-input').value);
    el('ai-key-input').value = '';
    el('ai-key-row').hidden = true;
    refreshAiKeyUi();
  });
  el('ai-key-clear').addEventListener('click', async () => {
    await window.api.setAiKey('');
    refreshAiKeyUi();
  });
  el('desc-close').addEventListener('click', closeDescEditor);
  el('desc-overlay').addEventListener('click', (e) => {
    if (e.target === el('desc-overlay')) closeDescEditor();
  });
  document.addEventListener('mousemove', onCardTagHover);

  el('db-search-input').addEventListener('input', (e) => {
    builderState.search = e.target.value;
    renderCardPool();
  });
  el('db-ownership-filter').addEventListener('change', (e) => {
    builderState.ownership = e.target.value;
    renderCardPool();
  });
  el('db-legal-only-filter').addEventListener('change', (e) => {
    builderState.legalOnly = e.target.checked;
    renderCardPool();
  });
  el('db-set-filter').addEventListener('change', (e) => {
    builderState.set = e.target.value;
    renderCardPool();
  });

  el('add-link-btn').addEventListener('click', addLink);

  el('legend-picker-close').addEventListener('click', closeLegendPicker);
  el('legend-picker-overlay').addEventListener('click', (e) => {
    if (e.target === el('legend-picker-overlay')) closeLegendPicker();
  });
  el('legend-picker-search').addEventListener('input', (e) => {
    legendPicker.search = e.target.value;
    renderLegendPicker();
  });
  el('legend-picker-ownership').addEventListener('change', (e) => {
    legendPicker.ownership = e.target.value;
    renderLegendPicker();
  });
  el('legend-picker-back').addEventListener('click', () => {
    legendPicker.variantFor = null;
    renderLegendPicker();
  });

  el('view-back-to-list-btn').addEventListener('click', backToList);
  el('view-edit-deck-btn').addEventListener('click', () => openDeckForEdit(viewingDeck.id));
  el('view-export-btn').addEventListener('click', () => openExportModal(viewingDeck));
  el('view-test-hand-btn').addEventListener('click', openTestHand);

  el('card-detail-overlay').addEventListener('click', (e) => {
    if (e.target === el('card-detail-overlay')) closeCardDetail();
  });
  el('card-detail-prev').addEventListener('click', (e) => {
    e.stopPropagation();
    stepCardDetail(-1);
  });
  el('card-detail-next').addEventListener('click', (e) => {
    e.stopPropagation();
    stepCardDetail(1);
  });

  el('test-hand-close').addEventListener('click', closeTestHand);
  el('test-hand-overlay').addEventListener('click', (e) => {
    if (e.target === el('test-hand-overlay')) closeTestHand();
  });
  el('test-hand-mulligan-btn').addEventListener('click', mulliganTestHand);
  el('test-hand-draw-btn').addEventListener('click', drawOneTestHand);
  el('test-hand-reset-btn').addEventListener('click', openTestHand);

  el('printing-split-close').addEventListener('click', closePrintingSplit);
  el('printing-split-overlay').addEventListener('click', (e) => {
    if (e.target === el('printing-split-overlay')) closePrintingSplit();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && legendPicker.open) closeLegendPicker();
    if (el('card-detail-overlay').classList.contains('open')) {
      if (e.key === 'Escape') closeCardDetail();
      if (e.key === 'ArrowLeft') stepCardDetail(-1);
      if (e.key === 'ArrowRight') stepCardDetail(1);
    }
    if (e.key === 'Escape' && el('test-hand-overlay').classList.contains('open')) closeTestHand();
    if (e.key === 'Escape' && el('printing-split-overlay').classList.contains('open')) closePrintingSplit();
    if (e.key === 'Escape' && el('desc-overlay').classList.contains('open') && el('desc-ac').hidden) closeDescEditor();
    if (e.key === 'Escape' && el('export-overlay').classList.contains('open')) closeExportModal();
    if (e.key === 'Escape' && el('import-overlay').classList.contains('open')) closeImportModal();
  });
}

init();
