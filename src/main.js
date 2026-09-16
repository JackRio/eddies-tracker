const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const pathToFileURL = require('url').pathToFileURL;

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

const MAX_BACKUPS = 3;

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

  const files = (await fs.readdir(backupsDir())).filter((f) => f.startsWith('collection-') && f.endsWith('.json'));
  const withTimes = await Promise.all(
    files.map(async (f) => ({ f, mtime: (await fs.stat(path.join(backupsDir(), f))).mtimeMs }))
  );
  withTimes.sort((a, b) => b.mtime - a.mtime);
  for (const { f } of withTimes.slice(MAX_BACKUPS)) {
    await fs.unlink(path.join(backupsDir(), f));
  }
}

async function listBackups() {
  await fs.mkdir(backupsDir(), { recursive: true });
  const files = (await fs.readdir(backupsDir())).filter((f) => f.startsWith('collection-') && f.endsWith('.json'));
  const withTimes = await Promise.all(
    files.map(async (f) => ({ filename: f, mtime: (await fs.stat(path.join(backupsDir(), f))).mtimeMs }))
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

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    fullscreen: true,
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
