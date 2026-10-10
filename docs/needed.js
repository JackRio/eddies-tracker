let neededData = { main: [], reserve: [] };
let pendingChanges = [];
let catalog = [];

let state = {
  bucket: 'main',
  colors: new Set(),
  types: new Set(),
  rarities: new Set(),
  set: 'welcometonightcitybeta',
  unique: false,
  search: '',
  sort: 'default'
};

const COLOR_ORDER = ['Red', 'Blue', 'Green', 'Yellow'];
const TYPE_ORDER = ['Legend', 'Unit', 'Gear', 'Program'];

// The 9 raw rarity values collapse to the 7 official tiers (icons), matching
// collection.js's rarity sidebar - all three "Iconic ..." rarities share one
// Iconic icon/button.
const RARITY_GROUPS = [
  { key: 'Common', title: 'Common', icon: 'common', match: ['Common'] },
  { key: 'Uncommon', title: 'Uncommon', icon: 'uncommon', match: ['Uncommon'] },
  { key: 'Rare', title: 'Rare', icon: 'rare', match: ['Rare'] },
  { key: 'Epic', title: 'Epic Rare', icon: 'epic', match: ['Epic'] },
  { key: 'Secret', title: 'Secret Rare', icon: 'secret-rare', match: ['Secret'] },
  { key: 'Iconic', title: 'Iconic Rare', icon: 'iconic-rare', match: ['Iconic Legend', 'Iconic Other', 'Iconic Secret'] },
  { key: 'Nova Rare', title: 'Nova Rare', icon: 'nova-rare', match: ['Nova Rare'] }
];

const el = (id) => document.getElementById(id);

function rarityClass(rarity) {
  return 'rarity-' + String(rarity || '').toLowerCase().replace(/\s+/g, '-');
}

async function init() {
  renderBuildInfo();
  try {
    [neededData, pendingChanges, catalog] = await Promise.all([
      fetchJson('data/needed.json'),
      fetchJson('data/pending-changes.json'),
      fetchJson('data/catalog.json').catch(() => [])
    ]);
  } catch (err) {
    el('empty-state').hidden = false;
    el('empty-state').textContent = `Couldn't load data: ${err.message}`;
    return;
  }

  keyById = new Map(catalog.map((c) => [c.id, `${c.displayName || c.name}|${c.rulesText || c.cardId}`]));
  buildFilterOptions();
  attachControls();
  render();
  renderBuildInfo(neededData.generatedAt);

  // Fires when another tab on this device (i.e. the Record page) changes
  // localStorage - lets an already-open Needed tab reflect a just-staged
  // trade without needing a manual reload.
  window.addEventListener('storage', (e) => {
    if (e.key === 'eddies_staged_deltas') render();
  });
}

function buildFilterOptions() {
  const all = [...neededData.main, ...neededData.reserve];
  const colors = [...new Set(all.map((c) => c.color).filter(Boolean))]
    .sort((a, b) => COLOR_ORDER.indexOf(a) - COLOR_ORDER.indexOf(b));
  const types = [...new Set(all.map((c) => c.cardType).filter(Boolean))]
    .sort((a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b));
  const presentRarities = new Set(all.map((c) => c.rarity).filter(Boolean));
  const rarityGroups = RARITY_GROUPS.filter((g) => g.match.some((r) => presentRarities.has(r)));
  const sets = [...new Map(all.map((c) => [c.set?.code, c.set])).values()].filter(Boolean);

  renderChipGroup('color-filters', colors, state.colors, (v) => `color-${v}`);
  renderChipGroup('type-filters', types, state.types, (v) => `type-${v}`);
  renderRarityFilters(rarityGroups);

  const select = el('set-filter');
  select.innerHTML = '<option value="all">All Sets</option>' +
    sets.map((s) => `<option value="${s.code}">${s.name}</option>`).join('');
  if (sets.some((s) => s.code === state.set)) select.value = state.set;
  else state.set = 'all';
}

