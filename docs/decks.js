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

// --- List page (hero / grid / search) -------------------------------------
const COLORS = { Red: '#e8465a', Blue: '#3d8bfd', Green: '#3ecf6e', Yellow: '#e8c93a' };
const PIN_KEY = 'eddies_pinned_deck';
const activeColors = new Set();

const safeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const safeSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };

function extraStats(deck) {
  const s = computeDeckStats(deck);
  let costSum = 0, costN = 0;
  for (const [cid, qty] of Object.entries(deck.cards || {})) {
    const c = cardByCardId(cid);
    if (c && c.cost != null) { costSum += c.cost * qty; costN += qty; }
  }
  const legends = (deck.legendPrintingIds || []).filter((p) => p && cardDetails[p]);
  const legendColors = [...new Set(legends.map((p) => cardDetails[p].color).filter(Boolean))];
  return { ...s, avg: costN ? costSum / costN : 0, legends, legendColors };
}

const fanHtml = (s) => s.legends.map((p) => `<img src="${imageUrl(p)}" alt="${escapeHtml(cardDetails[p].displayName)}" data-zoom="${escapeHtml(p)}" loading="lazy">`).join('');
const dotsHtml = (s) => `<span class="dots">${s.legendColors.map((c) => `<span class="dot" style="background:${COLORS[c]}" title="${c}"></span>`).join('')}</span>`;
const accent = (s) => `--accent1:${COLORS[s.legendColors[0]] || 'var(--yellow)'}`;

function curveHtml(s) {
  const ks = [0, 1, 2, 3, 4, 5, 6, 7];
  const max = Math.max(1, ...ks.map((k) => s.costCounts[k] || 0));
  return `<div class="curve-wrap"><div class="curve">${ks.map((k) => `<i style="height:${Math.max(4, (s.costCounts[k] || 0) / max * 100)}%" title="${k === 7 ? '7+' : k}: ${s.costCounts[k] || 0}"></i>`).join('')}</div>
    <div class="curve-labels">${ks.map((k) => `<span>${k === 7 ? '7+' : k}</span>`).join('')}</div></div>`;
}

function pillsHtml(s, full) {
  const t = (n) => s.typeCounts[n] || 0;
  return `<span class="pill ${s.total >= MAIN_DECK_MIN && s.total <= MAIN_DECK_MAX ? 'ok' : 'warn'}"><b>${s.total}</b> cards</span>
    <span class="pill"><b>${t('Unit')}</b> Unit · <b>${t('Gear')}</b> Gear · <b>${t('Program')}</b> Prog</span>
    <span class="pill">avg cost <b>${s.avg.toFixed(1)}</b></span>
    <span class="pill"><b>${s.sellablePct}%</b> sellable</span>${full ? dotsHtml(s) : ''}`;
}

function excerpt(d) {
  const raw = d.descSections?.overview || d.description || '';
  return raw.replace(/<[^>]+>/g, '').replace(/@\[+@?\[?([^\]|]+)(?:\|([^\]]+))?\]+/g, (_, n, a) => a || n).trim();
}

// Plain-text decklist (main + sideboard) for pasting into chat / other tools.
function decklistText(deck) {
  const line = (cid, qty) => `${qty} ${cardByCardId(cid)?.displayName || cardByCardId(cid)?.name || cid}`;
  const body = (map) => Object.entries(map || {}).filter(([, q]) => q > 0).map(([cid, q]) => line(cid, q));
  const out = [`# ${deck.name || 'Untitled Deck'}`, '', 'Legends'];
  (deck.legendCardIds || []).filter(Boolean).forEach((cid) => out.push(line(cid, 1)));
  out.push('', 'Main', ...body(deck.cards));
  const side = body(deck.sideboard);
  if (side.length) out.push('', 'Sideboard', ...side);
  return out.join('\n');
}

async function flash(btn, text) {
  const old = btn.dataset.label || btn.textContent;
  btn.dataset.label = old;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1300);
}
async function copyText(text, btn, msg) {
  try { await navigator.clipboard.writeText(text); flash(btn, msg || 'Copied'); }
  catch { flash(btn, 'Copy failed'); }
}
const shareUrl = (id) => new URL(`decks.html?id=${encodeURIComponent(id)}`, location.href).href;

