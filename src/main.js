const { app, BrowserWindow, WebContentsView, ipcMain, protocol, net, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const pathToFileURL = require('url').pathToFileURL;
const execFileAsync = require('util').promisify(require('child_process').execFile);
const prices = require('./prices');
const ai = require('./ai');

// Electron derives the default userData path (%APPDATA%/<name>) from this
// app name, which otherwise silently follows package.json's "name" field.
// Renaming that field (e.g. cyberpunk-tcg-tracker -> eddies) would then
// point every existing user at a brand-new, empty folder - orphaning their
// real cards-cache.json/collection.json/backups without deleting anything.
// Pinning it explicitly keeps userData stable across any future rename.
app.setName('cyberpunk-tcg-tracker');

const API_BASE = 'https://api.netdeck.gg/api/cards/cyberpunk';
const PAGE_LIMIT = 100;
const IMAGE_CONCURRENCY = 8;
const DETAIL_CONCURRENCY = 8;

protocol.registerSchemesAsPrivileged([
  { scheme: 'cardimg', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);

function cardsCachePath() {
  return path.join(app.getPath('userData'), 'cards-cache.json');
}

function collectionPath() {
  return path.join(app.getPath('userData'), 'collection.json');
}

function imagesDir() {
  return path.join(app.getPath('userData'), 'images');
}

function backupsDir() {
  return path.join(app.getPath('userData'), 'backups');
}

function decksPath() {
  return path.join(app.getPath('userData'), 'decks.json');
}

function backupsMetaPath() {
  return path.join(backupsDir(), 'meta.json');
}

const MAX_BACKUPS = 3;

async function readBackupsMeta() {
  return readJsonSafe(backupsMetaPath(), {});
}

async function writeBackupsMeta(meta) {
  await fs.writeFile(backupsMetaPath(), JSON.stringify(meta, null, 2), 'utf-8');
}

// Only counts against (and gets pruned by) the MAX_BACKUPS rotation if
// unlocked. Locked backups are kept forever regardless of age/count.
async function backupCollection() {
  await fs.mkdir(backupsDir(), { recursive: true });
  let raw;
  try {
    raw = await fs.readFile(collectionPath(), 'utf-8');
  } catch {
    return; // nothing to back up yet
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.writeFile(path.join(backupsDir(), `collection-${stamp}.json`), raw, 'utf-8');

  const all = await listBackups();
  const unlockedOverflow = all.filter((b) => !b.locked).slice(MAX_BACKUPS);
  if (unlockedOverflow.length) {
    const meta = await readBackupsMeta();
    for (const { filename } of unlockedOverflow) {
      await fs.unlink(path.join(backupsDir(), filename)).catch(() => {});
      delete meta[filename];
    }
    await writeBackupsMeta(meta);
  }
}

async function listBackups() {
  await fs.mkdir(backupsDir(), { recursive: true });
  const meta = await readBackupsMeta();
  const files = (await fs.readdir(backupsDir())).filter((f) => f.startsWith('collection-') && f.endsWith('.json'));
  const withTimes = await Promise.all(
    files.map(async (f) => ({
      filename: f,
      mtime: (await fs.stat(path.join(backupsDir(), f))).mtimeMs,
      label: meta[f]?.label || null,
      locked: !!meta[f]?.locked
    }))
  );
  withTimes.sort((a, b) => b.mtime - a.mtime);
  return withTimes;
}

async function readJsonSafe(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

async function fetchAllCards() {
  let offset = 0;
  let total = Infinity;
  const items = [];
  while (offset < total) {
    const res = await fetch(`${API_BASE}?limit=${PAGE_LIMIT}&offset=${offset}`);
    if (!res.ok) throw new Error(`Card API request failed: ${res.status}`);
    const data = await res.json();
    total = data.total;
    items.push(...data.items);
    offset += data.items.length;
    if (data.items.length === 0) break;
  }
  return items;
}

// Localized card names for deck import. The list endpoint takes `language=`
// and returns the same cardId with translated name/subname. Cached per
// language in userData/alt-names.json; a failed download falls back to it.
function altNamesPath() {
  return path.join(app.getPath('userData'), 'alt-names.json');
}

async function fetchAltNames() {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(altNamesPath(), 'utf8')); } catch {}
  const week = 7 * 24 * 3600 * 1000;
  if (cache.fetchedAt && Date.now() - cache.fetchedAt < week) return cache.names || [];
  try {
    const fres = await fetch(`${API_BASE}/filters`);
    const filters = await fres.json();
    const langs = (filters.filters.find((f) => f.key === 'language')?.options || []).map((o) => o.value).filter((v) => v !== 'en');
    const names = [];
    for (const lang of langs) {
      let offset = 0;
      let total = Infinity;
      while (offset < total) {
        const res = await fetch(`${API_BASE}?limit=${PAGE_LIMIT}&offset=${offset}&language=${lang}`);
        if (!res.ok) throw new Error(`alt names ${lang}: ${res.status}`);
        const data = await res.json();
        total = data.total;
        for (const it of data.items) names.push({ cardId: it.id, name: it.name, subname: it.subname || null });
        offset += data.items.length;
        if (!data.items.length) break;
      }
    }
    fs.writeFileSync(altNamesPath(), JSON.stringify({ fetchedAt: Date.now(), names }));
    return names;
  } catch (err) {
    console.error('[alt-names]', err.message);
    return cache.names || [];
  }
}

ipcMain.handle('cards:altNames', () => fetchAltNames());

async function fetchCardDetail(slug) {
  const res = await fetch(`${API_BASE}/${slug}`);
  if (!res.ok) throw new Error(`Card detail request failed for ${slug}: ${res.status}`);
  return res.json();
}

async function fetchAllCardDetails(summaries) {
  const details = new Array(summaries.length);
  let index = 0;
  async function worker() {
    while (index < summaries.length) {
      const i = index++;
      details[i] = await fetchCardDetail(summaries[i].slug);
    }
  }
  await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, worker));
  return details;
}

// The bulk list endpoint collapses each card to a single default printing.
// Fetching each card's detail exposes its full `printings` array (one entry
// per set/art variant), which is what we actually want to track.
function flattenPrintings(detail) {
  const base = {
    cardId: detail.id,
    externalId: detail.external_id,
    name: detail.name,
    subname: detail.subname,
    displayName: detail.display_name,
    slug: detail.slug,
    rulesText: detail.rules_text,
    flavorText: detail.flavor_text,
    color: detail.color,
    cardType: detail.card_type,
    isEddiable: detail.is_eddiable,
    classifications: detail.classifications || [],
    keywords: detail.keywords || [],
    cost: detail.cost,
    power: detail.power,
    ram: detail.ram,
    legality: detail.legality
  };
  const printings = detail.printings && detail.printings.length ? detail.printings : [
    {
      id: detail.printing_id,
      collector_number: detail.print_number,
      image_url: detail.image_url,
      set: detail.set,
      rarity: detail.rarity,
      finish: null,
      artist: detail.artist
    }
  ];
  return printings.map((p) => ({
    ...base,
    id: p.id,
    collectorNumber: p.collector_number,
    set: p.set,
    rarity: p.rarity,
    finish: p.finish,
    artist: p.artist,
    remoteImageUrl: p.image_url,
    imageUrl: `cardimg://${p.id}.webp`
  }));
}

async function downloadImage(printing) {
  const dest = path.join(imagesDir(), `${printing.id}.webp`);
  try {
    await fs.access(dest);
    return;
  } catch {
    // not cached yet, fall through to download
  }
  const res = await fetch(printing.remoteImageUrl);
  if (!res.ok) throw new Error(`Image download failed for ${printing.id}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
}

async function downloadAllImages(printings) {
  await fs.mkdir(imagesDir(), { recursive: true });
  let index = 0;
  async function worker() {
    while (index < printings.length) {
      const printing = printings[index++];
      try {
        await downloadImage(printing);
      } catch (err) {
        console.log(`[image download] ${printing.id} failed: ${err.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: IMAGE_CONCURRENCY }, worker));
}

