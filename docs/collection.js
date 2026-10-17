let pendingChanges = [];
let catalog = [];

const VIEWS = ['lg', 'md', 'sm', 'list'];
const STATUSES = [
  { key: 'all', label: 'All' },
  { key: 'full', label: 'Full' },
  { key: 'partial', label: 'Partial' },
  { key: 'missing', label: 'Missing' }
];

let state = {
  bucket: 'main',
  status: 'all',
  colors: new Set(),
  types: new Set(),
  rarities: new Set(),
  set: 'welcometonightcitybeta',
  unique: false,
  search: '',
  sort: 'default',
  view: 'list'
};

const COLOR_ORDER = ['Red', 'Blue', 'Green', 'Yellow'];
const TYPE_ORDER = ['Legend', 'Unit', 'Gear', 'Program'];

// The 9 raw rarity values collapse to the 7 official tiers (same as the old
// Needed page), so all three "Iconic ..." rarities share one button.
const RARITY_GROUPS = [
  { key: 'Common', title: 'Common', icon: 'common', match: ['Common'] },
  { key: 'Uncommon', title: 'Uncommon', icon: 'uncommon', match: ['Uncommon'] },
  { key: 'Rare', title: 'Rare', icon: 'rare', match: ['Rare'] },
  { key: 'Epic', title: 'Epic Rare', icon: 'epic', match: ['Epic'] },
  { key: 'Secret', title: 'Secret Rare', icon: 'secret-rare', match: ['Secret'] },
  { key: 'Iconic', title: 'Iconic Rare', icon: 'iconic-rare', match: ['Iconic Legend', 'Iconic Other', 'Iconic Secret'] },
  { key: 'Nova Rare', title: 'Nova Rare', icon: 'nova-rare', match: ['Nova Rare'] }
];

// Lowest rarity first.
const RARITY_RANK = ['Common', 'Uncommon', 'Rare', 'Epic', 'Secret', 'Iconic Other', 'Iconic Legend', 'Iconic Secret', 'Nova Rare'];
const rarityRank = (r) => { const i = RARITY_RANK.indexOf(r); return i === -1 ? RARITY_RANK.length : i; };

const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const rarityClass = (rarity) => 'rarity-' + String(rarity || '').toLowerCase().replace(/\s+/g, '-');
const mechKey = (c) => `${c.displayName || c.name}|${c.rulesText || c.cardId}`;

function loadView() {
  try {
    const v = localStorage.getItem('eddies_collection_view2');
    if (VIEWS.includes(v)) state.view = v;
  } catch { /* storage unavailable */ }
}

async function init() {
  renderBuildInfo();
  loadView();
  try {
    [catalog, pendingChanges] = await Promise.all([
      fetchJson('data/catalog.json'),
      fetchJson('data/pending-changes.json').catch(() => [])
    ]);
  } catch (err) {
    el('empty-state').hidden = false;
    el('empty-state').textContent = `Couldn't load data: ${err.message}`;
    return;
  }

  buildFilterOptions();
  attachControls();
  render();

  // Another tab on this device (the Record page) staged a trade.
  window.addEventListener('storage', (e) => {
    if (e.key === 'eddies_staged_deltas') render();
  });
}

function buildFilterOptions() {
  const colors = [...new Set(catalog.map((c) => c.color).filter(Boolean))]
    .sort((a, b) => COLOR_ORDER.indexOf(a) - COLOR_ORDER.indexOf(b));
  const types = [...new Set(catalog.map((c) => c.cardType).filter(Boolean))]
    .sort((a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b));
  const present = new Set(catalog.map((c) => c.rarity).filter(Boolean));
  const rarityGroups = RARITY_GROUPS.filter((g) => g.match.some((r) => present.has(r)));
  const sets = [...new Map(catalog.map((c) => [c.set?.code, c.set])).values()].filter(Boolean);

  renderStatusFilters();
  renderChipGroup('color-filters', colors, state.colors, (v) => `color-${v}`);
  renderChipGroup('type-filters', types, state.types, (v) => `type-${v}`);
  renderRarityFilters(rarityGroups);

  const select = el('set-filter');
  select.innerHTML = '<option value="all">All Sets</option>' +
    sets.map((s) => `<option value="${esc(s.code)}">${esc(s.name)}</option>`).join('');
  select.value = sets.some((s) => s.code === state.set) ? state.set : 'all';
  state.set = select.value;
}

