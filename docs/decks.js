// Read-only port of the desktop app's Deck Builder "Deck View"
// (src/renderer/deckbuilder.js's renderDeckView/computeDeckStats/
// viewDeckTileHtml) - duplicated rather than shared, matching this
// project's existing convention (mainSetCap()/renderRulesText() are
// already duplicated across renderer.js/collection.js/record.js). Only
// the decks the desktop app has explicitly published (via "Publish
// Decks") ever reach this file - decks.json itself never leaves the
// desktop.

let publishedDecks = [];
let cardDetails = {}; // printingId -> denormalized card fields
let currentDeck = null;

const el = (id) => document.getElementById(id);

const COLOR_ORDER = ['Red', 'Blue', 'Green', 'Yellow'];
const TYPE_ORDER = ['Unit', 'Gear', 'Program'];
const TYPE_COLORS = { Unit: 'var(--type-unit)', Gear: 'var(--type-gear)', Program: 'var(--type-program)' };
const DECK_COLOR_VARS = { Red: 'var(--color-red)', Blue: 'var(--color-blue)', Green: 'var(--color-green)', Yellow: 'var(--color-yellow)' };
const LEGEND_SLOTS = 3;
const MAIN_DECK_MIN = 40;
const MAIN_DECK_MAX = 50;

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : str;
  return div.innerHTML;
}

function imageUrl(printingId) {
  return `images/${printingId}.webp`;
}

// All printings sharing a cardId have identical name/type/color/ram/cost/
// power/isEddiable (only rarity/set/art differ) - any one is a fine
// representative for card-level (not printing-level) stats.
function cardByCardId(cardId) {
  return Object.values(cardDetails).find((c) => c.cardId === cardId);
}

async function init() {
  renderBuildInfo();
  try {
    [publishedDecks, cardDetails] = await Promise.all([
      fetchJson('data/published-decks.json').catch(() => []),
      fetchJson('data/deck-card-details.json').catch(() => ({}))
    ]);
  } catch (err) {
    el('decks-empty').hidden = false;
    el('decks-empty').textContent = `Couldn't load decks: ${err.message}`;
    return;
  }

  el('back-to-decks-link').addEventListener('click', (e) => {
    e.preventDefault();
    showList();
  });

  const params = new URLSearchParams(location.search);
  const requestedId = params.get('id');
  if (requestedId && publishedDecks.some((d) => d.id === requestedId)) {
    showDetail(requestedId);
  } else {
    showList();
  }
}

function showList() {
  currentDeck = null;
  history.replaceState(null, '', 'decks.html');
  el('deck-detail').hidden = true;
  el('decks-list').hidden = false;

  el('deck-result-count').textContent = `${publishedDecks.length} deck${publishedDecks.length === 1 ? '' : 's'} live`;
  el('decks-empty').hidden = publishedDecks.length !== 0;
  el('deck-list-grid').innerHTML = publishedDecks.map(deckListCardHtml).join('');
  el('deck-list-grid').querySelectorAll('[data-open-deck]').forEach((card) => {
    card.addEventListener('click', () => showDetail(card.dataset.openDeck));
  });
}

function deckListCardHtml(deck) {
  const stats = computeDeckStats(deck);
  const legendThumbs = Array.from({ length: LEGEND_SLOTS }, (_, i) => {
    const pid = deck.legendPrintingIds?.[i];
    const c = pid && cardDetails[pid];
    return c ? `<img class="deck-list-legend-thumb" src="${imageUrl(pid)}" alt="${escapeHtml(c.displayName)}" />` : '<div class="deck-list-legend-empty"></div>';
  }).join('');

  return `
    <div class="deck-list-card" data-open-deck="${deck.id}">
      <div class="deck-list-card-name">${escapeHtml(deck.name || 'Untitled Deck')}</div>
      <div class="deck-list-legends">${legendThumbs}</div>
      <div class="deck-list-card-meta">${stats.total}/${MAIN_DECK_MAX} cards · ${stats.sellablePct}% sellable</div>
    </div>
  `;
}

function showDetail(deckId) {
  const deck = publishedDecks.find((d) => d.id === deckId);
  if (!deck) return;
  currentDeck = deck;
  history.replaceState(null, '', `decks.html?id=${encodeURIComponent(deckId)}`);
  el('decks-list').hidden = true;
  el('deck-detail').hidden = false;
  renderDetail(deck);
}

// --- Stats (ported from computeDeckStats in deckbuilder.js) ---------------

function computeDeckStats(deck) {
  const entries = Object.entries(deck.cards || {})
    .map(([cardId, qty]) => ({ card: cardByCardId(cardId), qty }))
    .filter((e) => e.card);
  const total = entries.reduce((sum, e) => sum + e.qty, 0);
  const colorCounts = {};
  const typeCounts = {};
  const costCounts = {};
  let sellable = 0;
  for (const { card, qty } of entries) {
    if (card.color) colorCounts[card.color] = (colorCounts[card.color] || 0) + qty;
    typeCounts[card.cardType] = (typeCounts[card.cardType] || 0) + qty;
    const costKey = card.cost == null ? '?' : Math.min(card.cost, 7);
    costCounts[costKey] = (costCounts[costKey] || 0) + qty;
    if (card.isEddiable) sellable += qty;
  }
  const filled = (deck.legendCardIds || []).filter(Boolean).length;
  const isValid = filled === LEGEND_SLOTS && total >= MAIN_DECK_MIN && total <= MAIN_DECK_MAX;
  return {
    total,
    colorCounts,
    typeCounts,
    costCounts,
    sellable,
    unsellable: total - sellable,
    sellablePct: total ? Math.round((sellable / total) * 100) : 0,
    legendsFilled: filled,
    isValid
  };
}

