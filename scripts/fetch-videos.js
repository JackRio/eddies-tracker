#!/usr/bin/env node
// Tracks new uploads from the YouTube creators shown on the site and writes
// docs/data/videos.json, which the Home page reads to embed the latest videos.
//
// Where the channel list comes from (merged, de-duplicated):
//   1. Every creator tag in the app's tag database that has a youtube.com URL
//      (docs/data/creators.json, written by both Publish buttons), plus
//      creator tags on published decks (docs/data/deck-meta.json). Add a
//      creator tag with their channel URL in the app and they're followed
//      after the next publish.
//   2. docs/data/channels.json -> { "channels": [{ "name", "url" }] } for any
//      extra channels you want on the Home page without tagging a deck.
//
// How it works: YouTube serves a public RSS feed per channel
// (youtube.com/feeds/videos.xml?channel_id=...). Browsers can't read it (no
// CORS), so this runs in Node - from the scheduled GitHub Action
// (.github/workflows/videos.yml, once a day) or by hand: `npm run videos`.
// No API key, no dependencies, Node 18+.
//
// The file is only rewritten when the set of videos actually changes, so the
// Action doesn't add a commit every run.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'docs', 'data');
const OUT = path.join(DATA_DIR, 'videos.json');
const PER_CHANNEL = 8;
const UA = { 'user-agent': 'Mozilla/5.0 (compatible; eddies-video-tracker)', 'accept-language': 'en', cookie: 'CONSENT=YES+1' };

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

const decodeXml = (s) =>
  String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

const tag = (xml, name) => decodeXml((xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)) || [])[1] || '').trim();

function collectChannels(prevChannels) {
  const found = [];
  for (const c of readJson(path.join(DATA_DIR, 'creators.json'), { creators: [] }).creators || []) {
    if (c && c.url) found.push({ name: c.name, url: c.url });
  }
  const meta = readJson(path.join(DATA_DIR, 'deck-meta.json'), { tags: {} });
  for (const t of Object.values(meta.tags || {})) {
    if (t.category === 'creator' && /youtube\.com|youtu\.be/i.test(t.url || '')) found.push({ name: t.name, url: t.url });
  }
  for (const c of readJson(path.join(DATA_DIR, 'channels.json'), { channels: [] }).channels || []) {
    if (c && c.url) found.push({ name: c.name, url: c.url });
  }
  const byUrl = new Map(prevChannels.map((c) => [c.url, c.id]));
  const seen = new Set();
  const out = [];
  for (const c of found) {
    const key = c.url.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const direct = (c.url.match(/youtube\.com\/channel\/(UC[\w-]{22})/) || [])[1];
    out.push({ name: c.name, url: c.url, id: direct || byUrl.get(c.url) || null });
  }
  return out;
}

// @handle / custom URLs -> channel id, read off the channel page itself.
async function resolveChannelId(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`channel page ${res.status}`);
  const html = await res.text();
  const id = (html.match(/rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/) || [])[1]
    || (html.match(/"channelId":"(UC[\w-]{22})"/) || [])[1];
  if (!id) throw new Error('no channel id found on page');
  return id;
}

async function fetchFeed(channelId) {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, { headers: UA });
  if (!res.ok) throw new Error(`feed ${res.status}`);
  const xml = await res.text();
  const channelName = tag(xml.split('<entry>')[0], 'name');
  const videos = xml.split('<entry>').slice(1).map((entry) => ({
    id: tag(entry, 'yt:videoId'),
    title: tag(entry, 'title'),
    published: tag(entry, 'published')
  })).filter((v) => v.id && v.title);
  return { channelName, videos };
}

// The feed mixes Shorts in with real videos. /shorts/<id> answers 200 for a
// Short and redirects for anything else - cheap to ask, and cached forever.
async function isShort(id) {
  try {
    const res = await fetch(`https://www.youtube.com/shorts/${id}`, { method: 'HEAD', redirect: 'manual', headers: UA });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function main() {
  const prev = readJson(OUT, { channels: [], videos: [] });
  const shortCache = new Map((prev.checked || []).map((x) => [x.id, x.short]));
  const channels = collectChannels(prev.channels || []);
  if (!channels.length) {
    console.log('No YouTube channels to follow (tag a deck creator in the app, or add one to docs/data/channels.json).');
    return;
  }

  const videos = [];
  let failures = 0;
  for (const ch of channels) {
    try {
      if (!ch.id) ch.id = await resolveChannelId(ch.url);
      const feed = await fetchFeed(ch.id);
      if (!ch.name) ch.name = feed.channelName;
      let kept = 0;
      for (const v of feed.videos) {
        if (kept >= PER_CHANNEL) break;
        if (!shortCache.has(v.id)) shortCache.set(v.id, await isShort(v.id));
        if (shortCache.get(v.id)) continue;
        videos.push({ ...v, channelId: ch.id });
        kept++;
      }
      console.log(`${ch.name || ch.url}: ${kept} videos`);
    } catch (err) {
      failures++;
      console.warn(`${ch.name || ch.url}: ${err.message} - keeping previous videos`);
      videos.push(...(prev.videos || []).filter((v) => v.channelId === ch.id));
    }
  }
  if (failures === channels.length && !videos.length) {
    console.error('Every channel failed; leaving videos.json untouched.');
    process.exit(1);
  }

  videos.sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
  const next = {
    channels: channels.filter((c) => c.id).map(({ id, name, url }) => ({ id, name: name || url, url })),
    videos
  };
  const kept = new Set(next.videos.map((v) => v.id));
  next.checked = [...shortCache].filter(([id]) => kept.has(id)).map(([id, short]) => ({ id, short }));

  const same = JSON.stringify({ c: prev.channels, v: prev.videos }) === JSON.stringify({ c: next.channels, v: next.videos });
  if (same) {
    console.log('No changes.');
    return;
  }
  next.updatedAt = new Date().toISOString();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(next, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${next.videos.length} videos from ${next.channels.length} channel(s).`);
}

main().catch((err) => { console.error(err); process.exit(1); });