function renderChipGroup(containerId, values, activeSet, extraClass) {
  const container = el(containerId);
  container.innerHTML = values
    .map((v) => `<div class="chip ${extraClass ? extraClass(v) : ''}" data-value="${v}">${v}</div>`)
    .join('');
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

function renderRarityFilters(groups) {
  const container = el('rarity-filters');
  container.innerHTML = groups
    .map((g) => `
      <button class="rarity-filter-btn" data-value="${g.key}" title="${g.title}">
        <span class="rarity-icon rarity-icon-${g.icon}"></span>
      </button>
    `)
    .join('');
  container.querySelectorAll('.rarity-filter-btn').forEach((btn) => {
    if (state.rarities.has(btn.dataset.value)) btn.classList.add('active');
    btn.addEventListener('click', () => {
      const val = btn.dataset.value;
      if (state.rarities.has(val)) state.rarities.delete(val);
      else state.rarities.add(val);
      btn.classList.toggle('active');
      render();
    });
  });
}

function attachControls() {
  document.querySelectorAll('#bucket-toggle button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.bucket = btn.dataset.bucket;
      document.querySelectorAll('#bucket-toggle button').forEach((b) => b.classList.toggle('active', b === btn));
      render();
    });
  });
  const toggleUnique = () => {
    state.unique = !state.unique;
    el('unique-filter').classList.toggle('active', state.unique);
    render();
  };
  el('unique-filter').addEventListener('click', toggleUnique);
  el('unique-filter').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleUnique(); }
  });
  el('set-filter').addEventListener('change', (e) => {
    state.set = e.target.value;
    render();
  });
  el('search').addEventListener('input', (e) => {
    state.search = e.target.value.trim().toLowerCase();
    render();
  });
  el('sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    render();
  });
  el('filter-clear').addEventListener('click', () => {
    state.colors.clear();
    state.types.clear();
    state.rarities.clear();
    state.unique = false;
    state.set = 'all';
    el('unique-filter').classList.remove('active');
    buildFilterOptions();
    render();
  });

  // Desktop shows the filter panel as a sidebar (always open); on a phone it
  // starts collapsed so the cards come first.
  const wide = window.matchMedia('(min-width: 960px)');
  const syncFilters = () => { el('filters').open = wide.matches; };
  syncFilters();
  wide.addEventListener('change', syncFilters);
}

// Pending changes recorded on the Record page (not yet pulled into the
// desktop app) haven't regenerated needed.json yet, so we adjust the
// last-published numbers client-side - keeps this page feeling live. This
// also counts deltas the Record page has only *staged* locally and hasn't
// committed to GitHub yet (see stageDelta() in shared.js) - same origin,
// same localStorage, so a card recorded a second ago on this same device
// disappears here immediately, not just after its background sync commit.
function pendingDeltaFor(id, bucket) {
  const committed = pendingChanges
    .filter((c) => c.id === id && c.bucket === bucket)
    .reduce((sum, c) => sum + (c.delta || 0), 0);
  return committed + stagedDeltaFor(id, bucket);
}

// Cards that read the same (same name + rules text) are one "mechanical"
// card no matter how many printings/rarities exist.
// needed.json entries lack rulesText, so keys are resolved through the catalog by id.
let keyById = new Map();
function mechKey(c) {
  return keyById.get(c.id) || `${c.displayName || c.name}|${c.cardId}`;
}

// Lowest rarity first; Iconic variants and Nova Rare are the priciest tiers.
const RARITY_RANK = ['Common', 'Uncommon', 'Rare', 'Epic', 'Secret', 'Iconic Other', 'Iconic Legend', 'Iconic Secret', 'Nova Rare'];
function rarityRank(r) {
  const i = RARITY_RANK.indexOf(r);
  return i === -1 ? RARITY_RANK.length : i;
}

// Total copies owned in the bucket across every printing of each mechanical
// card (catalog snapshot + pending/staged deltas).
function ownedByMechKey(bucket) {
  const owned = new Map();
  for (const c of catalog) {
    const k = mechKey(c);
    owned.set(k, (owned.get(k) || 0) + (c[bucket] || 0) + pendingDeltaFor(c.id, bucket));
  }
  return owned;
}

// Collapse to one entry per mechanical card: needed = cap - total owned over
// all printings, shown as the lowest-rarity printing that passes `keep`.
function collapseUnique(cards, keep) {
  const owned = ownedByMechKey(state.bucket);
  const best = new Map();
  for (const c of cards) {
    if (!keep(c)) continue;
    const k = mechKey(c);
    const cur = best.get(k);
    if (!cur || rarityRank(c.rarity) < rarityRank(cur.rarity) ||
        (rarityRank(c.rarity) === rarityRank(cur.rarity) && (c.price ?? Infinity) < (cur.price ?? Infinity))) {
      best.set(k, c);
    }
  }
  return [...best.entries()]
    .map(([k, c]) => ({ ...c, needed: Math.max(0, c.cap - (owned.get(k) || 0)) }))
    .filter((c) => c.needed > 0);
}

