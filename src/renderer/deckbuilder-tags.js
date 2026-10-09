// Deck tags, groups and the AI job queue for the Deck Builder window.
// Loaded before deckbuilder.js and shares its globals (decks, draft, el,
// escapeHtml, cardById, ...), which are only touched at call time.
//
//  - Tag database (userData/tag-db.json): archetype / creator (YouTube) / misc
//    tags the owner curates; archetype + misc definitions are also what the AI
//    "knows" (see ai.tagDeck). Color tags (BBG...) are derived from the Legends.
//  - Groups (userData/deck-groups.json): named, collapsible sections of the My
//    Decks list, published to the website with a per-group share link.
//  - AI queue: description drafts and tag suggestions run one at a time.

let tagDb = [];
let groups = [];
let siteBase = '';
let editingGroupId = null;
let confirmGroupDeleteId = null;
let ungroupedCollapsed = false;
let confirmTagDeleteId = null;
let tagsEditing = null; // { draft: boolean, id }

const TAG_CATS = [
  { key: 'archetype', title: 'Archetype' },
  { key: 'creator', title: 'YouTube / creator' },
  { key: 'misc', title: 'Miscellaneous' }
];
const COLOR_HEX = { Red: '#e8465a', Blue: '#3d8bfd', Green: '#3ecf6e', Yellow: '#e8c93a' };
const COLOR_LETTER = { R: 'Red', B: 'Blue', G: 'Green', Y: 'Yellow' };
const FEATURED_ID = 'misc-featured';

const tagOf = (id) => tagDb.find((t) => t.id === id);
const tagsInCat = (cat) => tagDb.filter((t) => t.category === cat);

function showOverlay(id) {
  const o = el(id);
  o.hidden = false;
  requestAnimationFrame(() => o.classList.add('open'));
}
function hideOverlay(id) {
  const o = el(id);
  o.classList.remove('open');
  setTimeout(() => {
    if (!o.classList.contains('open')) o.hidden = true;
  }, 150);
}
function flashBtn(btn, text) {
  const old = btn.dataset.label || btn.textContent;
  btn.dataset.label = old;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1300);
}

// --- Color tags (rule-based; duplicated in main.js's colorTagFor) -------------

function colorTagOf(deck) {
  const counts = {};
  for (const id of (deck.legendCardIds || []).filter(Boolean)) {
    const c = cardById(id)?.color;
    if (COLOR_ORDER.includes(c)) counts[c] = (counts[c] || 0) + 1;
  }
  return COLOR_ORDER.filter((c) => counts[c])
    .sort((a, b) => counts[b] - counts[a])
    .map((c) => c[0].repeat(counts[c]))
    .join('');
}

function colorChipHtml(tag) {
  if (!tag) return '';
  const letters = [...tag].map((l) => `<span style="color:${COLOR_HEX[COLOR_LETTER[l]]}">${l}</span>`).join('');
  return `<span class="tag-chip cat-color" title="Color identity - worked out from the Legends">${letters}</span>`;
}

// --- A deck's tags --------------------------------------------------------------

// Creator tags are explicit ones plus the channel of any reference link.
function deckTagIds(deck) {
  const out = { archetype: [...(deck.tags?.archetype || [])], creator: [...(deck.tags?.creator || [])], misc: [...(deck.tags?.misc || [])] };
  for (const l of deck.links || []) if (l.creatorId && !out.creator.includes(l.creatorId)) out.creator.push(l.creatorId);
  for (const k of Object.keys(out)) out[k] = out[k].filter((id) => tagOf(id));
  return out;
}

function tagChipHtml(t) {
  const feat = t.id === FEATURED_ID ? ' featured' : '';
  return `<span class="tag-chip cat-${t.category}${feat}" title="${escapeHtml(t.description || t.name)}">${escapeHtml(t.name)}</span>`;
}

function deckChipsHtml(deck) {
  const ids = deckTagIds(deck);
  const chips = [colorChipHtml(colorTagOf(deck))];
  for (const cat of TAG_CATS) for (const id of ids[cat.key]) chips.push(tagChipHtml(tagOf(id)));
  return chips.filter(Boolean).join('');
}