ipcMain.handle('cards:get', async () => {
  const cache = await readJsonSafe(cardsCachePath(), null);
  return cache;
});

ipcMain.handle('cards:refresh', async () => {
  const summaries = await fetchAllCards();
  const details = await fetchAllCardDetails(summaries);
  const printings = details.flatMap(flattenPrintings);
  await downloadAllImages(printings);
  const cache = {
    fetchedAt: new Date().toISOString(),
    cards: printings.map(({ remoteImageUrl, ...rest }) => rest)
  };
  await fs.writeFile(cardsCachePath(), JSON.stringify(cache, null, 2), 'utf-8');
  return cache;
});

// --- Cardmarket prices (see prices.js) ------------------------------------

function pricesCachePath() {
  return path.join(app.getPath('userData'), 'prices-cache.json');
}

// { [printingId]: idProduct | null } - null means "explicitly no match".
function priceOverridesPath() {
  return path.join(app.getPath('userData'), 'price-overrides.json');
}

// Re-downloads if the cache is older than a day's Cardmarket regeneration
// (or `force`); a failed download falls back to whatever is cached, so
// being offline just means slightly older prices, not none.
async function loadPriceData(force = false) {
  const cached = await readJsonSafe(pricesCachePath(), null);
  if (!force && !prices.isStale(cached)) return cached;
  try {
    const fresh = await prices.downloadCardmarketData();
    await fs.writeFile(pricesCachePath(), JSON.stringify(fresh), 'utf-8');
    return fresh;
  } catch (err) {
    console.log(`[prices] ${err.message}`);
    if (force && !cached) throw err;
    return cached;
  }
}

async function getPriceView(force = false) {
  const [data, cache, overrides] = await Promise.all([
    loadPriceData(force),
    readJsonSafe(cardsCachePath(), { cards: [] }),
    readJsonSafe(priceOverridesPath(), {})
  ]);
  return prices.buildPriceView(cache.cards, data, overrides);
}

ipcMain.handle('prices:get', async () => getPriceView(false));
ipcMain.handle('prices:refresh', async () => getPriceView(true));

// idProduct: a Cardmarket product id, null for "no match", or 'auto' to
// clear the override and go back to the automatic match.
ipcMain.handle('prices:setOverride', async (_event, printingId, idProduct) => {
  const overrides = await readJsonSafe(priceOverridesPath(), {});
  if (idProduct === 'auto') delete overrides[printingId];
  else overrides[printingId] = idProduct === null ? null : Number(idProduct);
  await fs.writeFile(priceOverridesPath(), JSON.stringify(overrides, null, 2), 'utf-8');
  return getPriceView(false);
});

const BUCKETS = ['main', 'reserve', 'extras'];

ipcMain.handle('collection:get', async () => {
  const collection = await readJsonSafe(collectionPath(), {});
  // Migrate older {owned} / {owned, foil} shapes into a single "main" bucket
  // now that copies are split into main / reserve / extras.
  let migrated = false;
  for (const [cardId, entry] of Object.entries(collection)) {
    if (!entry || typeof entry !== 'object') continue;
    if (BUCKETS.some((b) => b in entry)) continue;
    const owned = (entry.owned || 0) + (entry.foil || 0);
    if (owned > 0) collection[cardId] = { main: owned, reserve: 0, extras: 0 };
    else delete collection[cardId];
    migrated = true;
  }
  if (migrated) {
    await fs.writeFile(collectionPath(), JSON.stringify(collection, null, 2), 'utf-8');
  }
  return collection;
});

ipcMain.handle('collection:set', async (_event, cardId, bucket, value) => {
  if (!BUCKETS.includes(bucket)) throw new Error(`Invalid bucket: ${bucket}`);
  const collection = await readJsonSafe(collectionPath(), {});
  const current = collection[cardId] || { main: 0, reserve: 0, extras: 0 };
  const next = { ...current, [bucket]: Math.max(0, value) };
  if (BUCKETS.every((b) => !next[b])) {
    delete collection[cardId];
  } else {
    collection[cardId] = next;
  }
  await fs.writeFile(collectionPath(), JSON.stringify(collection, null, 2), 'utf-8');
  return collection;
});

ipcMain.handle('collection:backup', async () => {
  await backupCollection();
  return listBackups();
});

ipcMain.handle('collection:listBackups', async () => {
  return listBackups();
});

ipcMain.handle('collection:restoreBackup', async (_event, filename) => {
  const backups = await listBackups();
  if (!backups.some((b) => b.filename === filename)) throw new Error('Unknown backup file');
  // Snapshot the current state first, so a restore is itself undoable.
  await backupCollection();
  const raw = await fs.readFile(path.join(backupsDir(), filename), 'utf-8');
  await fs.writeFile(collectionPath(), raw, 'utf-8');
  return JSON.parse(raw);
});

ipcMain.handle('collection:renameBackup', async (_event, filename, label) => {
  const backups = await listBackups();
  if (!backups.some((b) => b.filename === filename)) throw new Error('Unknown backup file');
  const meta = await readBackupsMeta();
  meta[filename] = { ...(meta[filename] || {}), label: label || null };
  await writeBackupsMeta(meta);
  return listBackups();
});

