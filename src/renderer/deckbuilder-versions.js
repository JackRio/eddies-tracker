// Deck versions: several card lists under one deck (name, description, tags,
// links and group are shared). The deck's top-level fields always hold the
// ACTIVE version's content, so everything else (Builder, Deck View, Prep List,
// AI, publish) keeps reading deck.cards etc. unchanged; deck.versions keeps a
// copy of each version's content and is synced from the top level before a
// switch and on save. A deck that never made a version has an implicit "v1".
// Loaded before deckbuilder.js; uses its globals at call time.

const VERSION_FIELDS = ['legendCardIds', 'legendPrintingIds', 'cards', 'sideboard', 'cardPrintings', 'swapPlans'];
const VERSION_DEFAULTS = { legendCardIds: [null, null, null], legendPrintingIds: [null, null, null], cards: {}, sideboard: {}, cardPrintings: {}, swapPlans: [] };
const vClone = (x) => JSON.parse(JSON.stringify(x));

let versionUi = { renaming: false, confirmDelete: false };
let lastVersionSwitch = null; // { deckId, from, to, diff } - shown as the swap summary

function resetVersionUi() {
  versionUi = { renaming: false, confirmDelete: false };
  lastVersionSwitch = null;
}

function versionSnapshot(deck) {
  return Object.fromEntries(VERSION_FIELDS.map((f) => [f, vClone(deck[f] ?? VERSION_DEFAULTS[f])]));
}

function versionsOf(deck) {
  return deck.versions?.length ? deck.versions : [{ id: 'v1', name: 'v1' }];
}

function activeVersionIdOf(deck) {
  const list = versionsOf(deck);
  return list.some((v) => v.id === deck.activeVersionId) ? deck.activeVersionId : list[0].id;
}

function ensureVersions(deck) {
  if (!deck.versions?.length) deck.versions = [{ id: 'v1', name: 'v1', ...versionSnapshot(deck) }];
  deck.activeVersionId = activeVersionIdOf(deck);
}

// Copies the working (top-level) content into the active version's slot.
function syncActiveVersion(deck) {
  if (!deck.versions?.length) return;
  Object.assign(deck.versions.find((v) => v.id === activeVersionIdOf(deck)), versionSnapshot(deck));
}

function loadVersionContent(deck, version) {
  for (const f of VERSION_FIELDS) deck[f] = vClone(version[f] ?? VERSION_DEFAULTS[f]);
  deck.activeVersionId = version.id;
}

// Per zone: copies that left (out) and arrived (in) going from a -> b.
function versionDiff(a, b) {
  const zone = (x = {}, y = {}) => {
    const out = [];
    const inn = [];
    for (const id of new Set([...Object.keys(x), ...Object.keys(y)])) {
      const d = (y[id] || 0) - (x[id] || 0);
      if (d < 0) out.push({ cardId: id, qty: -d });
      else if (d > 0) inn.push({ cardId: id, qty: d });
    }
    return { out, in: inn };
  };
  const la = (a.legendCardIds || []).filter(Boolean);
  const lb = (b.legendCardIds || []).filter(Boolean);
  return {
    legends: { out: la.filter((id) => !lb.includes(id)).map((id) => ({ cardId: id, qty: 1 })), in: lb.filter((id) => !la.includes(id)).map((id) => ({ cardId: id, qty: 1 })) },
    main: zone(a.cards, b.cards),
    side: zone(a.sideboard, b.sideboard)
  };
}

// Switches the deck's working content to version `toId`; returns the switch
// record for the summary (null if nothing changed).
function switchVersion(deck, toId) {
  ensureVersions(deck);
  syncActiveVersion(deck);
  const from = deck.versions.find((v) => v.id === deck.activeVersionId);
  const to = deck.versions.find((v) => v.id === toId);
  if (!to || to === from) return null;
  loadVersionContent(deck, to);
  return { deckId: deck.id, from: from.name, to: to.name, diff: versionDiff(from, to) };
}

function nextVersionName(deck) {
  const names = new Set(deck.versions.map((v) => v.name));
  let n = deck.versions.length + 1;
  while (names.has(`v${n}`)) n++;
  return `v${n}`;
}