function updateTagsSummary() {
  if (!draft) return;
  const parts = [colorTagOf(draft)];
  const ids = deckTagIds(draft);
  for (const cat of TAG_CATS) for (const id of ids[cat.key]) parts.push(tagOf(id).name);
  const g = groups.find((x) => x.id === draft.groupId);
  if (g) parts.push(`in "${g.name}"`);
  el('deck-tags-summary').textContent = parts.filter(Boolean).join(' · ') || 'No tags yet - click to add';
}

// --- Filters + grouped list ------------------------------------------------------

function deckMatchesTagFilters(d) {
  if (listUiState.color && colorTagOf(d) !== listUiState.color) return false;
  if (listUiState.archetype && !deckTagIds(d).archetype.includes(listUiState.archetype)) return false;
  return true;
}

function deckTagSearchText(d) {
  const ids = deckTagIds(d);
  return [colorTagOf(d), ...Object.values(ids).flat().map((id) => tagOf(id).name)].join(' ');
}

function updateListFilters() {
  el('ai-tag-all-btn').hidden = !Object.values(decks).some((d) => !deckTagIds(d).archetype.length);
  const colors = [...new Set(Object.values(decks).map(colorTagOf).filter(Boolean))].sort();
  const used = new Set(Object.values(decks).flatMap((d) => deckTagIds(d).archetype));
  const fill = (id, options, current) => {
    el(id).innerHTML = '<option value="">All</option>' + options.map(([v, label]) => `<option value="${escapeHtml(v)}">${escapeHtml(label)}</option>`).join('');
    el(id).value = options.some(([v]) => v === current) ? current : '';
  };
  fill('list-color', colors.map((c) => [c, c]), listUiState.color);
  fill('list-archetype', tagsInCat('archetype').filter((t) => used.has(t.id)).map((t) => [t.id, t.name]), listUiState.archetype);
  listUiState.color = el('list-color').value;
  listUiState.archetype = el('list-archetype').value;
}

const isFilteringList = () => !!(listUiState.search.trim() || listUiState.ownership !== 'all' || listUiState.color || listUiState.archetype);

// cardHtml: deckCardHtml from deckbuilder.js. Returns the whole grouped list.
function groupedListHtml(list, cardHtml) {
  const filtering = isFilteringList();
  const buckets = new Map(groups.map((g) => [g.id, []]));
  const loose = [];
  for (const d of list) (buckets.has(d.groupId) ? buckets.get(d.groupId) : loose).push(d);

  if (!groups.length) return `<div class="deck-grid">${list.map(cardHtml).join('')}</div>`;

  const section = (id, name, decksIn, controls, collapsed) => {
    const body = collapsed
      ? ''
      : decksIn.length
        ? `<div class="deck-grid">${decksIn.map(cardHtml).join('')}</div>`
        : `<div class="grp-empty">Drag decks here, or use a deck's Tags button.</div>`;
    return `<section class="deck-group${collapsed ? ' is-collapsed' : ''}">
      <div class="deck-group-head" data-drop-group="${escapeHtml(id)}">${controls}</div>
      ${body}
    </section>`;
  };

  const sections = groups.map((g, i) => {
    const decksIn = buckets.get(g.id);
    if (filtering && !decksIn.length) return '';
    const collapsed = g.collapsed && !filtering;
    const nameHtml =
      editingGroupId === g.id
        ? `<input class="grp-name-input" data-grp-name-input="${g.id}" value="${escapeHtml(g.name)}" maxlength="60" />`
        : `<span class="grp-name">${escapeHtml(g.name)}</span>`;
    // A group with decks needs its name typed to delete; an empty one deletes at once.
    const delBtn =
      confirmGroupDeleteId === g.id
        ? `<input class="grp-name-input" data-grp-del-input="${g.id}" placeholder="Type &quot;${escapeHtml(g.name)}&quot; to delete" size="${Math.max(18, g.name.length + 16)}" /><button class="grp-btn danger" data-grp-del-ok="${g.id}" disabled>Delete</button><button class="grp-btn" data-grp-del-cancel="1">Cancel</button>`
        : `<button class="grp-btn danger" data-grp-del="${g.id}">Delete</button>`;
    const controls = `<button class="grp-btn" data-grp-toggle="${g.id}" title="${collapsed ? 'Expand' : 'Minimize'}">${collapsed ? '&#9656;' : '&#9662;'}</button>
      ${nameHtml}<span class="grp-count">${decksIn.length} deck${decksIn.length === 1 ? '' : 's'}</span><span class="grp-spacer"></span>
      <button class="grp-btn" data-grp-rename="${g.id}">Rename</button>
      <button class="grp-btn" data-grp-move="${g.id}:-1" ${i === 0 ? 'disabled' : ''} title="Move up">&#9650;</button>
      <button class="grp-btn" data-grp-move="${g.id}:1" ${i === groups.length - 1 ? 'disabled' : ''} title="Move down">&#9660;</button>
      ${delBtn}`;
    return section(g.id, g.name, decksIn, controls, collapsed);
  });
  if (loose.length || !filtering) {
    const closed = ungroupedCollapsed && !filtering;
    sections.push(section('', 'Ungrouped', loose, `<button class="grp-btn" data-grp-toggle="__ungrouped" title="${closed ? 'Expand' : 'Minimize'}">${closed ? '&#9656;' : '&#9662;'}</button><span class="grp-name">Ungrouped</span><span class="grp-count">${loose.length} deck${loose.length === 1 ? '' : 's'}</span>`, closed));
  }
  return sections.join('');
}