ipcMain.handle('collection:setBackupLocked', async (_event, filename, locked) => {
  const backups = await listBackups();
  if (!backups.some((b) => b.filename === filename)) throw new Error('Unknown backup file');
  const meta = await readBackupsMeta();
  meta[filename] = { ...(meta[filename] || {}), locked: !!locked };
  await writeBackupsMeta(meta);
  return listBackups();
});

// Overwrites one specific save's content with the current collection state
// in place - same filename, same label/lock, just refreshed content and
// mtime. This is a deliberate user action, so it's allowed even on a
// locked save (locking only protects against the automatic 3-save rotation).
ipcMain.handle('collection:overwriteBackup', async (_event, filename) => {
  const backups = await listBackups();
  if (!backups.some((b) => b.filename === filename)) throw new Error('Unknown backup file');
  const raw = await fs.readFile(collectionPath(), 'utf-8');
  await fs.writeFile(path.join(backupsDir(), filename), raw, 'utf-8');
  return listBackups();
});

// --- Deck builder -----------------------------------------------------
//
// Decks are stored separately from collection.json (same privacy tier -
// never committed). A deck slot is keyed by a card's *cardId*, not a
// printing id, because the game's copy-limit ("max 3 of a card with an
// identical name+subtitle") and Legend-uniqueness rules both operate on the
// card itself, not the specific art/printing - see CLAUDE.md's "Printings,
// not cards" note. The renderer owns all deckbuilding legality logic
// (RAM/color ceilings, copy limits); this process is just CRUD storage.

ipcMain.handle('decks:get', async () => {
  return readJsonSafe(decksPath(), {});
});

ipcMain.handle('decks:save', async (_event, deck) => {
  const decks = await readJsonSafe(decksPath(), {});
  const now = new Date().toISOString();
  const id = deck.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const existing = decks[id];
  decks[id] = {
    // Tags/group are also edited outside the Builder (setMeta), so a save
    // that doesn't carry them must not wipe them.
    ...(existing?.tags ? { tags: existing.tags } : {}),
    ...(existing?.groupId ? { groupId: existing.groupId } : {}),
    ...deck,
    id,
    createdAt: existing?.createdAt || deck.createdAt || now,
    updatedAt: now
  };
  enforceSingleFeatured(decks, id);
  await fs.writeFile(decksPath(), JSON.stringify(decks, null, 2), 'utf-8');
  return decks;
});

ipcMain.handle('decks:delete', async (_event, deckId) => {
  const decks = await readJsonSafe(decksPath(), {});
  delete decks[deckId];
  await fs.writeFile(decksPath(), JSON.stringify(decks, null, 2), 'utf-8');
  return decks;
});

// --- Deck tags + groups ------------------------------------------------------
//
// Tag database: userData/tag-db.json, seeded from src/data/tag-seed.json.
// Categories: archetype / creator (YouTube channels) / misc are stored tags;
// "color" tags (BBG, RRY...) are never stored - they're derived from a deck's
// Legends (colorTagFor). A deck references stored tags by id in
// deck.tags = { archetype: [ids], creator: [ids], misc: [ids] }; deck.groupId
// points into deck-groups.json. Neither is part of the Builder's draft logic
// beyond being carried along, so setMeta can edit them without touching
// updatedAt or the rest of the deck.

const TAG_CATEGORIES = ['archetype', 'creator', 'misc'];
// Only one deck can be Featured: giving it to a deck takes it from the rest.
function enforceSingleFeatured(decks, keepId) {
  if (!decks[keepId]?.tags?.misc?.includes('misc-featured')) return;
  for (const [id, d] of Object.entries(decks)) {
    if (id !== keepId && d.tags?.misc?.includes('misc-featured')) d.tags.misc = d.tags.misc.filter((t) => t !== 'misc-featured');
  }
}

const tagDbPath = () => path.join(app.getPath('userData'), 'tag-db.json');
const groupsPath = () => path.join(app.getPath('userData'), 'deck-groups.json');

async function loadTagDb() {
  const saved = await readJsonSafe(tagDbPath(), null);
  if (saved?.tags) return saved.tags;
  const seed = await readJsonSafe(path.join(__dirname, 'data', 'tag-seed.json'), { tags: [] });
  await fs.writeFile(tagDbPath(), JSON.stringify({ tags: seed.tags }, null, 2), 'utf-8');
  return seed.tags;
}

// Every creator tag that has a YouTube channel URL, for the website's video
// tracker (scripts/fetch-videos.js reads docs/data/creators.json). This is the
// whole tag DB, not just creators used by published decks, so a channel is
// followed as soon as it's in the DB.
async function writeCreatorsFile() {
  const creators = (await loadTagDb())
    .filter((t) => t.category === 'creator' && /^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(t.url || ''))
    .map((t) => ({ name: t.name, url: t.url }));
  await fs.mkdir(docsDataDir(), { recursive: true });
  await fs.writeFile(path.join(docsDataDir(), 'creators.json'), JSON.stringify({ creators }, null, 2), 'utf-8');
}

// Letters in the fixed R,B,G,Y order; most-represented color first, so
// Blue+Blue+Green and Green+Blue+Blue are both "BBG" and one of each is "RBG".
function colorTagFor(colors) {
  const order = ['Red', 'Blue', 'Green', 'Yellow'];
  const counts = {};
  for (const c of colors) if (order.includes(c)) counts[c] = (counts[c] || 0) + 1;
  return order
    .filter((c) => counts[c])
    .sort((a, b) => counts[b] - counts[a])
    .map((c) => c[0].repeat(counts[c]))
    .join('');
}

ipcMain.handle('tags:get', async () => loadTagDb());

// Saving the whole list; any tag that disappeared is also removed from decks.
ipcMain.handle('tags:save', async (_event, tags) => {
  const clean = tags
    .filter((t) => t && TAG_CATEGORIES.includes(t.category) && String(t.name || '').trim())
    .map((t) => ({ id: t.id, category: t.category, name: String(t.name).trim(), description: String(t.description || '').trim(), ...(t.url ? { url: String(t.url).trim() } : {}), ...(t.locked ? { locked: true } : {}) }));
  await fs.writeFile(tagDbPath(), JSON.stringify({ tags: clean }, null, 2), 'utf-8');
  const live = new Set(clean.map((t) => t.id));
  const decks = await readJsonSafe(decksPath(), {});
  let changed = false;
  for (const deck of Object.values(decks)) {
    for (const cat of TAG_CATEGORIES) {
      const ids = deck.tags?.[cat];
      if (ids && ids.some((id) => !live.has(id))) {
        deck.tags[cat] = ids.filter((id) => live.has(id));
        changed = true;
      }
    }
    for (const l of deck.links || []) {
      if (l.creatorId && !live.has(l.creatorId)) {
        delete l.creatorId;
        changed = true;
      }
    }
  }
  if (changed) await fs.writeFile(decksPath(), JSON.stringify(decks, null, 2), 'utf-8');
  return { tags: clean, decks };
});