// ---- LIST ---------------------------------------------------------------
function matches(deck, s, q) {
  if (activeColors.size && ![...activeColors].some((c) => s.legendColors.includes(c))) return false;
  if (!q) return true;
  const names = Object.keys(deck.cards || {}).concat(Object.keys(deck.sideboard || {})).map((c) => cardByCardId(c)?.displayName || '').join(' ');
  const lg = s.legends.map((p) => cardDetails[p].displayName).join(' ');
  return `${deck.name} ${lg} ${names}`.toLowerCase().includes(q);
}

function renderList() {
  const q = document.getElementById('q').value.trim().toLowerCase();
  const sort = document.getElementById('sort').value;
  const pinned = safeGet(PIN_KEY);
  let list = publishedDecks.map((d) => ({ d, s: extraStats(d) })).filter(({ d, s }) => matches(d, s, q));

  const byUpdated = (a, b) => (b.d.updatedAt || 0) - (a.d.updatedAt || 0);
  if (sort === 'recent') list.sort(byUpdated);
  else if (sort === 'name') list.sort((a, b) => a.d.name.localeCompare(b.d.name));
  else if (sort === 'cost') list.sort((a, b) => a.s.avg - b.s.avg);
  else if (sort === 'size') list.sort((a, b) => b.s.total - a.s.total);
  else list.sort((a, b) => (b.d.id === pinned) - (a.d.id === pinned) || byUpdated(a, b));

  document.getElementById('count').textContent = list.length;
  const showFeatured = sort === 'default' && !q && !activeColors.size && list.length > 1;
  const feat = showFeatured ? list.shift() : null;
  const featEl = document.getElementById('featured');
  featEl.innerHTML = feat ? `
    <div class="featured clip hoverable" style="${accent(feat.s)}" data-open="${feat.d.id}">
      <div class="tag">${feat.d.id === pinned ? 'PINNED' : 'FEATURED'}</div>
      <div class="legend-fan">${fanHtml(feat.s)}</div>
      <div>
        <h2>${escapeHtml(feat.d.name)}</h2>
        <p class="blurb">${escapeHtml(excerpt(feat.d)) || 'No description yet.'}</p>
        <div class="stat-row">${pillsHtml(feat.s, true)}</div>
        ${curveHtml(feat.s)}
        ${actionsHtml(feat.d, pinned)}
      </div>
    </div>` : '';

  const grid = document.getElementById('deck-list-grid');
  grid.innerHTML = list.map(({ d, s }) => `
    <div class="deck clip hoverable" style="${accent(s)}" data-open="${d.id}">
      <h3>${escapeHtml(d.name || 'Untitled Deck')}</h3>
      <div class="sub"><span>${dotsHtml(s)}</span><span>${s.total}/${MAIN_DECK_MAX} · ${s.sellablePct}% sellable</span></div>
      <div class="legend-fan">${fanHtml(s)}</div>
      <div class="row-between">${curveHtml(s)}<span class="pill">avg <b>${s.avg.toFixed(1)}</b></span></div>
      <p class="excerpt">${escapeHtml(excerpt(d))}</p>
      ${actionsHtml(d, pinned)}
    </div>`).join('');

  const empty = document.getElementById('decks-empty');
  const none = !featEl.innerHTML && !list.length;
  empty.hidden = !none;
  if (none) empty.textContent = publishedDecks.length ? 'No decks match your search or filters.' : 'No decks are published right now. Check back soon.';
}

function actionsHtml(d, pinned) {
  return `<div class="actions">
    <button class="btn" data-copy="${d.id}">Copy list</button>
    <button class="btn" data-share="${d.id}">Share</button>
    <button class="btn ${d.id === pinned ? 'on' : ''}" data-pin="${d.id}">${d.id === pinned ? 'Unpin' : 'Pin'}</button>
  </div>`;
}

// Delegated clicks for both list and featured areas.
document.getElementById('decks-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn) {
    e.stopPropagation();
    const deck = (id) => publishedDecks.find((d) => d.id === id);
    if (btn.dataset.copy) return copyText(decklistText(deck(btn.dataset.copy)), btn);
    if (btn.dataset.share) return copyText(shareUrl(btn.dataset.share), btn, 'Link copied');
    if (btn.dataset.pin) {
      safeSet(PIN_KEY, safeGet(PIN_KEY) === btn.dataset.pin ? null : btn.dataset.pin);
      return renderList();
    }
    return;
  }
  const card = e.target.closest('[data-open]');
  if (card) showDetail(card.dataset.open);
});