// --- Stacked-tile art (ported from viewDeckTileHtml/TILE_RAISE_PX) --------

const TILE_RAISE_PX = 12;
const TILE_ASPECT_PCT = (88 / 63) * 100;

function tileHtml(printings, titleAttr) {
  const n = printings.length;
  const extra = (n - 1) * TILE_RAISE_PX;
  const layers = printings
    .map((p, i) => `<img class="deck-tile-layer" style="top: ${i * TILE_RAISE_PX}px; z-index: ${i + 1}" src="${imageUrl(p.id)}" alt="${escapeHtml(p.displayName)}" loading="lazy" />`)
    .join('');
  return `<div class="deck-tile" ${titleAttr || ''} style="padding-bottom: calc(${TILE_ASPECT_PCT}% + ${extra}px)">${layers}</div>`;
}

// Expands a {printingId: count} split (back-most first) into one printing
// per physical copy - same as printingsForCardEntry() in deckbuilder.js.
function printingsForCardEntry(deck, cardId, qty) {
  const split = deck.cardPrintings?.[cardId] || {};
  const list = [];
  for (const [pid, n] of Object.entries(split)) {
    const p = cardDetails[pid];
    if (p) for (let i = 0; i < n; i++) list.push(p);
  }
  const fallback = cardByCardId(cardId);
  while (list.length < qty && fallback) list.push(fallback);
  return list.slice(0, qty);
}

// --- Cost curve + donuts (ported from costCurveHtml/donutBlockHtml) -------

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
  return `<div class="ram-curve">${cols}</div>`;
}

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
    <div class="donut-block">
      <h4>${escapeHtml(title)}</h4>
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

// --- Detail rendering -------------------------------------------------

function renderDetail(deck) {
  const stats = computeDeckStats(deck);

  el('detail-title').textContent = deck.name || 'Untitled Deck';
  el('detail-links').innerHTML = (deck.links || [])
    .map((l) => `<a class="detail-link-chip" href="${escapeHtml(l.url)}" target="_blank" rel="noopener">&#128279; ${escapeHtml(l.label || l.url)}</a>`)
    .join('');

  el('detail-status').classList.toggle('invalid', !stats.isValid);
  el('detail-status-sub').textContent = `${stats.legendsFilled}/${LEGEND_SLOTS} Legends · ${stats.total}/${MAIN_DECK_MIN}-${MAIN_DECK_MAX} Deck`;
  el('detail-status-badge').textContent = stats.isValid ? 'Valid' : 'Invalid';

  const legendPrintings = (deck.legendCardIds || []).map((cardId, i) => {
    const pid = deck.legendPrintingIds?.[i];
    return cardId && pid ? cardDetails[pid] : null;
  });
  el('detail-legends-count').textContent = `${legendPrintings.filter(Boolean).length}`;
  el('detail-legends').innerHTML = legendPrintings
    .map((p) => (p ? tileHtml([p], `title="${escapeHtml(p.name)}"`) : '<div class="deck-tile-empty">No Legend</div>'))
    .join('');

  el('detail-description').innerHTML = deck.description || '';

  el('detail-cost-curve').innerHTML = costCurveHtml(stats.costCounts);

  el('detail-donuts').innerHTML = [
    donutBlockHtml('Sellable vs Unsellable', [
      { label: 'Sellable', count: stats.sellable, color: 'var(--green)' },
      { label: 'Unsellable', count: stats.unsellable, color: 'var(--red)' }
    ]),
    donutBlockHtml('Card Types', TYPE_ORDER.map((t) => ({ label: t + 's', count: stats.typeCounts[t] || 0, color: TYPE_COLORS[t] }))),
    donutBlockHtml('Colors', COLOR_ORDER.map((c) => ({ label: c, count: stats.colorCounts[c] || 0, color: DECK_COLOR_VARS[c] })))
  ].join('');

  const cardEntries = Object.entries(deck.cards || {})
    .map(([cardId, qty]) => ({ cardId, card: cardByCardId(cardId), qty }))
    .filter((e) => e.card)
    .sort((a, b) => COLOR_ORDER.indexOf(a.card.color) - COLOR_ORDER.indexOf(b.card.color) || a.card.name.localeCompare(b.card.name));

  const grouped = TYPE_ORDER.map((t) => ({ type: t, entries: cardEntries.filter((e) => e.card.cardType === t) })).filter((g) => g.entries.length);

  el('detail-card-sections').innerHTML = grouped
    .map((g) => {
      const tiles = g.entries
        .map((e) => tileHtml(printingsForCardEntry(deck, e.cardId, e.qty), `title="${escapeHtml(e.card.name)} x${e.qty}"`))
        .join('');
      return `<div class="deck-section"><h3>${escapeHtml(g.type)}s <span class="count-badge">${g.entries.reduce((s, e) => s + e.qty, 0)}</span></h3><div class="tile-grid">${tiles}</div></div>`;
    })
    .join('');
}

init();