ipcMain.handle('groups:get', async () => {
  let siteBase = '';
  try {
    siteBase = `https://${(await fs.readFile(path.join(__dirname, '..', 'docs', 'CNAME'), 'utf-8')).trim()}/`;
  } catch {}
  return { groups: await readJsonSafe(groupsPath(), []), siteBase };
});

// [{ id, name, collapsed }] in display order. Decks pointing at a removed
// group fall back to ungrouped.
ipcMain.handle('groups:save', async (_event, groups) => {
  const clean = groups.map((g) => ({ id: g.id, name: String(g.name || '').trim() || 'Untitled group', collapsed: !!g.collapsed }));
  await fs.writeFile(groupsPath(), JSON.stringify(clean, null, 2), 'utf-8');
  const live = new Set(clean.map((g) => g.id));
  const decks = await readJsonSafe(decksPath(), {});
  let changed = false;
  for (const deck of Object.values(decks)) {
    if (deck.groupId && !live.has(deck.groupId)) {
      delete deck.groupId;
      changed = true;
    }
  }
  if (changed) await fs.writeFile(decksPath(), JSON.stringify(decks, null, 2), 'utf-8');
  return { groups: clean, decks };
});

// Edits tags / group on a saved deck without touching anything else (and
// without bumping updatedAt - this isn't a content edit).
ipcMain.handle('decks:setMeta', async (_event, deckId, patch) => {
  const decks = await readJsonSafe(decksPath(), {});
  const deck = decks[deckId];
  if (!deck) return decks;
  if (patch.tags) deck.tags = patch.tags;
  if ('groupId' in patch) {
    if (patch.groupId) deck.groupId = patch.groupId;
    else delete deck.groupId;
  }
  enforceSingleFeatured(decks, deckId);
  await fs.writeFile(decksPath(), JSON.stringify(decks, null, 2), 'utf-8');
  return decks;
});

