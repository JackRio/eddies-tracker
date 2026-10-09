let allCards = [];
let collection = {};
let faqData = {};
let activeType = 'All';
let activeCompletion = 'all';
let activeSet = 'welcometonightcitybeta';
let activeBucket = 'main';

const COLORS = ['Red', 'Blue', 'Green', 'Yellow'];
const el = (id) => document.getElementById(id);

function rarityClass(rarity) {
  return 'rarity-' + String(rarity || '').toLowerCase().replace(/\s+/g, '-');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Card rulesText comes from the API with {Keyword} tokens (e.g. "{Call}",
// "{Go Solo}") standing in for the game's official badge icons. Swap each
// one for the matching SVG (scraped from cyberpunktcg.com's own rules-faq
// page, same icons/colors as the real cards) instead of showing the raw
// bracketed text.
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

function getBucketCount(cardId, bucket) {
  return collection[cardId]?.[bucket] || 0;
}

// Deck legality: a unique Legend only needs 1 copy in your Main set; every
// other card type (Unit/Gear/Program) can run up to 3. Keep in sync with
// the same helper in renderer.js.
function mainSetCap(cardType) {
  return cardType === 'Legend' ? 1 : 3;
}

function isFullSet(card) {
  return getBucketCount(card.id, activeBucket) >= mainSetCap(card.cardType);
}

function bucketLabel() {
  return activeBucket === 'main' ? 'Main' : 'Reserve';
}

function buildSetOptions() {
  const sets = [...new Map(allCards.map((c) => [c.set?.code, c.set])).values()].filter(Boolean);
  const select = el('set-filter');
  select.innerHTML = '<option value="all">All Sets</option>' +
    sets.map((s) => `<option value="${s.code}">${s.name}</option>`).join('');
  if (activeSet !== 'all' && !sets.some((s) => s.code === activeSet)) activeSet = 'all';
  // Force this explicitly - Chromium can restore a <select>'s prior value
  // on a fresh load of dynamically-populated options, overriding the
  // default we just set as the selected option.
  select.value = activeSet;
}

// --- Cardmarket prices (matching/fetching lives in src/prices.js). Kept in
// sync with the same helpers in renderer.js.
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
  const cache = await window.api.getCards();
  allCards = (cache && cache.cards) || [];
  collection = await window.api.getCollection();
  try {
    faqData = await fetch('faq-data.json').then((r) => r.json());
  } catch {
    faqData = {};
  }
  buildSetOptions();

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => selectType(btn.dataset.type));
  });
  document.querySelectorAll('.filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeCompletion = btn.dataset.filter;
      document.querySelectorAll('.filter-chip').forEach((b) => b.classList.toggle('active', b === btn));
      selectType(activeType);
    });
  });
  el('set-filter').addEventListener('change', (e) => {
    activeSet = e.target.value;
    selectType(activeType);
  });
  document.querySelectorAll('.bucket-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeBucket = btn.dataset.bucket;
      document.querySelectorAll('.bucket-toggle-btn').forEach((b) => b.classList.toggle('active', b === btn));
      selectType(activeType);
    });
  });
  document.querySelectorAll('.rarity-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const rarity = btn.dataset.rarity;
      const turningOff = activeRarityFilter === rarity;
      document.querySelectorAll('.rarity-filter-btn').forEach((b) => b.classList.remove('active'));
      activeRarityFilter = turningOff ? null : rarity;
      if (!turningOff) btn.classList.add('active');
      applyRarityHighlight();
    });
  });
  el('close-btn').addEventListener('click', () => window.api.overlayClose());
  el('win-minimize').addEventListener('click', () => window.api.windowMinimize());
  el('win-maximize').addEventListener('click', () => window.api.windowToggleMaximize());
  el('win-close').addEventListener('click', () => window.api.windowClose());
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
    if (e.key === 'Escape') closePopped();
    if (!el('popped-overlay').classList.contains('open')) return;
    if (e.key === 'ArrowLeft') stepPopped(-1);
    if (e.key === 'ArrowRight') stepPopped(1);
  });

  selectType('All');
  loadPrices();
}