async function persistGroups() {
  const r = await window.api.saveGroups(groups);
  groups = r.groups;
  decks = r.decks;
}

async function moveDeckToGroup(deckId, groupId) {
  decks = await window.api.setDeckMeta(deckId, { groupId: groupId || null });
  renderList();
}

function attachTagControls() {
  const grid = el('deck-grid');

  grid.addEventListener('click', async (e) => {
    const t = e.target;
    const btn = t.closest('button');
    if (!btn) return;
    const d = btn.dataset;
    if (d.grpToggle === '__ungrouped') {
      ungroupedCollapsed = !ungroupedCollapsed;
      renderList();
    } else if (d.grpToggle) {
      const g = groups.find((x) => x.id === d.grpToggle);
      g.collapsed = !g.collapsed;
      await persistGroups();
      renderList();
    } else if (d.grpRename) {
      editingGroupId = d.grpRename;
      renderList();
      const inp = grid.querySelector('[data-grp-name-input]');
      inp?.focus();
      inp?.select();
    } else if (d.grpMove) {
      const [id, dir] = d.grpMove.split(':');
      const i = groups.findIndex((x) => x.id === id);
      const j = i + Number(dir);
      if (j < 0 || j >= groups.length) return;
      [groups[i], groups[j]] = [groups[j], groups[i]];
      await persistGroups();
      renderList();
    } else if (d.grpDel) {
      const hasDecks = Object.values(decks).some((x) => x.groupId === d.grpDel);
      if (hasDecks) {
        confirmGroupDeleteId = d.grpDel;
        renderList();
        grid.querySelector('[data-grp-del-input]')?.focus();
      } else {
        groups = groups.filter((x) => x.id !== d.grpDel);
        await persistGroups();
        renderList();
      }
    } else if (d.grpDelCancel) {
      confirmGroupDeleteId = null;
      renderList();
    } else if (d.grpDelOk) {
      const g = groups.find((x) => x.id === d.grpDelOk);
      const typed = grid.querySelector('[data-grp-del-input]')?.value.trim();
      if (!g || typed !== g.name) return;
      groups = groups.filter((x) => x.id !== g.id);
      confirmGroupDeleteId = null;
      await persistGroups();
      renderList();
    } else if (d.tagsDeck) {
      openTagsEditor({ draft: false, id: d.tagsDeck });
    } else if (d.aiFill) {
      enqueueAi('desc', d.aiFill);
    }
  });

  // Inline group rename: Enter/blur saves, Escape cancels.
  const commitRename = async (inp, save) => {
    const g = groups.find((x) => x.id === inp.dataset.grpNameInput);
    editingGroupId = null;
    if (g && save && inp.value.trim()) {
      g.name = inp.value.trim();
      await persistGroups();
    }
    renderList();
  };
  grid.addEventListener('input', (e) => {
    const inp = e.target.closest?.('[data-grp-del-input]');
    if (!inp) return;
    const g = groups.find((x) => x.id === inp.dataset.grpDelInput);
    inp.parentElement.querySelector('[data-grp-del-ok]').disabled = !g || inp.value.trim() !== g.name;
  });
  grid.addEventListener('keydown', (e) => {
    const inp = e.target.closest?.('[data-grp-name-input]');
    if (!inp) return;
    if (e.key === 'Enter') commitRename(inp, true);
    if (e.key === 'Escape') commitRename(inp, false);
  });
  grid.addEventListener('focusout', (e) => {
    const inp = e.target.closest?.('[data-grp-name-input]');
    if (inp && editingGroupId) commitRename(inp, true);
  });

  // Drag a deck card onto a group header (or the Ungrouped header).
  grid.addEventListener('dragstart', (e) => {
    const card = e.target.closest?.('.deck-card');
    if (!card) return;
    e.dataTransfer.setData('text/plain', card.dataset.deckId);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  grid.addEventListener('dragend', (e) => e.target.closest?.('.deck-card')?.classList.remove('dragging'));
  grid.addEventListener('dragover', (e) => {
    const head = e.target.closest?.('[data-drop-group]');
    if (!head) return;
    e.preventDefault();
    head.classList.add('drop-over');
  });
  grid.addEventListener('dragleave', (e) => e.target.closest?.('[data-drop-group]')?.classList.remove('drop-over'));
  grid.addEventListener('drop', (e) => {
    const head = e.target.closest?.('[data-drop-group]');
    if (!head) return;
    e.preventDefault();
    head.classList.remove('drop-over');
    const id = e.dataTransfer.getData('text/plain');
    if (decks[id]) moveDeckToGroup(id, head.dataset.dropGroup);
  });

  el('new-group-btn').addEventListener('click', async () => {
    const id = `g${Date.now().toString(36)}`;
    groups.push({ id, name: 'New group', collapsed: false });
    editingGroupId = id;
    await persistGroups();
    renderList();
    const inp = grid.querySelector('[data-grp-name-input]');
    inp?.scrollIntoView({ block: 'center' });
    inp?.focus();
    inp?.select();
  });
  el('list-color').addEventListener('change', (e) => {
    listUiState.color = e.target.value;
    renderList();
  });
  el('list-archetype').addEventListener('change', (e) => {
    listUiState.archetype = e.target.value;
    renderList();
  });
  el('ai-tag-all-btn').addEventListener('click', () => {
    const todo = Object.values(decks).filter((d) => !deckTagIds(d).archetype.length);
    todo.forEach((d) => enqueueAi('tags', d.id));
    if (!todo.length) alert('Every deck already has an archetype tag.');
  });

  // --- tag editor / manager overlays
  el('tag-manager-btn').addEventListener('click', openTagManager);
  el('deck-tags-btn').addEventListener('click', () => openTagsEditor({ draft: true, id: draft.id }));
  for (const [overlay, close] of [['tags-overlay', 'tags-close'], ['tagdb-overlay', 'tagdb-close']]) {
    el(close).addEventListener('click', () => hideOverlay(overlay));
    el(overlay).addEventListener('click', (e) => {
      if (e.target === el(overlay)) hideOverlay(overlay);
    });
  }
  el('tags-body').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.toggleTag) toggleDeckTag(btn.dataset.cat, btn.dataset.toggleTag);
    else if (btn.dataset.aiTags) enqueueAi('tags', btn.dataset.aiTags);
    else if (btn.dataset.openManager) openTagManager();
  });
  el('tags-body').addEventListener('change', (e) => {
    if (e.target.dataset.groupSelect !== undefined) commitDeckMeta((m) => (m.groupId = e.target.value || null));
  });
  attachTagManagerControls();
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (el('tagdb-overlay').classList.contains('open')) hideOverlay('tagdb-overlay');
    else if (el('tags-overlay').classList.contains('open')) hideOverlay('tags-overlay');
  });
  window.__refreshTagUi = () => {
    renderAiQueueBar();
    if (el('tags-overlay').classList.contains('open')) renderTagsEditor();
  };
}