const SORTERS = {
  'default': (a, b) =>
    COLOR_ORDER.indexOf(a.color) - COLOR_ORDER.indexOf(b.color) ||
    TYPE_ORDER.indexOf(a.cardType) - TYPE_ORDER.indexOf(b.cardType) ||
    a.name.localeCompare(b.name),
  'price-desc': (a, b) => (b.price ?? -1) - (a.price ?? -1) || a.name.localeCompare(b.name),
  'price-asc': (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity) || a.name.localeCompare(b.name),
  'needed': (a, b) => b.needed - a.needed || a.name.localeCompare(b.name),
  'rarity': (a, b) => rarityRank(b.rarity) - rarityRank(a.rarity) || a.name.localeCompare(b.name),
  'name': (a, b) => a.name.localeCompare(b.name)
};

function render() {
  const source = state.bucket === 'main' ? neededData.main : neededData.reserve;

  const activeGroups = RARITY_GROUPS.filter((g) => state.rarities.has(g.key));
  const passesSet = (c) => state.set === 'all' || c.set?.code === state.set;
  const passesRarity = (c) => !state.rarities.size || activeGroups.some((g) => g.match.includes(c.rarity));
  const passesOther = (c) =>
    (!state.colors.size || state.colors.has(c.color)) && (!state.types.size || state.types.has(c.cardType));
  const passesSearch = (c) =>
    !state.search || `${c.displayName || ''} ${c.name} ${c.subname || ''}`.toLowerCase().includes(state.search);

  let cards;
  if (state.unique && catalog.length) {
    // Rarity filter applies to the chosen (lowest) printing, set filter
    // narrows which printings are candidates; ownership counts all printings.
    cards = collapseUnique(source, (c) => passesSet(c) && passesOther(c)).filter((c) => passesRarity(c) && passesSearch(c));
  } else {
    cards = source
      .map((c) => ({ ...c, needed: Math.max(0, c.needed - pendingDeltaFor(c.id, state.bucket)) }))
      .filter((c) => c.needed > 0 && passesSet(c) && passesOther(c) && passesRarity(c) && passesSearch(c));
  }

  cards.sort(SORTERS[state.sort] || SORTERS.default);

  // Rough "what would buying the rest cost" - Cardmarket trend x copies
  // still needed, only over cards that have a price at all.
  const total = cards.reduce((sum, c) => sum + (c.price != null ? c.price * c.needed : 0), 0);
  const copies = cards.reduce((sum, c) => sum + c.needed, 0);
  const unpriced = cards.filter((c) => c.price == null).length;
  el('stat-cards').textContent = cards.length.toLocaleString();
  el('stat-copies').textContent = copies.toLocaleString();
  el('stat-cost').textContent = total ? `~${formatEur(total)}` : '–';
  el('stat-cost-label').textContent = unpriced && total ? `est. on Cardmarket (${unpriced} unpriced)` : 'est. on Cardmarket';
  el('result-count').textContent = `Showing ${cards.length.toLocaleString()} card${cards.length === 1 ? '' : 's'}`;

  const filterCount = state.colors.size + state.types.size + state.rarities.size +
    (state.set !== 'all' ? 1 : 0) + (state.unique ? 1 : 0);
  el('filter-count').hidden = !filterCount;
  el('filter-count').textContent = filterCount;
  el('filter-clear').hidden = !filterCount;

  el('empty-state').hidden = cards.length !== 0;
  const grid = el('card-grid');
  grid.innerHTML = cards.map(cardHtml).join('');
  stagger(grid);
}

// Cardmarket trend price snapshot, written into needed.json/catalog.json by
// the desktop app's Publish (see priceFieldsFor in src/main.js).
function formatEur(v) {
  return `€${v >= 100 ? Math.round(v) : v.toFixed(2)}`;
}

function cardHtml(c) {
  const safeName = c.name.replace(/'/g, '&#39;');
  const imgTag = `<img src="images/${c.id}.webp" alt="${c.displayName}" loading="lazy" onerror="this.closest('.need-card-img-wrap').classList.add('no-image'); this.insertAdjacentHTML('afterend', '<span>${safeName}</span>'); this.remove();" />`;
  return `
    <a class="need-card" href="record.html?id=${encodeURIComponent(c.id)}&bucket=${state.bucket}">
      <div class="need-card-img-wrap">
        ${imgTag}
      </div>
      <div class="need-card-info">
        <div class="need-badge">Need ${c.needed}</div>
        <div class="need-card-name">${c.name}</div>
        ${c.subname ? `<div class="need-card-subname">${c.subname}</div>` : ''}
        <div class="need-card-meta ${rarityClass(c.rarity)}">${c.rarity} · ${c.set?.name || ''}</div>
        ${c.price != null ? `<div class="need-card-price${c.priceGuess ? ' price-guess' : ''}" title="Cardmarket trend${c.priceGuess ? ' (best-guess match)' : ''}">${formatEur(c.price)}${c.priceGuess ? '?' : ''}</div>` : ''}
      </div>
    </a>
  `;
}

init();
