// Trading window: one pool of suggested cards (filtered), added with one click
// to either the Looking list (looking-list.json) or the Selling list (the same
// trade-list.json the main window's Sell controls write). Both lists are
// published to docs/data/looking.json / trade.json by "Publish Site".

const COLOR_ORDER = ['Red', 'Blue', 'Green', 'Yellow'];
const TYPE_ORDER = ['Legend', 'Unit', 'Gear', 'Program'];
// Lowest -> highest rarity. Used to pick the lowest-tier printing to look for.
const RARITY_RANK = ['Common', 'Uncommon', 'Rare', 'Epic', 'Secret', 'Iconic Other', 'Iconic Legend', 'Iconic Secret', 'Nova Rare'];
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
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

let allCards = [];
let collection = {};
let priceView = null;
let trade = {};
let looking = {};
let groups = new Map(); // mechKey -> printings[]
let byId = new Map();

const state = {
  view: 'B',
  suggest: 'all',
  colors: new Set(),
  types: new Set(),
  rarities: new Set(),
  minPrice: 10,
  set: 'all',
  sort: 'price',
  search: ''
};

// Keep in sync with mainSetCap() elsewhere and mechKey() in main.js/docs/trading.js.
const mainSetCap = (type) => (type === 'Legend' ? 1 : 3);
const mechKey = (c) => `${c.displayName || c.name}|${c.rulesText || c.cardId}`;
const rarityRank = (r) => {
  const i = RARITY_RANK.indexOf(r);
  return i === -1 ? RARITY_RANK.length : i;
};
const rarityIconClass = (r) => RARITY_GROUPS.find((g) => g.match.includes(r))?.icon || 'common';
const iconHtml = (r) => `<span class="rarity-icon rarity-icon-${rarityIconClass(r)}"></span>`;

function formatEur(v) {
  if (v == null) return '—';
  return `€${v >= 100 ? Math.round(v).toLocaleString('en') : v.toFixed(2)}`;
}
function headlinePrice(p) {
  return p ? p.trend ?? p.low ?? p.trendFoil ?? p.lowFoil ?? null : null;
}
function priceOf(c) {
  const m = priceView?.matches?.[c.id];
  const p = m && m.idProduct != null ? priceView.products[m.idProduct] : null;
  return headlinePrice(p);
}

const owned = (c, bucket) => (collection[c.id] || {})[bucket] || 0;
const ownedAll = (c) => owned(c, 'main') + owned(c, 'reserve') + owned(c, 'extras');
const groupSum = (key, fn) => (groups.get(key) || []).reduce((sum, c) => sum + fn(c), 0);

