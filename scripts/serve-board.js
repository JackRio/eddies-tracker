// Local dev server for the standalone board / replay viewer in board/.
//   /                     board/ static files
//   /card/<cardId>        card art from the Eddies image cache (%APPDATA%/cyberpunk-tcg-tracker/images),
//                         cardId = the sim's snake_case id, e.g. meredith_stout_stone_cold_corpo
//   /api/replays          list of cyberpunk-tcg-sim replay files in ~/Downloads
//   /api/replays/<name>   one replay file
// Run: node scripts/serve-board.js   (port 4181)
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..', 'board');
const port = 4181;
const userData = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'cyberpunk-tcg-tracker');
const downloads = path.join(os.homedir(), 'Downloads');
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
  try { cards = JSON.parse(fs.readFileSync(path.join(userData, 'cards-cache.json'), 'utf8')).cards; } catch { return; }
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
}

function send(res, code, body, type = 'text/plain') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(body);
}

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);

  if (url.startsWith('/card/')) {
    if (!imageIndex) buildImageIndex();
    const id = letters(url.slice(6).replace(/\.webp$/, ''));
    const file = imageIndex.get(id);
    if (!file) return send(res, 404, 'no image');
    return fs.readFile(file, (err, data) => err ? send(res, 404, 'no image') :
      (res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'max-age=3600' }), res.end(data)));
  }

  if (url === '/api/replays') {
    let list = [];
    try {
      list = fs.readdirSync(downloads).filter(f => REPLAY_RE.test(f))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(downloads, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    } catch { /* no Downloads folder */ }
    return send(res, 200, JSON.stringify(list), MIME['.json']);
  }
  if (url.startsWith('/api/replays/')) {
    const name = path.basename(url.slice('/api/replays/'.length));
    if (!REPLAY_RE.test(name)) return send(res, 400, 'bad name');
    return fs.readFile(path.join(downloads, name), (err, data) => err ? send(res, 404, 'not found') : send(res, 200, data, MIME['.json']));
  }

  let filePath = path.join(root, url);
  if (!filePath.startsWith(root)) return send(res, 403, 'forbidden');
  if (url.endsWith('/')) filePath = path.join(filePath, 'index.html');
  fs.readFile(filePath, (err, data) => err ? send(res, 404, 'Not found') : send(res, 200, data, MIME[path.extname(filePath)] || 'application/octet-stream'));
}).listen(port, () => console.log(`Board viewer at http://localhost:${port}`));
