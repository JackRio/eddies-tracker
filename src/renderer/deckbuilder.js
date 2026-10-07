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
let listUiState = { confirmDeleteId: null, selectedIds: new Set() };
let publishState = { deckIds: [], publishedAt: null }; // which decks are currently live on the website
let builderState = {
  search: '',
  colors: new Set(),
  types: new Set(),
  rarities: new Set(),
  set: 'all',
  ownership: 'owned',
  legalOnly: true
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
    if (stillValid && sum === qty) return existing;
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

function canSetCardQty(deck, card, nextQty) {
  if (nextQty <= 0) return { ok: true };
  if (nextQty > card.ownedMain) {
    return { ok: false, reason: `You only own ${card.ownedMain} cop${card.ownedMain === 1 ? 'y' : 'ies'} of "${card.name}" in Main.` };
  }
  if (nextQty > 3) return { ok: false, reason: 'A deck can only run up to 3 copies of the same card.' };
  if (card.color && !cardFitsCeilings(deck, card)) {
    const ceiling = computeCeilings(deck)[card.color] || 0;
    if (ceiling === 0) return { ok: false, reason: `None of your Legends provide ${card.color} RAM, so "${card.name}" can't be included.` };
    return { ok: false, reason: `"${card.name}" needs ${card.ram} ${card.color} RAM, but your Legends only provide ${ceiling}.` };
  }
  return { ok: true };
}

function deckMainCount(deck) {
  return Object.values(deck.cards).reduce((sum, q) => sum + q, 0);
}

function computeDeckWarnings(deck) {
  const warnings = [];
  const filled = deck.legendCardIds.filter(Boolean).length;
  if (filled < LEGEND_SLOTS) warnings.push(`Missing ${LEGEND_SLOTS - filled} Legend${LEGEND_SLOTS - filled === 1 ? '' : 's'}.`);
  const total = deckMainCount(deck);
  if (total < MAIN_DECK_MIN) warnings.push(`${MAIN_DECK_MIN - total} card${MAIN_DECK_MIN - total === 1 ? '' : 's'} short of the ${MAIN_DECK_MIN}-card minimum.`);
  if (total > MAIN_DECK_MAX) warnings.push(`${total - MAIN_DECK_MAX} card${total - MAIN_DECK_MAX === 1 ? '' : 's'} over the ${MAIN_DECK_MAX}-card maximum.`);
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

function renderList() {
  const container = el('deck-grid');
  const list = Object.values(decks).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  el('deck-list-empty').hidden = list.length !== 0;
  container.innerHTML = list.map(deckCardHtml).join('');

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
  container.querySelectorAll('[data-unpublish-deck]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      publishDecks(publishState.deckIds.filter((id) => id !== btn.dataset.unpublishDeck));
    });
  });

  updateListToolbar();
}

function updateListToolbar() {
  const n = listUiState.selectedIds.size;
  el('prep-list-btn').disabled = n < 1;
  el('prep-list-btn').textContent = n ? `Prep List (${n})` : 'Prep List';
  el('publish-decks-btn').disabled = n < 1;
  el('deck-publish-status').textContent = publishState.publishedAt
    ? `Last published: ${new Date(publishState.publishedAt).toLocaleString()} · ${publishState.deckIds.length} deck${publishState.deckIds.length === 1 ? '' : 's'} live`
    : 'Nothing published yet';
}