function buildGroups() {
  groups = new Map();
  byId = new Map();
  for (const c of allCards) {
    byId.set(c.id, c);
    const k = mechKey(c);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
}

const needQty = (c) => mainSetCap(c.cardType) - groupSum(mechKey(c), (x) => owned(x, 'main'));

function lowest(printings) {
  return printings.slice().sort((a, b) =>
    rarityRank(a.rarity) - rarityRank(b.rarity) || (priceOf(a) ?? Infinity) - (priceOf(b) ?? Infinity))[0];
}

// A "spare upgrade": selling one copy of this (pricier) printing still leaves
// the card at or above its cap across every rarity, and a cheaper-rarity
// printing of it is owned to stand in for it.
function spareInfo(c) {
  if (ownedAll(c) < 1) return null;
  const key = mechKey(c);
  if (groupSum(key, ownedAll) - 1 < mainSetCap(c.cardType)) return null;
  const subs = groups.get(key).filter((x) => x.id !== c.id && ownedAll(x) > 0 &&
    rarityRank(x.rarity) < rarityRank(c.rarity) && (priceOf(x) ?? 0) < (priceOf(c) ?? 0));
  return subs.length ? lowest(subs) : null;
}

function passesFilters(c) {
  if (state.colors.size && !state.colors.has(c.color)) return false;
  if (state.types.size && !state.types.has(c.cardType)) return false;
  if (state.rarities.size && !RARITY_GROUPS.some((g) => state.rarities.has(g.key) && g.match.includes(c.rarity))) return false;
  if (state.set !== 'all' && c.set?.code !== state.set) return false;
  if (state.search && !c.displayName.toLowerCase().includes(state.search)) return false;
  return (priceOf(c) ?? 0) >= state.minPrice;
}

function getPool() {
  const items = [];
  const lookingKeys = new Set(Object.keys(looking).map((id) => byId.get(id)).filter(Boolean).map(mechKey));
  for (const [key, printings] of groups) {
    if (state.suggest !== 'spare' && !lookingKeys.has(key)) {
      const need = mainSetCap(printings[0].cardType) - groupSum(key, (x) => owned(x, 'main'));
      const candidates = printings.filter((c) => state.set === 'all' || c.set?.code === state.set);
      if (need > 0 && candidates.length) {
        const c = lowest(candidates);
        if (passesFilters(c)) items.push({ c, kind: 'need', need });
      }
    }
    if (state.suggest !== 'need') {
      for (const c of printings) {
        if (trade[c.id] || !passesFilters(c)) continue;
        const sub = spareInfo(c);
        if (sub) items.push({ c, kind: 'spare', sub });
      }
    }
  }
  items.sort(state.sort === 'name'
    ? (a, b) => a.c.displayName.localeCompare(b.c.displayName)
    : (a, b) => (priceOf(b.c) ?? 0) - (priceOf(a.c) ?? 0));
  return items;
}

// All three row types share one structure so the text lines up everywhere:
// art | name / rarity + set / status line | price (+ action).
function rowShell(c, status, right, list) {
  const grip = list ? `<div class="grip" title="Drag to reorder"><button data-act="up" data-list="${list}" data-id="${c.id}" aria-label="Move up">▲</button><span aria-hidden="true">⋮⋮</span><button data-act="down" data-list="${list}" data-id="${c.id}" aria-label="Move down">▼</button></div>` : '';
  return `<div class="tile${list ? ' sortable' : ''}" data-id="${c.id}"${list ? ` data-list="${list}" draggable="true"` : ''}>${grip}<img src="${c.imageUrl}" alt="" loading="lazy" /><div class="nm"><b title="${esc(c.displayName)}">${esc(c.displayName)}</b><div class="meta">${iconHtml(c.rarity)}<span>${esc(c.rarity)} · ${esc(c.set?.name || '')}</span></div><div class="status">${status}</div></div><div class="right">${right}</div></div>`;
}
const priceHtml = (c) => `<div class="price"><small>Market Price</small><b>${formatEur(priceOf(c))}</b></div>`;
const coveredHtml = (sub) => `<span class="note">Covered by</span><span class="sub">${iconHtml(sub.rarity)}${esc(sub.rarity)} · ${formatEur(priceOf(sub))}</span>`;

function tileHtml(it) {
  const c = it.c;
  const status = it.kind === 'need'
    ? `<span class="tag need">NEED ×${it.need}</span><span class="note">Lowest rarity</span>`
    : `<span class="tag spare">SPARE</span>${coveredHtml(it.sub)}`;
  const btn = it.kind === 'need'
    ? `<button class="btn-t look" data-act="look" data-id="${c.id}">+ LOOK</button>`
    : `<button class="btn-t sell" data-act="sell" data-id="${c.id}">+ SELL</button>`;
  return rowShell(c, status, `${priceHtml(c)}${btn}`);
}

function lookingRowHtml(c) {
  const need = needQty(c);
  const status = need > 0 ? `<span class="tag need">NEED ×${need}</span>` : '<span class="tag done">COMPLETE</span>';
  return rowShell(c, status, `${priceHtml(c)}<button class="x" data-act="unlook" data-id="${c.id}" aria-label="Remove">✕</button>`, 'looking');
}

function sellingRowHtml(c) {
  const sub = spareInfo(c);
  const step = `<span class="qty-step"><button data-act="qty-" data-id="${c.id}" aria-label="Sell fewer">−</button><span class="tag qty">×${trade[c.id]}</span><button data-act="qty+" data-id="${c.id}" aria-label="Sell more">+</button></span>`;
  const status = `${step}${sub ? coveredHtml(sub) : `<span class="note">You own ${ownedAll(c)}</span>`}`;
  return rowShell(c, status, `${priceHtml(c)}<button class="x" data-act="unsell" data-id="${c.id}" aria-label="Remove">✕</button>`, 'selling');
}

// Hover the small card art for 0.5s to see the full card, sized and styled
// like the card popup in the other windows (340px, yellow ring) - not a
// full-page overlay. Only the thumbnail triggers it, not the rest of the row.
const PREVIEW_DELAY_MS = 500;

function setupCardPopup() {
  const box = document.createElement('div');
  box.id = 'card-popup';
  box.hidden = true;
  box.innerHTML = '<img alt="" />';
  document.body.appendChild(box);
  const img = box.firstChild;
  let timer = null;
  let current = null;

  const hide = () => {
    clearTimeout(timer);
    timer = null;
    current = null;
    box.hidden = true;
  };
  const show = (thumb, src) => {
    img.src = src;
    box.hidden = false;
    const r = thumb.getBoundingClientRect();
    const w = box.offsetWidth, h = box.offsetHeight, m = 12;
    // Beside the thumbnail: right if it fits, else left; clamped vertically.
    let x = r.right + m;
    if (x + w > window.innerWidth - 8) x = Math.max(8, r.left - w - m);
    const y = Math.max(8, Math.min(r.top + r.height / 2 - h / 2, window.innerHeight - h - 8));
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
  };

  document.body.addEventListener('mouseover', (e) => {
    const thumb = e.target.closest('.tile[data-id] > img');
    if (thumb === current) return;
    hide();
    if (!thumb) return;
    current = thumb;
    const src = byId.get(thumb.parentElement.dataset.id)?.imageUrl;
    timer = setTimeout(() => show(thumb, src), PREVIEW_DELAY_MS);
  });
  document.body.addEventListener('mouseout', (e) => {
    if (current && !e.relatedTarget?.closest?.('.tile[data-id] > img')) hide();
  });
  // Dragging, clicking or scrolling dismisses it so it never gets in the way.
  document.body.addEventListener('mousedown', hide);
  document.addEventListener('scroll', hide, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
}

// One-shot sorts (applied when picked, then the list is yours to drag again).
const SORTS = {
  'price-desc': { label: 'Price: high to low', cmp: (a, b) => (priceOf(b) ?? 0) - (priceOf(a) ?? 0) },
  'price-asc': { label: 'Price: low to high', cmp: (a, b) => (priceOf(a) ?? Infinity) - (priceOf(b) ?? Infinity) },
  'name': { label: 'Name: A to Z', cmp: (a, b) => a.displayName.localeCompare(b.displayName) },
  'rarity-desc': { label: 'Rarity: highest first', cmp: (a, b) => rarityRank(b.rarity) - rarityRank(a.rarity) },
  'rarity-asc': { label: 'Rarity: lowest first', cmp: (a, b) => rarityRank(a.rarity) - rarityRank(b.rarity) },
  'color': { label: 'Color', cmp: (a, b) => COLOR_ORDER.indexOf(a.color) - COLOR_ORDER.indexOf(b.color) },
  'type': { label: 'Type', cmp: (a, b) => TYPE_ORDER.indexOf(a.cardType) - TYPE_ORDER.indexOf(b.cardType) },
  'set': { label: 'Set', cmp: (a, b) => (a.set?.name || '').localeCompare(b.set?.name || '') },
  'need-desc': { label: 'Need: most first', lists: ['looking'], cmp: (a, b) => needQty(b) - needQty(a) },
  'qty-desc': { label: 'For sale: most first', lists: ['selling'], cmp: (a, b) => (trade[b.id] || 0) - (trade[a.id] || 0) }
};

function buildSortSelects() {
  document.querySelectorAll('.sort-select').forEach((sel) => {
    const list = sel.dataset.sortList;
    sel.innerHTML = '<option value="">Sort by…</option>' + Object.entries(SORTS)
      .filter(([, s]) => !s.lists || s.lists.includes(list))
      .map(([key, s]) => `<option value="${key}">${s.label}</option>`).join('');
    sel.addEventListener('change', () => {
      const sort = SORTS[sel.value];
      sel.value = '';
      if (!sort) return;
      const cards = orderedCards(list === 'looking' ? looking : trade);
      // Ties (e.g. same color) fall back to price, highest first.
      saveOrder(list, cards.sort((a, b) => sort.cmp(a, b) || (priceOf(b) ?? 0) - (priceOf(a) ?? 0)).map((c) => c.id));
    });
  });
}

// Lists keep the order you arranged (object key order in the stored file).
const orderedCards = (list) => Object.keys(list).map((id) => byId.get(id)).filter(Boolean);

async function saveOrder(listName, ids) {
  if (listName === 'looking') looking = await window.api.reorderLooking(ids);
  else trade = await window.api.reorderTrade(ids);
  render();
}

function moveId(listName, id, to) {
  const ids = orderedCards(listName === 'looking' ? looking : trade).map((c) => c.id);
  const from = ids.indexOf(id);
  if (from < 0) return;
  to = Math.max(0, Math.min(ids.length - 1, to));
  if (to === from) return;
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  return saveOrder(listName, ids);
}

// Drag a row within its own list; the drop position comes from the pointer
// height relative to the other rows' midpoints.
function setupDragSort() {
  let drag = null;
  const rows = (list) => [...document.querySelectorAll(`.tile.sortable[data-list="${list}"]`)];
  const clear = () => document.querySelectorAll('.drop-before, .drop-after, .dragging').forEach((n) => n.classList.remove('drop-before', 'drop-after', 'dragging'));
  document.body.addEventListener('dragstart', (e) => {
    const tile = e.target.closest?.('.tile.sortable');
    if (!tile) return;
    drag = { id: tile.dataset.id, list: tile.dataset.list };
    tile.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', drag.id);
  });
  document.body.addEventListener('dragover', (e) => {
    if (!drag) return;
    const list = e.target.closest?.('.list');
    if (!list || list.id !== `list-${drag.list}`) return;
    e.preventDefault();
    document.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
    const others = rows(drag.list).filter((r) => r.dataset.id !== drag.id);
    const target = others.find((r) => e.clientY < r.getBoundingClientRect().top + r.offsetHeight / 2);
    if (target) target.classList.add('drop-before');
    else if (others.length) others[others.length - 1].classList.add('drop-after');
  });
  document.body.addEventListener('drop', (e) => {
    if (!drag) return;
    const list = e.target.closest?.('.list');
    if (!list || list.id !== `list-${drag.list}`) return;
    e.preventDefault();
    const ids = rows(drag.list).map((r) => r.dataset.id).filter((id) => id !== drag.id);
    const before = document.querySelector('.drop-before');
    const after = document.querySelector('.drop-after');
    if (before) ids.splice(ids.indexOf(before.dataset.id), 0, drag.id);
    else if (after) ids.splice(ids.indexOf(after.dataset.id) + 1, 0, drag.id);
    else ids.push(drag.id);
    const { list: name } = drag;
    drag = null;
    clear();
    saveOrder(name, ids);
  });
  document.body.addEventListener('dragend', () => { drag = null; clear(); });
}

function render() {
  const pool = getPool();
  el('pool').innerHTML = pool.map(tileHtml).join('') || '<div class="empty">Nothing else matches these filters.</div>';
  el('pool-info').textContent = `${pool.length} card${pool.length === 1 ? '' : 's'} match`;

  const lookCards = orderedCards(looking);
  const sellCards = orderedCards(trade);
  el('list-looking').innerHTML = lookCards.map(lookingRowHtml).join('') || '<div class="empty">Add cards from the pool above.</div>';
  el('list-selling').innerHTML = sellCards.map(sellingRowHtml).join('') || '<div class="empty">Add cards from the pool above.</div>';
  el('count-looking').textContent = lookCards.length;
  el('count-selling').textContent = sellCards.length;
  el('total-looking').textContent = formatEur(lookCards.reduce((s, c) => s + (priceOf(c) ?? 0) * Math.max(0, needQty(c)), 0));
  el('total-selling').textContent = formatEur(sellCards.reduce((s, c) => s + (priceOf(c) ?? 0) * trade[c.id], 0));

  el('p-looking').hidden = state.view === 'S';
  el('p-selling').hidden = state.view === 'L';
  el('cols').classList.toggle('single', state.view !== 'B');
}

async function onAction(act, id, listName) {
  const c = byId.get(id);
  if (act === 'up' || act === 'down') {
    const ids = orderedCards(listName === 'looking' ? looking : trade).map((x) => x.id);
    return moveId(listName, id, ids.indexOf(id) + (act === 'up' ? -1 : 1));
  }
  if (act === 'look') looking = await window.api.setLookingMany({ [id]: true });
  else if (act === 'unlook') looking = await window.api.setLookingMany({ [id]: false });
  else if (act === 'sell') trade = await window.api.setTradeQty(id, 1);
  else if (act === 'unsell') trade = await window.api.setTradeQty(id, 0);
  else if (act === 'qty+') trade = await window.api.setTradeQty(id, Math.min(ownedAll(c), (trade[id] || 0) + 1));
  else if (act === 'qty-') trade = await window.api.setTradeQty(id, (trade[id] || 0) - 1);
  render();
}

function chipRow(containerId, values, set, cls) {
  const box = el(containerId);
  box.innerHTML = values.map((v) => `<span class="pill ${cls ? cls(v) : ''}" data-v="${esc(v)}">${esc(v)}</span>`).join('');
  box.querySelectorAll('.pill').forEach((p) => p.addEventListener('click', () => {
    const v = p.dataset.v;
    if (set.has(v)) set.delete(v); else set.add(v);
    p.classList.toggle('on', set.has(v));
    render();
  }));
}

function buildFilters() {
  chipRow('f-color', COLOR_ORDER, state.colors, (v) => `c-${v}`);
  chipRow('f-type', TYPE_ORDER, state.types);
  el('f-rarity').innerHTML = RARITY_GROUPS.map((g) => `<button class="rbtn" data-v="${g.key}" title="${g.title}"><span class="rarity-icon rarity-icon-${g.icon}"></span></button>`).join('');
  el('f-rarity').querySelectorAll('.rbtn').forEach((b) => b.addEventListener('click', () => {
    const v = b.dataset.v;
    if (state.rarities.has(v)) state.rarities.delete(v); else state.rarities.add(v);
    b.classList.toggle('on', state.rarities.has(v));
    render();
  }));
  const sets = [...new Map(allCards.map((c) => [c.set?.code, c.set])).values()].filter(Boolean);
  el('f-set').innerHTML = '<option value="all">All sets</option>' + sets.map((s) => `<option value="${esc(s.code)}">${esc(s.name)}</option>`).join('');
  document.querySelectorAll('[data-sg]').forEach((p) => p.addEventListener('click', () => {
    state.suggest = p.dataset.sg;
    document.querySelectorAll('[data-sg]').forEach((x) => x.classList.toggle('on', x === p));
    render();
  }));
  el('f-min').addEventListener('change', (e) => { state.minPrice = Number(e.target.value); render(); });
  el('f-set').addEventListener('change', (e) => { state.set = e.target.value; render(); });
  el('f-sort').addEventListener('change', (e) => { state.sort = e.target.value; render(); });
  el('f-search').addEventListener('input', (e) => { state.search = e.target.value.trim().toLowerCase(); render(); });
  document.querySelectorAll('#seg span').forEach((s) => s.addEventListener('click', () => {
    state.view = s.dataset.v;
    document.querySelectorAll('#seg span').forEach((x) => x.classList.toggle('on', x === s));
    render();
  }));
  document.body.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (btn) onAction(btn.dataset.act, btn.dataset.id, btn.dataset.list);
  });
}

async function init() {
  el('win-minimize').addEventListener('click', () => window.api.windowMinimize());
  el('win-maximize').addEventListener('click', () => window.api.windowToggleMaximize());
  el('win-close').addEventListener('click', () => window.api.windowClose());
  el('close-btn').addEventListener('click', () => window.api.windowClose());

  allCards = (await window.api.getCards())?.cards || [];
  collection = await window.api.getCollection();
  trade = await window.api.getTradeList();
  looking = await window.api.getLookingList();
  try { priceView = await window.api.getPrices(); } catch { priceView = null; }
  if (!allCards.length) {
    el('pool').innerHTML = '<div class="empty">No card data yet - open the main Eddies window and click "Refresh Card Data" first.</div>';
    return;
  }
  buildGroups();
  buildFilters();
  setupCardPopup();
  setupDragSort();
  buildSortSelects();
  render();
}

init();