// New version = a copy of the current one, which becomes active.
function addVersion(deck) {
  ensureVersions(deck);
  stampExistingFor(deck, deck.activeVersionId);
  syncActiveVersion(deck);
  const v = { id: `v${Date.now().toString(36)}`, name: nextVersionName(deck), ...versionSnapshot(deck) };
  deck.versions.push(v);
  deck.activeVersionId = v.id;
  return v;
}

function renameActiveVersion(deck, name) {
  const clean = String(name || '').trim();
  if (!clean) return;
  ensureVersions(deck);
  deck.versions.find((v) => v.id === deck.activeVersionId).name = clean.slice(0, 40);
}

// Deletes the active version and switches to its neighbour.
function deleteActiveVersion(deck) {
  ensureVersions(deck);
  if (deck.versions.length < 2) return null;
  syncActiveVersion(deck);
  const i = deck.versions.findIndex((v) => v.id === deck.activeVersionId);
  const [gone] = deck.versions.splice(i, 1);
  const to = deck.versions[Math.max(0, i - 1)];
  loadVersionContent(deck, to);
  return { deckId: deck.id, from: gone.name, to: to.name, diff: versionDiff(gone, to) };
}

// --- UI ---------------------------------------------------------------------------

// Dropdown (+ rename / new / delete when editable).
function versionBarHtml(deck, editable) {
  const list = versionsOf(deck);
  const active = activeVersionIdOf(deck);
  if (!editable && list.length < 2) return '';
  const current = list.find((v) => v.id === active);
  const picker = versionUi.renaming && editable
    ? `<input class="version-name-input" data-version-rename value="${escapeHtml(current.name)}" maxlength="40" />`
    : `<select class="version-select" data-version-select title="Deck version">${list.map((v) => `<option value="${escapeHtml(v.id)}" ${v.id === active ? 'selected' : ''}>${escapeHtml(v.name)}</option>`).join('')}</select>`;
  if (!editable) return picker;
  const del = list.length > 1
    ? `<button class="version-btn danger" data-version-delete>${versionUi.confirmDelete ? `Delete ${escapeHtml(current.name)}?` : '&#10005;'}</button>`
    : '';
  return `${picker}<button class="version-btn" data-version-rename-btn title="Rename this version">&#9998;</button><button class="version-btn" data-version-add title="New version (a copy of this one)">+ Version</button>${del}`;
}

function versionSummaryHtml(sw) {
  if (!sw) return '';
  const chips = (list, cls, sign) =>
    list
      .map((e) => ({ ...e, card: cardById(e.cardId) }))
      .filter((e) => e.card)
      .sort((a, b) => a.card.name.localeCompare(b.card.name))
      .map((e) => `<span class="${cls} vs-card" data-hover-card="${escapeHtml(e.cardId)}" title="${escapeHtml(e.card.displayName)}">${sign}${e.qty} ${escapeHtml(e.card.name)}</span>`);
  const row = (label, z) => {
    const items = [...chips(z.out, 'plan-out', '−'), ...chips(z.in, 'plan-in', '+')];
    return items.length ? `<div class="vs-row"><span class="vs-label">${label}</span>${items.join('')}</div>` : '';
  };
  const rows = row('Legends:', sw.diff.legends) + row('Main Deck:', sw.diff.main) + row('Sideboard:', sw.diff.side);
  return `<div class="version-summary">
    <div class="vs-head"><span><b>${escapeHtml(sw.from)}</b> &rarr; <b>${escapeHtml(sw.to)}</b></span><button class="vs-close" data-vs-close title="Hide">&#10005;</button></div>
    ${rows || '<div class="vs-row vs-none">No card changes.</div>'}
  </div>`;
}

function renderBuilderVersions() {
  el('builder-version-bar').innerHTML = versionBarHtml(draft, true);
  const sw = lastVersionSwitch?.deckId === draft.id ? lastVersionSwitch : null;
  el('builder-version-summary').innerHTML = versionSummaryHtml(sw);
  el('builder-version-summary').hidden = !sw;
  renderVersionWarnings();
}

function renderViewVersions() {
  el('view-version-bar').innerHTML = versionBarHtml(viewingDeck, false);
  const sw = lastVersionSwitch?.deckId === viewingDeck.id ? lastVersionSwitch : null;
  el('view-version-summary').innerHTML = versionSummaryHtml(sw);
  el('view-version-summary').hidden = !sw;
  renderVersionWarnings();
}