function renderStatusFilters() {
  const container = el('status-filters');
  container.innerHTML = STATUSES
    .map((s) => `<div class="chip${state.status === s.key ? ' active' : ''}" data-value="${s.key}" role="button" tabindex="0">${s.label}</div>`)
    .join('');
  container.querySelectorAll('.chip').forEach((chip) => {
    const pick = () => {
      state.status = chip.dataset.value;
      container.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
      render();
    };
    chip.addEventListener('click', pick);
    chip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
    });
  });
}

function renderChipGroup(containerId, values, activeSet, extraClass) {
  const container = el(containerId);
  container.innerHTML = values
    .map((v) => `<div class="chip ${extraClass ? extraClass(v) : ''}" data-value="${esc(v)}">${esc(v)}</div>`)
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
  const syncView = () => document.querySelectorAll('#view-toggle button')
    .forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  document.querySelectorAll('#view-toggle button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.view = btn.dataset.view;
      try { localStorage.setItem('eddies_collection_view2', state.view); } catch { /* ignore */ }
      syncView();
      render();
    });
  });
  syncView();

  const toggleUnique = () => {
    state.unique = !state.unique;
    el('unique-filter').classList.toggle('active', state.unique);
    render();
  };
  el('unique-filter').addEventListener('click', toggleUnique);
  el('unique-filter').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleUnique(); }
  });
  el('set-filter').addEventListener('change', (e) => { state.set = e.target.value; render(); });
  el('search').addEventListener('input', (e) => { state.search = e.target.value.trim().toLowerCase(); render(); });
  el('sort').addEventListener('change', (e) => { state.sort = e.target.value; render(); });
  el('filter-clear').addEventListener('click', () => {
    state.status = 'all';
    state.colors.clear();
    state.types.clear();
    state.rarities.clear();
    state.unique = false;
    state.set = 'welcometonightcitybeta';
    el('unique-filter').classList.remove('active');
    buildFilterOptions();
    render();
  });

  // Desktop: filters are an always-open sidebar. Phone: collapsed.
  const wide = window.matchMedia('(min-width: 960px)');
  const syncFilters = () => { el('filters').open = wide.matches; };
  syncFilters();
  wide.addEventListener('change', syncFilters);
}

// Deltas recorded on the Record page that the desktop app hasn't published
// yet (committed to GitHub, or only staged on this device).
function pendingDeltaFor(id, bucket) {
  const committed = pendingChanges
    .filter((c) => c.id === id && c.bucket === bucket)
    .reduce((sum, c) => sum + (c.delta || 0), 0);
  return committed + stagedDeltaFor(id, bucket);
}

const qtyOf = (c, bucket) => Math.max(0, (c[bucket] || 0) + pendingDeltaFor(c.id, bucket));

// One entry per mechanical card: total owned across every printing, shown as
// the printing you hold most of (ties: lowest rarity, then cheapest).
function collapseUnique(rows, keep) {
  const totals = new Map();
  for (const c of rows) totals.set(mechKey(c), (totals.get(mechKey(c)) || 0) + c.qty);
  const best = new Map();
  for (const c of rows) {
    if (!keep(c)) continue;
    const k = mechKey(c);
    const cur = best.get(k);
    const better = !cur || c.qty > cur.qty ||
      (c.qty === cur.qty && (rarityRank(c.rarity) < rarityRank(cur.rarity) ||
        (rarityRank(c.rarity) === rarityRank(cur.rarity) && (c.price ?? Infinity) < (cur.price ?? Infinity))));
    if (better) best.set(k, c);
  }
  return [...best.entries()].map(([k, c]) => ({ ...c, qty: totals.get(k) || 0 }));
}

const statusOf = (c) => (c.qty <= 0 ? 'missing' : c.qty >= c.cap ? 'full' : 'partial');

