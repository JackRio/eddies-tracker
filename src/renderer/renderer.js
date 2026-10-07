let allCards = [];
let collection = {};
// { printingId: qty } for sale on the website's trade page (docs/trade.html).
let tradeList = {};
let faqData = {};
let state = {
  search: '',
  ownership: 'all',
  colors: new Set(),
  types: new Set(),
  rarities: new Set(),
  set: 'welcometonightcitybeta',
  sort: 'default',
  onSaleOnly: false
};

const el = (id) => document.getElementById(id);

const TYPE_ORDER = ['Legend', 'Unit', 'Gear', 'Program'];
const COLOR_ORDER = ['Red', 'Blue', 'Green', 'Yellow'];
// Ordered common -> rarest, by actual printing population in the card pool.
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

function rarityClass(rarity) {
  return 'rarity-' + String(rarity || '').toLowerCase().replace(/\s+/g, '-');
}

// Card rulesText comes from the API with {Keyword} tokens (e.g. "{Call}",
// "{Go Solo}") standing in for the game's official badge icons. Swap each
// one for the matching SVG (scraped from cyberpunktcg.com's own rules-faq
// page, same icons/colors as the real cards) instead of showing the raw
// bracketed text. Kept in sync with the same helper in collection.js.
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

// --- Cardmarket prices (matching/fetching lives in src/prices.js). Kept in
// sync with the same helpers in collection.js.
let priceView = null;

function formatEur(v) {
  if (v == null) return '—';
  return `€${v >= 100 ? Math.round(v).toLocaleString('en') : v.toFixed(2)}`;
}

function headlinePrice(p) {
  return p ? p.trend ?? p.low ?? p.trendFoil ?? p.lowFoil ?? null : null;
}

function priceMatchFor(printingId) {
  return priceView?.matches?.[printingId] || null;
}

function priceProductFor(printingId) {
  const m = priceMatchFor(printingId);
  return m && m.idProduct != null ? priceView.products[m.idProduct] || null : null;
}

const PRICE_SOURCE_LABELS = {
  auto: 'Auto-matched',
  guess: 'Best guess — check the match below',
  manual: 'Matched by you',
  none: 'No Cardmarket listing found',
  'none-manual': 'Set to "no match" by you'
};

function cardmarketUrl(name) {
  return `https://www.cardmarket.com/en/Cyberpunk/Products/Search?searchString=${encodeURIComponent(name)}`;
}

// Cardmarket lists several same-named products per expansion (one per art
// version) with nothing but an id to tell them apart - number them V1, V2...
// in id order, which is also Cardmarket's own version order.
function candidateLabel(idProduct, candidates) {
  const p = priceView.products[idProduct];
  const sameExp = candidates.filter((id) => priceView.products[id]?.exp === p.exp);
  const version = sameExp.length > 1 ? ` · V${sameExp.indexOf(idProduct) + 1}` : '';
  return `${p.expName}${version} · ${formatEur(headlinePrice(p))}`;
}

function priceTagHtml(c) {
  const p = priceProductFor(c.id);
  const price = headlinePrice(p);
  if (price == null) return '';
  const guess = priceMatchFor(c.id).source === 'guess';
  const title = `Cardmarket trend${guess ? ' (best-guess match)' : ''}`;
  return `<span class="price-tag${guess ? ' price-guess' : ''}" title="${title}">${formatEur(price)}${guess ? '?' : ''}</span>`;
}

// "Sell all shown" is checked when every owned printing in the current
// filter is listed at its full owned count; toggling it lists all of them at
// full count, or unlists all of them. Only touches trade-list.json (the
// trade page), never the collection itself.
function saleTogglesHtml(cards) {
  const eligible = cards.filter((c) => getTotalCount(c.id) > 0);
  const allListed = eligible.length > 0 && eligible.every((c) => (tradeList[c.id] || 0) === getTotalCount(c.id));
  const listedCount = cards.filter((c) => tradeList[c.id]).length;
  return `
    <span class="sale-toggles">
      <label class="sale-toggle" title="List every owned copy of the ${eligible.length} owned printing(s) shown for sale - or unlist them all">
        <input type="checkbox" id="sell-all-toggle" ${allListed ? 'checked' : ''} ${eligible.length ? '' : 'disabled'} />
        Sell all shown
      </label>
      <label class="sale-toggle" title="Only show printings listed on the trade page">
        <input type="checkbox" id="on-sale-toggle" ${state.onSaleOnly ? 'checked' : ''} />
        On sale only${listedCount ? ` (${listedCount})` : ''}
      </label>
    </span>`;
}

async function onSellAllToggle(cards) {
  const eligible = cards.filter((c) => getTotalCount(c.id) > 0);
  const allListed = eligible.every((c) => (tradeList[c.id] || 0) === getTotalCount(c.id));
  const updates = Object.fromEntries(eligible.map((c) => [c.id, allListed ? 0 : getTotalCount(c.id)]));
  tradeList = await window.api.setTradeQtys(updates);
  render();
}

// Value of what you own among the printings currently shown in the grid
// (i.e. after all filters): headline Cardmarket price x every copy you hold
// of that printing across Main + Reserve + Extras.
function resultTotalHtml(cards) {
  if (!priceView) return '';
  let total = 0;
  let copies = 0;
  let unpriced = 0;
  for (const c of cards) {
    const owned = getTotalCount(c.id);
    if (!owned) continue;
    const price = headlinePrice(priceProductFor(c.id));
    if (price == null) {
      unpriced += owned;
      continue;
    }
    total += price * owned;
    copies += owned;
  }
  if (!total) return '';
  const title = `${copies} owned cop${copies === 1 ? 'y' : 'ies'} (Main + Reserve + Extras) at Cardmarket trend${unpriced ? ` - ${unpriced} without a price not counted` : ''}`;
  return ` · <span class="result-total" title="${title}">${formatEur(total)} owned</span>${unpriced ? ` <span class="result-unpriced">(${unpriced} unpriced)</span>` : ''}`;
}