function attachVersionControls() {
  const bar = el('builder-version-bar');
  bar.addEventListener('change', (e) => {
    if (!e.target.matches('[data-version-select]')) return;
    lastVersionSwitch = switchVersion(draft, e.target.value);
    versionUi.confirmDelete = false;
    setDeckMessage(null);
    renderBuilder();
  });
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if ('versionAdd' in btn.dataset) {
      const v = addVersion(draft);
      lastVersionSwitch = null;
      versionUi.confirmDelete = false;
      setDeckMessage(`Created ${v.name} - a copy of the previous version. Edits now go to ${v.name}.`, false);
      renderBuilder();
    } else if ('versionRenameBtn' in btn.dataset) {
      versionUi.renaming = true;
      renderBuilderVersions();
      const inp = bar.querySelector('[data-version-rename]');
      inp.focus();
      inp.select();
    } else if ('versionDelete' in btn.dataset) {
      if (!versionUi.confirmDelete) {
        versionUi.confirmDelete = true;
        renderBuilderVersions();
        return;
      }
      versionUi.confirmDelete = false;
      lastVersionSwitch = deleteActiveVersion(draft);
      renderBuilder();
    }
  });
  const finishRename = (inp, save) => {
    if (!versionUi.renaming) return;
    versionUi.renaming = false;
    if (save) renameActiveVersion(draft, inp.value);
    renderBuilderVersions();
  };
  bar.addEventListener('keydown', (e) => {
    if (!e.target.matches('[data-version-rename]')) return;
    if (e.key === 'Enter') finishRename(e.target, true);
    if (e.key === 'Escape') finishRename(e.target, false);
  });
  bar.addEventListener('focusout', (e) => {
    if (e.target.matches('[data-version-rename]')) finishRename(e.target, true);
  });

  // Deck View: switching makes that version the deck's current one (saved),
  // like picking which printing faces front.
  el('view-version-bar').addEventListener('change', async (e) => {
    if (!e.target.matches('[data-version-select]')) return;
    const sw = switchVersion(viewingDeck, e.target.value);
    decks = await window.api.saveDeck(viewingDeck);
    viewingDeck = decks[viewingDeck.id];
    lastVersionSwitch = sw;
    viewPlanId = null;
    renderDeckView();
  });

  attachVersionWarningControls();
  for (const id of ['builder-version-summary', 'view-version-summary']) {
    el(id).addEventListener('click', (e) => {
      if (!e.target.closest('[data-vs-close]')) return;
      lastVersionSwitch = null;
      if (view === 'builder') renderBuilderVersions();
      else renderViewVersions();
    });
  }
}

// --- Shared description / tags vs. versions -----------------------------------
// The description and archetype tags are shared by every version, so they only
// ever describe some of them. deck.descVersionIds / deck.tagsVersionIds list
// the versions they were written (or confirmed) for: editing resets the list
// to the version you're on, "Still fits" adds the current one. A warning shows
// when the current version isn't in the list, or when the description names
// cards that only exist in another version.

function stampDesc(deck) {
  deck.descVersionIds = [activeVersionIdOf(deck)];
}
function stampTags(deck) {
  deck.tagsVersionIds = [activeVersionIdOf(deck)];
}
function confirmForVersion(deck, what) {
  const key = what === 'tags' ? 'tagsVersionIds' : 'descVersionIds';
  const id = activeVersionIdOf(deck);
  deck[key] = [...new Set([...(deck[key] || []), id])];
}

// When a deck first gets a second version, whatever description/tags it has
// were written for the version it started from.
function stampExistingFor(deck, versionId) {
  deck.descVersionIds ??= [versionId];
  deck.tagsVersionIds ??= [versionId];
}

const contentCardIds = (c) => [...(c.legendCardIds || []).filter(Boolean), ...Object.keys(c.cards || {}), ...Object.keys(c.sideboard || {})];

function descHasText(deck) {
  return !!(deck.description || '').trim() || Object.values(deck.descSections || {}).some((t) => String(t || '').trim());
}