function showList() {
  currentDeck = null;
  history.replaceState(null, '', 'decks.html');
  document.getElementById('deck-detail').hidden = true;
  document.getElementById('decks-list').hidden = false;
  renderList();
}

// ---- Init -----------------------------------------------------------------
async function init() {
  renderBuildInfo();
  try {
    [publishedDecks, cardDetails] = await Promise.all([
      fetchJson('data/published-decks.json').catch(() => []),
      fetchJson('data/deck-card-details.json').catch(() => ({}))
    ]);
  } catch (err) {
    document.getElementById('deck-list-grid').innerHTML = '';
    const e = document.getElementById('decks-empty'); e.hidden = false; e.textContent = `Couldn't load decks: ${err.message}`;
    return;
  }
  document.getElementById('color-chips').innerHTML = Object.keys(COLORS).map((c) => `<button class="chip color-${c}" data-c="${c}">${c}</button>`).join('');
  document.getElementById('color-chips').addEventListener('click', (e) => {
    const c = e.target.dataset.c; if (!c) return;
    activeColors.has(c) ? activeColors.delete(c) : activeColors.add(c);
    e.target.classList.toggle('active'); renderList();
  });
  document.getElementById('q').addEventListener('input', renderList);
  document.getElementById('sort').addEventListener('change', renderList);
  document.getElementById('back-to-decks-link').addEventListener('click', (e) => { e.preventDefault(); showList(); });
  addEventListener('keydown', (e) => {
    if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement.tagName) && !document.getElementById('decks-list').hidden) {
      e.preventDefault(); document.getElementById('q').focus();
    }
  });
  const id = new URLSearchParams(location.search).get('id');
  if (id && publishedDecks.some((d) => d.id === id)) showDetail(id); else showList();
}

function showDetail(deckId) {
  const deck = publishedDecks.find((d) => d.id === deckId);
  if (!deck) return;
  currentDeck = deck;
  viewPlanId = null;
  history.replaceState(null, '', `decks.html?id=${encodeURIComponent(deckId)}`);
  el('decks-list').hidden = true;
  el('deck-detail').hidden = false;
  renderDetail(deck);
  window.scrollTo({ top: 0 });
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
    .map((p, i) => `<img class="deck-tile-layer" style="top: ${i * TILE_RAISE_PX}px; z-index: ${i + 1}" src="${imageUrl(p.id)}" alt="${escapeHtml(p.displayName)}" data-zoom="${escapeHtml(p.id)}" loading="lazy" />`)
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

// --- Description sections (ported from deckbuilder.js) --------------------

const DESC_SECTIONS = [
  { title: 'Overview', open: true, cls: '', fields: [{ key: 'overview' }] },
  { title: 'Game Plan', cls: '', fields: [{ key: 'early', label: 'Early' }, { key: 'mid', label: 'Mid' }, { key: 'late', label: 'Late' }] },
  { title: 'Key Cards', cls: 'dd-combo', fields: [{ key: 'combos' }] },
  { title: 'Mulligan', cls: '', fields: [{ key: 'mulligan', label: 'Keep / toss' }, { key: 'mulliganFirst', label: 'Going first' }, { key: 'mulliganSecond', label: 'Going second' }] },
  { title: 'Sideboard', cls: 'dd-side', fields: [{ key: 'sideboard' }] },
  { title: 'Notes', cls: '', fields: [{ key: 'notes' }] }
];

function renderDescTags(text) {
  return escapeHtml(text).replace(/@\[([^\]|]+)(?:\|([^\]]+))?\]/g, (_, name, alias) => `<span class="card-tag" data-card-tag="${name}">${alias || name}</span>`);
}

