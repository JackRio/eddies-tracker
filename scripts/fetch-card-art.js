// Downloads one image per card in the engine's card pool from the official card database
// (api.netdeck.gg, the API behind cyberpunktcg.com) into board/card-art/<slug letters>.webp, so the
// replay / play board shows real cards on machines without the Eddies app's image cache.
// Uses the printing the engine's card url names (?printing=...), else the card's default printing.
// Image URLs are signed and expire in ~24 h, so they are fetched fresh each run; existing files are
// skipped (--force re-downloads). Usage: node scripts/fetch-card-art.js [--force]
'use strict';
const fs = require('fs');
const path = require('path');
const { CARDS } = require('../src/engine');

const OUT = path.join(__dirname, '..', 'board', 'card-art');
const API = 'https://api.netdeck.gg/api/cards/cyberpunk/';
const force = process.argv.includes('--force');
const letters = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function one(c) {
  const m = (c.url || '').match(/\/cards\/([^?#]+)(?:\?printing=([\w-]+))?/);
  if (!m) return 'no url';
  const [, slug, printing] = m;
  const file = path.join(OUT, `${letters(slug)}.webp`);
  if (!force && fs.existsSync(file)) return 'have';
  const r = await fetch(API + slug);
  if (!r.ok) return `api ${r.status}`;
  const d = await r.json();
  const p = (d.printings || []).find(x => x.id === printing && x.image_url);
  const url = p?.image_url || d.image_url;
  if (!url) return 'no image';
  const img = await fetch(url);
  if (!img.ok) return `image ${img.status}`;
  fs.writeFileSync(file, Buffer.from(await img.arrayBuffer()));
  return 'ok';
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const tally = {};
  const queue = CARDS.slice();
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let c; (c = queue.shift());) {
      let res;
      try { res = await one(c); } catch (e) { res = `error ${e.message}`; }
      tally[res] = (tally[res] || 0) + 1;
      if (!['ok', 'have'].includes(res)) console.log(`${c.name}: ${res}`);
    }
  }));
  console.log(tally);
})();