function versionWarnings(deck) {
  if ((deck.versions?.length || 0) < 2) return null;
  const active = activeVersionIdOf(deck);
  const nameOf = (id) => deck.versions.find((v) => v.id === id)?.name;
  const namesFor = (ids) => (ids || []).map(nameOf).filter(Boolean).join(', ');

  let desc = null;
  if (descHasText(deck) && !(deck.descVersionIds || []).includes(active)) {
    // cards the description names that this version doesn't run but another does
    const here = new Set(contentCardIds(deck)); // top level = this version, possibly unsaved edits
    const elsewhere = new Set(deck.versions.filter((v) => v.id !== active).flatMap(contentCardIds));
    const text = [deck.description || '', ...Object.values(deck.descSections || {})].join('\n');
    const names = [...new Set([...text.matchAll(/@\[([^\]|]+)/g)].map((m) => m[1]))];
    const stale = names
      .map((n) => uniqueCards.find((c) => c.displayName === n))
      .filter((c) => c && !here.has(c.cardId) && elsewhere.has(c.cardId));
    desc = { writtenFor: namesFor(deck.descVersionIds), stale };
  }
  const tags = (deck.tags?.archetype?.length || 0) > 0 && !(deck.tagsVersionIds || []).includes(active) ? { setFor: namesFor(deck.tagsVersionIds) } : null;
  if (!desc && !tags) return null;
  return { versionName: nameOf(active), desc, tags };
}

function versionWarningHtml(deck) {
  const w = versionWarnings(deck);
  if (!w) return '';
  const lines = [];
  if (w.desc) {
    const stale = w.desc.stale.length
      ? ` It mentions ${w.desc.stale.map((c) => `<span class="vw-card" data-hover-card="${escapeHtml(c.cardId)}">${escapeHtml(c.name)}</span>`).join(', ')}, which ${w.desc.stale.length === 1 ? "isn't" : "aren't"} in ${escapeHtml(w.versionName)}.`
      : '';
    lines.push(`<div class="vw-line"><span>&#9888; The <b>description</b> was written for ${escapeHtml(w.desc.writtenFor || 'another version')}.${stale}</span><button class="version-btn" data-vw-confirm="desc">Still fits ${escapeHtml(w.versionName)}</button></div>`);
  }
  if (w.tags) {
    lines.push(`<div class="vw-line"><span>&#9888; The <b>archetype tags</b> were set for ${escapeHtml(w.tags.setFor || 'another version')}.</span><button class="version-btn" data-vw-confirm="tags">Still fit ${escapeHtml(w.versionName)}</button></div>`);
  }
  return `<div class="version-warning">${lines.join('')}</div>`;
}

// Compact flag for the My Decks list.
function versionWarningFlagHtml(deck) {
  const w = versionWarnings(deck);
  if (!w) return '';
  const what = [w.desc && 'description', w.tags && 'tags'].filter(Boolean).join(' & ');
  return `<span class="deck-flag deck-flag-missing" title="Written for ${escapeHtml(w.desc?.writtenFor || w.tags?.setFor || 'another version')} - open the deck to check">&#9888; ${what} from another version</span>`;
}

function renderVersionWarnings() {
  if (view === 'builder' && draft) {
    const html = versionWarningHtml(draft);
    el('builder-version-warning').innerHTML = html;
    el('builder-version-warning').hidden = !html;
    el('desc-version-warning').innerHTML = html;
    el('desc-version-warning').hidden = !html;
  } else if (view === 'view' && viewingDeck) {
    const html = versionWarningHtml(viewingDeck);
    el('view-version-warning').innerHTML = html;
    el('view-version-warning').hidden = !html;
  }
}

function attachVersionWarningControls() {
  for (const id of ['builder-version-warning', 'desc-version-warning']) {
    el(id).addEventListener('click', (e) => {
      const btn = e.target.closest('[data-vw-confirm]');
      if (!btn) return;
      confirmForVersion(draft, btn.dataset.vwConfirm);
      renderVersionWarnings();
    });
  }
  el('view-version-warning').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-vw-confirm]');
    if (!btn) return;
    confirmForVersion(viewingDeck, btn.dataset.vwConfirm);
    decks = await window.api.saveDeck(viewingDeck);
    viewingDeck = decks[viewingDeck.id];
    renderVersionWarnings();
  });
}