function selectType(type) {
  activeType = type;
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.type === type);
  });

  const typeCards = allCards.filter(
    (c) => (type === 'All' || c.cardType === type) && (activeSet === 'all' || c.set?.code === activeSet)
  );

  // All four completion modes read the *active* bucket (Main or Reserve),
  // same as the toggle implies: Missing means "0 in this bucket", not "0
  // everywhere" - so switching to Reserve Set shows what's missing from
  // Reserve specifically, even if those cards are fully stocked in Main.
  const shownCards = typeCards.filter((c) => {
    const count = getBucketCount(c.id, activeBucket);
    if (activeCompletion === 'missing') return count === 0;
    if (count === 0) return false;
    if (activeCompletion === 'full') return isFullSet(c);
    if (activeCompletion === 'partial') return !isFullSet(c);
    return true;
  });

  const queuedCardEls = [];
  COLORS.forEach((color) => {
    const rowCards = shownCards
      .filter((c) => c.color === color)
      .sort((a, b) => a.name.localeCompare(b.name));
    queuedCardEls.push(...renderRow(color, rowCards));
  });
  loadCardImagesQueued(queuedCardEls);
  // Rows were just rebuilt from scratch, so any pinned ghosts are pointing
  // at detached elements - clear and reapply against the fresh DOM.
  applyRarityHighlight();
}

// One edge-autoscroll loop per row; re-rendering a row (tab/filter switch)
// must cancel its previous loop or it'd keep ticking against a detached node.
const edgeScrollCleanup = {};

function renderRow(color, cards) {
  if (edgeScrollCleanup[color]) {
    edgeScrollCleanup[color]();
    delete edgeScrollCleanup[color];
  }

  const stackEl = document.querySelector(`.fan-stack[data-row="${color}"]`);
  if (!cards.length) {
    const emptyMessage = activeCompletion === 'missing'
      ? `Nothing missing from your ${bucketLabel()} set`
      : `No cards in your ${bucketLabel()} set yet`;
    stackEl.innerHTML = `<div class="fan-empty">${emptyMessage}</div>`;
    return [];
  }
  // data-src, not src: assigning src is what actually triggers the browser
  // to fetch/decode the image. Doing that for every card in the tab at once
  // (which used to happen here) is what froze the UI on first load - the
  // CSS entrance stagger only delayed each card's *opacity*, not the real
  // work. loadCardImagesQueued() below assigns src in small batches instead.
  stackEl.innerHTML = cards
    .map(
      (c, i) => `
      <div class="fan-card" data-id="${c.id}" data-rarity="${c.rarity || ''}" style="z-index:${i + 1}; --enter-delay:${Math.min(i * 20, 500)}ms">
        <div class="card-shimmer"></div>
        <img data-src="${c.imageUrl}" alt="${c.displayName}" decoding="async" />
      </div>`
    )
    .join('');
  attachFanInteractions(stackEl, cards);
  edgeScrollCleanup[color] = attachEdgeAutoScroll(stackEl);
  return [...stackEl.querySelectorAll('.fan-card')];
}

const IMAGE_LOAD_CONCURRENCY = 8;

function loadCardImage(card) {
  return new Promise((resolve) => {
    const img = card.querySelector('img');
    const src = img.dataset.src;
    if (!src) return resolve();
    const done = () => {
      img.classList.add('loaded');
      card.classList.add('img-loaded');
      resolve();
    };
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
    img.src = src;
  });
}

async function loadCardImagesQueued(cardEls) {
  let index = 0;
  async function worker() {
    while (index < cardEls.length) {
      await loadCardImage(cardEls[index++]);
    }
  }
  await Promise.all(Array.from({ length: IMAGE_LOAD_CONCURRENCY }, worker));
}

// No visible scrollbar (see .fan-stack in collection.css) - instead, the row
// pans itself while the cursor sits near its left/right edge and there's
// still more to reveal, like a carousel. Speed ramps up the closer the
// cursor gets to the very edge.
const EDGE_ZONE = 90;
const EDGE_MAX_SPEED = 14;