async function publishDecks(deckIds) {
  el('publish-decks-btn').disabled = true;
  const prevLabel = el('publish-decks-btn').textContent;
  el('publish-decks-btn').textContent = 'Publishing...';
  try {
    publishState = await window.api.publishDecks(deckIds);
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
  const legendThumbs = Array.from({ length: LEGEND_SLOTS }, (_, i) => {
    const cardId = deck.legendCardIds[i];
    const card = cardId && cardById(cardId);
    if (!card) return '<div class="deck-card-legend-empty"></div>';
    const printing = (deck.legendPrintingIds?.[i] && printingById(deck.legendPrintingIds[i])) || card;
    return `<img class="deck-card-legend-thumb" src="${printing.imageUrl}" alt="${escapeHtml(printing.displayName)}" title="${escapeHtml(card.name)}" />`;
  }).join('');

  const colorTotal = Object.values(stats.colorCounts).reduce((s, v) => s + v, 0) || 1;
  const colorBar = COLOR_ORDER.filter((c) => stats.colorCounts[c])
    .map((c) => `<div class="color-bar ${c}" style="flex: ${stats.colorCounts[c] / colorTotal}"></div>`)
    .join('');

  const isConfirming = listUiState.confirmDeleteId === deck.id;
  const isPublished = publishState.deckIds.includes(deck.id);
  const isSelected = listUiState.selectedIds.has(deck.id);

  return `
    <div class="deck-card">
      <input type="checkbox" class="deck-card-select" data-select-deck="${deck.id}" ${isSelected ? 'checked' : ''} title="Select for Prep List / publishing" />
      ${isPublished ? `<button class="deck-card-published-badge" data-unpublish-deck="${deck.id}" title="Live on the website - click to unpublish">&#128225; Live</button>` : ''}
      <div class="deck-card-name">${escapeHtml(deck.name || 'Untitled Deck')}</div>
      <div class="deck-card-legends">${legendThumbs}</div>
      <div class="deck-card-color-bar">${colorBar}</div>
      <div class="deck-card-meta">
        <span>${stats.total}/${MAIN_DECK_MAX} cards</span>
        <span>${stats.sellablePct}% sellable</span>
      </div>
      ${stats.warnings.length ? `<div class="deck-card-warning">${escapeHtml(stats.warnings[0])}</div>` : ''}
      <div class="deck-card-actions">
        ${
          isConfirming
            ? `<button data-confirm-delete="${deck.id}" class="deck-danger">Yes, delete</button><button data-cancel-delete="${deck.id}">Cancel</button>`
            : `<button data-view-deck="${deck.id}">View</button><button data-open-deck="${deck.id}">Edit</button><button data-duplicate-deck="${deck.id}">Duplicate</button><button data-ask-delete="${deck.id}" class="deck-danger">Delete</button>`
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
    legendCardIds: [null, null, null],
    legendPrintingIds: [null, null, null],
    cards: {},
    cardPrintings: {},
    links: []
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
    legendCardIds: [0, 1, 2].map((i) => deck.legendCardIds?.[i] || null),
    legendPrintingIds: [0, 1, 2].map((i) => deck.legendPrintingIds?.[i] || null),
    cards: { ...(deck.cards || {}) },
    cardPrintings: Object.fromEntries(Object.entries(deck.cardPrintings || {}).map(([cardId, split]) => [cardId, { ...split }])),
    links: (deck.links || []).map((l) => ({ ...l }))
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
    legendCardIds: [0, 1, 2].map((i) => deck.legendCardIds?.[i] || null),
    legendPrintingIds: [0, 1, 2].map((i) => deck.legendPrintingIds?.[i] || null),
    cards: { ...(deck.cards || {}) },
    cardPrintings: Object.fromEntries(Object.entries(deck.cardPrintings || {}).map(([cardId, split]) => [cardId, { ...split }])),
    links: (deck.links || []).map((l) => ({ ...l }))
  };
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
}

function backToList() {
  draft = null;
  viewingDeck = null;
  showView('list');
  renderList();
}

async function saveDraft() {
  if (!draft.name.trim()) {
    setDeckMessage('Give the deck a name before saving.', true);
    return;
  }
  decks = await window.api.saveDeck(draft);
  setDeckMessage('Saved.', false);
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
    for (const [cardId, qty] of Object.entries(deck.cards || {})) {
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

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      if (!next.name) next.name = line.replace(/^#+\s*/, '').trim();
      continue;
    }
    if (line.startsWith('//')) continue;
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
      } else if (card.ownedMain < 1) {
        notes.push(`${card.name}: not owned in Main`);
      } else {
        next.legendCardIds[legendIdx] = card.cardId;
        const owned = ownedPrintingsFor(card.cardId);
        next.legendPrintingIds[legendIdx] = owned[0]?.id || null;
        legendIdx++;
      }
      continue;
    }

    const have = next.cards[card.cardId] || 0;
    const allowed = Math.min(3, card.ownedMain) - have;
    const take = Math.max(0, Math.min(qty, allowed));
    if (take < qty) notes.push(`${card.name}: wanted ${qty}, added ${take}${card.ownedMain < Math.min(3, have + qty) ? ` (own ${card.ownedMain} in Main)` : ''}`);
    if (take > 0) next.cards[card.cardId] = have + take;
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

function openDeckView(deckId) {
  const deck = decks[deckId];
  if (!deck) return;
  viewingDeck = deck;
  showView('view');
  renderDeckView();
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
  const deck = viewingDeck;
  const stats = computeDeckStats(deck);

  el('view-deck-title').textContent = deck.name || 'Untitled Deck';
  // Rendered as raw HTML on purpose - it's the deck's own author (you)
  // writing markup into your own local decks.json, not untrusted input, so
  // "HTML tags are supported" means literally that.
  el('view-deck-description').innerHTML = deck.description || '';
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

  el('view-deck-card-sections').innerHTML = grouped
    .map((g) => {
      const tiles = g.entries
        .map((e) => viewDeckTileHtml(e.printings, `data-detail-index="${runningIndex++}"`, e.cardId))
        .join('');
      return `<div class="view-deck-section"><h3>${escapeHtml(g.type)}s <span class="deck-count-badge">${g.entries.reduce((s, e) => s + e.qty, 0)}</span></h3><div class="view-deck-tile-grid">${tiles}</div></div>`;
    })
    .join('');

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
  el('view-deck-status-sub').textContent = `${stats.legendsFilled}/${LEGEND_SLOTS} Legends · ${stats.total}/${MAIN_DECK_MIN}-${MAIN_DECK_MAX} Deck`;
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
  const pool = shuffled(buildDeckDrawPool(viewingDeck));
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

// --- Builder view -----------------------------------------------------

function renderBuilder() {
  el('deck-name-input').value = draft.name;
  el('deck-description-input').value = draft.description || '';
  renderDeckMessage();
  renderLegendRow();
  renderCeilingStrip();
  renderCardPool();
  renderDeckCardsList();
  renderLinksList();
  renderDeckStats();
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
      if (builderState.ownership === 'owned' && c.ownedMain === 0) return false;
      if (builderState.legalOnly && !cardFitsCeilings(draft, c)) return false;
      return true;
    })
    .sort((a, b) => COLOR_ORDER.indexOf(a.color) - COLOR_ORDER.indexOf(b.color) || TYPE_ORDER.indexOf(a.cardType) - TYPE_ORDER.indexOf(b.cardType) || a.name.localeCompare(b.name));
}