const byName = (a, b) => a.name.localeCompare(b.name);
const SORTERS = {
  'default': (a, b) =>
    COLOR_ORDER.indexOf(a.color) - COLOR_ORDER.indexOf(b.color) ||
    TYPE_ORDER.indexOf(a.cardType) - TYPE_ORDER.indexOf(b.cardType) || byName(a, b),
  'qty': (a, b) => b.qty - a.qty || byName(a, b),
  'rarity': (a, b) => rarityRank(b.rarity) - rarityRank(a.rarity) || byName(a, b),
  'name': byName
};

function render() {
  const activeGroups = RARITY_GROUPS.filter((g) => state.rarities.has(g.key));
  const passesSet = (c) => state.set === 'all' || c.set?.code === state.set;
  const passesRarity = (c) => !state.rarities.size || activeGroups.some((g) => g.match.includes(c.rarity));
  const passesOther = (c) =>
    (!state.colors.size || state.colors.has(c.color)) && (!state.types.size || state.types.has(c.cardType));
  const passesSearch = (c) =>
    !state.search || `${c.displayName || ''} ${c.name} ${c.subname || ''}`.toLowerCase().includes(state.search);
  const passesStatus = (c) => state.status === 'all' || statusOf(c) === state.status;

  const rows = catalog.map((c) => ({ ...c, qty: qtyOf(c, state.bucket) }));
  let cards;
  if (state.unique) {
    cards = collapseUnique(rows, (c) => passesSet(c) && passesOther(c))
      .filter((c) => passesRarity(c) && passesSearch(c) && passesStatus(c));
  } else {
    cards = rows.filter((c) => passesSet(c) && passesOther(c) && passesRarity(c) && passesSearch(c) && passesStatus(c));
  }
  cards.sort(SORTERS[state.sort] || SORTERS.default);

  const copies = cards.reduce((sum, c) => sum + c.qty, 0);
  el('stat-cards').textContent = cards.length.toLocaleString();
  el('stat-copies').textContent = copies.toLocaleString();
  el('result-count').textContent = `Showing ${cards.length.toLocaleString()} card${cards.length === 1 ? '' : 's'}`;

  const filterCount = (state.status !== 'all' ? 1 : 0) + state.colors.size + state.types.size +
    state.rarities.size + (state.set !== 'all' ? 1 : 0) + (state.unique ? 1 : 0);
  el('filter-count').hidden = !filterCount;
  el('filter-count').textContent = filterCount;
  el('filter-clear').hidden = !filterCount;

  el('empty-state').hidden = cards.length !== 0;
  const grid = el('card-grid');
  const list = el('own-list');
  const isList = state.view === 'list';
  grid.hidden = isList;
  list.hidden = !isList;
  if (isList) {
    list.innerHTML = cards.length ? listHtml(cards) : '';
  } else {
    grid.className = `card-grid size-${state.view}`;
    grid.innerHTML = cards.map(tileHtml).join('');
    stagger(grid);
  }
}

const hrefFor = (c) => `#card-${c.id}`;

function tileHtml(c) {
  const img = `<img src="images/${c.id}.webp" alt="${esc(c.displayName)}" loading="lazy" onerror="this.closest('.need-card-img-wrap').classList.add('no-image'); this.remove();" />`;
  return `
    <a class="need-card own-${statusOf(c)}" href="${hrefFor(c)}" data-card="${c.id}" title="${esc(c.displayName)} · ${c.qty}/${c.cap}">
      <div class="need-card-img-wrap">
        ${img}
        <span class="own-qty">${c.qty}<small>/${c.cap}</small></span>
      </div>
      <div class="need-card-info">
        <div class="need-card-name">${esc(c.name)}</div>
        ${c.subname ? `<div class="need-card-subname">${esc(c.subname)}</div>` : ''}
        <div class="need-card-meta ${rarityClass(c.rarity)}">${esc(c.rarity)} · ${esc(c.set?.name || '')}</div>
      </div>
    </a>
  `;
}

// Which rarity groups are minimized (kept per device).
let collapsed = new Set();
try { collapsed = new Set(JSON.parse(localStorage.getItem('eddies_collection_collapsed') || '[]')); } catch { /* ignore */ }
function saveCollapsed() {
  try { localStorage.setItem('eddies_collection_collapsed', JSON.stringify([...collapsed])); } catch { /* ignore */ }
}