function attachEdgeAutoScroll(stackEl) {
  let dir = 0;
  let speed = 0;
  let rafId = null;

  function tick() {
    if (dir !== 0) stackEl.scrollLeft += dir * speed;
    rafId = requestAnimationFrame(tick);
  }

  function onMouseMove(e) {
    const rect = stackEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const maxScroll = stackEl.scrollWidth - stackEl.clientWidth;

    if (x < EDGE_ZONE && stackEl.scrollLeft > 0) {
      dir = -1;
      speed = EDGE_MAX_SPEED * (1 - Math.max(x, 0) / EDGE_ZONE);
    } else if (x > rect.width - EDGE_ZONE && stackEl.scrollLeft < maxScroll) {
      dir = 1;
      speed = EDGE_MAX_SPEED * Math.min((x - (rect.width - EDGE_ZONE)) / EDGE_ZONE, 1);
    } else {
      dir = 0;
    }
  }

  function onMouseLeave() {
    dir = 0;
  }

  stackEl.addEventListener('mousemove', onMouseMove);
  stackEl.addEventListener('mouseleave', onMouseLeave);
  rafId = requestAnimationFrame(tick);

  return () => {
    dir = 0;
    if (rafId) cancelAnimationFrame(rafId);
    stackEl.removeEventListener('mousemove', onMouseMove);
    stackEl.removeEventListener('mouseleave', onMouseLeave);
  };
}

// The row that holds the fan is a horizontal-scroll container (overflow-x:
// auto), and CSS forces overflow-y to clip too whenever overflow-x isn't
// "visible" - so a raised, scaled-up card gets its top sliced off by that
// invisible boundary no matter how much padding the row is given. The fix
// is to lift the hovered card into a `position: fixed` "ghost" appended to
// <body>, i.e. outside every clipping ancestor, positioned exactly over the
// real card and then animated - the real card's own image just fades out
// underneath so nothing visually duplicates.
let ghostEl = null;

function ensureGhost() {
  if (ghostEl) return ghostEl;
  ghostEl = document.createElement('div');
  ghostEl.className = 'fan-ghost';
  ghostEl.innerHTML = '<img alt="" />';
  document.body.appendChild(ghostEl);
  return ghostEl;
}

function showGhost(cardEl) {
  const rect = cardEl.getBoundingClientRect();
  const ghost = ensureGhost();
  const cardImg = cardEl.querySelector('img');
  // If this card's turn in the load queue hasn't come up yet, its <img> has
  // no src - fall back to data-src so hovering doesn't show a blank ghost.
  ghost.querySelector('img').src = cardImg.src || cardImg.dataset.src;
  ghost.style.left = `${rect.left}px`;
  ghost.style.top = `${rect.top}px`;
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost.classList.add('visible');
  requestAnimationFrame(() => ghost.classList.add('raised'));
}

function hideGhost() {
  if (!ghostEl) return;
  ghostEl.classList.remove('raised', 'visible');
}

function attachFanInteractions(stackEl, rowCards) {
  const cardEls = [...stackEl.querySelectorAll('.fan-card')];
  cardEls.forEach((card, i) => {
    card.addEventListener('mouseenter', () => {
      // Already permanently raised by the rarity sidebar - don't also spawn
      // the mouse-following hover ghost on top of its own pinned ghost.
      if (card.classList.contains('pinned-source')) return;
      card.classList.add('hovered');
      showGhost(card);
      cardEls.forEach((other, j) => {
        if (other === card) return;
        const dist = j - i;
        if (dist < 0 && dist >= -3) other.classList.add('push-left');
        if (dist > 0 && dist <= 3) other.classList.add('push-right');
      });
    });
    card.addEventListener('mouseleave', () => {
      card.classList.remove('hovered');
      hideGhost();
      cardEls.forEach((other) => other.classList.remove('push-left', 'push-right'));
    });
    card.addEventListener('click', (e) => {
      e.stopPropagation();
      openPopped(card.dataset.id, rowCards);
    });
  });
}