// --- Per-deck tag + group editor ---------------------------------------------------

function editedDeck() {
  if (!tagsEditing) return null;
  return tagsEditing.draft ? draft : decks[tagsEditing.id];
}

async function commitDeckMeta(mutate) {
  const d = editedDeck();
  if (!d) return;
  const meta = {
    tags: { archetype: [...(d.tags?.archetype || [])], creator: [...(d.tags?.creator || [])], misc: [...(d.tags?.misc || [])] },
    groupId: d.groupId || null
  };
  mutate(meta);
  if (tagsEditing.draft) {
    draft.tags = meta.tags;
    draft.groupId = meta.groupId;
    updateTagsSummary();
  } else {
    decks = await window.api.setDeckMeta(tagsEditing.id, meta);
  }
  renderTagsEditor();
  if (view === 'list') renderList();
}

function toggleDeckTag(cat, id) {
  commitDeckMeta((m) => {
    const list = m.tags[cat];
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1);
    else list.push(id);
  });
}

function openTagsEditor(target) {
  tagsEditing = target;
  renderTagsEditor();
  showOverlay('tags-overlay');
}

function renderTagsEditor() {
  const d = editedDeck();
  if (!d) return;
  el('tags-title').textContent = `Tags & Group - ${d.name || 'Untitled Deck'}`;
  const explicit = d.tags || {};
  const derivedCreators = deckTagIds(d).creator;
  const queued = aiQueue.find((j) => j.kind === 'tags' && j.deckId === d.id);
  const aiLabel = !queued ? '&#10024; Suggest with AI' : queued.status === 'running' ? 'Thinking...' : queued.status === 'queued' ? 'Queued' : 'Failed - retry';

  const sections = TAG_CATS.map((cat) => {
    const all = tagsInCat(cat.key);
    const chips = all.length
      ? all
          .map((t) => {
            const on = (explicit[cat.key] || []).includes(t.id);
            const viaLink = !on && cat.key === 'creator' && derivedCreators.includes(t.id);
            const featured = t.id === FEATURED_ID ? ' featured' : '';
            return `<button class="tag-chip cat-${cat.key}${featured}${on || viaLink ? ' on' : ''}" data-cat="${cat.key}" data-toggle-tag="${t.id}" ${viaLink ? 'disabled' : ''} title="${escapeHtml(viaLink ? 'Added by a reference link for this channel' : t.description || t.name)}">${escapeHtml(t.name)}</button>`;
          })
          .join('')
      : '';
    const ai = cat.key === 'archetype' ? `<button class="ai-btn" data-ai-tags="${d.id}" ${queued ? 'disabled' : ''}>${aiLabel}</button>` : '';
    const err = cat.key === 'archetype' && queued?.status === 'error' ? `<div class="tags-hint" style="color:var(--red)">${escapeHtml(queued.error)}</div>` : '';
    return `<div class="tags-sec"><h4>${cat.title} ${ai}</h4><div class="tag-chips">${chips}</div>${err}</div>`;
  }).join('');

  const groupOpts = ['<option value="">Ungrouped</option>']
    .concat(groups.map((g) => `<option value="${g.id}" ${d.groupId === g.id ? 'selected' : ''}>${escapeHtml(g.name)}</option>`))
    .join('');
  el('tags-body').innerHTML = `
    <div class="tags-sec"><h4>Colors</h4>
      <div class="tag-chips">${colorChipHtml(colorTagOf(d))}</div></div>
    ${sections}
    <div class="tags-sec"><h4>Group</h4>
      <select data-group-select ${groups.length ? '' : 'disabled'}>${groupOpts}</select></div>
    <div><button class="btn" data-open-manager="1">&#127991; Manage tag database</button></div>`;
}

