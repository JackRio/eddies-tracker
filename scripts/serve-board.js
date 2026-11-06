// Local dev server for the standalone board / replay viewer in board/.
//   /                     board/ static files
//   /card/<cardId>        card art from the Eddies image cache (%APPDATA%/cyberpunk-tcg-tracker/images),
//                         cardId = the sim's snake_case id, e.g. meredith_stout_stone_cold_corpo
//   /api/replays          list of cyberpunk-tcg-sim replay files in ~/Downloads and board/replays
//   /api/replays/<name>   one replay file
//   /api/coach/<name>     Replay Coach result for that replay (board/replays/coach/, from scripts/coach.js)
//   /api/play/...         live games vs the bots for board/play.html (see playApi below)
// Run: node scripts/serve-board.js   (port 4181)
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..', 'board');
const port = 4181;
const userData = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'cyberpunk-tcg-tracker');
const downloads = path.join(os.homedir(), 'Downloads');
const replaysDir = path.join(root, 'replays');
const REPLAY_RE = /^cyberpunk-tcg-sim-replay-.*\.json$/;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

// cardId -> image file. Prefer the plainest printing that has an image: Retail set, lowest rarity.
const RARITY = ['Common', 'Uncommon', 'Rare', 'Epic Rare', 'Iconic Rare', 'Iconic Other', 'Iconic Secret', 'Secret Rare', 'Nova Rare'];
let imageIndex = null;
const letters = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
function buildImageIndex() {
  imageIndex = new Map();
  let cards = [];
  try { cards = JSON.parse(fs.readFileSync(path.join(userData, 'cards-cache.json'), 'utf8')).cards; } catch { /* no Eddies cache */ }
  const rank = p => (/retail/i.test(p.set?.code || '') ? 0 : 100) + Math.max(0, RARITY.indexOf(p.rarity));
  const bySlug = new Map();
  for (const p of cards) {
    const file = path.join(userData, 'images', `${p.id}.webp`);
    if (!fs.existsSync(file)) continue;
    const key = letters(p.slug || '');
    const prev = bySlug.get(key);
    if (!prev || rank(p) < prev.r) bySlug.set(key, { r: rank(p), file });
  }
  for (const [k, v] of bySlug) imageIndex.set(k, v.file);
  // fallback: board/card-art/ (node scripts/fetch-card-art.js - one image per card from the official database)
  const art = path.join(root, 'card-art');
  try { for (const f of fs.readdirSync(art)) if (f.endsWith('.webp') && !imageIndex.has(letters(f.slice(0, -5)))) imageIndex.set(letters(f.slice(0, -5)), path.join(art, f)); } catch { /* not fetched */ }
}

function send(res, code, body, type = 'text/plain') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(body);
}

// Play vs bot / watch bot vs bot (board/play.html, src/bot/play.js):
//   GET  /api/play/config            bots, decks, defaults
//   POST /api/play/new               { mode, you, bots: {p1,p2}, decks: {p1,p2}, first, seed } -> { id }
//   GET  /api/play/<id>?from=N       board steps since N + the current decision
//   POST /api/play/<id>/move         { i } - you play option i
//   POST /api/play/<id>/advance      the bot to act makes one decision
let PLAY = null;
const play = () => (PLAY ||= require('../src/bot/play'));
const readBody = req => new Promise(ok => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e5) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch { ok({}); } }); });
async function playApi(req, res, url) {
  const json = (code, o) => send(res, code, JSON.stringify(o), MIME['.json']);
  try {
    if (url === '/api/play/config') return json(200, play().config());
    if (url === '/api/play/new' && req.method === 'POST') return json(200, { id: play().create(await readBody(req)) });
    const m = url.match(/^\/api\/play\/(\d+)(\/move|\/advance)?$/);
    if (!m) return json(404, { error: 'no such route' });
    if (!m[2]) { const from = +(new URLSearchParams(req.url.split('?')[1] || '').get('from') || 0); const p = play().poll(m[1], from); return p ? json(200, p) : json(404, { error: 'no such game' }); }
    if (req.method !== 'POST') return json(405, { error: 'POST only' });
    const r = m[2] === '/move' ? play().move(m[1], (await readBody(req)).i) : play().advance(m[1]);
    return json(r.error ? 400 : 200, r);
  } catch (e) {
    console.error(e);
    return json(500, { error: e.message });
  }
}

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url.startsWith('/api/play/')) return playApi(req, res, url);

  if (url.startsWith('/card/')) {
    if (!imageIndex) buildImageIndex();
    const id = letters(url.slice(6).replace(/\.webp$/, ''));
    const file = imageIndex.get(id);
    if (!file) return send(res, 404, 'no image');
    return fs.readFile(file, (err, data) => err ? send(res, 404, 'no image') :
      (res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'max-age=3600' }), res.end(data)));
  }

  // replays from ~/Downloads and from board/replays (the ones shared in the repo); same name = same file
  if (url === '/api/replays') {
    const seen = new Map();
    for (const dir of [downloads, replaysDir]) {
      try {
        for (const f of fs.readdirSync(dir).filter(f => REPLAY_RE.test(f)))
          if (!seen.has(f)) seen.set(f, { name: f, date: (f.match(/replay-(\d{4}-\d\d-\d\d)/) || [])[1] || '' });
      } catch { /* folder missing */ }
    }
    const list = [...seen.values()].sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
    return send(res, 200, JSON.stringify(list), MIME['.json']);
  }
  // Replay Coach results (node scripts/coach.js), keyed by replay file name
  if (url.startsWith('/api/coach/')) {
    const name = path.basename(url.slice('/api/coach/'.length));
    if (!REPLAY_RE.test(name)) return send(res, 400, 'bad name');
    const file = path.join(replaysDir, 'coach', name.replace(/\.json$/, '.coach.json'));
    return fs.readFile(file, (err, data) => err ? send(res, 404, 'not coached yet') : send(res, 200, data, MIME['.json']));
  }
  if (url.startsWith('/api/replays/')) {
    const name = path.basename(url.slice('/api/replays/'.length));
    if (!REPLAY_RE.test(name)) return send(res, 400, 'bad name');
    const file = [downloads, replaysDir].map(d => path.join(d, name)).find(f => fs.existsSync(f));
    if (!file) return send(res, 404, 'not found');
    return fs.readFile(file, (err, data) => err ? send(res, 404, 'not found') : send(res, 200, data, MIME['.json']));
  }

  let filePath = path.join(root, url);
  if (!filePath.startsWith(root)) return send(res, 403, 'forbidden');
  if (url.endsWith('/')) filePath = path.join(filePath, 'index.html');
  fs.readFile(filePath, (err, data) => err ? send(res, 404, 'Not found') : send(res, 200, data, MIME[path.extname(filePath)] || 'application/octet-stream'));
}).listen(port, () => console.log(`Board viewer at http://localhost:${port}`));
