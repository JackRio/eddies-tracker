// Import the public decklists from netdeck.gg (the deckbuilder behind cyberpunktcg.com) as bot training
// opponents ("the field").
//   node scripts/fetch-netdeck.js [--max N] [--min-likes 0] [--concurrency 3]
// List: GET api.netdeck.gg/api/cyberpunk/decks/public?limit=100&offset=N&sort=liked (no auth; robots.txt
// allows it). Detail: GET /api/cyberpunk/decks/<id> (zones: legends / deck / sideboard). Details are cached
// in notes/decks/netdeck-raw/<id>.json (gitignored) and only re-fetched when the deck's updated_at changes.
// Each Standard deck that is legal for our engine (3 Legends, 40-50 cards, RAM, copies) and isn't a
// duplicate of one already kept (same Legends + main deck) is written as a Text List to
// src/bot/field-decks/netdeck/<name>-<id8>.txt (main deck as cards; sideboard as "# side:" comments).
// Prints card coverage: legal cards appearing in no / one imported list.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const API = 'https://api.netdeck.gg/api/cyberpunk/decks';
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const MAX = +flag('--max', 1e9), MIN_LIKES = +flag('--min-likes', 0), CONC = +flag('--concurrency', 3);
const RAW = path.join(ROOT, 'notes', 'decks', 'netdeck-raw');
const OUT = path.join(ROOT, 'src', 'bot', 'field-decks', 'netdeck');
fs.mkdirSync(RAW, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const { engineCard, CARDS } = require('../src/coach/cards');
const { deckIsIllegal } = require('../src/engine');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, tries = 4) {
  for (let t = 1; ; t++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (r.status === 404 || r.status === 401 || r.status === 403) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (t >= tries) { console.log(`  giving up on ${url}: ${e.message}`); return null; }
      await sleep(1000 * t);
    }
  }
}

(async () => {
  // 1. the list (headers only)
  const heads = [];
  for (let off = 0; off < MAX; off += 100) {
    const page = await get(`${API}/public?limit=100&offset=${off}&sort=liked`);
    const items = page?.items || page?.data || page?.decks || (Array.isArray(page) ? page : []);
    if (!items.length) break;
    heads.push(...items);
    if (page.total && heads.length >= page.total) break;
    await sleep(300);
  }
  const want = heads.filter(h => (h.format?.code || h.format || 'standard') === 'standard' && (h.engagement?.like_count ?? h.engagement?.likes ?? 0) >= MIN_LIKES).slice(0, MAX);
  console.log(`netdeck: ${heads.length} public decks listed, ${want.length} Standard to check`);

  // 2. details (cached by updated_at)
  let fetched = 0, cached = 0, k = 0;
  const details = [];
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (k < want.length) {
      const h = want[k++], f = path.join(RAW, `${h.id}.json`);
      let d = null;
      if (fs.existsSync(f)) { d = JSON.parse(fs.readFileSync(f, 'utf8')); if (d.updated_at !== h.updated_at) d = null; else cached++; }
      if (!d) {
        d = await get(`${API}/${h.id}`);
        if (d) {   // keep what we use (the full card objects are large)
          d = { id: d.id, name: d.name, owner: d.owner?.display_name, created_at: d.created_at, updated_at: d.updated_at, format: d.format?.code || d.format,
            engagement: d.engagement, description: (d.description || '').slice(0, 2000),
            zones: (d.zones || []).map(z => ({ zone: z.zone_code, cards: (z.cards || []).map(c => ({ id: c.card_entity_id, n: c.quantity, name: c.card?.name, sub: c.card?.subname })) })) };
          fs.writeFileSync(f, JSON.stringify(d));
          fetched++;
          await sleep(150);
        }
      }
      if (d) details.push(d);
    }
  }));
  console.log(`  details: ${fetched} fetched, ${cached} from cache`);

  // 3. convert, check legality, dedupe, write
  for (const f of fs.readdirSync(OUT)) if (f.endsWith('.txt')) fs.unlinkSync(path.join(OUT, f));
  const LEGAL = CARDS.filter(c => c.legal !== false);
  const seen = new Set(), use = new Map(), why = {};
  let kept = 0;
  details.sort((a, b) => (b.engagement?.like_count || 0) - (a.engagement?.like_count || 0));
  for (const d of details) {
    const zone = z => (d.zones.find(x => x.zone === z)?.cards || []);
    const conv = list => list.map(c => ({ c: engineCard(c.sub ? `${c.name}: ${c.sub}` : c.name), n: c.n, raw: c }));
    const L = conv(zone('legends')), M = conv(zone('deck')), S = conv(zone('sideboard'));
    const bad = [...L, ...M, ...S].filter(x => !x.c);
    if (bad.length) { why['unknown card'] = (why['unknown card'] || 0) + 1; continue; }
    const legends = L.map(x => x.c.number), cards = M.map(x => ({ card_id: x.c.number, count: x.n }));
    const def = { name: d.name, legends, cards };
    let err = null;
    try { err = deckIsIllegal(def); } catch (e) { err = e.message; }
    if (err) { const r = String(err).split(/[:(]/)[0].slice(0, 40); why[r] = (why[r] || 0) + 1; continue; }
    const sig = [...legends].sort().join() + '|' + cards.map(x => `${x.card_id}x${x.count}`).sort().join();
    if (seen.has(sig)) { why.duplicate = (why.duplicate || 0) + 1; continue; }
    seen.add(sig);
    kept++;
    for (const x of [...L, ...M]) use.set(x.c.number, (use.get(x.c.number) || 0) + 1);
    const slug = (d.name || 'deck').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'deck';
    const likes = d.engagement?.like_count || 0, views = d.engagement?.view_count || 0;
    const txt = [`# ${d.name} - by ${d.owner || '?'} (netdeck.gg ${d.id}, ${likes} likes, ${views} views, updated ${String(d.updated_at).slice(0, 10)})`,
      '// imported by scripts/fetch-netdeck.js - a public community list, training opponent only', '', '// Legends',
      ...L.map(x => `${x.n} ${x.c.name}`), '', '// Main deck', ...M.map(x => `${x.n} ${x.c.name}`),
      ...(S.length ? ['', '# Sideboard (not loaded):', ...S.map(x => `# side: ${x.n} ${x.c.name}`)] : []), ''].join('\n');
    fs.writeFileSync(path.join(OUT, `${slug}-${d.id.slice(0, 8)}.txt`), txt);
  }
  console.log(`  kept ${kept} legal, distinct lists; skipped: ${JSON.stringify(why)}`);
  const none = LEGAL.filter(c => !use.has(c.number)), one = LEGAL.filter(c => use.get(c.number) === 1);
  console.log(`  coverage: ${LEGAL.length - none.length}/${LEGAL.length} legal cards appear in at least one list (${one.length} in exactly one)`);
  if (none.length) console.log(`  in no list: ${none.map(c => c.name).join('; ')}`);
})();