function priceSectionHtml(c) {
  if (!priceView) {
    return `<div class="popped-price"><h4>Cardmarket</h4><div class="price-note">Prices unavailable right now (offline?).</div></div>`;
  }
  const m = priceMatchFor(c.id) || { idProduct: null, source: 'none', candidates: [] };
  const p = priceProductFor(c.id);
  const rows = p
    ? [
        ['Trend', p.trend],
        ['From', p.low],
        ['7-day avg', p.avg7],
        ['30-day avg', p.avg30],
        ...(p.trendFoil != null || p.lowFoil != null ? [['Foil trend', p.trendFoil ?? p.lowFoil]] : [])
      ]
        .map(([label, v]) => `<div class="price-cell"><span>${label}</span><strong>${formatEur(v)}</strong></div>`)
        .join('')
    : '';
  const selected = m.source === 'manual' ? String(m.idProduct) : m.source === 'none-manual' ? 'none' : 'auto';
  const options = [
    `<option value="auto">Automatic</option>`,
    ...(m.candidates || []).map((id) => `<option value="${id}">${escapeHtml(candidateLabel(id, m.candidates))}</option>`),
    `<option value="none">No match</option>`
  ].join('');
  const asOf = priceView.priceDate ? new Date(priceView.priceDate).toLocaleDateString() : '';
  return `
    <div class="popped-price">
      <div class="price-head">
        <h4>Cardmarket</h4>
        <span class="price-source price-source-${m.source}">${PRICE_SOURCE_LABELS[m.source] || ''}</span>
      </div>
      ${rows ? `<div class="price-grid">${rows}</div>` : ''}
      <div class="price-match-row">
        <label>Match
          <select data-price-override data-selected="${selected}">${options}</select>
        </label>
        <button class="price-link-btn" data-price-link="${escapeHtml(cardmarketUrl(p ? p.name : c.displayName.replace(': ', ' - ')))}">Cardmarket ↗</button>
      </div>
      ${asOf ? `<div class="price-note">Cardmarket price guide as of ${asOf}</div>` : ''}
    </div>`;
}

function wirePriceSection(container, c, onChange) {
  const sel = container.querySelector('[data-price-override]');
  if (sel) {
    sel.value = sel.dataset.selected;
    sel.addEventListener('change', async () => {
      const v = sel.value;
      priceView = await window.api.setPriceOverride(c.id, v === 'auto' ? 'auto' : v === 'none' ? null : Number(v));
      onChange();
    });
  }
  const link = container.querySelector('[data-price-link]');
  if (link) link.addEventListener('click', () => window.api.openExternalLink(link.dataset.priceLink));
}

async function loadPrices(force = false) {
  try {
    priceView = await (force ? window.api.refreshPrices() : window.api.getPrices());
  } catch (err) {
    console.error('Price load failed:', err);
  }
}

async function init() {
  try {
    const cached = await window.api.getCards();
    if (cached && cached.cards && cached.cards.length) {
      allCards = cached.cards;
      setLastUpdated(cached.fetchedAt);
    } else {
      await doRefresh();
    }
    collection = await window.api.getCollection();
    tradeList = await window.api.getTradeList();
    try {
      faqData = await fetch('faq-data.json').then((r) => r.json());
    } catch {
      faqData = {};
    }
    buildFilterOptions();
    render();
    await refreshBackupList();
    el('loading-state').hidden = true;
    // Prices are a nice-to-have - load after the grid is up (a stale cache
    // triggers a Cardmarket download) and just re-render when they arrive.
    loadPrices().then(render);
  } catch (err) {
    console.error('INIT ERROR:', err);
    el('loading-state').textContent = 'Error loading cards: ' + err.message;
  }
}

function setLastUpdated(iso) {
  if (!iso) return;
  const d = new Date(iso);
  el('last-updated').textContent = `Last updated: ${d.toLocaleString()}`;
}

async function doRefresh() {
  const btn = el('refresh-btn');
  btn.disabled = true;
  btn.textContent = 'Refreshing...';
  try {
    const cache = await window.api.refreshCards();
    allCards = cache.cards;
    setLastUpdated(cache.fetchedAt);
    await loadPrices(true);
    buildFilterOptions();
    render();
  } catch (err) {
    alert('Failed to refresh card data: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh Card Data';
  }
}

function buildFilterOptions() {
  const colors = [...new Set(allCards.map((c) => c.color).filter(Boolean))]
    .sort((a, b) => COLOR_ORDER.indexOf(a) - COLOR_ORDER.indexOf(b));
  const types = [...new Set(allCards.map((c) => c.cardType).filter(Boolean))]
    .sort((a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b));
  const rarities = [...new Set(allCards.map((c) => c.rarity).filter(Boolean))]
    .sort((a, b) => RARITY_ORDER.indexOf(a) - RARITY_ORDER.indexOf(b));
  const sets = [...new Map(allCards.map((c) => [c.set?.code, c.set])).values()].filter(Boolean);

  renderChipGroup('color-filters', colors, state.colors);
  renderChipGroup('type-filters', types, state.types);
  renderChipGroup('rarity-filters', rarities, state.rarities);

  const setSelect = el('set-filter');
  setSelect.innerHTML = '<option value="all">All Sets</option>' +
    sets.map((s) => `<option value="${s.code}">${s.name}</option>`).join('');
  if (sets.some((s) => s.code === state.set)) {
    setSelect.value = state.set;
  }
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
      render();
    });
  });
}