// --- Tag database manager ------------------------------------------------------------

function openTagManager() {
  confirmTagDeleteId = null;
  renderTagManager();
  showOverlay('tagdb-overlay');
  requestAnimationFrame(() => requestAnimationFrame(sizeTagTextareas));
}

function renderTagManager() {
  const sections = TAG_CATS.map((cat) => {
    const rows = tagsInCat(cat.key)
      .map((t) => {
        const second =
          cat.key === 'creator'
            ? `<input data-tag-field="url" data-id="${t.id}" value="${escapeHtml(t.url || '')}" placeholder="Channel URL (https://youtube.com/@...)" />`
            : `<textarea data-tag-field="description" data-id="${t.id}" rows="2" placeholder="What does this mean? (the AI reads this)">${escapeHtml(t.description || '')}</textarea>`;
        const del = t.locked
          ? '<span class="tagdb-locked"></span>'
          : `<button class="grp-btn danger" data-del-tag="${t.id}">${confirmTagDeleteId === t.id ? 'Really?' : 'Delete'}</button>`;
        return `<div class="tagdb-row"><input data-tag-field="name" data-id="${t.id}" value="${escapeHtml(t.name)}" ${t.locked ? 'disabled' : ''} />${second}${del}</div>`;
      })
      .join('');
    const ph = cat.key === 'creator' ? 'Channel URL' : 'Definition';
    return `<div class="tags-sec"><h4>${cat.title}</h4>${rows}
      <div class="tagdb-add"><input id="add-name-${cat.key}" placeholder="New ${cat.key === 'creator' ? 'channel' : 'tag'} name" /><input id="add-desc-${cat.key}" placeholder="${ph}" /><button class="btn" data-add-tag="${cat.key}">Add</button></div></div>`;
  }).join('');
  el('tagdb-body').innerHTML = sections;
  sizeTagTextareas();
}