// AI archetype suggestion. Categories the model may assign are listed in
// ai.js (AI_TAG_CATEGORIES); every tag in the DB for those categories - with
// its description - is what it "knows", so adding a tag teaches it. Decks you
// already tagged serve as worked examples.
ipcMain.handle('ai:tagDeck', async (event, deck) => {
  try {
    const tags = await loadTagDb();
    const decks = await readJsonSafe(decksPath(), {});
    const cache = await readJsonSafe(cardsCachePath(), { cards: [] });
    const nameOf = new Map(cache.cards.map((c) => [c.cardId, c.displayName]));
    const examples = Object.values(decks)
      .filter((d) => d.id !== deck.id && d.tags?.archetype?.length)
      .slice(0, 8)
      .map((d) => ({
        name: d.name,
        legends: (d.legendCardIds || []).filter(Boolean).map((id) => nameOf.get(id) || id),
        tags: d.tags.archetype.map((id) => tags.find((t) => t.id === id)?.name).filter(Boolean)
      }));
    const result = await ai.tagDeck(deck, tags, examples, (msg) => event.sender.send('ai:progress', msg));
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// AI deck summary (see src/ai.js). The renderer only ever learns whether a
// key exists, never its value.
ipcMain.handle('ai:keyStatus', async () => ai.keyStatus());
ipcMain.handle('ai:setKey', async (_event, key) => ai.setKey(key));
async function aiPool() {
  const cache = await readJsonSafe(cardsCachePath(), { cards: [] });
  return cache.cards || [];
}
ipcMain.handle('ai:knowledgeStatus', async () => ai.knowledgeStatus(await aiPool()));
ipcMain.handle('ai:buildKnowledge', async (event) => {
  try {
    return { ok: true, status: await ai.buildKnowledge(await aiPool(), (msg) => event.sender.send('ai:progress', msg)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('ai:analyzeDeck', async (event, deck) => {
  try {
    const { sections, analysis } = await ai.analyzeDeck(deck, (msg) => event.sender.send('ai:progress', msg));
    return { ok: true, sections, analysis };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// { [printingId]: qty } - how many copies of a printing are up for sale on
// the website's trade page (docs/trade.html). Local-only like
// collection.json; publish:run snapshots it into docs/data/trade.json.
function tradeListPath() {
  return path.join(app.getPath('userData'), 'trade-list.json');
}

ipcMain.handle('trade:get', async () => readJsonSafe(tradeListPath(), {}));

async function updateTradeList(updates) {
  const list = await readJsonSafe(tradeListPath(), {});
  for (const [printingId, qty] of Object.entries(updates)) {
    if (qty > 0) list[printingId] = qty;
    else delete list[printingId];
  }
  await fs.writeFile(tradeListPath(), JSON.stringify(list, null, 2), 'utf-8');
  return list;
}

ipcMain.handle('trade:set', async (_event, printingId, qty) => updateTradeList({ [printingId]: qty }));
// { printingId: qty } in one write - the main window's "Sell all shown" toggle.
ipcMain.handle('trade:setMany', async (_event, updates) => updateTradeList(updates));

// { [printingId]: true } - cards on the "Looking" list (the Trading window,
// published to docs/data/looking.json). Local-only like trade-list.json; the
// quantity still needed is derived live from the collection, never stored.
function lookingListPath() {
  return path.join(app.getPath('userData'), 'looking-list.json');
}

ipcMain.handle('looking:get', async () => readJsonSafe(lookingListPath(), {}));

// { printingId: boolean } in one write.
ipcMain.handle('looking:setMany', async (_event, updates) => {
  const list = await readJsonSafe(lookingListPath(), {});
  for (const [printingId, on] of Object.entries(updates)) {
    if (on) list[printingId] = true;
    else delete list[printingId];
  }
  await fs.writeFile(lookingListPath(), JSON.stringify(list, null, 2), 'utf-8');
  return list;
});

// Re-write a { id: value } list in the given id order (the Trading window's
// drag/arrow reordering). The key order in the file IS the list order, and
// publish:run iterates it, so the website shows the same order. Ids missing
// from `ids` keep their relative order after the listed ones.
async function reorderList(filePath, ids) {
  const list = await readJsonSafe(filePath, {});
  const next = {};
  for (const id of ids) if (id in list) next[id] = list[id];
  for (const id of Object.keys(list)) if (!(id in next)) next[id] = list[id];
  await fs.writeFile(filePath, JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

ipcMain.handle('looking:reorder', async (_event, ids) => reorderList(lookingListPath(), ids));
ipcMain.handle('trade:reorder', async (_event, ids) => reorderList(tradeListPath(), ids));

ipcMain.handle('shell:openExternal', async (_event, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new Error('Only http/https URLs can be opened.');
  }
  await shell.openExternal(url);
});

// --- Web publish (needed-list website, see docs/) -------------------------
//
// The published site is fully static (GitHub Pages serves docs/ as-is) and
// never writes back through this app directly. Instead, the phone queues
// changes into docs/data/pending-changes.json via GitHub's own API; this
// app is the only thing that ever *applies* those changes to the real
// collection.json, via `git pull` picking up that file. That keeps
// collection.json (private, local-only, never committed) as the single
// source of truth, with the same backup safety net as manual edits.

function projectRoot() {
  return path.join(__dirname, '..');
}

function docsDir() {
  return path.join(projectRoot(), 'docs');
}

function docsDataDir() {
  return path.join(docsDir(), 'data');
}

function docsImagesDir() {
  return path.join(docsDir(), 'images');
}

function pendingChangesPath() {
  return path.join(docsDataDir(), 'pending-changes.json');
}

// Keep in sync with mainSetCap() in renderer.js/collection.js.
function mainSetCap(cardType) {
  return cardType === 'Legend' ? 1 : 3;
}

// Printings with the same name + rules text are one mechanical card. Keep in
// sync with mechKey() in trading.js and docs/trading.js.
function mechKey(c) {
  return `${c.displayName || c.name}|${c.rulesText || c.cardId}`;
}

async function runGit(args) {
  return execFileAsync('git', args, { cwd: projectRoot() });
}

// Applies queued phone-recorded changes (see docs/record.js) to the real,
// local collection.json. Each entry is a *delta* (not an absolute value) so
// concurrent/out-of-order entries can't clobber each other - only ever
// nudges a bucket up or down from whatever it currently is.
async function applyPendingChanges(collection, pending) {
  for (const change of pending) {
    if (!change || !BUCKETS.includes(change.bucket)) continue;
    const current = collection[change.id] || { main: 0, reserve: 0, extras: 0 };
    const next = { ...current, [change.bucket]: Math.max(0, (current[change.bucket] || 0) + (change.delta || 0)) };
    if (BUCKETS.every((b) => !next[b])) delete collection[change.id];
    else collection[change.id] = next;
  }
  return collection;
}

// Snapshot of each printing's Cardmarket price for the website (the site
// can't run the matcher itself - no userData, no overrides).
function priceFieldsFor(priceView, printingId) {
  const m = priceView?.matches?.[printingId];
  const p = m && m.idProduct != null ? priceView.products[m.idProduct] : null;
  const price = prices.headlinePrice(p);
  if (price == null) return {};
  return { price, priceGuess: m.source === 'guess', cmName: p.name };
}

function computeNeeded(cards, collection, priceView) {
  const main = [];
  const reserve = [];
  for (const c of cards) {
    const cap = mainSetCap(c.cardType);
    const entry = collection[c.id] || { main: 0, reserve: 0, extras: 0 };
    const base = {
      id: c.id,
      cardId: c.cardId,
      name: c.name,
      subname: c.subname,
      displayName: c.displayName,
      color: c.color,
      cardType: c.cardType,
      rarity: c.rarity,
      set: c.set,
      collectorNumber: c.collectorNumber,
      cap,
      ...priceFieldsFor(priceView, c.id)
    };
    const mainNeeded = cap - (entry.main || 0);
    if (mainNeeded > 0) main.push({ ...base, have: entry.main || 0, needed: mainNeeded });
    const reserveNeeded = cap - (entry.reserve || 0);
    if (reserveNeeded > 0) reserve.push({ ...base, have: entry.reserve || 0, needed: reserveNeeded });
  }
  return { generatedAt: new Date().toISOString(), pricesAsOf: priceView?.priceDate || null, main, reserve };
}

async function copyNeededImages(needed) {
  await copyImagesToDocs([...needed.main, ...needed.reserve].map((c) => c.id));
}

async function copyImagesToDocs(printingIds) {
  await fs.mkdir(docsImagesDir(), { recursive: true });
  const ids = new Set(printingIds);
  for (const id of ids) {
    const dest = path.join(docsImagesDir(), `${id}.webp`);
    try {
      await fs.access(dest);
      continue; // already published
    } catch {
      // fall through and copy it
    }
    try {
      await fs.copyFile(path.join(imagesDir(), `${id}.webp`), dest);
    } catch (err) {
      console.log(`[publish] couldn't copy image ${id}: ${err.message}`);
    }
  }
}

ipcMain.handle('publish:run', async () => {
  const steps = [];

  // 1. Pull first, so any pending changes the phone queued since our last
  // publish are on disk before we read/apply them.
  try {
    await runGit(['pull', '--ff-only']);
    steps.push('Pulled latest from GitHub.');
  } catch (err) {
    throw new Error(`git pull failed - resolve this in a terminal first: ${err.message}`);
  }

  const pending = await readJsonSafe(pendingChangesPath(), []);
  let collection = await readJsonSafe(collectionPath(), {});

  if (pending.length) {
    await backupCollection(); // safety net before mutating collection.json
    collection = await applyPendingChanges(collection, pending);
    await fs.writeFile(collectionPath(), JSON.stringify(collection, null, 2), 'utf-8');
    steps.push(`Applied ${pending.length} pending change(s) from the phone.`);
  }

  const cache = await readJsonSafe(cardsCachePath(), { cards: [] });
  let priceView = null;
  try {
    priceView = await getPriceView(false);
  } catch (err) {
    steps.push(`Prices skipped: ${err.message}`);
  }
  const needed = computeNeeded(cache.cards, collection, priceView);
  await fs.mkdir(docsDataDir(), { recursive: true });
  await fs.writeFile(path.join(docsDataDir(), 'needed.json'), JSON.stringify(needed, null, 2), 'utf-8');
  // Tiny summary for the website's Home page (so it needn't download the
  // full needed list just to show a couple of counts).
  const sumNeeded = (list) => list.reduce((n, c) => n + c.needed, 0);
  await fs.writeFile(
    path.join(docsDataDir(), 'stats.json'),
    JSON.stringify({
      generatedAt: needed.generatedAt,
      neededMain: needed.main.length,
      neededMainCopies: sumNeeded(needed.main),
      neededReserve: needed.reserve.length,
      neededReserveCopies: sumNeeded(needed.reserve)
    }, null, 2),
    'utf-8'
  );
  await writeCreatorsFile();
  await copyNeededImages(needed);

  // A lightweight full catalog (no images) so the Record page can log a
  // trade for *any* card, not just ones currently needed. Ownership counts
  // are a snapshot as of this publish - the Record page adds any since-
  // queued delta on top itself (pendingDeltaFor) to show what you're about
  // to actually own, not just this stale snapshot.
  const catalog = cache.cards.map((c) => {
    const entry = collection[c.id] || { main: 0, reserve: 0, extras: 0 };
    return {
      id: c.id,
      cardId: c.cardId,
      name: c.name,
      subname: c.subname,
      displayName: c.displayName,
      slug: c.slug,
      color: c.color,
      cardType: c.cardType,
      rarity: c.rarity,
      rulesText: c.rulesText,
      set: c.set,
      collectorNumber: c.collectorNumber,
      cap: mainSetCap(c.cardType),
      main: entry.main || 0,
      reserve: entry.reserve || 0,
      extras: entry.extras || 0,
      ...priceFieldsFor(priceView, c.id)
    };
  });
  await fs.writeFile(path.join(docsDataDir(), 'catalog.json'), JSON.stringify(catalog), 'utf-8');

  // Trade list (docs/trade.html) - unlinked share-by-URL page. Only the
  // for-sale quantity is published, never the Main/Reserve/Extras split;
  // capped at total owned in case copies were removed after marking them.
  const tradeList = await readJsonSafe(tradeListPath(), {});
  const cardsById = new Map(cache.cards.map((c) => [c.id, c]));
  const trade = [];
  for (const [id, qty] of Object.entries(tradeList)) {
    const c = cardsById.get(id);
    if (!c) continue;
    const entry = collection[id] || {};
    const owned = BUCKETS.reduce((sum, b) => sum + (entry[b] || 0), 0);
    const forSale = Math.min(qty, owned);
    if (forSale <= 0) continue;
    trade.push({
      id: c.id,
      name: c.name,
      subname: c.subname,
      displayName: c.displayName,
      color: c.color,
      cardType: c.cardType,
      rarity: c.rarity,
      set: c.set,
      collectorNumber: c.collectorNumber,
      qty: forSale,
      ...priceFieldsFor(priceView, c.id)
    });
  }
  await fs.writeFile(
    path.join(docsDataDir(), 'trade.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), pricesAsOf: priceView?.priceDate || null, cards: trade }, null, 2),
    'utf-8'
  );
  await copyImagesToDocs(trade.map((c) => c.id));

  // Looking list (docs/trading.html): the "still needed" quantity counts
  // Main copies across every printing of the same card (same name + rules
  // text), so it matches the Trading window's NEED x badge.
  const lookingList = await readJsonSafe(lookingListPath(), {});
  const mainOwnedByKey = new Map();
  for (const c of cache.cards) {
    const k = mechKey(c);
    mainOwnedByKey.set(k, (mainOwnedByKey.get(k) || 0) + ((collection[c.id] || {}).main || 0));
  }
  const looking = [];
  for (const id of Object.keys(lookingList)) {
    const c = cardsById.get(id);
    if (!c) continue;
    const needed = mainSetCap(c.cardType) - (mainOwnedByKey.get(mechKey(c)) || 0);
    if (needed <= 0) continue;
    looking.push({
      id: c.id,
      name: c.name,
      subname: c.subname,
      displayName: c.displayName,
      color: c.color,
      cardType: c.cardType,
      rarity: c.rarity,
      set: c.set,
      collectorNumber: c.collectorNumber,
      needed,
      ...priceFieldsFor(priceView, c.id)
    });
  }
  await fs.writeFile(
    path.join(docsDataDir(), 'looking.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), pricesAsOf: priceView?.priceDate || null, cards: looking }, null, 2),
    'utf-8'
  );
  await copyImagesToDocs(looking.map((c) => c.id));
  await fs.writeFile(pendingChangesPath(), JSON.stringify([], null, 2), 'utf-8');
  steps.push(`Published ${needed.main.length} Main / ${needed.reserve.length} Reserve needed, ${trade.length} for sale, ${looking.length} looking.`);

  await runGit(['add', 'docs']);
  try {
    await runGit(['commit', '-m', `Publish: ${new Date().toISOString()}`]);
    steps.push('Committed.');
  } catch (err) {
    if (!/nothing to commit/i.test(err.stdout || '')) throw err;
    steps.push('Nothing changed to commit.');
  }
  await runGit(['push']);
  steps.push('Pushed to GitHub.');

  return { steps, collection };
});

// --- Deck publishing ("Now Playing" website page, see docs/decks.html) ----
//
// decks.json itself never leaves this machine - publishing a deck copies
// only the selected decks' data plus a lookup of the specific card details
// needed to render them into docs/, as their own dedicated files. This is
// deliberately a separate git add/commit/push cycle from publish:run above
// (a different concern - "which decks am I bringing to an event" vs "what
// do I still need for my collection" - edited from a different window, on
// its own schedule).

function deckPublishStatePath() {
  return path.join(app.getPath('userData'), 'deck-publish-state.json');
}

function docsDeckDataPaths() {
  return {
    decks: path.join(docsDataDir(), 'published-decks.json'),
    cardDetails: path.join(docsDataDir(), 'deck-card-details.json')
  };
}

ipcMain.handle('decks:getPublishState', async () => {
  return readJsonSafe(deckPublishStatePath(), { deckIds: [], publishedAt: null });
});

ipcMain.handle('decks:publish', async (_event, deckIds) => {
  await runGit(['pull', '--ff-only']);

  const allDecks = await readJsonSafe(decksPath(), {});
  const published = deckIds.map((id) => allDecks[id]).filter(Boolean);
  const cache = await readJsonSafe(cardsCachePath(), { cards: [] });
  const collection = await readJsonSafe(collectionPath(), {});

  const printingsByCardId = new Map();
  for (const c of cache.cards) {
    if (!printingsByCardId.has(c.cardId)) printingsByCardId.set(c.cardId, []);
    printingsByCardId.get(c.cardId).push(c);
  }

  // Every printing referenced as a Legend or a regular card by any
  // published deck, denormalized with just the fields the site's deck view
  // needs (catalog.json is close but lacks ram/cost/power/isEddiable, which
  // the cost curve / RAM display / sellable stat all need).
  const referencedIds = new Set();
  for (const deck of published) {
    for (const pid of deck.legendPrintingIds || []) {
      if (pid) referencedIds.add(pid);
    }
    for (const split of Object.values(deck.cardPrintings || {})) {
      for (const pid of Object.keys(split)) referencedIds.add(pid);
    }
    // cardPrintings is only populated lazily, the first time the Deck
    // Builder's renderer actually looks at a card's split (see
    // getPrintingSplit() in deckbuilder.js) - a deck saved before that
    // feature existed, or a card never opened in the split picker since,
    // can have entries in `cards` with no matching cardPrintings key at
    // all. Fall back to any owned printing (any printing at all, failing
    // that) so every card in the deck still resolves to *something* to
    // render, same preference order as defaultPrintingSplit() client-side.
    // Sideboard cards (and swap-plan cards) need a renderable printing too.
    for (const cardId of [...Object.keys(deck.cards || {}), ...Object.keys(deck.sideboard || {})]) {
      const printings = printingsByCardId.get(cardId) || [];
      const alreadyCovered = printings.some((p) => referencedIds.has(p.id));
      if (alreadyCovered) continue;
      const owned = printings.find((p) => (collection[p.id]?.main || 0) > 0) || printings[0];
      if (owned) referencedIds.add(owned.id);
    }
  }

  // Cards tagged as @[Display Name] in a deck's description sections (e.g. a
  // sideboard card not in the deck) also need a printing + image so the
  // site's hover popup can show them.
  const taggedNames = new Set();
  for (const deck of published) {
    for (const text of Object.values(deck.descSections || {})) {
      for (const m of String(text).matchAll(/@\[([^\]|]+)(?:\|[^\]]+)?\]/g)) taggedNames.add(m[1]);
    }
  }
  for (const name of taggedNames) {
    const printings = cache.cards.filter((c) => c.displayName === name);
    if (printings.some((p) => referencedIds.has(p.id))) continue;
    const pick = printings.find((p) => (collection[p.id]?.main || 0) > 0) || printings[0];
    if (pick) referencedIds.add(pick.id);
  }

  const cardDetails = {};
  for (const c of cache.cards) {
    if (!referencedIds.has(c.id)) continue;
    cardDetails[c.id] = {
      id: c.id,
      cardId: c.cardId,
      name: c.name,
      subname: c.subname,
      displayName: c.displayName,
      slug: c.slug,
      cardType: c.cardType,
      color: c.color,
      rarity: c.rarity,
      ram: c.ram,
      cost: c.cost,
      power: c.power,
      isEddiable: c.isEddiable,
      rulesText: c.rulesText,
      set: c.set
    };
  }

  await fs.mkdir(docsImagesDir(), { recursive: true });
  for (const id of referencedIds) {
    const dest = path.join(docsImagesDir(), `${id}.webp`);
    try {
      await fs.access(dest);
      continue; // already published (e.g. also currently "needed")
    } catch {
      // fall through and copy it
    }
    try {
      await fs.copyFile(path.join(imagesDir(), `${id}.webp`), dest);
    } catch (err) {
      console.log(`[deck publish] couldn't copy image ${id}: ${err.message}`);
    }
  }

  const { decks: publishedDecksPath, cardDetails: cardDetailsPath } = docsDeckDataPaths();
  await fs.mkdir(docsDataDir(), { recursive: true });
  // Tags/groups: the site is read-only, so everything it needs is resolved
  // here. Color tags come from the Legends, creator tags also from any
  // reference link tied to a channel.
  const tagDb = await loadTagDb();
  const tagById = new Map(tagDb.map((t) => [t.id, t]));
  const colorByCardId = new Map(cache.cards.map((c) => [c.cardId, c.color]));
  const usedTagIds = new Set();
  const publishedWithTags = published.map((deck) => {
    const tags = {};
    for (const cat of TAG_CATEGORIES) {
      const ids = new Set(deck.tags?.[cat] || []);
      if (cat === 'creator') for (const l of deck.links || []) if (l.creatorId) ids.add(l.creatorId);
      tags[cat] = [...ids].filter((id) => tagById.has(id));
      tags[cat].forEach((id) => usedTagIds.add(id));
    }
    const colorTag = colorTagFor((deck.legendCardIds || []).filter(Boolean).map((id) => colorByCardId.get(id)));
    return { ...deck, tags, colorTag };
  });
  const groups = (await readJsonSafe(groupsPath(), []))
    .map((g) => ({ id: g.id, name: g.name, collapsed: !!g.collapsed, deckIds: published.filter((d) => d.groupId === g.id).map((d) => d.id) }))
    .filter((g) => g.deckIds.length);
  const meta = {
    groups,
    tags: Object.fromEntries([...usedTagIds].map((id) => [id, { id, category: tagById.get(id).category, name: tagById.get(id).name, description: tagById.get(id).description || '', ...(tagById.get(id).url ? { url: tagById.get(id).url } : {}) }]))
  };
  await fs.writeFile(path.join(docsDataDir(), 'deck-meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
  await writeCreatorsFile();
  await fs.writeFile(publishedDecksPath, JSON.stringify(publishedWithTags, null, 2), 'utf-8');
  await fs.writeFile(cardDetailsPath, JSON.stringify(cardDetails, null, 2), 'utf-8');

  const state = { deckIds, publishedAt: new Date().toISOString() };
  await fs.writeFile(deckPublishStatePath(), JSON.stringify(state, null, 2), 'utf-8');

  await runGit(['add', 'docs']);
  const label = published.length ? `Publish decks: ${published.map((d) => d.name || 'Untitled Deck').join(', ')}` : 'Unpublish all decks';
  try {
    await runGit(['commit', '-m', label]);
  } catch (err) {
    if (!/nothing to commit/i.test(err.stdout || '')) throw err;
  }
  await runGit(['push']);

  return state;
});

// Windows are created hidden and maximized right before their first paint,
// so they never flash at the 1400x900 "restored" size first. That size is
// what dragging the title bar (or the restore button) drops back to.
function showMaximized(win) {
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    // Maximized, not fullscreen: Windows won't let you drag a true-
    // fullscreen window at all, and a minimize/restore used to silently
    // drop it out of fullscreen while Electron still reported it as
    // fullscreen - so dragging "sometimes worked" and the maximize button
    // cycled unpredictably. See showMaximized().
    show: false,
    frame: false,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  win.on('close', (e) => {
    if (win.__closeConfirmed) return;
    if (!overlays.some((o) => o.name === 'deckbuilder' && o.host === win)) return;
    e.preventDefault();
    guardDeckBuilderClose(win);
  });
  win.webContents.on('console-message', (_e, _level, message, line, sourceId) => {
    console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    console.log(`[did-fail-load] ${errorCode} ${errorDescription} ${validatedURL}`);
  });
  showMaximized(win);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// Collection, Trading and the Deck Builder all live inside the main window
// as full-size WebContentsViews laid over its content (not separate OS
// windows), so they share the main window's frame/taskbar entry and closing
// one just returns to whatever is underneath with its filters/scroll intact.
// Overlays can stack (e.g. Trading opened from Collection): each is added on
// top, and closing returns to the one below.
const overlays = []; // [{ name, view, host }] bottom -> top

function fitOverlay(entry) {
  if (!entry.host || entry.host.isDestroyed()) return;
  const [w, h] = entry.host.getContentSize();
  entry.view.setBounds({ x: 0, y: 0, width: w, height: h });
}

function overlayForSender(sender) {
  return overlays.find((o) => !o.view.webContents.isDestroyed() && o.view.webContents === sender) || null;
}

// The real OS window behind any renderer: an overlay's host, or the window
// itself for the main renderer.
function windowForSender(sender) {
  const overlay = overlayForSender(sender);
  if (overlay) return overlay.host;
  return BrowserWindow.fromWebContents(sender);
}

function closeOverlay(entry) {
  const i = overlays.indexOf(entry);
  if (i === -1) return;
  overlays.splice(i, 1);
  const { view, host, listeners } = entry;
  if (host && !host.isDestroyed()) {
    for (const [evt, fn] of listeners) host.removeListener(evt, fn);
    host.contentView.removeChildView(view);
  }
  if (!view.webContents.isDestroyed()) view.webContents.close();
  // Hand focus back to whatever is now on top.
  const top = overlays[overlays.length - 1];
  if (top && !top.view.webContents.isDestroyed()) top.view.webContents.focus();
  else if (host && !host.isDestroyed() && !host.webContents.isDestroyed()) host.webContents.focus();
}

function openOverlay(name, file, host) {
  if (!host || host.isDestroyed()) return;
  const existing = overlays.find((o) => o.name === name && o.host === host);
  if (existing) {
    // Already open: bring it to the front instead of opening a second copy.
    host.contentView.removeChildView(existing.view);
    host.contentView.addChildView(existing.view);
    overlays.splice(overlays.indexOf(existing), 1);
    overlays.push(existing);
    existing.view.webContents.focus();
    return;
  }
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  view.setBackgroundColor('#0a0a0f');
  view.webContents.on('console-message', (_e, _level, message, line, sourceId) => {
    console.log(`[${name}-renderer] ${message} (${sourceId}:${line})`);
  });
  view.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    console.log(`[${name} did-fail-load] ${errorCode} ${errorDescription} ${validatedURL}`);
  });
  const entry = { name, view, host, listeners: [] };
  host.contentView.addChildView(view);
  fitOverlay(entry);
  for (const evt of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    const fn = () => fitOverlay(entry);
    entry.listeners.push([evt, fn]);
    host.on(evt, fn);
  }
  host.once('closed', () => {
    const i = overlays.indexOf(entry);
    if (i !== -1) overlays.splice(i, 1);
  });
  overlays.push(entry);
  view.webContents.loadFile(path.join(__dirname, 'renderer', file));
  view.webContents.focus();
}

ipcMain.handle('collection-view:open', (event) => {
  openOverlay('collection', 'collection.html', windowForSender(event.sender));
});

ipcMain.handle('deck-builder:open', (event) => {
  openOverlay('deckbuilder', 'deckbuilder.html', windowForSender(event.sender));
});

ipcMain.handle('trading:open', (event) => {
  openOverlay('trading', 'trading.html', windowForSender(event.sender));
});

// The window controls act on the real OS window (minimize/maximize), except
// "close", which on an overlay just closes that overlay.


ipcMain.handle('window:minimize', (event) => {
  const win = windowForSender(event.sender);
  if (!win) return;
  if (win.isFullScreen()) win.setFullScreen(false);
  win.minimize();
});

ipcMain.handle('window:toggle-maximize', (event) => {
  const win = windowForSender(event.sender);
  if (!win) return;
  if (win.isFullScreen()) {
    // Not reachable from our own UI anymore (windows open maximized), but
    // keep a sane way out if something ever puts a window in fullscreen.
    win.setFullScreen(false);
    win.maximize();
  } else if (win.isMaximized()) {
    win.unmaximize();
  } else {
    win.maximize();
  }
});

// The title-bar X always closes the real window, which quits the app - from
// the main window or from any overlay (Collection / Trading / Deck Builder).
ipcMain.handle('window:close', (event) => {
  const win = windowForSender(event.sender);
  if (win) win.close();
});

// Native Save / Discard / Cancel prompt (window.confirm is unreliable in
// Electron) - returns 'save' | 'discard' | 'cancel'.
async function askUnsaved(win, name) {
  const { response } = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
    type: 'question',
    buttons: ['Save', 'Discard', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'Unsaved changes',
    message: `Save changes to "${name || 'Untitled Deck'}"?`,
    detail: "Your changes will be lost if you don't save."
  });
  return ['save', 'discard', 'cancel'][response];
}

ipcMain.handle('dialog:unsaved', (event, name) => askUnsaved(windowForSender(event.sender), name));

// Closing the whole window (title-bar X, Alt+F4, anything that quits the app)
// while the Deck Builder holds unsaved edits asks first.
async function guardDeckBuilderClose(win) {
  const entry = overlays.find((o) => o.name === 'deckbuilder' && o.host === win);
  const wc = entry && entry.view.webContents;
  if (wc && !wc.isDestroyed()) {
    let dirty = null;
    try {
      dirty = await wc.executeJavaScript('window.__deckBuilderDirty ? window.__deckBuilderDirty() : null');
    } catch {}
    if (dirty) {
      const choice = await askUnsaved(win, dirty.name);
      if (choice === 'cancel') return;
      if (choice === 'save') {
        let saved = false;
        try {
          saved = await wc.executeJavaScript('window.__deckBuilderSave()');
        } catch {}
        if (!saved) return; // e.g. the deck has no name yet - stay so the user can fix it
      }
    }
  }
  win.__closeConfirmed = true;
  win.close();
}

// An overlay's own "Close" button just returns to what's underneath it.
ipcMain.handle('overlay:close', (event) => {
  const overlay = overlayForSender(event.sender);
  if (overlay) closeOverlay(overlay);
});

app.whenReady().then(() => {
  protocol.handle('cardimg', (request) => {
    const url = new URL(request.url);
    const filename = decodeURIComponent(url.hostname + (url.pathname === '/' ? '' : url.pathname));
    const filePath = path.join(imagesDir(), filename);
    return net.fetch(pathToFileURL(filePath).toString());
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