const PIC_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-5-5-8 9"/></svg>';

function rowHtml(c) {
  const num = c.collectorNumber ? `<span class="own-num">(${esc(c.collectorNumber)})</span>` : '';
  return `
    <div class="own-row own-${statusOf(c)}">
      <span class="own-name">
        <button type="button" class="own-pic" data-id="${c.id}" aria-label="Show ${esc(c.displayName)}">${PIC_ICON}</button>
        <a href="${hrefFor(c)}" data-card="${c.id}">${num}<b>${esc(c.name)}</b>${c.subname ? `<i>${esc(c.subname)}</i>` : ''}
          <span class="own-set-m">${esc(c.set?.name || '')}</span></a>
      </span>
      <span class="own-col-set">${esc(c.set?.name || '')}</span>
      <span class="own-col-qty">${c.qty}<small>/${c.cap}</small></span>
    </div>`;
}

// List view: one collapsible section per rarity tier, common first.
function listHtml(cards) {
  const label = state.bucket === 'main' ? 'Main' : 'Reserve';
  const sections = RARITY_GROUPS.map((g) => ({ g, rows: cards.filter((c) => g.match.includes(c.rarity)) }))
    .filter((s) => s.rows.length);
  return sections.map(({ g, rows }) => {
    const shut = collapsed.has(g.key);
    const copies = rows.reduce((n, c) => n + c.qty, 0);
    return `
      <section class="rar-group${shut ? ' shut' : ''}" data-key="${g.key}">
        <button type="button" class="rar-head" aria-expanded="${!shut}">
          <span class="rarity-icon rarity-icon-${g.icon}"></span>
          <span class="rar-title">${g.title}</span>
          <span class="rar-count">${rows.length} cards · ${copies} ${label}</span>
          <span class="rar-caret" aria-hidden="true"></span>
        </button>
        <div class="rar-body"${shut ? ' hidden' : ''}>${rows.map(rowHtml).join('')}</div>
      </section>`;
  }).join('');
}

// Collapse/expand rarity sections.
el('own-list').addEventListener('click', (e) => {
  const head = e.target.closest('.rar-head');
  if (!head) return;
  const group = head.closest('.rar-group');
  const shut = !group.classList.contains('shut');
  group.classList.toggle('shut', shut);
  head.setAttribute('aria-expanded', String(!shut));
  group.querySelector('.rar-body').hidden = shut;
  if (shut) collapsed.add(group.dataset.key); else collapsed.delete(group.dataset.key);
  saveCollapsed();
});

// Card preview: follows the pointer on desktop hover/focus; on touch a tap
// opens it centered and any tap closes it.
const pop = document.createElement('div');
pop.id = 'card-pop';
pop.hidden = true;
pop.innerHTML = '<img alt="" />';
document.body.appendChild(pop);
const canHover = window.matchMedia('(hover: hover)').matches;

function showPop(id) {
  const img = pop.firstChild;
  img.src = `images/${id}.webp`;
  pop.hidden = false;
}
function hidePop() { pop.hidden = true; pop.classList.remove('centered'); }
function placePop(x, y) {
  const w = pop.offsetWidth, h = pop.offsetHeight;
  let left = x + 22;
  if (left + w > window.innerWidth - 8) left = x - w - 22;
  const top = Math.max(8, Math.min(y - h / 2, window.innerHeight - h - 8));
  pop.style.left = `${Math.max(8, left)}px`;
  pop.style.top = `${top}px`;
}

const picOf = (e) => e.target.closest?.('.own-pic');
document.addEventListener('mouseover', (e) => {
  const pic = picOf(e);
  if (!pic || !canHover) return;
  showPop(pic.dataset.id);
  placePop(e.clientX, e.clientY);
});
document.addEventListener('mousemove', (e) => {
  if (!pop.hidden && !pop.classList.contains('centered')) placePop(e.clientX, e.clientY);
});
document.addEventListener('mouseout', (e) => {
  if (picOf(e) && canHover) hidePop();
});
document.addEventListener('click', (e) => {
  const pic = picOf(e);
  if (pic && !canHover) {
    e.preventDefault();
    showPop(pic.dataset.id);
    pop.classList.add('centered');
    pop.style.left = '';
    pop.style.top = '';
    return;
  }
  if (!pop.hidden) hidePop();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePop(); });