// One line per idea: a single line is a paragraph, several become a bullet
// list. Sections with several fields (Game Plan, Mulligan) get a label column.
// Duplicated from deckbuilder.js.
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
  const sections = DESC_SECTIONS.map((sec) => {
    const body = ddBodyHtml(sec, s);
    if (!body.trim()) return '';
    return `<details class="${sec.cls}" ${sec.open ? 'open' : ''}><summary>${sec.title}</summary><div class="dd-body">${body}</div></details>`;
  }).join('');
  return (deck.description ? `<div class="dd-legacy">${deck.description}</div>` : '') + sections;
}

// Hover zoom: shows an enlarged card next to the cursor for
//  - @[Card] tags in the description (looked up by display name; the publish
//    step makes sure every tagged card has a printing + image), and
//  - any element carrying data-zoom="<printing id>" (Legends, every decklist
//    tile layer, the Legend fans on the deck list).
// Skipped on touch devices, which have no hover.
const canHover = window.matchMedia?.('(hover: hover)').matches ?? true;

document.addEventListener('mousemove', (e) => {
  if (!canHover) return;
  let pop = document.getElementById('card-tag-pop');
  const zoomEl = e.target.closest?.('[data-zoom]');
  const tag = !zoomEl && e.target.closest?.('[data-card-tag]');
  const cardId = zoomEl
    ? zoomEl.dataset.zoom
    : tag && Object.values(cardDetails).find((c) => c.displayName === tag.dataset.cardTag)?.id;
  if (!cardId) {
    if (pop) pop.hidden = true;
    return;
  }
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'card-tag-pop';
    pop.className = 'card-tag-pop';
    pop.innerHTML = '<img alt="" />';
    document.body.appendChild(pop);
  }
  const img = pop.querySelector('img');
  if (img.getAttribute('src') !== imageUrl(cardId)) img.src = imageUrl(cardId);
  pop.hidden = false;
  // Beside the cursor; flip to its left near the right edge, keep fully on screen.
  // Size from the CSS width + card aspect ratio, not from the element: the image
  // may not have loaded yet on the first hover, which would measure ~0 tall.
  const w = Math.min(300, innerWidth * 0.38, ((innerHeight - 20) * 63) / 88);
  const h = Math.round((w * 88) / 63) + 4;
  const left = e.clientX + 18 + w > innerWidth - 8 ? e.clientX - 18 - w : e.clientX + 18;
  pop.style.left = `${Math.max(8, left)}px`;
  pop.style.top = `${Math.max(8, Math.min(e.clientY - h / 2, innerHeight - h - 8))}px`;
});
// Hide when the pointer leaves the page or the view scrolls out from under it.
document.addEventListener('mouseleave', () => document.getElementById('card-tag-pop')?.setAttribute('hidden', ''));
window.addEventListener('scroll', () => document.getElementById('card-tag-pop')?.setAttribute('hidden', ''), { passive: true });

// --- Detail rendering -------------------------------------------------

let viewPlanId = null;

function planById(deck, id) {
  return (deck.swapPlans || []).find((p) => p.id === id) || null;
}

// Main deck after a swap plan: swapped-out copies trade places with the
// swapped-in sideboard copies (ported from applyPlan in deckbuilder.js).
function applyPlan(deck, plan) {
  const cards = { ...deck.cards };
  const side = { ...(deck.sideboard || {}) };
  const inMap = {};
  const outMap = {};
  for (const s of plan?.swaps || []) {
    cards[s.out] = (cards[s.out] || 0) - s.qty;
    if (cards[s.out] <= 0) delete cards[s.out];
    cards[s.in] = (cards[s.in] || 0) + s.qty;
    side[s.in] = (side[s.in] || 0) - s.qty;
    if (side[s.in] <= 0) delete side[s.in];
    side[s.out] = (side[s.out] || 0) + s.qty;
    outMap[s.out] = (outMap[s.out] || 0) + s.qty;
    inMap[s.in] = (inMap[s.in] || 0) + s.qty;
  }
  return { deck: { ...deck, cards, sideboard: side }, inMap, outMap };
}

function swapBadgeHtml(inQty, outQty) {
  const parts = [];
  if (inQty) parts.push(`<span class="swap-badge-in">+${inQty} IN</span>`);
  if (outQty) parts.push(`<span class="swap-badge-out">${outQty} OUT</span>`);
  return parts.length ? `<div class="swap-badges">${parts.join('')}</div>` : '';
}

