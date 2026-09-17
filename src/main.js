const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const pathToFileURL = require('url').pathToFileURL;
const execFileAsync = require('util').promisify(require('child_process').execFile);

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

function computeNeeded(cards, collection) {
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
      cap
    };
    const mainNeeded = cap - (entry.main || 0);
    if (mainNeeded > 0) main.push({ ...base, have: entry.main || 0, needed: mainNeeded });
    const reserveNeeded = cap - (entry.reserve || 0);
    if (reserveNeeded > 0) reserve.push({ ...base, have: entry.reserve || 0, needed: reserveNeeded });
  }
  return { generatedAt: new Date().toISOString(), main, reserve };
}

async function copyNeededImages(needed) {
  await fs.mkdir(docsImagesDir(), { recursive: true });
  const ids = new Set([...needed.main, ...needed.reserve].map((c) => c.id));
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
  const needed = computeNeeded(cache.cards, collection);
  await fs.mkdir(docsDataDir(), { recursive: true });
  await fs.writeFile(path.join(docsDataDir(), 'needed.json'), JSON.stringify(needed, null, 2), 'utf-8');
  await copyNeededImages(needed);

  // A lightweight full catalog (no images) so the Record page can log a
  // trade for *any* card, not just ones currently needed.
  const catalog = cache.cards.map((c) => ({
    id: c.id,
    cardId: c.cardId,
    name: c.name,
    subname: c.subname,
    displayName: c.displayName,
    color: c.color,
    cardType: c.cardType,
    rarity: c.rarity,
    set: c.set,
    collectorNumber: c.collectorNumber
  }));
  await fs.writeFile(path.join(docsDataDir(), 'catalog.json'), JSON.stringify(catalog), 'utf-8');
  await fs.writeFile(pendingChangesPath(), JSON.stringify([], null, 2), 'utf-8');
  steps.push(`Published ${needed.main.length} Main / ${needed.reserve.length} Reserve needed.`);

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

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    fullscreen: true,
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
  win.webContents.on('console-message', (_e, _level, message, line, sourceId) => {
    console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    console.log(`[did-fail-load] ${errorCode} ${errorDescription} ${validatedURL}`);
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

let collectionWin = null;

function createCollectionWindow() {
  if (collectionWin && !collectionWin.isDestroyed()) {
    collectionWin.focus();
    return;
  }
  collectionWin = new BrowserWindow({
    fullscreen: true,
    frame: false,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  collectionWin.setMenuBarVisibility(false);
  collectionWin.webContents.on('console-message', (_e, _level, message, line, sourceId) => {
    console.log(`[collection-renderer] ${message} (${sourceId}:${line})`);
  });
  collectionWin.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    console.log(`[collection did-fail-load] ${errorCode} ${errorDescription} ${validatedURL}`);
  });
  collectionWin.loadFile(path.join(__dirname, 'renderer', 'collection.html'));
  collectionWin.on('closed', () => {
    collectionWin = null;
  });
}

ipcMain.handle('collection-view:open', () => {
  createCollectionWindow();
});

// Both windows are frameless (frame: false) for a consistent look, so
// there's no native title bar - these back the custom minimize/maximize/
// close buttons each renderer draws for itself. Always act on whichever
// window actually sent the request, not a hardcoded reference.
ipcMain.handle('window:minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (win.isFullScreen()) win.setFullScreen(false);
  win.minimize();
});

ipcMain.handle('window:toggle-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (win.isFullScreen()) {
    win.setFullScreen(false);
    win.maximize();
  } else if (win.isMaximized()) {
    win.unmaximize();
  } else {
    win.maximize();
  }
});

ipcMain.handle('window:close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
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