// Definitions grow to fit their text (no scrollbar, no handle). Needs the
// overlay laid out, so it also runs after it opens.
function sizeTagTextareas() {
  el('tagdb-body').querySelectorAll('textarea').forEach((ta) => {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  });
}

async function saveTagDb() {
  const r = await window.api.saveTags(tagDb);
  tagDb = r.tags;
  decks = r.decks;
  if (view === 'list') renderList();
}

function attachTagManagerControls() {
  const body = el('tagdb-body');
  body.addEventListener('input', (e) => {
    if (e.target.tagName === 'TEXTAREA') sizeTagTextareas();
  });
  body.addEventListener('change', async (e) => {
    const f = e.target.dataset.tagField;
    if (!f) return;
    const t = tagOf(e.target.dataset.id);
    if (!t) return;
    if (f === 'name' && !e.target.value.trim()) {
      e.target.value = t.name;
      return;
    }
    t[f] = e.target.value.trim();
    await saveTagDb();
  });
  body.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.delTag) {
      if (confirmTagDeleteId !== btn.dataset.delTag) {
        confirmTagDeleteId = btn.dataset.delTag;
      } else {
        tagDb = tagDb.filter((t) => t.id !== btn.dataset.delTag);
        confirmTagDeleteId = null;
        await saveTagDb();
      }
      renderTagManager();
    } else if (btn.dataset.addTag) {
      const cat = btn.dataset.addTag;
      const name = el(`add-name-${cat}`).value.trim();
      if (!name) return;
      const extra = el(`add-desc-${cat}`).value.trim();
      const tag = { id: `${cat.slice(0, 4)}-${Date.now().toString(36)}`, category: cat, name, description: cat === 'creator' ? '' : extra };
      if (cat === 'creator' && extra) tag.url = extra;
      tagDb.push(tag);
      await saveTagDb();
      renderTagManager();
      if (el('tags-overlay').classList.contains('open')) renderTagsEditor();
    }
  });
}

// --- AI queue (descriptions + tag suggestions, one at a time) ------------------------

const aiQueue = []; // { kind: 'desc' | 'tags', deckId, status: 'queued' | 'running' | 'error', error }
let aiQueuePumping = false;

const deckForJob = (id) => (draft && draft.id === id ? draft : decks[id]);

// True when there is nothing to lose by drafting: no section text and no
// legacy HTML description.
function descIsEmpty(deck) {
  if ((deck.description || '').trim()) return false;
  const s = deck.descSections || {};
  return !DESC_SECTIONS.some((sec) => sec.fields.some((f) => (s[f.key] || '').trim()));
}

function aiJobFor(kind, deckId) {
  return aiQueue.find((j) => j.kind === kind && j.deckId === deckId);
}

function enqueueAi(kind, deckId) {
  const existing = aiJobFor(kind, deckId);
  if (existing && existing.status !== 'error') return;
  if (existing) aiQueue.splice(aiQueue.indexOf(existing), 1);
  aiQueue.push({ kind, deckId, status: 'queued' });
  refreshAiQueueUi();
  pumpAiQueue();
}

function refreshAiQueueUi() {
  renderAiQueueBar();
  if (view === 'list') renderList();
  if (el('tags-overlay').classList.contains('open')) renderTagsEditor();
}

async function pumpAiQueue() {
  if (aiQueuePumping) return;
  aiQueuePumping = true;
  try {
    let job;
    while ((job = aiQueue.find((j) => j.status === 'queued'))) {
      // The Description editor's own AI Draft shares the same API calls.
      while (aiBusy) await new Promise((r) => setTimeout(r, 1000));
      job.status = 'running';
      aiBusy = true;
      refreshAiQueueUi();
      try {
        await runAiJob(job);
        aiQueue.splice(aiQueue.indexOf(job), 1);
      } catch (err) {
        job.status = 'error';
        job.error = err.message;
      } finally {
        aiBusy = false;
      }
      refreshAiQueueUi();
    }
  } finally {
    aiQueuePumping = false;
  }
}