window.addEventListener('scroll', () => { if (canHover) hidePop(); }, { passive: true });

// ---- Card view popup ---------------------------------------------------
let faqData = {};
let faqLoaded = false;

function renderRulesText(text) {
  if (!text) return '';
  return String(text)
    .split(/(\{[^}]+\})/g)
    .map((part) => {
      const m = part.match(/^\{([^}]+)\}$/);
      if (!m) return esc(part);
      const slug = m[1].toLowerCase().replace(/\s+/g, '-');
      return `<img class="keyword-icon" src="assets/keywords/${slug}.svg" alt="${esc(m[1])}" title="${esc(m[1])}">`;
    })
    .join('');
}

function faqHtml(slug) {
  const entry = faqData[slug];
  if (!entry || !entry.faqs?.length) return '';
  return `<div class="popped-faq"><h4>Rules FAQ</h4>${entry.faqs
    .map((f) => `<div class="faq-item"><div class="faq-q">${renderRulesText(f.q)}</div><div class="faq-a">${renderRulesText(f.a)}</div></div>`)
    .join('')}</div>`;
}

const modal = document.createElement('div');
modal.id = 'card-modal';
modal.hidden = true;
modal.setAttribute('role', 'dialog');
modal.setAttribute('aria-modal', 'true');
document.body.appendChild(modal);
let lastFocus = null;

async function openCard(id) {
  const c = catalog.find((x) => x.id === id);
  if (!c) return;
  hidePop();
  if (!faqLoaded) {
    faqLoaded = true;
    try { faqData = await fetchJson('data/faq.json'); } catch { faqData = {}; }
  }
  const n = (b) => qtyOf(c, b);
  const stat = (label, v) => (v == null || v === '' ? '' : `<span class="cm-stat"><small>${label}</small>${esc(v)}</span>`);
  modal.innerHTML = `
    <div class="cm-box">
      <button type="button" class="cm-close" aria-label="Close">&times;</button>
      <img class="cm-art" src="images/${c.id}.webp" alt="${esc(c.displayName)}" />
      <div class="cm-info">
        <h2>${esc(c.name)}</h2>
        ${c.subname ? `<div class="cm-sub">${esc(c.subname)}</div>` : ''}
        <div class="cm-meta ${rarityClass(c.rarity)}">${c.collectorNumber ? `(${esc(c.collectorNumber)}) · ` : ''}${esc(c.rarity)} · ${esc(c.set?.name || '')}</div>
        <div class="cm-stats">${stat('Type', c.cardType)}${stat('Color', c.color)}${stat('Cost', c.cost)}${stat('Power', c.power)}${stat('RAM', c.ram)}</div>
        <div class="cm-owned">
          <div class="${state.bucket === 'main' ? 'on' : ''}"><small>Main</small><b>${n('main')}</b>/${c.cap}</div>
          <div class="${state.bucket === 'reserve' ? 'on' : ''}"><small>Reserve</small><b>${n('reserve')}</b>/${c.cap}</div>
          <div><small>Extras</small><b>${qtyOf(c, 'extras')}</b></div>
        </div>
        ${c.rulesText ? `<div class="cm-rules">${renderRulesText(c.rulesText)}</div>` : ''}
        ${faqHtml(c.slug)}
      </div>
    </div>`;
  lastFocus = document.activeElement;
  modal.hidden = false;
  document.body.classList.add('modal-open');
  modal.querySelector('.cm-close').focus();
  modal.querySelector('.cm-art').onerror = (e) => e.target.remove();
}

function closeCard() {
  if (modal.hidden) return;
  modal.hidden = true;
  document.body.classList.remove('modal-open');
  lastFocus?.focus?.();
}

modal.addEventListener('click', (e) => {
  if (e.target === modal || e.target.closest('.cm-close')) closeCard();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCard(); });
document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-card]');
  if (!link) return;
  e.preventDefault();
  openCard(link.dataset.card);
});

init();