function getFilteredCards() {
  let cards = allCards.filter((c) => {
    if (state.search) {
      const q = state.search.toLowerCase();
      const hay = `${c.name} ${c.subname || ''} ${c.rulesText || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (state.colors.size && !state.colors.has(c.color)) return false;
    if (state.types.size && !state.types.has(c.cardType)) return false;
    if (state.rarities.size && !state.rarities.has(c.rarity)) return false;
    if (state.set !== 'all' && c.set?.code !== state.set) return false;
    const owned = getTotalCount(c.id);
    if (state.ownership === 'owned' && owned === 0) return false;
    if (state.ownership === 'missing' && owned > 0) return false;
    if (state.onSaleOnly && !tradeList[c.id]) return false;
    return true;
  });

  cards = cards.slice().sort((a, b) => {
    switch (state.sort) {
      case 'name':
        return a.name.localeCompare(b.name);
      case 'cost':
        return (a.cost ?? 99) - (b.cost ?? 99);
      case 'power':
        return (b.power ?? -1) - (a.power ?? -1);
      case 'rarity':
        return RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity);
      case 'price':
        return (headlinePrice(priceProductFor(b.id)) ?? -1) - (headlinePrice(priceProductFor(a.id)) ?? -1);
      default:
        return (
          COLOR_ORDER.indexOf(a.color) - COLOR_ORDER.indexOf(b.color) ||
          TYPE_ORDER.indexOf(a.cardType) - TYPE_ORDER.indexOf(b.cardType) ||
          (a.cost ?? 0) - (b.cost ?? 0)
        );
    }
  });

  return cards;
}

function getBucketCount(cardId, bucket) {
  return collection[cardId]?.[bucket] || 0;
}

function getTotalCount(cardId) {
  return getBucketCount(cardId, 'main') + getBucketCount(cardId, 'reserve') + getBucketCount(cardId, 'extras');
}

let poppedRowCards = [];
let poppedIndex = -1;

function render() {
  const cards = getFilteredCards();
  poppedRowCards = cards;
  const grid = el('card-grid');
  el('result-count').innerHTML = `${cards.length} printing${cards.length === 1 ? '' : 's'}${resultTotalHtml(cards)}${saleTogglesHtml(cards)}`;
  el('sell-all-toggle')?.addEventListener('change', () => onSellAllToggle(cards));
  el('on-sale-toggle').addEventListener('change', (e) => {
    state.onSaleOnly = e.target.checked;
    render();
  });
  el('empty-state').hidden = cards.length !== 0;

  grid.innerHTML = cards.map(cardTileHtml).join('');

  grid.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', onCounterClick);
  });

  grid.querySelectorAll('.card-tile').forEach((tile) => {
    tile.addEventListener('click', (e) => {
      if (e.target.closest('[data-action]')) return;
      openPopped(tile.dataset.cardId);
    });
  });

  grid.querySelectorAll('.card-image-wrap').forEach((wrap) => {
    const img = wrap.querySelector('img');
    const markLoaded = () => {
      img.classList.add('loaded');
      wrap.classList.add('img-loaded');
    };
    if (img.complete && img.naturalWidth > 0) markLoaded();
    else {
      img.addEventListener('load', markLoaded);
      img.addEventListener('error', markLoaded);
    }
  });

  updateStats();

  // The popup may be open across a re-render (e.g. clicking +/- inside it),
  // so refresh its contents in place instead of leaving stale counts shown.
  if (!el('popped-overlay').hidden && poppedIndex >= 0 && poppedRowCards[poppedIndex]) {
    openPopped(poppedRowCards[poppedIndex].id);
  }
}

function poppedOwnedControlsHtml(c) {
  const cap = mainSetCap(c.cardType);
  return BUCKETS.map(
    ({ key, label, showMax }) => `
          <div class="mini-counter">
            <span class="mini-label">${label}</span>
            <button data-action="dec" data-bucket="${key}" data-card-id="${c.id}">-</button>
            <span class="counter-value">${getBucketCount(c.id, key)}</span>
            <button data-action="inc" data-bucket="${key}" data-card-id="${c.id}">+</button>
            ${showMax ? `<button class="mini-max-btn" data-action="setmax" data-bucket="${key}" data-cap="${cap}" data-card-id="${c.id}" title="Set ${label} to ${cap}">MAX</button>` : ''}
          </div>`
  ).join('') + `
          <div class="mini-counter sell-counter" title="Copies listed on the website's trade page (capped at total owned)">
            <span class="mini-label">Sell</span>
            <button data-action="sell-dec" data-card-id="${c.id}">-</button>
            <span class="counter-value">${tradeList[c.id] || 0}</span>
            <button data-action="sell-inc" data-card-id="${c.id}">+</button>
          </div>`;
}

function stepPopped(delta) {
  if (!poppedRowCards.length) return;
  const next = (poppedIndex + delta + poppedRowCards.length) % poppedRowCards.length;
  openPopped(poppedRowCards[next].id);
}

function openPopped(cardId) {
  const c = poppedRowCards.find((x) => x.id === cardId) || allCards.find((x) => x.id === cardId);
  if (!c) return;

  poppedIndex = poppedRowCards.findIndex((x) => x.id === cardId);

  el('popped-img').src = c.imageUrl;
  el('popped-img').alt = c.displayName;
  el('popped-name').textContent = c.name;
  el('popped-subname').textContent = c.subname || '';
  el('popped-subname').hidden = !c.subname;

  const meta = [
    c.cost != null ? `Cost ${c.cost}` : '',
    c.power != null ? `Power ${c.power}` : '',
    c.ram != null ? `RAM ${c.ram}` : '',
    c.cardType
  ]
    .filter(Boolean)
    .join(' · ');
  el('popped-meta').textContent = meta;

  const rarityEl = el('popped-rarity');
  rarityEl.textContent = c.rarity || '';
  rarityEl.className = `popped-rarity ${rarityClass(c.rarity)}`;

  el('popped-owned-controls').innerHTML = poppedOwnedControlsHtml(c);
  el('popped-owned-controls').querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', onCounterClick);
  });

  el('popped-price').innerHTML = priceSectionHtml(c);
  wirePriceSection(el('popped-price'), c, render);

  el('popped-rules').innerHTML = renderRulesText(c.rulesText);
  el('popped-faq').innerHTML = faqHtml(c.slug);

  const overlay = el('popped-overlay');
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add('open'));
}

function closePopped() {
  const overlay = el('popped-overlay');
  overlay.classList.remove('open');
  setTimeout(() => {
    if (!overlay.classList.contains('open')) overlay.hidden = true;
  }, 200);
}

// Highlights view - clicking the header logo opens a big rotating "cylinder"
// of the rarest cards in the currently-selected set, spinning slowly and
// continuously. It's read-only (no Main/Reserve/Extras edit buttons - this
// view is for browsing, not for changing your collection by accident).
// Clicking a card (or the periodic auto-spotlight) pops it up full-size with
// the same info as the main popup minus the arrows and edit buttons, plus a
// read-only owned count and a list of the card's other printings/sets.
const HIGHLIGHT_MIN_RARITY_INDEX = RARITY_ORDER.indexOf('Epic');
const HIGHLIGHT_SPEED_DEG_PER_SEC = 1; // slow continuous spin
const HIGHLIGHT_SPOTLIGHT_INTERVAL_MS = 15000;
const HIGHLIGHT_SPOTLIGHT_DURATION_MS = 6000;

let highlightCards = [];
let highlightAngle = 0;
let highlightStep = 0;
let highlightPaused = false;
let highlightRAF = null;
let highlightLastTs = null;
let highlightSpotlightTimer = null;
let highlightDetailToken = 0;
// {img, baseAngle} per tile, used every frame to curve each tile's corners
// more and darken it slightly as it swings toward the screen edge (see
// updateHighlightCurvature) - kept separate from highlightCards so this
// doesn't need to re-walk the DOM by id on every animation frame.
let highlightTileMeta = [];

// "Whatever set I have chosen" - same pool the main grid's stats use.
function getHighlightPool() {
  return state.set === 'all' ? allCards : allCards.filter((c) => c.set?.code === state.set);
}

function getHighlightCards() {
  return getHighlightPool()
    .filter((c) => RARITY_ORDER.indexOf(c.rarity) >= HIGHLIGHT_MIN_RARITY_INDEX)
    .sort((a, b) => RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity) || a.name.localeCompare(b.name));
}

function applyHighlightRotation() {
  el('highlight-cylinder').style.transform = `rotateY(${highlightAngle}deg)`;
  // Opposite direction (and, per buildHighlightBackgroundRing, different
  // cards) so this reads as its own distant ring of cards rather than a
  // shadow/echo of the foreground ring rotating in lockstep with it.
  el('highlight-cylinder-bg').style.transform = `rotateY(${-highlightAngle}deg)`;
}

// A tile facing the camera head-on (0deg) stays square with corners as
// drawn; one that has swung toward +/-90deg (the screen edge, since each
// tile is itself rotated to match its position on the ring) balloons toward
// a full pill shape, narrows, and dims - reads as a card wrapping around a
// curved cylindrical surface instead of a flat plane swinging on a hinge.
// sqrt() eases the curve in fast (most of the effect happens in the first
// ~30deg) rather than linearly, since a linear ramp barely reads as curved
// until a tile is almost edge-on.
function updateHighlightCurvature() {
  for (const { img, baseAngle } of highlightTileMeta) {
    const raw = ((baseAngle + highlightAngle) % 360 + 540) % 360 - 180;
    const factor = Math.min(Math.abs(raw) / 90, 1);
    const eased = Math.sqrt(factor);
    // A near-front card (eased ~0) is left with NO inline filter/transform
    // at all, rather than a no-op brightness(1)/scaleX(1). Chromium promotes
    // any filtered or extra-transformed element to its own rasterized
    // layer, and that layer gets resampled (blurrily) when perspective
    // enlarges the front card - skipping both for untouched cards is what
    // keeps them crisp.
    if (eased < 0.03) {
      img.style.borderRadius = '10px';
      img.style.transform = '';
      img.style.filter = '';
      continue;
    }
    const radius = Math.round(12 + eased * 150);
    const squeeze = (1 - eased * 0.32).toFixed(3);
    img.style.borderRadius = `${radius}px`;
    img.style.transform = `scaleX(${squeeze})`;
    img.style.filter = `brightness(${(1 - eased * 0.55).toFixed(2)})`;
  }
}

function highlightTick(ts) {
  if (highlightLastTs != null && !highlightPaused) {
    const dt = (ts - highlightLastTs) / 1000;
    highlightAngle -= HIGHLIGHT_SPEED_DEG_PER_SEC * dt;
    applyHighlightRotation();
    updateHighlightCurvature();
  }
  highlightLastTs = ts;
  highlightRAF = requestAnimationFrame(highlightTick);
}

// Mouse-wheel ("middle button scroll") rotation - deliberately low
// sensitivity so a normal scroll only nudges the ring a little; the
// continuous auto-spin keeps going underneath it regardless.
function onHighlightWheel(e) {
  if (!highlightStep) return;
  e.preventDefault();
  highlightAngle -= e.deltaY * 0.03;
  applyHighlightRotation();
  updateHighlightCurvature();
}

function buildHighlightCylinder() {
  highlightCards = getHighlightCards();
  const cylinder = el('highlight-cylinder');
  const n = highlightCards.length;

  if (!n) {
    highlightStep = 0;
    highlightTileMeta = [];
    cylinder.style.transform = 'none';
    cylinder.innerHTML = '<div class="highlight-empty">No rare cards found in this set - try refreshing card data or picking a different Set filter.</div>';
    el('highlight-cylinder-bg').innerHTML = '';
    return;
  }

  highlightStep = 360 / n;
  // Radius that keeps a full ring of ~320px-wide tiles from overlapping,
  // with a little extra breathing room (180 vs. the 160 half-width) so
  // neighboring tiles don't touch edge-to-edge - that gap is what makes the
  // per-tile rotation (and the curvature it implies) actually visible
  // instead of one tile's flat face hiding the next tile's turn.
  const radius = Math.max(680, Math.round(180 / Math.tan(Math.PI / n)));
  // The stage's `perspective` sets how strongly translateZ scales a tile's
  // apparent size - it has to scale WITH the radius (not stay fixed), or the
  // front tile (translated forward by the full radius) ends up zoomed huge
  // (perspective too close to radius) or behind the camera (perspective
  // smaller than radius). A 3D-transformed element gets rasterized then
  // scaled by the compositor rather than re-rendered at its final size, so
  // enlarging it much at all reads as soft/blurry text - 14x keeps the
  // front tile's zoom mild (~7%) instead of the ~25% a smaller multiplier
  // like 5x gives, which is what was making front-facing cards blurry.
  el('highlight-stage').style.perspective = `${radius * 14}px`;

  cylinder.innerHTML = highlightCards
    .map(
      (c, i) => `
    <div class="highlight-tile" data-card-id="${c.id}" style="transform: rotateY(${i * highlightStep}deg) translateZ(${radius}px)">
      <img src="${c.imageUrl}" alt="${c.displayName}" loading="lazy" />
      <div class="highlight-tile-label">${c.name}</div>
    </div>`
    )
    .join('');

  highlightTileMeta = [];
  cylinder.querySelectorAll('.highlight-tile').forEach((tile, i) => {
    tile.addEventListener('click', () => openHighlightDetail(tile.dataset.cardId));
    highlightTileMeta.push({ img: tile.querySelector('img'), baseAngle: i * highlightStep });
  });

  buildHighlightBackgroundRing(radius);

  highlightAngle = 0;
  applyHighlightRotation();
  updateHighlightCurvature();
}

// A different set of cards than the foreground ring - otherwise, spinning
// in sync at the same angles, it reads as the front ring's own shadow
// rather than a second ring of cards. Pulls whatever's left of the current
// Set's pool after the foreground ring's picks (falling back to the whole
// pool if that runs short) in a different order, and cycles through them if
// there are fewer than n.
function getHighlightBackgroundCards(n) {
  const usedIds = new Set(highlightCards.map((c) => c.id));
  const rest = getHighlightPool().filter((c) => !usedIds.has(c.id));
  const source = (rest.length ? rest : getHighlightPool()).slice().sort((a, b) => (a.id < b.id ? -1 : 1));
  if (!source.length) return [];
  return Array.from({ length: n }, (_, i) => source[i % source.length]);
}

// A second, wider ring of different cards (see .highlight-bg-wrap in
// style.css) - pushed back a static distance and offset half a step so it
// peeks out from the gaps/edges of the foreground ring, blurred and dimmed,
// and spun every frame in the OPPOSITE direction from the foreground ring
// via applyHighlightRotation, so it reads as its own distant ring of cards
// turning rather than an echo/shadow of the front one. Purely decorative -
// no click handling, no label.
function buildHighlightBackgroundRing(fgRadius) {
  const bgRadius = Math.round(fgRadius * 1.2);
  // Pushed back much further than it's widened, so its net depth (bgRadius
  // - bgPushBack) lands well behind the z=0 plane the foreground ring's
  // front card sits in front of - that's what makes perspective actually
  // shrink it (to roughly 3/4 scale) instead of it reading as just another,
  // barely-smaller ring at the same distance. Scaled up from a flat *3 now
  // that the stage's perspective itself is much larger (see the *14 in
  // buildHighlightCylinder) - otherwise the bigger perspective value alone
  // would flatten out the bg ring's apparent distance.
  const bgPushBack = Math.round(fgRadius * 6);
  el('highlight-bg-wrap').style.transform = `translateZ(-${bgPushBack}px)`;
  const bgCards = getHighlightBackgroundCards(highlightCards.length);
  el('highlight-cylinder-bg').innerHTML = bgCards
    .map(
      (c, i) => `
    <div class="highlight-tile-bg" style="transform: rotateY(${(i + 0.5) * highlightStep}deg) translateZ(${bgRadius}px)">
      <img src="${c.imageUrl}" alt="" loading="lazy" />
    </div>`
    )
    .join('');
}

function frontHighlightCardId() {
  if (!highlightCards.length || !highlightStep) return null;
  const n = highlightCards.length;
  const idx = Math.round((((-highlightAngle % 360) + 360) % 360) / highlightStep) % n;
  return highlightCards[idx].id;
}

function scheduleHighlightSpotlight() {
  clearTimeout(highlightSpotlightTimer);
  highlightSpotlightTimer = setTimeout(() => {
    if (!highlightPaused) {
      const cardId = frontHighlightCardId();
      if (cardId) openHighlightDetail(cardId, { auto: true });
    }
    scheduleHighlightSpotlight();
  }, HIGHLIGHT_SPOTLIGHT_INTERVAL_MS);
}

function otherPrintingsHtml(c) {
  const others = allCards
    .filter((x) => x.cardId === c.cardId && x.id !== c.id)
    .sort((a, b) => (a.set?.name || '').localeCompare(b.set?.name || ''));
  if (!others.length) return '';
  const rows = others
    .map((o) => `<div class="other-printing-row"><span>${o.set?.name || o.set?.code || 'Unknown set'}</span><span class="${rarityClass(o.rarity)}">${o.rarity || ''}</span></div>`)
    .join('');
  return `<div class="highlight-other-sets"><h4>Also Printed In</h4>${rows}</div>`;
}

function openHighlightDetail(cardId, opts = {}) {
  const c = highlightCards.find((x) => x.id === cardId) || allCards.find((x) => x.id === cardId);
  if (!c) return;

  highlightPaused = true;
  highlightDetailToken++;
  const myToken = highlightDetailToken;

  el('hd-img').src = c.imageUrl;
  el('hd-img').alt = c.displayName;
  el('hd-name').textContent = c.name;
  el('hd-subname').textContent = c.subname || '';
  el('hd-subname').hidden = !c.subname;

  const meta = [
    c.cost != null ? `Cost ${c.cost}` : '',
    c.power != null ? `Power ${c.power}` : '',
    c.ram != null ? `RAM ${c.ram}` : '',
    c.cardType,
    c.set?.name
  ]
    .filter(Boolean)
    .join(' · ');
  el('hd-meta').textContent = meta;

  const rarityEl = el('hd-rarity');
  rarityEl.textContent = c.rarity || '';
  rarityEl.className = `popped-rarity ${rarityClass(c.rarity)}`;

  el('hd-buckets').innerHTML = `
    <span class="bucket-pill bucket-main">Main ${getBucketCount(c.id, 'main')}</span>
    <span class="bucket-pill bucket-reserve">Reserve ${getBucketCount(c.id, 'reserve')}</span>
    <span class="bucket-pill bucket-extras">Extras ${getBucketCount(c.id, 'extras')}</span>
  `;

  el('hd-rules').innerHTML = renderRulesText(c.rulesText);
  el('hd-faq').innerHTML = faqHtml(c.slug);
  el('hd-other-sets').innerHTML = otherPrintingsHtml(c);

  const overlay = el('highlight-detail');
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add('open'));

  if (opts.auto) {
    setTimeout(() => {
      if (myToken === highlightDetailToken) closeHighlightDetail();
    }, HIGHLIGHT_SPOTLIGHT_DURATION_MS);
  }
}

function closeHighlightDetail() {
  const overlay = el('highlight-detail');
  overlay.classList.remove('open');
  setTimeout(() => {
    if (!overlay.classList.contains('open')) overlay.hidden = true;
  }, 200);
  highlightPaused = false;
}

function openHighlights() {
  buildHighlightCylinder();
  const overlay = el('highlight-overlay');
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add('open'));
  // The page's own scrollbar (for the main grid underneath) doesn't do
  // anything useful while this full-screen overlay is up - hide it so it's
  // not just sitting there inert on top of the cylinder view.
  document.body.classList.add('highlights-open');
  highlightLastTs = null;
  highlightPaused = false;
  cancelAnimationFrame(highlightRAF);
  highlightRAF = requestAnimationFrame(highlightTick);
  scheduleHighlightSpotlight();
}

function closeHighlights() {
  cancelAnimationFrame(highlightRAF);
  clearTimeout(highlightSpotlightTimer);
  document.body.classList.remove('highlights-open');
  const detail = el('highlight-detail');
  detail.classList.remove('open');
  detail.hidden = true;
  const overlay = el('highlight-overlay');
  overlay.classList.remove('open');
  setTimeout(() => {
    if (!overlay.classList.contains('open')) overlay.hidden = true;
  }, 250);
}

// Deck legality: a unique Legend only needs 1 copy in your Main set; every
// other card type (Unit/Gear/Program) can run up to 3.
function mainSetCap(cardType) {
  return cardType === 'Legend' ? 1 : 3;
}

// Only Main and Reserve get a "Max" shortcut - Extras is just raw
// inventory with no target count to jump to.
const BUCKETS = [
  { key: 'main', label: 'Main', showMax: true },
  { key: 'reserve', label: 'Rsv', showMax: true },
  { key: 'extras', label: 'Xtra', showMax: false }
];

// Each bucket gets its own border color; a card held in more than one
// bucket gets a banded border instead of a single color, stacked top to
// bottom in this fixed order so it reads the same way on every card.
const OWNERSHIP_BANDS = [
  { bucket: 'main', color: 'var(--yellow)', cls: 'own-main' },
  { bucket: 'extras', color: 'var(--purple)', cls: 'own-extras' },
  { bucket: 'reserve', color: 'var(--cyan)', cls: 'own-reserve' }
];

function ownershipVisual(cardId) {
  const active = OWNERSHIP_BANDS.filter((b) => getBucketCount(cardId, b.bucket) > 0);
  if (active.length === 0) return { cls: '', style: '' };
  if (active.length === 1) return { cls: active[0].cls, style: '' };

  const step = 100 / active.length;
  const stops = active
    .map((b, i) => `${b.color} ${(i * step).toFixed(2)}%, ${b.color} ${((i + 1) * step).toFixed(2)}%`)
    .join(', ');
  return { cls: 'own-multi', style: `--band-gradient: linear-gradient(to bottom, ${stops});` };
}

function sellCounterHtml(cardId) {
  const qty = tradeList[cardId] || 0;
  return `
            <span class="tile-sell ${qty ? 'active' : ''}" title="Copies listed on the website's trade page (capped at total owned)">
              <span class="mini-label">Sell</span>
              <button data-action="sell-dec" data-card-id="${cardId}">-</button>
              <span class="counter-value">${qty}</span>
              <button data-action="sell-inc" data-card-id="${cardId}">+</button>
            </span>`;
}

function cardTileHtml(c) {
  const visual = ownershipVisual(c.id);
  const total = getTotalCount(c.id);
  const cap = mainSetCap(c.cardType);
  const statLine = [
    c.cost != null ? `<span>CST ${c.cost}</span>` : '',
    c.power != null ? `<span>PWR ${c.power}</span>` : '',
    c.ram != null ? `<span>RAM ${c.ram}</span>` : ''
  ].join('');

  // Extras has no MAX button, so the trade page's Sell counter shares its row.
  const bucketRows = BUCKETS.map(
    ({ key, label, showMax }) => `
          <div class="mini-counter">
            <span class="mini-label">${label}</span>
            <button data-action="dec" data-bucket="${key}" data-card-id="${c.id}">-</button>
            <span class="counter-value">${getBucketCount(c.id, key)}</span>
            <button data-action="inc" data-bucket="${key}" data-card-id="${c.id}">+</button>
            ${showMax ? `<button class="mini-max-btn" data-action="setmax" data-bucket="${key}" data-cap="${cap}" data-card-id="${c.id}" title="Set ${label} to ${cap}">MAX</button>` : ''}
            ${key === 'extras' ? sellCounterHtml(c.id) : ''}
          </div>`
  ).join('');

  return `
    <div class="card-tile ${visual.cls}" style="${visual.style}" data-card-id="${c.id}">
      <div class="card-image-wrap">
        <div class="card-shimmer"></div>
        <img src="${c.imageUrl}" alt="${c.displayName}" loading="lazy" decoding="async" />
        ${total > 0 ? `<div class="owned-badge">${total}</div>` : ''}
        ${tradeList[c.id] ? `<div class="sell-badge" title="For sale on the trade page">SELL ${tradeList[c.id]}</div>` : ''}
      </div>
      <div class="color-bar ${c.color || ''}"></div>
      <div class="card-info">
        <div class="card-name">${c.name}</div>
        ${c.subname ? `<div class="card-subname">${c.subname}</div>` : ''}
        <div class="card-meta">${statLine}<span>${c.cardType}</span></div>
        <div class="card-rarity-row">
          <div class="card-rarity ${rarityClass(c.rarity)}">${c.rarity}</div>
          ${priceTagHtml(c)}
        </div>
        <div class="owned-controls">${bucketRows}
        </div>
      </div>
    </div>
  `;
}

async function onCounterClick(e) {
  const cardId = e.currentTarget.dataset.cardId;
  const action = e.currentTarget.dataset.action;
  const bucket = e.currentTarget.dataset.bucket;

  if (action === 'sell-inc' || action === 'sell-dec') {
    const current = tradeList[cardId] || 0;
    const next = action === 'sell-inc' ? Math.min(getTotalCount(cardId), current + 1) : Math.max(0, current - 1);
    if (next === current) return;
    tradeList = await window.api.setTradeQty(cardId, next);
    render();
    return;
  }

  let next;
  if (action === 'setmax') {
    next = Number(e.currentTarget.dataset.cap);
  } else {
    const current = getBucketCount(cardId, bucket);
    next = action === 'inc' ? current + 1 : Math.max(0, current - 1);
  }

  collection = await window.api.setCollection(cardId, bucket, next);
  render();
}

function updateStats() {
  // Stats track whichever Set is selected in the filter (all sets stay
  // selectable; this just decides what "owned" is measured against).
  const statCards = state.set === 'all' ? allCards : allCards.filter((c) => c.set?.code === state.set);
  const totalUnique = statCards.length;
  const ownedUnique = statCards.filter((c) => getTotalCount(c.id) > 0).length;
  const totalCopies = statCards.reduce((sum, c) => sum + getTotalCount(c.id), 0);
  const pct = totalUnique ? Math.round((ownedUnique / totalUnique) * 100) : 0;

  el('stat-owned').textContent = `${ownedUnique}/${totalUnique}`;
  el('stat-complete').textContent = `${pct}%`;
  el('stat-total-copies').textContent = totalCopies;

  const setName = state.set === 'all' ? 'All Sets' : (statCards[0]?.set?.name || state.set);
  el('stat-tracking').textContent = `Tracking: ${setName}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Electron's window.prompt() is unreliable (silently no-ops in some builds),
// which is why "Rename" used to do nothing. Renaming and destructive actions
// (restore/overwrite) use inline UI states on the item itself instead of any
// native dialog.
let backupUiState = { filename: null, mode: null };

async function refreshBackupList() {
  const backups = await window.api.listBackups();
  const container = el('backup-list');
  if (!backups.length) {
    container.innerHTML = '<div class="backup-empty">No saves yet</div>';
    return;
  }
  container.innerHTML = backups.map(backupItemHtml).join('');
  container.querySelectorAll('[data-backup-action]').forEach((btn) => {
    btn.addEventListener('click', onBackupAction);
  });
  container.querySelectorAll('.backup-label[data-renameable]').forEach((label) => {
    label.addEventListener('dblclick', () => {
      backupUiState = { filename: label.dataset.filename, mode: 'rename' };
      refreshBackupList();
    });
  });
  const renameInput = container.querySelector('.backup-rename-input');
  if (renameInput) {
    renameInput.focus();
    renameInput.select();
    renameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        container.querySelector('[data-backup-action="confirm-rename"]').click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        container.querySelector('[data-backup-action="cancel"]').click();
      }
    });
  }
}

function backupItemHtml(b) {
  const date = new Date(b.mtime).toLocaleString();
  const isActive = backupUiState.filename === b.filename;

  if (isActive && backupUiState.mode === 'rename') {
    return `
      <div class="backup-item ${b.locked ? 'locked' : ''}">
        <div class="backup-info">
          <input type="text" class="backup-rename-input" data-filename="${b.filename}" value="${escapeHtml(b.label || '')}" placeholder="${date}" />
        </div>
        <div class="backup-actions">
          <button data-backup-action="confirm-rename" data-filename="${b.filename}">Save</button>
          <button data-backup-action="cancel" data-filename="${b.filename}">Cancel</button>
        </div>
      </div>
    `;
  }

  if (isActive && (backupUiState.mode === 'confirm-restore' || backupUiState.mode === 'confirm-overwrite')) {
    const verb = backupUiState.mode === 'confirm-restore' ? 'Restore' : 'Overwrite';
    const confirmAction = backupUiState.mode === 'confirm-restore' ? 'confirm-restore' : 'confirm-overwrite';
    return `
      <div class="backup-item ${b.locked ? 'locked' : ''}">
        <div class="backup-info">
          <div class="backup-label">${b.label ? escapeHtml(b.label) : date}</div>
          <div class="backup-date">${verb} this save?</div>
        </div>
        <div class="backup-actions">
          <button class="backup-danger" data-backup-action="${confirmAction}" data-filename="${b.filename}">Yes, ${verb}</button>
          <button data-backup-action="cancel" data-filename="${b.filename}">Cancel</button>
        </div>
      </div>
    `;
  }

  return `
    <div class="backup-item ${b.locked ? 'locked' : ''}">
      <div class="backup-info">
        <div class="backup-label" data-renameable data-filename="${b.filename}" title="Double-click to rename">${b.label ? escapeHtml(b.label) : date}</div>
        ${b.label ? `<div class="backup-date">${date}</div>` : ''}
      </div>
      <div class="backup-actions">
        <button data-backup-action="ask-restore" data-filename="${b.filename}">Restore</button>
        <button data-backup-action="ask-overwrite" data-filename="${b.filename}">Overwrite</button>
        <button data-backup-action="lock" data-filename="${b.filename}" data-locked="${b.locked}">${b.locked ? 'Unlock' : 'Lock'}</button>
      </div>
    </div>
  `;
}

async function onSaveBackup() {
  const btn = el('save-backup-btn');
  btn.disabled = true;
  btn.textContent = 'Saving...';
  try {
    await window.api.backupCollection();
    await refreshBackupList();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}

async function onPublishSite() {
  const btn = el('publish-site-btn');
  const status = el('publish-status');
  btn.disabled = true;
  btn.textContent = 'Publishing...';
  status.hidden = false;
  status.className = 'publish-status';
  status.textContent = 'Pulling latest, applying any phone-recorded changes, and pushing...';
  try {
    const result = await window.api.publishSite();
    collection = result.collection;
    render();
    status.classList.add('publish-status-ok');
    status.textContent = result.steps.join(' ');
  } catch (err) {
    status.classList.add('publish-status-error');
    status.textContent = `Publish failed: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Publish Site';
  }
}

async function onBackupAction(e) {
  const action = e.currentTarget.dataset.backupAction;
  const filename = e.currentTarget.dataset.filename;

  if (action === 'ask-restore' || action === 'ask-overwrite') {
    backupUiState = { filename, mode: action === 'ask-restore' ? 'confirm-restore' : 'confirm-overwrite' };
    await refreshBackupList();
    return;
  }

  if (action === 'cancel') {
    backupUiState = { filename: null, mode: null };
    await refreshBackupList();
    return;
  }

  if (action === 'confirm-rename') {
    const input = document.querySelector(`.backup-rename-input[data-filename="${CSS.escape(filename)}"]`);
    const next = input ? input.value.trim() : '';
    await window.api.renameBackup(filename, next);
    backupUiState = { filename: null, mode: null };
    await refreshBackupList();
    return;
  }

  if (action === 'confirm-restore') {
    collection = await window.api.restoreBackup(filename);
    backupUiState = { filename: null, mode: null };
    await refreshBackupList();
    render();
    return;
  }

  if (action === 'confirm-overwrite') {
    await window.api.overwriteBackup(filename);
    backupUiState = { filename: null, mode: null };
    await refreshBackupList();
    return;
  }

  if (action === 'lock') {
    const isLocked = e.currentTarget.dataset.locked === 'true';
    await window.api.setBackupLocked(filename, !isLocked);
    await refreshBackupList();
    return;
  }
}

function attachControls() {
  el('win-minimize').addEventListener('click', () => window.api.windowMinimize());
  el('win-maximize').addEventListener('click', () => window.api.windowToggleMaximize());
  el('win-close').addEventListener('click', () => window.api.windowClose());
  el('refresh-btn').addEventListener('click', doRefresh);
  el('collection-view-btn').addEventListener('click', () => window.api.openCollectionView());
  el('deck-builder-btn').addEventListener('click', () => window.api.openDeckBuilder());
  el('trading-btn').addEventListener('click', () => window.api.openTrading());
  el('save-backup-btn').addEventListener('click', onSaveBackup);
  el('publish-site-btn').addEventListener('click', onPublishSite);
  el('search-input').addEventListener('input', (e) => {
    state.search = e.target.value;
    render();
  });
  el('ownership-filter').addEventListener('change', (e) => {
    state.ownership = e.target.value;
    render();
  });
  el('set-filter').addEventListener('change', (e) => {
    state.set = e.target.value;
    render();
  });
  el('sort-select').addEventListener('change', (e) => {
    state.sort = e.target.value;
    render();
  });
  el('popped-overlay').addEventListener('click', (e) => {
    if (e.target === el('popped-overlay')) closePopped();
  });
  el('popped-prev').addEventListener('click', (e) => {
    e.stopPropagation();
    stepPopped(-1);
  });
  el('popped-next').addEventListener('click', (e) => {
    e.stopPropagation();
    stepPopped(1);
  });
  document.addEventListener('keydown', (e) => {
    if (el('popped-overlay').classList.contains('open')) {
      if (e.key === 'Escape') closePopped();
      if (e.key === 'ArrowLeft') stepPopped(-1);
      if (e.key === 'ArrowRight') stepPopped(1);
      return;
    }
    if (e.key !== 'Escape') return;
    if (el('highlight-detail').classList.contains('open')) closeHighlightDetail();
    else if (el('highlight-overlay').classList.contains('open')) closeHighlights();
  });

  el('app-logo').addEventListener('click', () => {
    if (el('highlight-overlay').hidden) openHighlights();
    else closeHighlights();
  });
  el('highlight-close').addEventListener('click', closeHighlights);
  el('highlight-overlay').addEventListener('click', (e) => {
    if (e.target === el('highlight-overlay')) closeHighlights();
  });
  el('highlight-stage').addEventListener('wheel', onHighlightWheel, { passive: false });
  el('highlight-detail').addEventListener('click', (e) => {
    if (e.target === el('highlight-detail')) closeHighlightDetail();
  });
  el('highlight-detail-close').addEventListener('click', closeHighlightDetail);
}

attachControls();
init();