function renderCardPool() {
  const cards = getFilteredPoolCards();
  el('db-result-count').textContent = `${cards.length} card${cards.length === 1 ? '' : 's'}`;
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
}

function cardPoolTileHtml(card) {
  const qty = draft.cards[card.cardId] || 0;
  const maxQty = Math.min(3, card.ownedMain);
  const incCheck = canSetCardQty(draft, card, qty + 1);
  return `
    <div class="db-card-tile">
      <img src="${card.imageUrl}" alt="${escapeHtml(card.displayName)}" loading="lazy" />
      <div class="db-card-tile-info">
        <div class="db-card-tile-name" title="${escapeHtml(card.name)}">${escapeHtml(card.name)}</div>
        <div class="db-card-tile-meta">
          <span>${card.color || ''} · RAM ${card.ram ?? '-'}</span>
          <span class="rarity-pip ${rarityClass(card.rarity)}">${card.rarity || ''}</span>
        </div>
        <div class="db-card-tile-owned">Owned: ${card.ownedMain}</div>
        <div class="db-qty-row">
          <button data-qty-action="dec" data-card-id="${card.cardId}" ${qty <= 0 ? 'disabled' : ''}>-</button>
          <span class="db-qty-value">${qty} / ${maxQty || 0}</span>
          <button data-qty-action="inc" data-card-id="${card.cardId}" ${qty >= maxQty || !incCheck.ok ? 'disabled' : ''} title="${qty >= maxQty || !incCheck.ok ? escapeHtml(incCheck.ok ? 'Owned copy limit reached' : incCheck.reason) : ''}">+</button>
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
      <div class="deck-card-row-qty">x${e.qty}</div>
      ${hasVariants ? `<button class="deck-card-row-art" data-split-card="${e.card.cardId}" title="Choose which printing(s) represent these copies">&#8635;</button>` : ''}
      <button data-dec-card="${e.card.cardId}" title="Remove one">-</button>
    </div>
  `;
    })
    .join('');

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

// Short label(s) for a card's current printing split, e.g. ["Epic"] for a
// uniform stack or ["Epic", "Iconic Other"] for a mixed one - used to flag
// mixed-rarity stacks in the Deck List instead of silently only showing one
// rarity for the whole group.
function splitRarities(deck, cardId) {
  const split = getPrintingSplit(deck, cardId);
  return [...new Set(Object.keys(split).map((pid) => printingById(pid)?.rarity).filter(Boolean))];
}

function renderLinksList() {
  const list = el('deck-links-list');
  if (!draft.links.length) {
    list.innerHTML = '<div class="deck-links-empty">No reference links yet.</div>';
    return;
  }
  list.innerHTML = draft.links
    .map(
      (l, i) => `
    <div class="deck-link-row">
      <a data-open-link="${escapeHtml(l.url)}" title="${escapeHtml(l.url)}">${escapeHtml(l.label || l.url)}</a>
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
  draft.links.push({ label: label || url, url });
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
  if (!owned.length) {
    setDeckMessage(`You don't own "${candidate.name}" in Main - Legends must be a card you own.`, true);
    return;
  }
  if (owned.length > 1) {
    legendPicker.variantFor = cardId;
    renderLegendPicker();
    return;
  }
  finalizeLegendSelection(cardId, owned[0].id);
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
  el('close-btn').addEventListener('click', () => window.api.windowClose());

  el('new-deck-btn').addEventListener('click', newDeck);
  el('import-deck-btn').addEventListener('click', openImportModal);
  el('import-close').addEventListener('click', closeImportModal);
  el('import-overlay').addEventListener('click', (e) => {
    if (e.target === el('import-overlay')) closeImportModal();
  });
  el('import-run-btn').addEventListener('click', runImport);
  el('back-to-list-btn').addEventListener('click', backToList);
  el('save-deck-btn').addEventListener('click', saveDraft);
  el('builder-export-btn').addEventListener('click', () => openExportModal(draft));

  el('export-close').addEventListener('click', closeExportModal);
  el('export-overlay').addEventListener('click', (e) => {
    if (e.target === el('export-overlay')) closeExportModal();
  });
  el('export-copy-btn').addEventListener('click', copyExportText);
  el('export-download-btn').addEventListener('click', downloadExportText);

  el('prep-list-btn').addEventListener('click', openPrepView);
  el('prep-back-to-list-btn').addEventListener('click', backToList);
  el('publish-decks-btn').addEventListener('click', () => publishDecks([...listUiState.selectedIds]));

  el('deck-name-input').addEventListener('input', (e) => {
    draft.name = e.target.value;
  });
  el('deck-description-input').addEventListener('input', (e) => {
    draft.description = e.target.value;
  });

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
    if (e.key === 'Escape' && el('export-overlay').classList.contains('open')) closeExportModal();
    if (e.key === 'Escape' && el('import-overlay').classList.contains('open')) closeImportModal();
  });
}

init();