// Rarity sidebar: pops every card matching the selected rarity up at once,
// reusing the same fixed-position ghost trick hover uses (so it isn't
// clipped by the row's horizontal-scroll container), but persistent across
// mouse movement instead of following the cursor. Multiple pinned ghosts
// can be up simultaneously (unlike the single shared hover ghost).
let activeRarityFilter = null;
const pinnedGhosts = new Map();

// The 9 raw rarity values collapse to the 7 official tiers shown on the
// sidebar - all three "Iconic ..." rarities share one Iconic button.
function rarityMatchesFilter(cardRarity, filterKey) {
  if (!cardRarity) return false;
  if (filterKey === 'Iconic') return cardRarity.startsWith('Iconic');
  return cardRarity === filterKey;
}

function pinCard(cardEl) {
  const cardId = cardEl.dataset.id;
  if (pinnedGhosts.has(cardId)) return;
  const rect = cardEl.getBoundingClientRect();
  const cardImg = cardEl.querySelector('img');
  const ghost = document.createElement('div');
  ghost.className = 'fan-ghost pinned';
  ghost.innerHTML = '<img alt="" />';
  ghost.querySelector('img').src = cardImg.src || cardImg.dataset.src;
  ghost.style.left = `${rect.left}px`;
  ghost.style.top = `${rect.top}px`;
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  document.body.appendChild(ghost);
  requestAnimationFrame(() => ghost.classList.add('visible', 'raised'));
  pinnedGhosts.set(cardId, ghost);
  cardEl.classList.add('pinned-source');
}

function unpinAll() {
  for (const ghost of pinnedGhosts.values()) {
    ghost.classList.remove('raised', 'visible');
    setTimeout(() => ghost.remove(), 200);
  }
  pinnedGhosts.clear();
  document.querySelectorAll('.fan-card.pinned-source').forEach((el) => el.classList.remove('pinned-source'));
}

function applyRarityHighlight() {
  unpinAll();
  if (!activeRarityFilter) return;
  document.querySelectorAll('.fan-card').forEach((cardEl) => {
    if (rarityMatchesFilter(cardEl.dataset.rarity, activeRarityFilter)) pinCard(cardEl);
  });
}

// The row a popped card was opened from, so the nav arrows / arrow keys can
// step through the same set the user was browsing.
let poppedRowCards = [];
let poppedIndex = -1;

function stepPopped(delta) {
  if (!poppedRowCards.length) return;
  const next = (poppedIndex + delta + poppedRowCards.length) % poppedRowCards.length;
  openPopped(poppedRowCards[next].id, poppedRowCards);
}

function openPopped(cardId, rowCards) {
  const c = allCards.find((x) => x.id === cardId);
  if (!c) return;

  if (rowCards) poppedRowCards = rowCards;
  poppedIndex = poppedRowCards.findIndex((x) => x.id === cardId);

  el('popped-img').src = c.imageUrl;
  el('popped-img').alt = c.displayName;
  el('popped-name').textContent = c.name;
  el('popped-subname').textContent = c.subname || '';
  el('popped-subname').hidden = !c.subname;

  const main = getBucketCount(c.id, 'main');
  const reserve = getBucketCount(c.id, 'reserve');
  const extras = getBucketCount(c.id, 'extras');
  const cap = mainSetCap(c.cardType);
  const activeCount = getBucketCount(c.id, activeBucket);
  const completionLabel = activeCount >= cap ? 'Full Set' : `Partial — need ${cap - activeCount} more`;
  el('popped-buckets').innerHTML = `
    <div class="popped-bucket-row">
      <span class="bucket-pill bucket-main">Main ${main}</span>
      <span class="bucket-pill bucket-reserve">Reserve ${reserve}</span>
      <span class="bucket-pill bucket-extras">Extras ${extras}</span>
    </div>
    <div class="popped-completion">${activeCount}/${cap} for ${bucketLabel()} Set — ${completionLabel}</div>
  `;

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

  el('popped-price').innerHTML = priceSectionHtml(c);
  wirePriceSection(el('popped-price'), c, () => openPopped(c.id));

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
    overlay.hidden = true;
  }, 200);
}

init();