async function runAiJob(job) {
  const deck = deckForJob(job.deckId);
  if (!deck) throw new Error('That deck no longer exists.');
  if (!deck.legendCardIds.filter(Boolean).length || !Object.keys(deck.cards || {}).length) throw new Error('Needs a Legend and some cards first.');
  const payload = aiPayload(deck);
  if (job.kind === 'desc') {
    const res = await window.api.analyzeDeck(payload);
    if (!res.ok) throw new Error(res.error);
    if (draft && draft.id === job.deckId) {
      mergeAiSections(draft.descSections, res.sections, false);
      updateDescSummary();
    } else {
      const saved = decks[job.deckId];
      if (!saved) throw new Error('That deck was deleted while drafting.');
      const sections = { ...(saved.descSections || {}) };
      mergeAiSections(sections, res.sections, false);
      decks = await window.api.saveDeck({ ...saved, descSections: sections });
    }
  } else {
    const res = await window.api.tagDeck(payload);
    if (!res.ok) throw new Error(res.error);
    const ids = res.tags.map((t) => t.id);
    const base = deckForJob(job.deckId);
    const tags = { archetype: [...new Set([...(base.tags?.archetype || []), ...ids])], creator: [...(base.tags?.creator || [])], misc: [...(base.tags?.misc || [])] };
    if (draft && draft.id === job.deckId) {
      draft.tags = tags;
      updateTagsSummary();
    } else {
      decks = await window.api.setDeckMeta(job.deckId, { tags });
    }
  }
}

function renderAiQueueBar() {
  const bar = el('ai-queue-bar');
  bar.hidden = !aiQueue.length;
  if (!aiQueue.length) return;
  const name = (j) => escapeHtml(decks[j.deckId]?.name || draft?.name || 'Untitled');
  const label = (j) => (j.kind === 'desc' ? 'description' : 'tags');
  const running = aiQueue.find((j) => j.status === 'running');
  const waiting = aiQueue.filter((j) => j.status === 'queued').length;
  const errors = aiQueue.filter((j) => j.status === 'error');
  bar.innerHTML = `<span>&#10024; AI queue:</span>
    ${running ? `<span>working on <b>${name(running)}</b> (${label(running)})</span>` : ''}
    ${waiting ? `<span>${waiting} waiting</span>` : ''}
    ${errors.map((j) => `<span class="err">${name(j)} (${label(j)}): ${escapeHtml(j.error)}</span>`).join('')}
    ${waiting ? '<button class="grp-btn" data-q="cancel">Cancel waiting</button>' : ''}
    ${errors.length ? '<button class="grp-btn" data-q="dismiss">Dismiss errors</button>' : ''}`;
  bar.onclick = (e) => {
    const q = e.target.dataset.q;
    if (!q) return;
    for (let i = aiQueue.length - 1; i >= 0; i--) {
      if ((q === 'cancel' && aiQueue[i].status === 'queued') || (q === 'dismiss' && aiQueue[i].status === 'error')) aiQueue.splice(i, 1);
    }
    refreshAiQueueUi();
  };
}

// The "Fill description" chip on a deck card (only shown when the description
// is completely empty).
function aiFillButtonHtml(deck) {
  if (!descIsEmpty(deck)) return '';
  const job = aiJobFor('desc', deck.id);
  if (job?.status === 'running') return '<button class="deck-flag deck-flag-ai running" disabled>&#10024; Drafting...</button>';
  if (job?.status === 'queued') return '<button class="deck-flag deck-flag-ai" disabled title="Waiting for earlier AI requests">&#9203; Queued</button>';
  if (job?.status === 'error') return `<button class="deck-flag deck-flag-ai" data-ai-fill="${deck.id}" title="${escapeHtml(job.error)}">&#9888; Failed - retry</button>`;
  return `<button class="deck-flag deck-flag-ai" data-ai-fill="${deck.id}" title="Draft all description sections with AI (queued if another request is running)">&#10024; Fill description</button>`;
}