function renderPlanBar(base, plan) {
  const bar = el('detail-plans');
  const plans = base.swapPlans || [];
  bar.hidden = !plans.length;
  if (!plans.length) return;
  const chips = [`<button class="plan-chip ${!viewPlanId ? 'active' : ''}" data-plan="">Game 1 &middot; Main</button>`]
    .concat(plans.map((p) => `<button class="plan-chip ${viewPlanId === p.id ? 'active' : ''}" data-plan="${escapeHtml(p.id)}">&#8646; ${escapeHtml(p.name || 'Plan')} <span class="plan-chip-n">${p.swaps.reduce((s, x) => s + x.qty, 0)}</span></button>`))
    .join('');
  const summary = plan
    ? `<div class="plan-summary">${plan.swaps.map((s) => `<span><span class="plan-out">${escapeHtml(cardByCardId(s.out)?.name || '?')}</span> &#8644; <span class="plan-in">${escapeHtml(cardByCardId(s.in)?.name || '?')}</span>${s.qty > 1 ? ` &times;${s.qty}` : ''}</span>`).join('')}</div>`
    : '';
  bar.innerHTML = `<div class="plan-chips">${chips}</div>${summary}`;
  bar.querySelectorAll('[data-plan]').forEach((btn) =>
    btn.addEventListener('click', () => {
      viewPlanId = btn.dataset.plan || null;
      renderDetail(currentDeck);
    })
  );
}

function renderDetail(baseDeck) {
  const plan = viewPlanId ? planById(baseDeck, viewPlanId) : null;
  const applied = plan ? applyPlan(baseDeck, plan) : { deck: baseDeck, inMap: {}, outMap: {} };
  const deck = applied.deck;
  renderPlanBar(baseDeck, plan);
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

  el('detail-description').innerHTML = deckDescriptionHtml(deck);

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

  const withBadge = (html, badge) => (badge ? html.replace(/<\/div>\s*$/, `${badge}</div>`) : html);
  const mainSections = grouped
    .map((g) => {
      const tiles = g.entries
        .map((e) => withBadge(tileHtml(printingsForCardEntry(deck, e.cardId, e.qty), `title="${escapeHtml(e.card.name)} x${e.qty}"`), swapBadgeHtml(applied.inMap[e.cardId], 0)))
        .join('');
      return `<div class="deck-section"><h3>${escapeHtml(g.type)}s <span class="count-badge">${g.entries.reduce((s, e) => s + e.qty, 0)}</span></h3><div class="tile-grid">${tiles}</div></div>`;
    })
    .join('');

  const sideEntries = Object.entries(deck.sideboard || {})
    .map(([cardId, qty]) => ({ cardId, card: cardByCardId(cardId), qty }))
    .filter((e) => e.card)
    .sort((a, b) => COLOR_ORDER.indexOf(a.card.color) - COLOR_ORDER.indexOf(b.card.color) || a.card.name.localeCompare(b.card.name));
  const sideTotal = sideEntries.reduce((s, e) => s + e.qty, 0);
  const sideSection = sideTotal
    ? `<div class="deck-section"><h3>Sideboard <span class="count-badge">${sideTotal}/7</span></h3><div class="tile-grid">${sideEntries
        .map((e) => withBadge(tileHtml(Array(e.qty).fill(e.card), `title="${escapeHtml(e.card.name)} x${e.qty}"`), swapBadgeHtml(0, applied.outMap[e.cardId])))
        .join('')}</div></div>`
    : '';
  el('detail-card-sections').innerHTML = mainSections + sideSection;

  const s = extraStats(deck);
  const detail = document.getElementById('deck-detail');
  detail.style.cssText = accent(s);
  document.getElementById('detail-fan').innerHTML = fanHtml(extraStats(baseDeck));
  document.getElementById('detail-pills').innerHTML = pillsHtml(s, true);
  document.getElementById('btn-copy').onclick = (e) => copyText(decklistText(deck), e.currentTarget);
  document.getElementById('btn-share').onclick = (e) => copyText(shareUrl(baseDeck.id), e.currentTarget, 'Link copied');
  document.getElementById('btn-print').onclick = () => window.print();
  document.title = `${baseDeck.name || 'Deck'} — Eddies`;
}

init();
