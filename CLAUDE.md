# Eddies — Project Reference

Personal Electron desktop app (formerly "Cyberpunk TCG Tracker", renamed to
**Eddies** after the in-game currency) that tracks a collection of the real,
official **Cyberpunk TCG** (published by Weird Co., licensed by CD Projekt
Red). Card data comes live from the public card-database API behind
cyberpunktcg.com. This doc exists so a new session can make changes without
re-reading the whole codebase — read this first, then only open the
specific file you need to touch.

## Run it

```bash
npm install
npm start
```

No build step, no bundler, no TypeScript — plain CommonJS/vanilla JS loaded
directly by Electron.

## Architecture at a glance

One Electron `BrowserWindow` (the main window) plus three full-size `WebContentsView` overlays laid over it (Collection, Trading, Deck Builder - opened by `openOverlay()` in `main.js`, never separate OS windows; closing one just reveals what is underneath; the title-bar X (`window:close`) quits the whole app from any overlay, while an overlay's own Close button uses `overlay:close` to return to what is underneath). The main window is maximized-by-default and frameless
(custom title bar, see below), all using the same `preload.js` (so all three
get the same `window.api`):

- **Main window** — `src/renderer/index.html` + `renderer.js` + `style.css`.
  The card browser/filter grid where you set Main/Reserve/Extras counts.
  Hovering a tile pops it up slightly (`.card-tile:hover`, plain CSS
  transform + raised `z-index` — no ghost-element trick needed here since,
  unlike the Collection window's fan rows, this grid has no horizontal-
  scroll clipping ancestor). Clicking a tile (anywhere except its counter
  buttons) opens a full-size click-to-close popup (`#popped-overlay` /
  `openPopped()`) with the card art, editable Main/Reserve/Extras counters,
  rules text, and a Rules FAQ section — same popup pattern as the
  Collection window's, described below.
- **Collection window** — `src/renderer/collection.html` + `collection.js` +
  `collection.css`. Opened via the "My Collection" button (IPC
  `collection-view:open`). Visual binder: 5 tabs (All/Legend/Unit/Gear/
  Program) × 4 color rows, a rarity-filter sidebar, and a Main Set/Reserve
  Set toggle that changes what every filter on the page means. Same
  click-to-open full-size popup as the Main window (read-only bucket pills
  here instead of editable counters).
- **Trading window** — `src/renderer/trading.html` + `trading.js` +
  `trading.css`. Opened via the "Trading" button (IPC `trading:open`). One
  filtered pool of suggested cards with one-click "+ LOOK" / "+ SELL", and two
  side-by-side lists (Looking / Selling, switchable via the Looking|Both|
  Selling toggle). See "Trading window" below.
- **Deck Builder window** — `src/renderer/deckbuilder.html` + `deckbuilder.js`
  + `deckbuilder.css`. Opened via the "Deck Builder" button (IPC
  `deck-builder:open`). See "Deck Builder" below for the rules engine and
  data model — this is the one window that writes its own storage file
  (`decks.json`) instead of `collection.json`.

Rules text (from the API) comes with `{Keyword}` tokens — e.g. `{Call}`,
`{Go Solo}`, `{Spend}` — standing in for the game's official badge icons.
`renderRulesText()` (duplicated in `renderer.js`/`collection.js`/
`docs/record.js`) swaps each for the matching SVG at
`assets/keywords/<slug>.svg` (scraped once from cyberpunktcg.com's own
rules-faq page — same shapes/colors as the real cards; see conversation
history if these ever need re-scraping). The popup's Rules FAQ section
(`faqHtml()`) looks up the card's `slug` in a bundled `faq-data.json`
(also scraped from cyberpunktcg.com/rules-faq, 140 cards/244 Q&As as of
this writing) and renders each Q&A through the same `renderRulesText()`.

All Node-side logic (API fetching, file I/O, image caching, backups, web
publish) lives in `src/main.js` and is exposed to both renderers through
`src/preload.js`'s `window.api` (contextIsolation is on, nodeIntegration is
off — renderers have zero direct Node/fs access, everything goes through
IPC).

There's also a **third, independent surface**: `docs/` is a static website
(see "Web publish" below) — a separate, GitHub-Pages-hosted mini-app for
checking/recording needed cards from a phone. It shares no code with the
Electron app, just the data the app publishes to it.

## Data model

**Printings, not cards.** The card API's bulk list endpoint collapses each
unique card to one default printing. This app instead fetches each card's
*detail* endpoint (`/api/cards/cyberpunk/<slug>`) to get its full
`printings` array — one entry per set/art variant (e.g. "V: Streetkid" has 5
printings across Retail/Beta/etc). Everything in this app — the grid, the
collection tracking, the Collection window, the published website — operates
at the **printing** level. A printing's `id` is what keys `collection.json`,
not the card's own `cardId`. `main.js`'s `flattenPrintings()` is where this
happens.

Normalized printing shape (what `cards-cache.json` stores and what
`allCards` holds in both renderers):
```
{ id, cardId, externalId, name, subname, displayName, slug, rulesText,
  flavorText, color, cardType, isEddiable, classifications, keywords,
  cost, power, ram, legality, collectorNumber, set: {code, name}, rarity,
  finish, artist, imageUrl }   // imageUrl is a local cardimg:// URL
```

Collection entry shape (`collection.json`, keyed by printing `id`):
```
{ main: number, reserve: number, extras: number }
```
- **Main** = your personal play set copy of a card.
- **Reserve** = spares you're keeping or might sell.
- **Extras** = raw inventory / trade fodder.
- Deck-legal cap: **Legend = 1**, **Unit/Gear/Program = 3** (`mainSetCap()`,
  duplicated in `renderer.js`, `collection.js`, and `main.js` — keep all
  three in sync if this ever changes). Each bucket row has a "MAX" button
  next to `+` (Main and Reserve only, not Extras) that directly sets that
  bucket to the type's cap — it does **not** move copies between buckets.
  There is deliberately no "auto-fill/redistribute" feature and no global
  bulk-mutate button — that was tried and explicitly rejected as too risky;
  don't re-add it without being asked.
- An entry is deleted from `collection.json` once all three buckets hit 0.
- **Ownership border colors** on main-window card tiles: Main = yellow,
  Reserve = cyan, Extras = purple (`own-main`/`own-reserve`/`own-extras` in
  `style.css`). A card held in more than one bucket gets a **banded**
  border instead (top→bottom: Main, Extras, Reserve, skipping empty ones),
  via `border-image-source: <gradient>` computed per-card in
  `ownershipVisual()` in `renderer.js`. Don't go back to the mask/
  pseudo-element ring trick for this — see the CSS gotchas section.

## netdeck.gg API (undocumented, reverse-engineered)

Base: `https://api.netdeck.gg/api/cards/cyberpunk`

- `GET ?limit=100&offset=N` — paginated bulk list (100/page max), each item
  missing its `printings` array.
- `GET /<slug>` — full card detail including `printings[]`, each printing
  has `id, collector_number, image_url, set, rarity, finish, artist`.
- `GET /filters` — available filter values (color/type/rarity/set/etc),
  useful if adding new filter UI. There are **15 sets** and **9 rarities**
  in the pool (see `RARITY_ORDER` in `renderer.js` for the full list and the
  intended common→rare visual ordering). The Collection window's rarity
  sidebar collapses the 3 "Iconic *" rarities to one "Iconic" icon, matching
  the game's own 7-tier rarity chart (Common/Uncommon/Rare/Epic Rare/Secret
  Rare/Iconic Rare/Nova Rare) — see `rarityMatchesFilter()` in
  `collection.js`.
- Two image URL fields per printing:
  - `image_url` — signed CloudFront URL, **expires in ~24 hours**. This is
    the one that actually works.
  - `source_image_url` — looks unsigned/permanent but 403s. Don't use it.
  Because signed URLs expire so fast, the app **downloads every printing's
  image once** into `userData/images/<printingId>.webp` and serves them
  through a custom `cardimg://` protocol registered in `main.js`
  (`protocol.handle('cardimg', ...)`). Never point `<img>` tags directly at
  a netdeck.gg URL from the renderer.

## Local storage (Electron `userData` dir)

- `cards-cache.json` — `{ fetchedAt, cards: [...printings] }`. Refreshed via
  the "Refresh Card Data" button (`cards:refresh` IPC), which re-fetches
  everything and re-downloads any missing images (existing images are
  skipped, not re-downloaded).
- `collection.json` — the Main/Reserve/Extras counts, keyed by printing id.
  **Never committed to git** — this is the one file that stays purely
  local/private; the published website only ever sees derived, need-only
  data (see "Web publish").
- `prices-cache.json` / `price-overrides.json` — see "Cardmarket prices".
- `decks.json` — saved decks, keyed by deck id. **Never committed to git**,
  same privacy tier as `collection.json`. See "Deck Builder" below.
- `images/<printingId>.webp` — cached card art.
- `backups/collection-<ISO timestamp>.json` — rotating backups, **max 3
  unlocked** ones (locked backups are exempt from the rotation entirely and
  kept forever), oldest-unlocked auto-pruned on every save
  (`collection:backup` IPC). `backups/meta.json` holds `{ label, locked }`
  per backup filename. A restore (`collection:restoreBackup`) backs up the
  *current* state first too, so restoring is itself undoable; same for
  overwrite (`collection:overwriteBackup`, lets you refresh one specific
  save's content in place — allowed even on a locked save, since locking
  only protects against the automatic rotation, not a deliberate action).
  Renaming a backup is **inline** (double-click its label in the sidebar) —
  not a button + `window.prompt()`, which is unreliable in Electron and was
  the original bug report here.

### ⚠️ The app name pins `userData`'s path — don't touch this casually

`app.setName('cyberpunk-tcg-tracker')` in `main.js` is **load-bearing**.
Electron derives the default `userData` path as `%APPDATA%/<app name>`,
and without this line that name silently follows `package.json`'s `"name"`
field. When the app was renamed to "Eddies", `package.json`'s `name` field
changed too — and without the explicit `app.setName()` pin, that would have
pointed every existing install at a brand-new empty `%APPDATA%/eddies`
folder, orphaning the real `cards-cache.json`/`collection.json`/`backups/`
(this actually happened once during the rename — nothing was deleted, the
app was just reading from the wrong folder). If `package.json`'s name ever
changes again, this pin must stay pointed at the *original* folder name
(`cyberpunk-tcg-tracker`) — never update it to match.

## IPC surface (`preload.js` → `window.api`)

```
getCards()                          cards:get
refreshCards()                      cards:refresh
getCollection()                     collection:get
setCollection(id, bucket, value)    collection:set             bucket ∈ main|reserve|extras
openCollectionView()                collection-view:open
backupCollection()                  collection:backup
listBackups()                       collection:listBackups
restoreBackup(filename)             collection:restoreBackup
renameBackup(filename, label)       collection:renameBackup
setBackupLocked(filename, locked)   collection:setBackupLocked
overwriteBackup(filename)           collection:overwriteBackup
windowMinimize()                    window:minimize
windowToggleMaximize()              window:toggle-maximize
windowClose()                       window:close
publishSite()                       publish:run                see "Web publish"
openDeckBuilder()                   deck-builder:open
getDecks()                          decks:get
saveDeck(deck)                      decks:save                 upserts by deck.id
deleteDeck(deckId)                  decks:delete
openExternalLink(url)               shell:openExternal          http(s) only, opens OS default browser
getPrices()                         prices:get                 see "Cardmarket prices"
refreshPrices()                     prices:refresh             forces a re-download
setPriceOverride(id, idProduct)     prices:setOverride         idProduct | null (no match) | 'auto'
getTradeList()                      trade:get                  see "Trade page"
setTradeQty(id, qty)                trade:set                  0 removes the entry
setTradeQtys({ id: qty })           trade:setMany              bulk, same semantics
```

## Cardmarket prices (`src/prices.js`)

Per-printing EUR prices from **Cardmarket** (Europe's main singles
marketplace). Its real API is closed to new applicants, but Cardmarket
publishes free, daily-regenerated JSON dumps per game on its own S3 bucket;
Cyberpunk is **game id 23**:
- `downloads.s3.cardmarket.com/productCatalog/productList/products_singles_23.json`
  (idProduct, name, idExpansion - **no rarity, no collector number**)
- `downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_23.json`
  (low/trend/avg1/avg7/avg30 + foil variants, EUR, keyed by idProduct)

Cached in `userData/prices-cache.json`, re-downloaded when older than 12h
(on `prices:get`, which the main window calls after the grid renders) or on
"Refresh Card Data". A failed download silently falls back to the cache.

**Matching is heuristic** because Cardmarket's file never says which art
version a product is. `SET_TO_EXPANSION` maps our 15 set codes onto
Cardmarket's 9 expansions (Retail+Beta share one; all tournament-prize
sets share 6722). Within one expansion+name group, printings collapse to
"versions" by collector number (`β` prefix and zero-padding stripped, so
Retail `005a` = Beta `β005a`). If the version count equals Cardmarket's
product count, they're zipped in collector-number / idProduct order
(`auto` - verified zero rarity-vs-price inversions at launch); otherwise
rarer version ↔ pricier product (`guess`, shown with a `?`). Manual
overrides (`userData/price-overrides.json`, `{ printingId: idProduct |
null }`) win over both, set from the popup's "Match" dropdown. Headline
price = trend, falling back to low, then foil trend/low.

Shown as: a trend badge on every main-grid tile (+ "Price" sort), a full
price box in both windows' popups (duplicated helpers in `renderer.js`/
`collection.js`), and on the website - `publish:run` snapshots
`price`/`priceGuess`/`cmName` into each `needed.json`/`catalog.json`
entry (`priceFieldsFor()`), so the site only updates prices on Publish.
The "Cardmarket ↗" links use Cardmarket's search URL (product pages need
an expansion/version slug the dumps don't provide).

## Custom window chrome

Both windows are created with `frame: false` (plus `icon:` pointing at
`build/icon.png`) — there's no native title bar, so `index.html` and
`collection.html` each draw their own slim `.window-titlebar` strip with
minimize/maximize-restore/close buttons wired to the `window:*` IPC calls
above. `window:toggle-maximize` toggles maximized ↔ restored (1400×900),
using whichever `BrowserWindow` actually sent the IPC
(`BrowserWindow.fromWebContents(event.sender)`), not a hardcoded window
reference. If you add another window, give it the same treatment.

**Windows open maximized, not `fullscreen: true`** (created with `show:
false`, then `showMaximized()` maximizes + shows on `ready-to-show`, so
there's no flash at the restored size). They used to open in true
fullscreen, which Windows refuses to drag at all - and the minimize handler
dropping fullscreen meant dragging only started working after a minimize/
restore, with the window state drifting ("acts funky"). Don't go back to
`fullscreen: true`; a maximized frameless window gets native drag-to-
restore from the `-webkit-app-region: drag` title bar for free.

## App icon / logo

`build/icon.png` + `build/icon.ico` are composited from the **real**
Cyberpunk Eurodollar ("Eddies") glyph — not hand-drawn. The source art
(`build/s-l1600.png`, a black glyph on a solid gray background) was
recolored to yellow-on-transparent via a PowerShell per-pixel luminance
threshold pass (see conversation history if this needs regenerating), then
composited onto a black rounded-square/yellow-border/red-accent badge
matching the app's card-frame aesthetic. `build/eddies-glyph-yellow.png`
(transparent background) is the one used as the in-app header `<img>` logo
in both windows; `icon.png`/`icon.ico` (opaque badge) are for the window/
taskbar icon and the electron-builder installer icon
(`package.json`'s `build.win.icon`).

`icon.ico` must be a proper **multi-resolution** ICO (16/32/48/64/128/256px
entries, full alpha) — a single 256px/16-color entry (what an early pass
produced) renders fine as a window icon but shows as a blank/generic icon
for a Windows desktop shortcut. If regenerating, write all six sizes into
one ICO rather than just the largest.

## Web publish (`docs/` — a separate static website)

A **second, independent deliverable**: a static site (meant for GitHub
Pages, served from `/docs` on this same repo) that lets you check what
cards you still need — and record a trade/pickup — **from your phone**,
without needing this desktop app open. It shares zero code with the
Electron app; it only reads/writes JSON files this app generates.

### Why this design (read before changing the sync model)

GitHub Pages is *static only* — it can't run server logic. But the phone
still needs to "write" (record a trade). The resolution: **the phone never
touches the real `collection.json`.** It only ever appends *delta* entries
(`{ id, bucket, delta, ts }`) to `docs/data/pending-changes.json`, using
GitHub's Contents API directly from browser JS (a personal access token,
scoped to just this repo, pasted in once and kept in the phone's
`localStorage`). This desktop app is the **only** thing that ever applies
those deltas to the real `collection.json` — via the "Publish Site" button,
which:

1. `git pull` (picks up anything the phone queued since the last publish)
2. Reads `docs/data/pending-changes.json`, applies each delta to
   `collection.json` (auto-backing up first — same safety net as any other
   collection edit), then clears the pending file
3. Recomputes `docs/data/needed.json` (both Main and Reserve "still need
   N more" lists, for every printing under its cap) and
   `docs/data/catalog.json` (lightweight, no images — every printing's
   name/set/rarity/rulesText/slug/etc, so the Record page can search *any*
   card, not just currently-needed ones — plus each printing's `main`/
   `reserve`/`extras` counts and `cap` as of this publish, so the Record
   page can show "Owned: N")
4. Copies any newly-needed printings' images from `userData/images/` into
   `docs/images/` (never removes old ones, so a link someone still has open
   doesn't 404)
5. `git add docs && git commit && git push`

All of this logic is `main.js`'s `computeNeeded()` / `applyPendingChanges()`
/ `copyNeededImages()` / the `publish:run` IPC handler. Don't make the
website write to `collection.json`-equivalent data directly, even for
convenience — the whole point is that a flaky phone/browser session can
never corrupt the real collection, only ever queue a delta that this app
reviews-by-applying on next publish.

**Staleness handling**: so the Needed page doesn't look stale on the same
day you record a trade (before the next desktop publish), it fetches both
`needed.json` *and* the live `pending-changes.json` on every load and
subtracts pending deltas client-side (`pendingDeltaFor()` in `needed.js`).
Recording something on the Record page is thus reflected on the Needed page
immediately, even though the underlying files haven't actually changed yet.

### Site structure

- `docs/index.html` + `home.js` + `home.css` — **Home** page (the site
  root). Its "What are you here for?" tiles are Decks, Trading, Needed and
  Loadout (Record was swapped out for Loadout; it's still in the nav). Hero (the featured deck's three Legends), headline numbers
  (`data/stats.json`, `looking.json`, `trade.json`, deck count), **Latest
  videos** (see "Home page videos" below), the featured deck, the freshest
  decks, and tiles explaining each page. Read-only, loads `decks.css` too to
  reuse the `.featured`/`.deck` styles; deck helpers in `home.js` are small
  duplicates of `decks.js`'s (the repo's no-shared-code convention).
- **Hero card cycle** (`setupHero()` in `home.js`): the three floating cards
  are the game's rarest cards ranked by Cardmarket price, advancing every
  4.5s (hover, a hidden tab or reduced-motion pause it; dots jump to a card;
  the glow takes the middle card's rarity color; the caption shows name,
  rarity, set and price, `~` = best-guess price match). The list is
  `docs/data/showcase.json`, written by `publish:run` via `pickShowcase()` in
  `src/showcase.js` and its images are copied to `docs/images/`. It draws from
  **every English printing, owned or not** (so Iconic Secrets, Promo / Box
  Topper / prize Nova Rares all appear): tier 1 = Nova Rare + Iconic Secret by
  price, topped up to 21 from Iconic Legends. Prices under EUR 1 are skipped
  (tournament-prize cards get heuristically matched to bogus EUR 0.10
  listings) and Retail/Beta twins collapse to the pricier one. Without a
  showcase file the hero falls back to the featured deck's Legends.
- `docs/needed.html` + `needed.js` — **Needed** page (it lived at
  `index.html` until Home was added; nav and old links updated). Filters sit
  in a sticky sidebar on desktop and a collapsed "Filters" panel on phones
  (`#filters`, a `<details>`): Main/Reserve toggle → Color → Type → Rarity
  → Set dropdown (defaults to `welcometonightcitybeta`, i.e. "Welcome to
  Night City — Beta", same default as the desktop app) → "Unique cards
  only". Plus a name search, a sort dropdown (`SORTERS` in `needed.js`),
  live stat tiles (cards / copies missing / est. cost) and a "Clear all
  filters" button. Read-only, no GitHub token needed — everything it reads
  is a plain same-origin `fetch()` of a file Pages serves statically.
- `docs/record.html` + `record.js` — **Record** page. Token-gated (shows
  `#token-gate` until a token is saved and passes `verifyToken()`). Search
  box over `catalog.json`, then +/−1 buttons per bucket for the selected
  card, showing **Owned: N** (the last-published snapshot's count for that
  bucket, from `catalog.json`'s `main`/`reserve`/`extras` fields, plus
  anything queued/staged since — see `updateOwnedCounts()` — so it reads as
  "what you're about to own," not a stale number).
  Clicking +/− does **not** commit immediately — it nets into an
  `eddies_staged_deltas` map in `localStorage` (`stageDelta()`/
  `getStagedDeltas()` in `shared.js`) and updates the screen instantly.
  Committing is **manual only** (the "Commit Trades" button calls
  `flushStaged()`, one `ghUpdateJsonFile` read-modify-write batching
  everything currently staged) — there is deliberately no auto-flush timer
  while editing; that was tried and explicitly rejected (see "Things
  explicitly not wanted"). The only automatic flushes are safety nets: on
  next page load if a previous visit staged something and never committed
  it, and best-effort on `pagehide` — neither fires *during* active
  editing. Batching this way also means clicks that cancel out (+1 then
  -1) never reach GitHub as a write at all, and a burst of clicks becomes
  one commit instead of one-per-click (which used to race two quick clicks
  on the same card into a 409, since each commit changes the file's `sha`).
  Shows a running "Pending" list combining committed + still-staged
  entries, plus a "Refresh Trades" button to re-pull the committed side
  from GitHub (this tab's own `pending` array only reflects what it has
  fetched/written itself).
  Optional "Trading away a card?" picker (`giveAway`/`selectGiveAway()`):
  searches the same `catalog.json`, and when set, the next `+1` click also
  stages a `-1` for it — from whichever of Main/Reserve/Extras you pick
  via the "From:" button row (defaults to Extras; don't hardcode it to
  Extras again, a real trade can come from any bucket), with a live
  "N owned in `<bucket>`" readout next to the picker. Only a *positive*
  pickup (`+1`) implies a trade-away — undoing a mistaken `-1` click
  shouldn't also silently return the traded card.
- `docs/needed.js`'s `pendingDeltaFor()` also reads `stagedDeltaFor()` from
  the same `localStorage` map, and a `storage` event listener re-renders
  it — so a trade staged on the Record page (even before its background
  commit lands) makes the card disappear/reappear on an already-open
  Needed tab on the same device immediately.
- `docs/shared.js` — GitHub Contents API helpers (`ghGetFile`, `ghPutFile`,
  `verifyToken`) and token storage (`localStorage`, key `eddies_gh_token`).
  Always hits `api.github.com` directly (never the Pages CDN), so the `sha`
  used for a PUT is fresh. `ghUpdateJsonFile(path, mutateFn, messageFn,
  attempts=3, onAttempt)` wraps the read→mutate→write pattern with a
  retry-on-409: if the `sha` went stale between the read and the write
  (another writer landed in between), it just re-reads and re-applies
  `mutateFn` against the fresh content instead of surfacing the error —
  `onAttempt(attempt, total)` lets the caller show retry progress instead
  of a silent retry. Also home to the staged-delta helpers
  (`stageDelta`/`getStagedDeltas`/`stagedDeltaFor`, see the Record page
  bullet above) and `renderBuildInfo()`/the update-banner check below.
- `docs/config.js` — `window.EDDIES_CONFIG = { owner: 'JackRio', repo:
  'eddies-tracker' }`. Real repo, connected and live at
  **https://eddies.help** (custom domain via `docs/CNAME`, DNS pointed at
  GitHub Pages' 4 standard A-record IPs; GitHub Pages redirects the
  `jackrio.github.io/eddies-tracker` URL to it automatically once a
  `CNAME` file is present).
- `docs/data/{needed,catalog,pending-changes,faq}.json` — `needed`/
  `catalog` generated by `publish:run` (see "Web publish" above);
  `pending-changes.json` starts as `[]` and is written to by the Record
  page between publishes; `faq.json` is the bundled cyberpunktcg.com FAQ
  scrape (static, not regenerated by publish — see the FAQ note above).
- `docs/images/` — copied subset of `userData/images/` (only currently- or
  previously-needed printings, not the full 509).
- `docs/assets/keywords/*.svg` + `docs/assets/rarity/*.png` — same keyword
  badge icons and rarity icons the desktop app uses (`src/renderer/assets/
  keywords/` and `.../rarity/`), duplicated here so the website's
  `renderRulesText()`/rarity filter buttons can reference them too. Keep
  both copies in sync if these ever get regenerated.
  **Rarity icons come from the official chart**: Figure 2 – Rarity Chart in
  the Comprehensive Rules (cyberpunktcg.com has no per-rarity icon files; the
  symbol is baked into each card's art). `node scripts/build-rarity-icons.js
  [chart url or path]` finds the seven symbols in that one image and rebuilds
  them as 1024x1024 black-on-transparent PNG masks in BOTH folders, at one
  shared scale so they keep the official proportions (Epic is smaller than
  Rare, Nova is large). Centers are diamonds, not dots, and Nova Rare is the
  striped square - the earlier hand-made set differed. Because the Nova icon
  is now full size, the old `mask-size: 160%` special case was removed from
  `docs/style.css`, `collection.css` and `trading.css`; don't re-add it. The
  chart URL embeds the rules edition and a hash; the current one is the image
  link in rule 3.16 of `api.netdeck.gg/api/cyberpunk/comprehensive-rules`.
  The website's icon URLs carry `?v=official` to beat the Pages cache.
- `renderBuildInfo()` in `shared.js` — shown in a small strip under the
  header on both pages, so a stale browser tab/cache is obvious. "Site
  updated" comes straight from GitHub's public commits API (most recent
  commit touching `docs/`), not a hand-maintained file — no CI/build step
  exists here to keep a stored timestamp fresh, so asking GitHub directly
  is the only version that can't go stale itself.
  GitHub Pages doesn't support custom response headers, so its fixed
  `Cache-Control: max-age=600` can't be shortened — a phone browser can
  sit on a stale cached page longer than expected with no way around it
  from our side. As a partial mitigation, once any page has loaded,
  `checkForNewerDeploy()` re-polls that same commits API every 2 minutes
  while the tab stays open and shows a sticky "A newer version is live —
  Reload" banner (`showUpdateBanner()`) if the latest commit sha changed
  since this tab's first check; the banner's reload appends a `?v=<ts>`
  cache-busting query string so it can't just re-serve the same cached
  response. This only helps once a version *with this check* has loaded at
  least once — it can't retroactively un-stale an already-cached page that
  predates it.

### Site layout and design rules (every `docs/` page)

- **Fluid, not fixed.** `style.css` owns the container: `main` is
  `max-width: var(--page-max)` (1560px) with side gutters from
  `--gutter: clamp(14px, 3.2vw, 44px)`; `main.narrow` (860px) is only for
  form-like pages (Record). Grids use `repeat(auto-fill, minmax(min(100%,
  Npx), 1fr))` — the `min(100%, …)` is what stops a grid forcing a page
  wider than a phone. Don't add fixed widths or `min-width`s above ~240px
  without a `min(100%, …)` guard.
- **The old "deck page too wide on phones" bug** was the header: four nav
  links in one non-wrapping row made the page ~40px wider than a 375px
  screen, so mobile browsers zoomed the whole page out. The header is now
  logo row + full-width nav row under 720px. Also removed
  `maximum-scale=1` from every viewport meta (blocks pinch zoom). After any
  layout change, check `document.documentElement.scrollWidth ===
  clientWidth` at 320, 375 and 768px on every page.
- Shared header/nav/footer markup is duplicated in each HTML file (no build
  step). Nav: Home, **Decks ▾** (Deck Library = `decks.html`, Loadout =
  `loadout.html`), Blogs, **Collection ▾** (Needed, Trading, Record). The two
  dropdowns are `<details class="nav-drop">` (tap works with no JS);
  `setupNavDrops()` in `shared.js` adds outside-click/Escape close and
  hover-open for mouse users. The active page's link and its group's
  `<summary>` both get `class="active"`. Pages under `docs/blog/` use `../`
  paths for everything. The footer holds
  `#build-info` (`renderBuildInfo()` fills it) and the unofficial-fan-site
  disclaimer.
- Motion: `stagger()`/`countUp()`/`timeAgo()` in `shared.js`; CSS `.rise`,
  `.page-enter`, `.skeleton-block`. `prefers-reduced-motion` switches it
  all off in `style.css`. The sticky header uses `backdrop-filter`; the faint
  background grid is `body::before` (so `html`, not `body`, carries the
  solid background color).
- Local assets are linked with `?v=<date>` (GitHub Pages caches 10 minutes
  and can't send other cache headers). Bump the date in every HTML file's
  `<link>`/`<script>` tags when a CSS/JS file changes.

### Blog (`docs/blog/`, `docs/data/blog.json`)

Hand-written articles. `docs/data/blog.json` (`{ posts: [{ slug, title, dek,
category, date, readMin, cover, coverAlt }] }`, paths relative to the site
root) is the index; each post is a static page at `docs/blog/<slug>.html`
(copy `card-curving.html` as the template: shared header/footer, `.prose`
article inside `.post-layout`, `.post-fig`/`.readout`/`.callout`/`.tier`/
`.take` blocks, `blog-post.js` for the sticky "On this page" sidebar built
from `section[id] > h2`, desktop >= 1100px only). Posts use the full
`--page-max` width like every other page; on phones figures go edge to edge. Post
images go in `docs/images/blog/`. `docs/blog/index.html` + `docs/blog.js`
list every post (newest first, newest as a wide card); Home's "From the
blog" section (`renderBlog()` in `home.js`, above the videos) shows the
newest post with "Read now" and "All posts". Styles for all three are in
`docs/blog.css`. Adding a post = new HTML page + an entry in `blog.json`; no
publish step from the desktop app is involved.
`card-sorting.html` is the exception: its four set tabs (Main/Reserve/Bulk/Chase) swap the article body, so it has no TOC sidebar, and its own components are scoped under `.sorting` in an inline `<style>`.
Each post carries `tags` (in `blog.json`, plus `article:tag` metas and
`data-tags` on `.prose`) for a future article filter - not built yet. The hero
sits inside the article column (`.post-main`), and "The short version" box
goes first in the article. Body text fills the column (no `ch` cap) with
`text-wrap: pretty`; the post was also hand-edited so no paragraph ends on a
1-2 word line at 1366-1920px - re-check that after editing a post's text.

### Home page videos (`docs/data/videos.json`)

New uploads from followed YouTube creators are embedded on the Home page. A
static site can't poll, and browsers can't read YouTube's RSS (no CORS), so:
- `scripts/fetch-videos.js` (Node 18+, no deps; `npm run videos`) reads each
  channel's public RSS feed (`youtube.com/feeds/videos.xml?channel_id=…`),
  drops Shorts (HEAD on `/shorts/<id>`), keeps the newest 8 per channel, and
  writes `docs/data/videos.json` (`{ channels, videos, checked, updatedAt }`).
  It only rewrites the file when the videos actually change.
- Channels followed = **every** creator tag with a youtube.com URL in the
  app's tag DB. Both Publish buttons write them to `docs/data/creators.json`
  (`writeCreatorsFile()` in `main.js`; the published `deck-meta.json` only has
  creators used by published decks, which is why that alone wasn't enough),
  **plus** any in `docs/data/channels.json` (`{ "channels": [{ "name", "url"
  }] }`) for channels with no tag. `@handle` URLs are resolved to channel ids
  from the channel page and remembered.
- `.github/workflows/videos.yml` runs it once a day (06:17 UTC; also on
  demand from the Actions tab) and commits `videos.json` if it changed, so
  the Home page stays current with the desktop app closed. A new video also
  triggers the "newer version is live" banner on open tabs.
- Home's default **"Fresh from the creators"** view is built in the browser
  (`freshVideos()` in `home.js`) per creator: every upload from the past 24
  hours (shown with a NEW badge), or - if that creator has nothing new - their
  single most recent video, so every followed creator is always represented.
  "Fresh | All videos" chips switch scope; the creator filter is chips for up
  to 6 creators and a dropdown beyond that. The 24-hour test uses the
  visitor's clock against each video's publish time.
- Playback is a click-to-load facade (thumbnail → `youtube-nocookie.com`
  iframe), so YouTube loads nothing until someone presses play.
- `docs/data/stats.json` (`neededMain`, `neededMainCopies`, …) is written by
  `publish:run` for the Home page's headline numbers.

### Loadout page (`docs/loadout.html` + `loadout.js` + `loadout.css`)

Public web version of the Deck Builder's Prep List. Keep its text minimal
(the user rejected helper paragraphs). Three steps:
1. **Decks** - add up to 10 (`MAX_DECKS`; the limit is only mentioned when
   someone tries an 11th), one at a time: paste a Text List or pick one of
   `published-decks.json`. Each shows a compact deck check (Add at the top, status, Legends, key
   numbers; the full card list + charts behind "Show cards & stats", open by
   default only when the deck is illegal; reuses `decks.css`) with
   Legal / Not legal and short reasons (`checkDeck()`: 3 Legends, unique
   Legend names, 40-50 cards, max 3 copies across main + sideboard, RAM
   ceilings, unknown lines; sideboard != 7 is only a warning). Only legal
   decks can be added (Add is disabled), and Next / the stepper stay blocked
   while an older saved deck is illegal (`allLegal()`). The same deck can't be added
   twice - compared by contents, not name (`deckSignature()`), so a renamed
   paste is caught too; duplicates in saved state are dropped on load. A different deck
   with a name already in use becomes "Name (2)" (`uniqueName()`, on add and
   on rename).
   Decks can also come from a **deck link** (`cyberpunktcg.com/decks/<id>` or a
   bare id): `fetchLinkedDeck()` reads netdeck's public
   `api.netdeck.gg/api/cyberpunk/decks/<id>` (CORS allows the site; private
   decks 401/404). Its `card_entity_id`s are our `cardId`s. Drag a deck by its
   letter to reorder (pointer events, `setupReorder()`; native dragstart is
   blocked or it cancels the drag), or focus the letter and use Arrow Up/Down. "Clear all" asks to confirm. Remove shows a 7s "Removed X · Undo" toast
   (`showUndo()`) that puts the deck back at its old position, main-deck flag included. One deck is
   always the **main deck** (first added by default). With 3+ decks the one
   with the fewest total swaps to all others gets a "Recommended" tag
   (`swapCost()`/`recommendedMainId()`, unique minimum only). Saved in
   `localStorage` (`eddies_loadout`) only.
2. **Card list** - per card, the MAX copies any deck uses (main + sideboard),
   grouped Legends then by color, each color split into Units / Gear /
   Programs subgroups (`typeSubgroups()`, also in the PNG); sort A-Z / Copies / RAM / Cost / Power. ×N badge bottom-center on
   the art (keeps the cost/power corners visible), a glowing yellow bar under cards in the main deck (no borders/tags),
   and per-deck chips (A, B, C...; the main deck's chip is yellow). A short "Tap a card to mark it packed." hint sits above the
   groups; tap a group heading to collapse it (`eddies_loadout_collapsed`),
   which also shows "N/M packed" per group. Tap a card to tick it
   off while packing ("N/M packed", Reset; `eddies_loadout_packed`). Search box
   filters by name. **Missing N** (red) shows only when the Record page's
   token (`eddies_gh_token`) is in this browser - i.e. the site owner's device -
   comparing against `catalog.json`'s main+reserve+extras as of last publish.
3. **Download** - on top, an on-page **Switch** panel (`renderSwitch()`): From / To
   dropdowns pick any two decks (From starts on the main deck; ⇄ swaps them;
   the same deck on both sides just says "Same deck selected."), see Out / In (and sideboard),
   tap cards to tick them off (ticks reset when either deck changes). Below it, two canvas PNGs (1600px): the card list, and a switch guide
   (main deck → each other deck: Out / In for main deck + Legends, with
   sideboard changes in their own block so the counts match).

Safeguards (silent unless hit): pasted text capped at 20k chars / 300
lines ("Decklist too long."), quantities over 99 count as unknown lines,
stacked tile layers capped at 4, stored decks rebuilt by `sanitizeDeck()` on
load, image loads time out after 8s, PNGs scale down past canvas limits
(30k px tall / ~16M px area for iOS), stale step-3 renders are dropped
(`renderToken`), and a double-click on Add can't add twice.

Card data comes from `catalog.json`, which `publish:run` now also fills with
`ram`/`cost`/`power`/`isEddiable` and an `img` flag (printing has an image in
`docs/images/`); publish also copies one image for any card that had none, so
every card a pasted list names can be drawn.

### Trade page (`docs/trade.html` + `trade.js` — unlisted)

A "cards I'm selling" page shared by URL only (`eddies.help/trade.html`).
Access control is **just being unlinked** — no nav in or out, `noindex`
meta, standalone JS (no `shared.js`/`config.js`). The user explicitly chose
this over password encryption / Cloudflare Access, knowing anyone with the
URL (or browsing the public repo) can see it. It only shows name/set/
rarity/Cardmarket price + the for-sale quantity — never the Main/Reserve/
Extras split.

For-sale quantities live in `userData/trade-list.json` (`{ printingId:
qty }`, local-only like `collection.json`), set from the "Sell" row at the
bottom of the main window's card popup, or the Sell -/+ sharing each grid
tile's Xtra row (capped at total owned). Tiles show a green "SELL N" badge.
Next to the result count/owned value: "On sale only" (a filter checkbox,
combinable with the Ownership dropdown) and "Sell all shown" - lists every
owned printing in the current filter at its full owned count, or unlists
them all if they already are (`trade:setMany`, one write). That bulk toggle
only touches the trade list, never collection buckets - the "no bulk
mutate" rule below is about the collection.
`publish:run` snapshots it into `docs/data/trade.json` (qty re-capped at
current total owned) and copies those images via `copyImagesToDocs()`.

### Local preview (without a real repo/token)

`scripts/serve-docs.js` is a tiny static file server (no deps) for
previewing `docs/` locally — `.claude/launch.json` has a `docs-preview`
config (`node scripts/serve-docs.js`, port 4173) for the `run`
skill/`preview_start`. The Record page's write actions will fail against a
placeholder `config.js`/fake token (expected — there's no real repo yet);
everything else (search, filters, selection UI) works fully offline. Don't
rely on the Claude Browser tool's `navigate` with a bare `file://` URL for
this project — it refuses local files outside an explicitly "open" project
folder; use the local server instead.

### Repo/hosting decisions already made (don't re-litigate without asking)

- Repo will be **public** (GitHub Pages' free tier requires it for a
  private-account repo) — user explicitly accepted that trade-off.
- "Needed" means **missing + partial** (anything under the type's cap),
  not just fully-missing-at-zero.
- Publishing is a **manual button click**, not automatic on every save.
- Custom domain (`eddies.help`, moved from `cyberpunktcg.help`, before that `jackrio.lol`) is live, DNS'd straight at GitHub Pages —
  no other host/CDN in front of it.

## Trading window (`trading.html`/`.js`/`.css`) and `docs/trading.html`

Two lists, edited **only in the app**, published read-only to the website:
- **Selling** = the existing `trade-list.json` (`{ printingId: qty }`, same
  `trade:*` IPC the main window's Sell controls use) - the old unlisted
  `docs/trade.html` still reads `trade.json`.
- **Looking** = `looking-list.json` (`{ printingId: true }`, IPC
  `looking:get`/`looking:setMany`). Only ids are stored; the "NEED ×N"
  quantity is derived live (cap - Main copies summed across every printing of
  the card).

**List order** is user-arranged: drag a row (or ▲/▼) in the Trading window;
`looking:reorder`/`trade:reorder` rewrite the JSON with keys in the new
order (UUID keys keep insertion order), `publish:run` iterates in that
order, and `docs/trading.js` shows it as published (no price re-sort).
The "Sort by…" dropdown in each panel header (price, name, rarity, color, type, set, plus need qty / for-sale qty) is a one-shot reorder, not a persistent mode.

**Mechanical identity**: printings with the same `displayName` + `rulesText`
are one card (`mechKey()`, duplicated in `trading.js`, `main.js` and
`docs/trading.js`/`needed.js`). Pool suggestions:
- *Unique needs*: per card, cap - Main total > 0 → the lowest-rarity printing
  (ties: cheaper), ranked via `RARITY_RANK`.
- *Spare upgrades*: a printing you own where, after selling one copy, total
  owned across ALL buckets/printings is still >= the cap AND a lower-rarity,
  cheaper printing is owned ("covered by"). Don't loosen this - e.g. 2 of 3
  owned across rarities must NOT suggest selling the pricier one.

`publish:run` also writes `docs/data/looking.json` (needed qty snapshot, prices,
images copied). `docs/trading.html`/`trading.js` render both lists read-only
(Looking | Both | Selling, search, "Total Est Amount"); "Trading" is in each
site page's nav. The Needed page also has a "Unique cards only" chip with the
same logic.

## Deck Builder (`deckbuilder.html`/`.js`/`.css` — its own window)

Builds real, constructed-legal Cyberpunk TCG decks from cards you own in
your **Main** bucket. Two views inside the one window, toggled by a `view`
state var: **My Decks** (list of saved decks with stats + Edit/Duplicate/
Delete) and **Builder** (editing one deck). `main.js` only does CRUD on
`decks.json` (`decks:get`/`decks:save`/`decks:delete`) — all deckbuilding
rule logic lives in the renderer.

**Decks are keyed by `cardId`, not printing `id`.** The game's copy-limit
rule ("max 3 of a card with an identical name+subtitle") and Legend
uniqueness rule ("unique names") both operate on the *card*, not the
specific art/printing — see "Printings, not cards" above. So:
- `buildUniqueCards()` collapses `allCards` (per-printing) down to one row
  per `cardId`, each annotated with `ownedMain` = the sum of the `main`
  bucket count across every printing that shares that `cardId`, and a
  representative printing (prefers one you own copies of, purely for which
  art to display).
- A deck's `cards` field is `{ cardId: quantity }`. A deck slot's ownership
  cap is that summed `ownedMain`, not any single printing's count.
- Legend uniqueness is checked by `name` (not `cardId`), since two
  printings of "V" with different subtitles (e.g. Streetkid vs. Corporate
  Exile) still can't both be Legends in the same deck.
- The Set filter/dropdown in the main card browser is built from every
  printing's set across a card's whole group (a `sets` array on each
  `uniqueCards` entry), not just the representative printing's set —
  otherwise a card owned via, say, its Beta printing but displayed with its
  Retail art would silently vanish from a "Retail" Set filter.
- A Legend slot separately tracks `legendCardIds[i]` (the card) and
  `legendPrintingIds[i]` (which specific owned printing's art to show).
  Picking a Legend with more than one owned printing (e.g. an Epic Retail
  copy and a Nova Rare Box Toppers copy of the same card) opens an
  art-variant sub-view in the Legend picker instead of finalizing
  immediately; a filled slot's "↺ Art" button (shown only when
  `ownedPrintingsFor(cardId).length > 1`) reopens that sub-view directly to
  change it later. A Legend you don't own can be picked too (via the
  picker's "Show All" toggle); it uses the card's representative art and the
  deck is flagged as missing it (see "Cards you don't own" below).
- Regular (non-Legend) cards can run up to 3 copies, and unlike a Legend
  slot those copies don't all have to be the same printing — e.g. 2 Epic +
  1 Iconic Other copy of the same named card is a completely normal
  ownership split. `deck.cardPrintings: { [cardId]: { [printingId]: count
  } }` records exactly which owned printings make up a card's copies; a
  card whose owned printings map already sums to its deck quantity keeps
  that mapping (see `getPrintingSplit()`), otherwise it's regenerated via
  `defaultPrintingSplit()` (greedily fills from owned printings in order).
  The "🎨" button on a Deck List row (shown when
  `ownedPrintingsFor(cardId).length > 1`) opens the printing-split picker
  (`#printing-split-overlay`), where each owned printing gets its own
  stepper capped at its own owned count, with "+" additionally disabled
  once the running total hits the card's deck quantity — you free up room
  by decrementing another printing first, since the total itself is fixed
  by the card's normal qty stepper, not by this picker.
  `printingsForCardEntry()` expands a split into one printing per physical
  copy (back-most first) for the stacked-tile art in both the Builder's
  Deck List and the read-only Deck View — this is also why a mixed-rarity
  stack's peeking layers show genuinely different card art instead of the
  same representative printing repeated `qty` times.
- Which printing is front-facing (fully visible, on top of the stack) is
  just whichever printing's key comes *last* in the split object - no
  separate field, since JS objects preserve string-key insertion order.
  `setFrontPrinting()` deletes and re-inserts a printing's entry to move it
  there. In the read-only Deck View, hovering a mixed-rarity tile reveals a
  row of mini swatches (`.view-deck-tile-switch`, one per distinct owned
  printing) - clicking one calls `switchFrontPrinting()`, which is the one
  edit Deck View makes directly (auto-saved on click) rather than requiring
  "Edit Deck" first, since it's purely cosmetic and never touches legality
  or counts.
- `deck.description` is a free-text field: edited as raw HTML source in a
  `<textarea>` next to the Legend row in the Builder, and rendered via
  `innerHTML` (deliberately not escaped) next to Deck View's Legends
  section. That's intentional, not an oversight — it's the deck's own
  author writing markup into their own local `decks.json`, not untrusted
  input from anyone else.

**RAM/color legality** (`computeCeilings()` + `canSetCardQty()`): each of
the 3 selected Legends has a `color` and a `ram` value. Sum `ram` per color
across the selected Legends — that's the RAM ceiling for that color for
this deck. A non-Legend card is only addable if its `color` has a nonzero
ceiling and its own `ram` is `<=` that ceiling. Cards with no `color` are
always legal (none currently exist in the pool, but the check is written to
allow for it).

**Enforcement is hard-block, not warn-and-allow**, for anything that makes
an action nonsensical: a 4th copy of a card, a 4th Legend, two Legends sharing a `name`, or a card whose
`ram` exceeds its color's current ceiling. Each rejection sets
`deckMessage` (rendered in `#deck-message`, styled red) instead of mutating
state — see `canSetCardQty()`/`legendNameConflict()`. Being under 40 cards,
over 50, or short a Legend is deliberately **not** blocked this way (a deck
is often mid-edit) — those show up as persistent lines in the stats panel
via `computeDeckWarnings()` instead.

**Ownership filtering**: the card browser defaults to "Owned Only"
(`builderState.ownership`), hiding any card with `ownedMain === 0`.
Switching to "Show All" reveals cards you don't own, and they CAN be added
(see below).

**Cards you don't own** (changed on request - this used to be hard-blocked at
`ownedMain`): a deck may use more copies of a card than your Main bucket holds
(still max 3 per card, main + sideboard combined). `deckMissing(deck)` counts
what isn't covered - main + sideboard share your owned copies, each Legend
needs 1 - and drives: the orange "need N" tags on Deck List rows and pool
tiles, a "N cards not in your collection" line in the builder stats, and on
the My Decks list an orange "⚠ N not owned" tag (tooltip lists the cards) or a
green "✓ Fully owned" tag. "Owned" here means the **Main** bucket, as before -
copies sitting only in Reserve/Extras count as missing. Copies you don't own
have no printing, so they render with the card's representative art and the
printing split only covers owned copies (`getPrintingSplit()` compares against
`min(qty, ownedMain)`). The My Decks list has a search box, a Show filter
(All / Fully owned / Missing cards) and a Sort (recently edited / name /
fewest missing); the header's "Select all" checkbox applies to the decks
currently shown (used for the Prep List only - publishing doesn't use the
selection).

**"Legal for current Legends" filter** (`builderState.legalOnly`, on by
default): hides any card `cardFitsCeilings()` rejects — same check
`canSetCardQty()` uses to hard-block an add, just applied as a pool filter
instead of a per-card disable. Since it's evaluated fresh inside
`getFilteredPoolCards()` on every `renderCardPool()` call (which every
Legend add/remove/art-change already triggers via `renderBuilder()`), the
pool narrows live the instant a Legend's color/RAM ceiling changes — no
separate wiring needed. Unchecking it falls back to the old behavior
(everything shown, illegal cards just individually disabled).

**Reference links** (`deck.links: [{ label, url }]`) are for citing where a
deck came from (a YouTube guide, a blog post, a community deckbuilder
export, etc). They open via `window.api.openExternalLink()` →
`shell:openExternal` in `main.js`, which validates the URL starts with
`http://`/`https://` before calling Electron's `shell.openExternal` — never
render them as a plain `<a target="_blank">`, since contextIsolation means
the renderer has no window-open handler wired for that.

**Prep List** (My Decks list, `listUiState.selectedIds`): you only ever
physically build *one* selected deck at a time, reusing shared cards
between them, so `computePrepList()` combines several decks' card lists by
**max quantity across the selection**, not a sum - e.g. 2 copies of a card
if the neediest of your selected decks wants 2, even though 3 is legal and
some other selected deck might also run it. Legends are just a name-deduped
union (always qty 1, no max needed). Rendered via the same
`viewDeckTileHtml()` as the read-only Deck View, but since every stacked
layer here is deliberately the *same* art (there's no per-deck printing
split to preserve), the usual raise-and-peek effect doesn't read as "more
than one" on its own - `viewDeckTileHtml()`'s 4th param is an optional
extra badge HTML string, used here (only here) to show an explicit "×N".

**Publishing decks to the website** (`docs/decks.html`) is a separate
concern from the Prep List and from the collection "Publish Site" button -
a deliberate, independent `git pull`/commit/push cycle
(`decks:publish` in `main.js`), triggered from "Publish" in the
Deck Builder's My Decks toolbar. `decks.json` itself never leaves the
machine; publishing copies every saved deck's data plus a
denormalized `docs/data/deck-card-details.json` lookup (printing id →
name/color/ram/cost/power/isEddiable/rulesText - `catalog.json` is close
but lacks the numeric stats the cost curve/donuts need) into
`docs/data/published-decks.json`, and copies each referenced printing's
image into `docs/images/` if not already there (generalizes the existing
`copyNeededImages()` pattern). "Publish" always publishes **every** saved deck (no per-deck selection or
unpublish; the whole published set is replaced each time). `userData/deck-publish-
state.json` (app-local, never committed) tracks `{ deckIds, publishedAt }`
so the toolbar can show "Last published: ...".

A deck's `cardPrintings` split (see above) is only populated *lazily*, the
first time the Builder's renderer actually looks at it - an older deck, or
one whose split-eligible cards were never opened in the split picker, can
have `cards` entries with no matching `cardPrintings` key at all.
`decks:publish` accounts for this: any card in `deck.cards` not already
covered by a `cardPrintings`/`legendPrintingIds` reference falls back to
any owned printing of that `cardId` (any printing at all, failing that),
so every card in a published deck still resolves to *something* renderable
on the site - `docs/decks.js`'s `printingsForCardEntry()` has the matching
client-side fallback for the same reason.

`docs/decks.js` is a **duplicated, read-only port** of `renderDeckView()`/
`computeDeckStats()`/`viewDeckTileHtml()`/`donutBlockHtml()`/
`costCurveHtml()` from `deckbuilder.js` - not shared code, matching this
repo's existing convention (`mainSetCap()`, `renderRulesText()` are
already duplicated 3+ places). It intentionally does *not* port the
card-detail popup or the front-facing art switch - those are editing/
inspection conveniences, not needed for "which cards do I need for this
deck," and porting them would mean duplicating `renderRulesText()`/
`faqHtml()` too for comparatively little value here.

### Sideboard + swap plans (Deck Builder)

`deck.sideboard: { cardId: qty }` - exactly 7 cards per the official Tournament Rules (hard cap 7, warning when != 7), no Legends, and the 3-copy limit + ownership are **combined** with the main deck (`checkCardLegality()`). `deck.swapPlans: [{ id, name, swaps: [{ out, in, qty }] }]` are named 1-for-1 swaps (so deck size never changes); `applyPlan()` trades the cards between main and sideboard, and Deck View / Test Hand / docs/decks.js render the post-board deck from it. `normalizePlans()` re-clamps plans whenever quantities change. Prep List counts main + sideboard copies. `decks:publish` includes sideboard cards' printings/images.

The description editor (`openDescEditor()`) shows each section as a
collapsible panel (header: caret, title, filled dot, one-line preview while
collapsed; open state kept in `descOpen`, and an AI draft opens the sections it
filled). Textareas auto-grow with their content (`autoGrow()`, `resize: none`)
- don't put a manual resize handle back.

### AI Draft (Deck Description editor)

"✨ AI Draft" in the description overlay fills `deck.descSections` from the
decklist. All logic is `src/ai.js` (main process): the Anthropic API key is
pasted in the overlay (`ai:setKey`), stored in `userData/ai-key.json`
(encrypted via `safeStorage`, never committed, never sent to a renderer -
`ai:hasKey` only returns a boolean). The renderer's `aiPayload()` sends
legends + cards (with rules text) + stats + sideboard/swap plans; the system
prompt is the instructions plus `src/data/rules.txt` (text of the official
comprehensive rules PDF, prompt-cached). Output is forced through a tool call
with one string per section key; any `@[Name]` tag not in the deck is stripped.
By default only *empty* sections are filled (checkbox overwrites). Model id is
`MODEL` in `ai.js`. Refresh `rules.txt` when the rules PDF updates. The AI never
sees raw `rules.txt`: `src/rules-filter.js` strips page header/footer noise, the
"Respect Your Rival" conduct block, and component rules (dice quality, sleeves,
translations); `node src/rules-filter.js` prints exactly what it cuts. The
playbook hash covers the filtered text, so edits here rebuild it automatically.

Knowledge is built **up front**, not per request: the "Build knowledge"
button (`ai:buildKnowledge`) studies every card in `cards-cache.json` (batches
of 20, 3 in parallel, resumable) and distills `rules.txt` into a short
`userData/rules-playbook.json`. Deck drafts then send only the playbook + that
deck's profiles; they study only cards that are new/changed since.

Output hygiene lives in `ai.js`: `makeTagger()` repairs `@[Card]` tags (resolves
short names like "Maman Brigitte" to the full "Name: Subtitle" display name,
keeping the short form as the `@[Full|Short]` label, and auto-tags untagged
mentions), `dropBadSellAdvice()` removes advice to sell cards without a Sell
Tag. The prompt forbids teaching rules / other-game jargon, asks for a card's
*role* instead of a paraphrase of its text, 3-5 Key Cards, and short
one-idea-per-line fields; `ddBodyHtml()` (duplicated in `docs/decks.js`)
renders those lines as bullets, with a label column for Game Plan/Mulligan.

It is a two-stage agent with persistent memory. **Study**: `studyCards()`
profiles each card (summary, fixed-list `roles`, `mechanics`, `wants`,
`enables`) in batches of 20 and stores them in `userData/card-knowledge.json`
keyed by `cardId` + a hash of its text, so only new/changed cards are ever
studied (the first draft of a deck studies its cards; later decks reuse them).
**Analyze**: the decklist goes in with each card's profile plus a role tally
computed in code; the tool schema makes the model fill an `analysis` (themes,
plan, loop, weaknesses) before the sections, and the prompt forbids explaining
game rules - the description must describe the deck.

## Rules engine (`src/engine/`) and replay board (`board/`)

- `src/engine/` is a patched fork of PUNKSIM's MIT `cyber-sim-engine`, fixed against the Oct 29 2026
  Comprehensive Rules + Rules FAQ. Fix list and API changes: `notes/engine-audit.md`; engine API in
  `src/engine/README.md`. Tests: `node src/engine/test/run.js [filter] [--fuzz N]` - each case fails on
  the upstream engine and passes here; the fuzz plays `test/decks/*.txt` against each other with rule
  invariants. User rulings confirmed with Weird Co (Johnny Silverhand readies on the rival's turn too,
  Radioport can Call on the rival's turn) are tests - don't "fix" them back.
- Card data audit (Nov 6 2026): every engine card's text / cost / power / RAM was compared with the
  official data in Eddies' `cards-cache.json` (match on "Name: Subtitle"). Only real difference:
  **Pyramid Song is -4 power** (upstream said -5, in `cards.json` and `card_scripts.json`); fixed,
  test `cards-pyramid-song.test.js`. Re-run that comparison after updating the engine's card data.
- `board/` is a standalone replay viewer for **cyberpunk-tcg-sim** replay JSON (snapshot + per-action
  patches; ChoomBattler's text log is too thin and isn't supported). Run `node scripts/serve-board.js`
  (port 4181, launch.json `board`): serves card art from the Eddies image cache (`/card/<simCardId>`,
  matched on letters only - accented slugs are odd) and lists `cyberpunk-tcg-sim-replay-*.json` from
  `~/Downloads` and `board/replays/` (the 15 shared replays, Oct-Nov 2026 - use them to test changes).
  Mats come from learnCTCG's two-player template (Rival's mat turned 180°). Card backs are the official
  Legend back (`board/assets/card-back-legend.webp`); non-Legend backs are the same image through the
  `#ctcg-swap` SVG filter (yellow/black swapped). Gig dice: colored by owner (green yours, red Rival's),
  stolen dice sit in the controller's "Rival Gigs" zone. Status effects (Lag, Adrenaline...) are only
  in the hover panel, never on the card - except attack locks (`CANNOT_ATTACK[_GIGS]`, e.g. Chrome Reverie / Nocturne):
  a red crossed-out sword top-left (`noAttackHtml()`, user request), on Units and face-up Legends; the power badge shows only when power differs from printed.
  `board/logfmt.js` rewrites every sim log line into one fixed format (`Verb [Card] → [Card] · detail ·
  via [Card]`); add a rule there for any new message (unmatched lines fall back to raw text).
  Stepping one action animates via FLIP (elements on the Rival's turned mat negate their offsets) and
  shows that step's lines in a caption strip in its own gap between the two mats (`bannerHtml()`, part
  of `#table`). Never float overlays on the mats - an earlier banner covered the Gig dice. The board
  column is exactly the board's width (`--bw` on `.layout`); the left and right panels share the rest.
  Deck/Trash/Eddies counts are badges in the pile's top corner (area labels sit on the bottom edge).
  `logfmt.js` covers every line in 15 replays (Oct + Nov 2026 servers); newer servers write card names
  as "Name: Subtitle" (older: "Name — Subtitle") - `short()` and the matcher handle both. Known names
  are matched as whole words only and names under 3 letters are skipped ("V" broke "Viktor").
  To check new replays: run every `history` message through the formatter with the same name list the
  app builds (full + short names) and look for lines with no verb. Mats are 1000 x 440, not the template's 1000 x 560, so two stacked mats fit
  a desktop window; wide screens (>1450px) get a left column (turn, then one block per player: clock,
  Gig race, counts, and their hand fanned - Rival as backs, yours face up). No hands on the mats.
  Mat columns: slim Deck/Trash column (8.8%), slim Gig strip (6.5% row). Field and Legends card sizes
  are computed per step by `sizeFields()` (largest size that fits every Unit, its Gear strips and spent
  rotation in one row; Field capped at 12cqw, Legends 7.5cqw). `--ch`/`--peek` are re-declared on
  `.field`/`.legends` - a custom property computed on `.mat` keeps the mat's smaller size and the Unit
  footprints overlap. `popArrivals()`: any card arriving in your hand, a trash or a Unit's Gear from a
  hidden place or your hand (draws, deck trashes, discards, played Programs/Gear, recoveries) pops up
  in the middle, then flies to its spot; it cancels that card's own FLIP slide first, or it measures the
  slide's start (the hand) as the destination. Field → trash moves keep the normal slide.
  Legends don't stack Gear strips under the card (it made them tiny): Gear sits tucked behind as thin
  edges (`.gear.tucked`) with a "⚙ N" badge, and the hover panel shows every attached Gear card. The step glow (`.hot`) is per card *instance*: when
  several copies share a name, only the copy whose zone/state changed this step glows (`cardSigs()`).

- **Layout v2 (Nov 6 2026, supersedes the two-mat notes above):** one shared table after the simulator's
  own board, filling the window (no title bar): left column = Rival hand, fixer dice, Gigs (+ "N/7 · total"
  box), a status block (whose turn, Turn N | phase, the step caption `bannerHtml()`), then yours mirrored;
  centre = Rival Legends + Eddies row, both Fields split by a line, your Legends + Eddies row; a strip of
  Trash/Deck piles on the right (`tableHtml()` in `app.js`). Nothing is rotated any more, so FLIP/pop
  code has no flip. Player zones are `.pz.you` / `.pz.rival` (colours via `--mat-line`). The old `.a-*`
  classes still exist but their grid-area names are reset inside `.table`. Hands are sized by
  `sizeHands()` (row height, overlap when needed). The right panel holds the replay picker / match info,
  Coach (replays) or decision + bot's thinking + controls (play page), and the log.
- Spent Eddies lie sideways; `spendFx()` animates freshly spent ones and flashes Legends/Units spent this
  step. During an attack the attacker (red), its target and a blocker stay marked (`attackMarks()`, from
  `game.attack` in `simview.js`). Pop-ups of drawn cards set their own background size (they used to get
  `no-img` and show only the art's corner).
- Pop-ups start where the card came from (deck if the deck shrank, else trash / hand) and include
  sales (`game.sold` from `play.js`; replays: your own hand → Eddies). `rollFx()` tumbles a new Gig
  die from the fixer dice to the middle and into the Gig row; `dealFx()` deals opening hands from the
  deck (`openLive`); `mulliganFx()` sends the hand back, shuffles the deck, redeals. Durations scale
  with `Board.setSpeed()` (bot pace), and live steps wait for them (`animUntil` in `extend`).

## Replay Coach (`src/coach/`, `scripts/coach.js`, `board/coach.js`)

Grades each of your turns in a replay: "you had X% to win, this line had Y%, here's why".
`node scripts/coach.js [files|folder] [--force] [--samples N]` writes
`board/replays/coach/<replay>.coach.json` (about 2 min per replay per worker; runs replays in
parallel); the board fetches it from `/api/coach/<replay>` and shows the Coach panel above the log
plus marks on the timeline. `node scripts/coach-check.js [--coverage] [--bot]` is the health check.

- **No move translation.** Sim replay actions are text labels only ("Resolved an action"), so the
  coach compares *positions*: A = first calm state of your turn (after the Gig roll), B = last calm
  state before you ended it (`positions.js`). "Calm" = `turnStep 'play'` *or* `'attack'` with no
  pending prompt: after the first attack the sim stays in 'attack' for the rest of the turn, and
  accepting only 'play' once put B before every attack (all attacking turns graded as non-attacks).
  The end-turn action's `turnNumber` is already the *next* turn's - match on order, not number.
- **Bridge** (`bridge.js`): sim state → engine board. Visible cards keep their sim id as iid
  (UUID → first 8 chars; hidden ids like `player1:eddies:hidden:0` stay whole - shortening them
  made every hidden card the same iid). Hidden cards (Rival hand, both deck orders, face-down
  Legends - yours too, the replay hides them - and every Eddie) are dealt from the inferred
  decklist with a seeded RNG: one deal = one "determinization". Status effects map to engine
  fields (lag → `entered_play_turn`, must-attack, ready/attack locks → `_until_keywords`, "+N this
  turn" → `_temp_power`); attachment/passive power is left to the engine. Built boards go through
  `combat.mainWaiting()`, never `step(b, undefined)` (in the main phase that ends the turn).
- **Decklists** (`decks.js`): every instance seen face up over the whole game (your full list is
  revealed by game end), then the closest base list - meta decks (`board/meta-decks/*.txt` plus the
  engine's `test/decks`) and `published-decks.json` (via `catalog.json` UUIDs); by deck name for
  you, by overlap for the Rival - then extra copies / same-colour cards. Adding real meta lists to
  `board/meta-decks/` is the main lever on Rival realism. Hindsight on purpose; the panel says so.
  `board/meta-decks/choombattler-*.txt` are ChoomBattler's ranked "standard list" per Legend trio
  (choombattler.com/meta, Core BO1, 30 days, fetched Nov 5 2026; trios at 54-62% win rate with
  500+ games, plus Alt/Dexter/V at 57% over 370). Refresh them from the trio pages' List view.
- **Why** (`explain.js`): named board differences between your end-of-turn board and the coach's
  (units, Gear, cards sold *from the starting hand* - effect sales like Bootleg's top card are
  unseen, so never named - Legends called, Rival Units removed, Gigs) plus playout stats recorded
  by `rollout()` (`atEnd`/`afterRival`/`afterMine` snapshots: losses, Rival's Gigs after their
  reply, yours after your next turn). The panel shows only the coach's line and these reasons.
- **Search** (`analyze.js`, `search.js`, `policy.js`): the bot plays 6 turn plans from A
  (greedy + noisy), keeps the 4 best distinct ones, and plays each plus your B to the end of the
  game 24 times, each sample a fresh deal shared by every option (paired comparison). Verdicts:
  blunder > +18 points, mistake > +8 (and > 2 standard errors), inaccuracy > +4. The bot is
  one-ply greedy over "macro" moves (a play plus its taps) with a hand-tuned position score; it
  beats random play every time (`--bot`) but is not a strong player - read results as hints.
- **Shadow check** (`coverage.js`): can the engine get from A to your B? About 17% exact and 42% to
  within one detail on the 15 shared replays; the misses are mid-turn draws (a new deal draws
  different cards) and lines the bot didn't try, not rules disagreements.

## Game bot (`src/bot/`, `scripts/arena.js`, `scripts/tune-greedy.js`)

A stronger player than the coach's rollout bot, built and measured separately (the coach still uses
`src/coach/policy.js` unchanged). Nothing in the app or board uses it yet; next step is a play-vs-bot mode.

- **Arena** (`scripts/arena.js <botA> <botB> [--pairs N] [--seed S] [--decks meta|all]`): bot-vs-bot
  over the 8 ChoomBattler lists in `board/meta-decks/` (`--decks all` adds the engine's test decks).
  Games come in **pairs** - same seed, decks, seats and first player, bots swapped - so deck and deal
  luck cancel; prints A's score with a 95% interval and Elo. Two identical deterministic bots score
  exactly 50.0%. Use a fresh `--seed` range when validating anything tuned on arena games. Bot specs:
  `greedy` (coach bot), `greedyw` (same, exposed weights - must stay identical to `greedy`), `greedyt`
  (tuned weights), `noisy`, `strong[:key=value...]`.
- **Tuned weights** (`src/bot/tuned.js`, `src/bot/tuned-weights.json`): the coach's `sideScore`
  constants as named weights, tuned by SPSA on greedy-vs-greedy win rate (`node scripts/tune-greedy.js
  --iters 300 --pairs 32`, ~7 min, games capped at 40 turns). Biggest moves: an Eddie 2.6 -> 13.4,
  a Gig 11 -> 19, Rival side weighted 1.25x. `greedyt` beats `greedy` 78.1% (+221 Elo, 400 held-out
  pairs). Re-tune after card pool / meta-deck changes (`--from tuned` continues from the current set).
- **Strong bot** (`src/bot/strong.js`): per-decision Monte Carlo. Every decision with a choice: the
  greedy (tuned) policy ranks options, the top `k` (+ end turn) are played on `deals` worlds where
  everything the bot can't see is re-dealt (`determinize()`: Rival hand+deck reshuffled together, own
  deck shuffled, engine RNG reseeded - the bot never peeks), each played out with tuned greedy for
  `horizon` turns (99 = to the end of the game), averaging win chance (`leaf: 'prob'`; a won world
  counts 1, not +1000 - averaging raw scores let single wins swamp the mean). `ctx.last` holds every
  option's value for UIs. Results vs `greedyt` (66 pairs), before the value net:
  horizon 1 = 50%, horizon 2 = 59%, play-to-end k 3 / 4 worlds = 65% (+109 Elo); the default
  (6 worlds, k 4) = 72.7% (+170 Elo, 66 pairs) at ~1.9 s per decision (one thread).
- **What didn't work** (don't retry blind): Texel-fitting the score to outcomes
  (`scripts/bot-data.js` + `scripts/fit-eval.js`; held-out log loss 0.57 -> 0.50, but a card in hand
  predicts winning better than the same card on the field, so greedy driven by it stopped playing
  cards: 1.7% vs greedy; as a search leaf it was worse than hand weights too). Whole-turn plan search
  (greedy/noisy plans scored after the Rival's reply) was only ~+50 Elo. More worlds/options at
  horizon 1 didn't help - the leaf score was the limit, not sample count.
- **Speed**: `step()` copies the board with `src/engine/lib/clone.js` instead of `structuredClone`
  (was 72% of all time; 3.4x faster, identical results - 50 tests + 3200-game fuzz pass). A plain tree
  copy is exact when `effect_stack` is empty (no shared references anywhere else on a board);
  otherwise `copyShared()` keeps the halted effect's shared objects shared. Keep that invariant if
  the engine ever stores the same object in two places outside the effect stack.
- **Value net** (`src/bot/value.js` + `value-net.json`, the `leaf=net` option): predicts the acting
  player's win chance at the start of their turn - exactly where `horizon=1` playouts stop. Input
  (`src/bot/vfeatures.js`): the 45 aggregate features + per-card counts in 13 zone "bags" (my hand,
  field, ready units, Legends up/down, Gear, deck contents, both trashes; Rival field/ready/Legends
  up/Gear) over the 150 legal cards (Rebecca PRM01-005 is a no-text promo, `legal: false`, excluded).
  Never the Rival's hand cards or any deck order. Model: EmbeddingBag(sparse)+Linear(dense) -> 256 ->
  64 -> 1. Pipeline: `node scripts/value-data.js --games 60000` (tuned-greedy self-play, 25% noisy
  games, turn-start positions labelled with the winner; ~16 min, 749k positions,
  `notes/value-data.jsonl`, gitignored) -> `D:/Codebase/venv/nitorch/Scripts/python.exe
  scripts/train-value.py` (GPU, RTX 2080; that venv has torch+CUDA - don't install into others)
  -> `node src/bot/value.js` (checks the JS forward pass against PyTorch outputs saved in the JSON;
  ~1e-4 from 5-decimal weights is expected). Held-out: log loss 0.429 / 78.8% vs 0.544 / 69.8% for a
  dense-only logistic. Plain-JS forward pass ~0.1 ms, no GPU at play time.
  `strong:leaf=net:horizon=1:deals=8:k=5` (now the `strong` default) vs `greedyt`: 81.1% (+253 Elo,
  66 pairs), 0.48 s/decision; vs the play-to-end version: 64.8% (+106 Elo, 44 pairs).
- **Coverage decks** (`src/bot/train-decks/coverage-NN.txt`, `node scripts/coverage-decks.js`): the
  12 real lists use only 77 of the 150 legal cards and 11 of 26 Legends (Panam, Judy, Takemura...
  never appear), so the nets could never learn the rest. 24 generated legal lists put every legal card
  and Legend in play at least twice (meta lists included): Legends from the least-used ones (built
  around any high-RAM card still uncovered, e.g. Judy: Nothing to Doubt needs 5 blue RAM), least-used
  fitting cards first, then filled toward the meta cost curve. Training data (`value-data.js`,
  `policy-data.js`) uses `TRAIN_DIRS` = real + coverage (`--meta-only` to skip them); the arena and the
  deck guesser use real lists only. Regenerate when new cards/sets arrive.
  `src/bot/value-net-cov.json` = value net trained on real + coverage games (753k positions; held-out
  0.405 / 80.6%). Head to head vs the default meta-trained net (`strong:vnet=src/bot/value-net-cov.json`,
  44 pairs each): 46.6% on real lists, 55.7% on coverage decks (`arena.js --decks coverage`) - both
  within noise. Default stays `value-net.json`; use the coverage net for off-meta decks.
- **Intuition net / expert iteration** (`src/bot/pnet.js` + `policy-net.json`, `src/bot/menc.js`):
  combos aren't taught one by one - the search discovers them and a policy net learns to recognise
  them. Loop: (1) `node scripts/policy-data.js --games 1500` - strong-vs-strong self-play with
  `explore=2` (each decision also searches 2 random moves outside the shortlist, so lines whose first
  step looks bad to greedy still get tested); every decision is recorded: position (vfeatures), all
  legal moves (`menc.js`: move type, acting card, target card by owner, picked cards, taps), greedy
  rank, shortlist flag, search value per move tried. (2) `train-policy.py` (GPU) fits a
  (position, move) scorer to softmax(search value / 0.03) and prints the strategy metrics below
  (also `notes/policy-report.json`). (3) `strong:prior=net` shortlists by the net instead of greedy;
  `cont=net` lets the net play the rest of the bot's own turn inside playouts (so a combo's follow-up
  is played and its first step gets credit). (4) Repeat with the new bot generating the data.
  `node src/bot/pnet.js` checks the JS forward pass against PyTorch.
  **Strategy metrics** (held-out games, net vs the greedy ranking): agreement with the search's pick;
  agreement on *non-obvious* decisions (search overruled greedy's top move - greedy scores 0% by
  definition); **discovery recall@k** - decisions where the search's pick came only from exploration
  and beat greedy's move by >= 3% win chance: does the net now rank it top-k (i.e. would shortlist it
  without exploration)? That is the "did it learn the combo" number; regret (win chance lost vs the
  search's best); agreement by move type (equip, Spend, interrupt, block, attack...).
  Round 1 (1,500 meta-only games, 125k decisions, `notes/policy-report.json`): discovery recall@5
  59% vs greedy 0% (342 discoveries), non-obvious agreement 25.7%, better than greedy at blocks
  (73% vs 35%) and choosing attack targets (52% vs 26%), but worse overall (47.5% vs 62.5%) - it
  is weak on routine moves. Arena vs `strong` (44 pairs): `prior=mix` 53.4% (+24, not significant);
  `prior=mix:cont=net` 38.6% (-80: the net plays routine moves worse than greedy, so don't use
  `cont=net` until overall agreement beats greedy). Next: round 2 on coverage decks with
  `prior=mix:explore=2` generating, more games, and/or greedy rank as a move input.
- **Data checks**: `node scripts/data-log.js notes/policy-data[-r2].jsonl [--games N | --g ID,...]` re-plays
  dataset games (same seed/decks/bot; round-1 files use the real lists only, `-r2` files all 36 decks)
  into a readable turn-by-turn log (`notes/data-log-*.txt`): board each turn, every searched move with
  its win-chance estimate, greedy rank and an exploration flag, each decision checked against the
  dataset (0 differences on 4 games). Findings (Nov 2026): the value net is well calibrated on tuned-greedy
  games (says 90-100% -> 95% won, 40-50% -> 49%), but because playouts are greedy-vs-greedy, early leads
  snowball - one turn-3 position with 1 Gig each was won 100/100 by greedy playouts - so 43% of recorded
  decisions are "decided" (every move <5% or >95%) and only 44% are informative (best 5-95% and moves
  >= 1% apart). Fixes to try: train only on informative decisions, noisier/stronger playouts, more
  worlds per decision.
- **Deck guessing** (`src/bot/belief.js`, `strong` option `belief=1`, the default): the bot no longer
  peeks at the Rival's list. Candidates = the 12 known lists, prior = ChoomBattler play counts from
  each meta file's "over N games" header (others 300), evidence = every card the Rival has shown face up
  (a list missing a shown card is penalised 0.01 per copy; more copies of shown cards = likelier),
  plus a "custom deck" hypothesis (8% prior) built from the rules: Legends drawn so their RAM per colour
  covers every shown card (a 4-RAM green card forces >= 4 green Legend RAM), the rest filled with legal
  cards of those colours weighted by meta play rate. Each world re-deals the Rival's hand, deck,
  face-down Eddies AND face-down Legends from one list drawn from that posterior (before, Legends and
  Eddies kept their real identities and the list itself leaked). `ctx.belief` = top 3 guesses.
  `node scripts/belief-check.js`: top guess right 60% by game turn 4, 77% by turn 8, 86% late; with the
  real list hidden, "custom deck" holds 20-33%. `belief=0` is the old leaky re-deal; `loo=1` hides the
  real list from the candidates (testing only). Adding lists to `board/meta-decks/` sharpens it.
  Strength cost of honesty: none measurable - honest vs leaky head to head 51.1% (44 pairs); vs
  `greedyt` on the same seeds 82.6% honest / 81.1% leaky, and 83.3% with the real list hidden (`loo=1`).
  Retrain after re-tuning the weights or changing the decks/features (indices shift with the vocab).
  Next step if more strength is needed: expert iteration - generate data with the net-leaf bot itself
  (slow: ~0.5 s/decision) or relabel greedy positions with net-leaf search values.

## Play vs bot (`board/play.html` + `live.js` + `play.css`, `src/bot/play.js`)

`node scripts/serve-board.js` then http://localhost:4181/play.html. The same two-mat board as the
replay viewer, driven live: play a bot, or watch two bots ("Next move" / "Finish turn" / "Auto").
- Server: `src/bot/play.js` holds sessions (engine board, bots, log) behind `/api/play/*` in
  `serve-board.js` (config, new, poll `?from=N`, `move {i}`, `advance` = the bot makes ONE decision,
  so each bot move lands on the board as it happens; Bot A ~0.3 s, Bot B up to ~2 s per decision).
  `src/bot/simview.js` turns engine boards into the sim-replay state shape `app.js` draws, hiding the
  opponent's hand / deck / face-down Legends from you (spectators and game-over see everything).
  Face-down Legends are hidden from their OWNER too (a Call flips a random one): only your last
  face-down Legend shows (dimmed, `.card.fd`, `known: true` - known by elimination). `policy.moves`
  offers one call option, and bots act on a board with their own face-down Legends shuffled
  (`hideOwnLegends()` in strong.js), so they only choose when to Call.
- Card art: `node scripts/fetch-card-art.js` fills `board/card-art/` (gitignored) from the official
  database; `serve-board.js` falls back to it when the Eddies image cache is missing.
- `app.js` gained `window.Board.openLive(R)` / `extend(steps, log)` and skips replay loading when the
  page has no `#replay-pick`; replays are unchanged. No card art on this machine (no Eddies image
  cache in %APPDATA%), so cards show as name tiles and hover shows a text card (`.ztext`).
- Your options are the engine's legal macro moves (`policy.moves`, taps chosen automatically, "pay N"),
  in plain English from `src/bot/describe.js` (effect choices are prefixed with their source card -
  `play.js` `cnOf()` carries it over follow-up prompts; cards an effect reveals are named and shown in
  the decision box; Legend "call" prompts read "Draw 1 (instead of: ...)"); forced
  single-option prompts are auto-played. "Bot's thinking" lists every bot decision of the turn on screen:
  the moves it compared with estimated win chance, how many it didn't search, and its deck guess.
- **You choose what pays.** `humanOptions()` in `play.js` strips the bots' automatic taps: each option has
  a cost `n` and `payables` (ready Eddies, face-down Legends "#slot", spendable face-up Legends); the page
  pre-picks Eddies, then face-down Legends, then face-up ones, and lets you change it (`move {i, pay}`).
  {Spend} abilities with a €$ cost pass `pay_iids` (engine `resolveSpendActivated` accepts it).
  Calls are offered per face-down slot (identity still unknown) because a Called Legend keeps its state:
  call a ready one and pay with something else to get it ready. Bots now do the same (`policy.moves`
  calls a ready face-down Legend and avoids paying with it).
- **Log detail** (`results()` in `play.js`, by diffing the board before/after each move): what paid
  ("paid 1 Eddie + 2 Legends" - counts only, no slot numbers, on request), roll results ("Roll the d6 →
  4"), dice changed / taken named by owner + size + old value ("Bot A's d6: 4 → 5"; choice lines'
  "own/opponent's d6" are rewritten the same way) with a ring on that die (`diceMarks()` in app.js),
  draws (named only if the viewer may see them), discards, deck trashes, trash returns, and a
  "Turn N starts: readies N spent cards · draws X" line after each end turn.
  Units leaving the Field say where they went (defeated / put on the bottom of the deck / returned to
  hand / removed / changes sides) and effect power changes are logged ("Meredith Stout: power 5 → 1").
  Two bots of the same kind are named by their deck colours ("Bot A (YYR)" / "Bot A (BBG)").
  Phrasing rules (`results(s, before, after, seq, subj)` + the folds in `apply()`): the line's player
  (`subj`) is unnamed ("draws X", "own d12"), the other is named with grammar ("you draw", "your
  Meredith Stout", "Bot A's d12"); dice are named by OWNER everywhere (describe's `choiceName` too).
  A choice and its result are said once: "decreases own d12 by 2 (3 → 1)", "adjusts by +1",
  "sets X's d10 (9 → 2)", "copies the value of your d12 (9)", "swaps own d4 (1) with your d12 (3)",
  "takes back own d12", "Adam Smasher: Bot A's Pepe Najarro defeated", "discards X"; engine prompts
  that repeat their card ("Jackie: choose…") lose the prefix. Gear leaving a Unit is logged
  ("Mantis Blades (on Johnny Silverhand) defeated"); a mulligan "draws a new hand".
  **Split by source**: `apply()` turns on the engine trace (`b._trace`, lines like "T8/trig p1/HEIST-002#22
  Draw{n:2} ok") for each move; draws made by a different card's effect than the line's own get their
  own line (River Ward's trash, then "Dexter DeShawn: draws X, Y" - two triggers resolved in one engine
  step). Keyword effects put on Units are logged ("Johnny Silverhand: can't attack until Bot A (BBG)'s
  next turn") and listed in the hover panel (`unitKeywords()` in simview.js) - a hidden Chrome Reverie
  lock once made the bot look like it skipped a lethal-saving attack. `_sessions` is exported from
  play.js for debugging (replay a seed, then inspect `s.b`). Pop-ups now play 420 ms apart.
  To review wording: play ~30 bot games and print one example per line shape (card names → X,
  numbers → N) - that is how these were found.
- **Hidden information.** Play mode: you never see the bot's hand, deck or face-down Legends, its
  private picks read "looks at the top 5 of the deck, takes a card" / "picks a card you can't see"
  (`privateText()`), and its thinking panel shows only the moves it made - what it compared (it names
  its hand) and its hand check are sent only once the game is over (`poll()` strips them; live.js
  refetches at game end). Every bot decides on `botView()`: your hand, deck, Eddies and face-down
  Legends re-dealt from its deck guess (belief.js), its own deck and face-down Legends shuffled - before
  this the greedy bot and the strong bot's shortlist ranking ran on the real board. Watch mode shows
  everything to you; the bots still only get their own `botView()`. The arena script still gives
  greedy bots the real board.
- **Sound** (`board/sfx.js`): table sounds are recorded clips from Kenney's CC0 packs **Casino Audio** and
  **Impact Sounds** (kenney.nl; 57 clips, ~550 KB in `board/sfx/`, licenses alongside), mapped in
  `CLIPS` (layers x random variants, slight pitch jitter); turn / win / lose chimes and any clip that
  hasn't loaded are synthesized. kenney.nl blocks scripted downloads - get packs via the site's
  Download button. `soundFx(prev, st)` in app.js plays
  per forward step (turn change, rolls, units in / defeated, Gear, Programs, draws, sales, spends,
  flips, attacks, blocks, dice changed / taken); deal / shuffle / mulligan sound from their animations;
  win / lose from live.js. 🔊 button + volume slider on both pages, M toggles.
- The table's one grid row is capped (`grid-template-rows: minmax(0, 1fr)`, board column is flex): on
  wide screens it used to grow taller than the window behind the timeline. Gig dice shrink with
  their count (`--n` on `.gigs`).
- Keys (both pages, `app.js` keydown): A / D step back / forward, S play-pause, Q / E a whole turn
  back / forward (arrows, Shift+arrows and Space still work). Bot vs bot on the latest step: D = next
  bot move, E = finish the turn, S = Auto (`board:live-key` event, handled in live.js).
- Bot pace: Step (click each move) / Very slow 6 s / Slow 4 s / Normal 1.8 s / Fast 1 s per move (`eddies_bot_pace`); live steps play one at a
  time (`Board.extend(steps, log, gap)` is async) so every move animates.
- **Mulligans** (`src/bot/mulligan.js`, used by every bot: greedy, greedyt, strong): the search score
  only counts hand size, so bots used to keep every hand. Now a hand is scored by rules (sellable
  cards, a Unit castable on your first turn - 2 €$ going first, 4 going second (rule 7.7.4) - Units by
  turn 2, 6+ cost clunk) and compared with 400 sampled fresh hands from the same deck: mulligan only
  in the bottom 25% and 1+ below the mean (~25% of hands). Arena: greedyt with it vs `greedyt:mull=old`
  52.5% [50.6, 54.4], +17 Elo (400 pairs); 15/35/45% cut-offs were within noise. The play page shows
  the bot's hand score and reason. `mull=old` restores always-keep.
- **Undo** (play mode, button or U): `move()` saves the game (board, decision, log/step counts) before each
  of your decisions; `undo()` (`POST /api/play/<id>/undo`) restores the last save, bot moves after it
  included, and live.js reloads the board there.
- **Playing look** (Nov 7 2026): while you play (`body.playing`) the replay timeline and the match header
  (names + Legends) are hidden; buttons are cut-corner neon, your options are lit-edge cards with the cost as
  a chip, End turn in red; bigger log text. Dice are drawn as polyhedra (`DIE3D`/`dieSvg()` in app.js: body,
  lighter front face, facet edges, `#die-gloss` gradient defined in each page's hidden SVG).
- **Amount choices fit the die** (engine, rule 6.4.4 + FAQ "up to"): a ChooseAmount feeding an
  Increase/Decrease/AdjustGig of an already-chosen Gig only offers amounts that die can take
  (`linkAmountsToGigs()` in engine `cards.js`, range in effects.js; test `cards-amount-fits-gig`). Industrial
  Assembly on a d4 at 2 offers +1..+2 (it used to offer +4, which fails by rule). Off under the legacy switch.
- Bots offered: **Bot A - Net Searcher** (`strong:vnet=src/bot/value-net-r2.json:pnet=src/bot/policy-net-r2.json:prior=mix`
  since Nov 6 2026 - league round 2 nets, see "Archetype pilots"), **Bot B - Playout Searcher**
  (`strong:leaf=prob:horizon=99:deals=6:k=4`), tuned greedy. Defaults: you = Adam/River/Viktor
  (Yellow 4 / Red 2), Bot A deck = Dexter/Padre/V (Red 4 / Green 2), Bot B = Alt/Hanako/Jackie
  (Blue 4 / Green 2). The old greedy-self-play datasets were deleted on 2026-11-06 (bad data: greedy
  playouts snowballed); training data now comes from the league (see "Archetype pilots").

## Archetype pilots and the league (`src/bot/pilot.js`, `match.js`, `view.js`, `scripts/league.js`)

Four Bot A "pilots", one per colour combo, each on the best ChoomBattler list (choombattler.com/meta,
30 days, fetched Nov 6 2026; `src/bot/pilots/choombattler.json` holds each trio's standard list and
its top-20 card table, also written to `board/meta-decks/`): **YYR** Adam/River/Viktor (Bo3 list, 66%
over 219), **BBG** Alt/Hanako/Jackie Pour One Out (Bo3, 57% over 172), **RRG** Adam/Dexter/Padre (Bo1,
67% over 219; Dexter/Padre/V and Adam/Saburo/V as variants), **RGB** Dexter/Padre/Wakako (Bo1, 45% over
62 - the only Red-Green-Blue trio ChoomBattler has; "V" has a red and a blue version, trio colours come
from the exact Legend slugs in the trio links). No ChoomBattler sideboards exist: each pilot's 7 start
from trio cards the standard list doesn't max.

- **Bo3 matches** (`playMatch()` in `match.js`, user's tournament rule): every game both players roll a
  D20 (re-roll ties) and the higher roller chooses first or second; first to 2 wins. A game still going
  after turn 16 (8 turns each, `MAX_TURNS` in match.js) is a draw: half a game each. Sideboard rules:
  exactly 7, no Legends, max 3 copies across main + side, 1-for-1 swaps between games, RAM legal
  (`legal()` in pilot.js). Bots always decide on `botView()` (`src/bot/view.js`, shared with play.js).
- **What a pilot learns outside the nets** (`src/bot/pilots/state/<ID>.json`, Thompson sampling over
  Beta posteriors): go first/second per opponent (prior 59.5% first, ChoomBattler's field); its deck -
  a one-card challenger (main or side, from the trio pool or any legal card) alternates with the
  champion, promoted at P(better) > 0.85 after >= 24 matches, rejected < 0.3 or at 80. Learned so far:
  RGB +Johnny Silverhand -Pepe Najarro, RRG +Maelstrom Zealots -Industrial Assembly, BBG +Synapse
  Burnout -Lizzy Wizzy; YYR rejected every change. **Sideboarding is ON HOLD** (`--sideboard` to
  re-enable): per-plan stats per opponent never got enough games, and whole-game swap tests are far too
  noisy (a one-card change is a few points; 24 paired games = +-14). Kept for later:
  `scripts/sideboard-lab.js` (paired swap games) and `scripts/card-review.js` (add each legal card to the
  hand at real positions, the search scores it - "would Dexter DeShawn have helped vs BBG here"; needs
  ~50 positions per matchup to be stable). The user's idea for the real fix: learn card-vs-card values
  (MaxTac Suppression Team vs Go Solo Legends / Adrenaline, Rockn' Rockerboy otherwise).
- **League** (`node scripts/league.js [--matches N] [--record] [--teach 0.15]`, 15 workers): pilots vs
  each other (50%), mirrors (10%) and a field of every legal list we have (ChoomBattler + engine tests +
  published decks + coverage decks, ~70). ~3-5 min per Bo3 match per worker, ~150-225 matches/hour.
  The run log prints one line per finished game (winner, turns, D20, who went first).
  `notes/league/matches.jsonl` (results, decks, D20s, plans) and `data-<seed>.jsonl` (policy-data
  format, gitignored). The user wants the playing bot and the teacher at FULL settings for data - don't
  lighten them to save time without asking.
- **Teacher**: on 15% of undecided decisions a deeper search (`deals=24:k=10`, same nets) re-scores the
  options; those records carry its values (`teach: 1`) and `mistake: 1` when its best beat the played
  move by 3+ points. Round 2: 554 / 7,557 (7.3%); round 3 with the r2 bot: 2.6%. Hand-checked
  (`scripts/league-check.js --mistakes`): the mistakes are real and mostly moves never on the
  shortlist - attacking a Unit, equipping Gear - which the policy net's `prior=mix` picks fix.
- **Data checks** (`scripts/league-check.js [--games N] [--all] [--mistakes]`): replays games exactly
  and flags END+ (ended the turn with a play scored within 3 points), TIE (top two within 1 point),
  DONE (all <5% or >95%), MISS (legal moves never searched). Round 1: only 28% informative, 69% ties,
  43% with unsearched moves; the value net is calibrated at the extremes but too pessimistic at 10-40%
  (actually 31-49%). Policy training therefore uses teacher + informative decisions only.
- **Training without PyTorch** (the laptop had none): `scripts/train-value.js` / `train-policy.js`
  re-tune the existing nets in plain Node (same file formats, checked equal to value.js / pnet.js);
  `scripts/league-to-value.js` turns league games into value rows (first main-phase decision per turn).
  The Python trainers now also take `--init` (and `--teach-only` / `--informative-only` for policy).
  CUDA on the laptop (RTX 3060): `D:/Codebase/venv/nitorch/Scripts/python.exe` (Python 3.12, torch
  2.6.0+cu124, CUDA works). Wheel kept in `D:/Codebase/wheels`; the pytorch.org download stalls - use
  curl with `--speed-limit/--speed-time` and `-C -` resume. The Anaconda `mmseg` env's torch is broken.
- **Gate** (`node scripts/pilot-arena.js <specA> <specB> [--pairs N]`): paired Bo3 matches on the four
  pilots' decks, bots swapped per pair. Round 2 nets (value: 10k league positions, held-out log loss
  0.521 -> 0.493; policy: 28k decisions incl. 7.9k teacher, regret 3.16 -> 2.29 pts vs greedy 3.52) with
  `prior=mix` beat the old Bot A **62.5% of Bo3 matches [53.4, 71.6], +89 Elo** (40 pairs, games 60.8%)
  -> promoted to `src/bot/value-net-r2.json` + `policy-net-r2.json`, the play page's Bot A and the
  league default. Loop: league round (record + teach) -> re-tune nets -> gate -> promote only winners.

### Research-plan upgrades (Nov 6 2026, see `notes/research-plan-gap.md`)

- **Leak test** (`node scripts/leak-test.js [--games N]`): at every decision of fast games it builds a
  second board that differs only in hidden facts (Rival hand/deck/Eddies with different cards,
  face-down Legends swapped, own deck reordered) and requires `botView()` to be identical. Shuffles in
  `determinize()`/`hideOwnLegends()` now start from a sorted list so the view can't depend on hidden
  order; `EDDIES_LEGACY_SHUFFLE=1` restores the old board-order shuffle, needed ONLY to replay games
  recorded before this change exactly (`reanalyse.js` sets it).
- **Sold cards are remembered** (ruling from the user): a card sold from hand is revealed, then goes face
  down. The engine marks those Eddies `seen: true` (turn.js); `belief.shown()` counts them (deck guess) and
  `redeal()` keeps them (they can't also be in hand/deck). Top-of-deck sales by effect stay hidden.
  `BELIEF.legacy.on` (env `EDDIES_LEGACY_SHUFFLE=1`) turns this and the sorted shuffles off for exact
  replays of older games; `reanalyse.js` switches it on only while replaying.
- **Move lists**: league games now also write `games-<seed>.jsonl` (decks, first player, every applied
  move), so any position can be rebuilt with the engine alone, whatever the bot code becomes (needed for
  future Reanalyse and the card-encoding project #8).
- **Reanalyse** (`node scripts/reanalyse.js <data.jsonl> --bot <spec that played it> [--by spec]
  [--rate 1]`): replays recorded games exactly (checked decision by decision; drifting games are
  dropped) and re-scores every undecided decision with a deeper/newer search (default: teacher depth
  with the r2 nets). Writes `data-<seed>-re.jsonl` (records marked `teach: 1, re: 1`, `v` = best value).
- **Value targets**: `league-to-value.js --mix L` makes the label L x result + (1-L) x search value
  (held-out loss is still on real results); rows carry turns-left for `train-value.py`'s auxiliary
  head (`--aux 0.1`, training only, not saved). `train-value.py` with `--init` never ends worse than
  the starting net.
- **Past bots** (`league.js --past specA,specB [--past-share 0.2]`): that share of matches gives the
  opponent to an older Bot A; its decisions aren't recorded and its pilot stats don't change.
- **Community field** (`node scripts/fetch-netdeck.js`): every public Standard deck on netdeck.gg (the
  cyberpunktcg.com deckbuilder; `GET api.netdeck.gg/api/cyberpunk/decks/public?limit=100&offset=N&sort=liked`,
  no auth, robots allow) -> `src/bot/field-decks/netdeck/*.txt` (legal + distinct only; header has author,
  likes, views; sideboard as `# side:` comments). Nov 6 2026: 1,697 public -> 1,600 kept, all 150 legal
  cards in 2+ lists, 20 colour combos (most: YYR 215, BBG 163, RRY 133, YYY 128). Details cached in
  `notes/decks/netdeck-raw/` (gitignored); re-run to refresh. `league.js --net-share 0.5`: that share of
  field matches uses these, weighted 1 + likes. ChoomBattler has only per-trio stats (tRPC
  `meta.field`), no lists; no tournament lists exist yet. Not in `belief.js` candidates (yet).
- **Sequential halving** (`strong` option `sh=1`): same total playouts (moves x deals), spent in rounds
  that drop the worse half of the shortlist. Being tested against the flat search in the arena.

## Known CSS gotchas (already solved, don't reintroduce)

- **`overflow-x: auto` + `overflow-y: visible` silently forces vertical
  clipping too** (browsers collapse the pair to auto/auto). This bit the
  Collection window's fan-stack rows. Fixed by *not* trying to raise the
  hovered card in place at all — `collection.js`'s hover handler instead
  spawns a `position: fixed` "ghost" element appended to `<body>` (see
  `showGhost`/`hideGhost`/`.fan-ghost`), which lives outside any clipping
  ancestor. The real card just fades its own `<img>` to `opacity: 0`
  underneath. The rarity-sidebar's "pinned" cards (`pinCard`/`unpinAll`)
  reuse the exact same ghost mechanism, just persistent instead of
  hover-triggered, and multiple can be up at once (`pinnedGhosts` Map keyed
  by printing id, vs. the single shared `ghostEl` for mouse-hover).
- **Nested flexbox needs `min-width: 0` on every level, not just
  `min-height: 0`.** Adding the rarity sidebar (`.board-layout` as a new
  flex *row* wrapping `.fan-board`) reintroduced this in the other axis:
  `.fan-board` had `min-height: 0` (correct, it's a flex *column*) but not
  `min-width: 0`, so it refused to shrink below its cards' total intrinsic
  width and the whole board silently grew wider than the window instead of
  clipping/scrolling internally — `.fan-stack`'s edge-auto-scroll then had
  `scrollWidth === clientWidth` (zero *internal* overflow) even though the
  row was visibly cut off by the viewport. Any time a fan-stack row stops
  scrolling, check `min-width: 0` up the whole flex-parent chain first.
- **Gradient borders: use `border-image-source`, not a masked
  pseudo-element.** The banded ownership border (main-window card tiles
  with copies in more than one bucket) originally used a `::after` ring
  with `mask`/`-webkit-mask-composite: xor` — it silently failed to render
  the top band with no console error (confirmed by direct pixel sampling).
  Switched to `border-image-slice: 1; border-image-source:
  linear-gradient(...)` directly on the tile, which is far more reliable.
  Trade-off: `border-image` ignores `border-radius`, so multi-bucket tiles
  have square corners while single-bucket ones stay rounded — accepted as
  worth it for a border that actually renders.
- **Selector collisions inside `.mini-counter`**: the `-`/`+` buttons and
  the `MAX` button are all `<button>` elements inside the same
  `.mini-counter` div. A bare `.mini-counter button` selector will also
  match `.mini-max-btn` and squash it into the tiny 17×17px counter-button
  box. Always scope with `:not(.mini-max-btn)` (see `style.css`) when
  styling the counter buttons.
- Buttons across the app set an explicit `:focus-visible` outline (not
  browser-default `outline: auto`, which renders oversized/misaligned at
  these small sizes) — keep using explicit `outline: Npx solid <color>;
  outline-offset: Npx;` for any new tiny buttons.
- Loading ~500 images at once (Collection window, "All" tab) froze the UI
  even with a CSS entrance-stagger animation, because the stagger only
  delayed each card's *opacity*, not the actual `src` assignment that
  triggers the real fetch/decode work. Fixed with a real concurrency-capped
  queue (`loadCardImagesQueued`, `IMAGE_LOAD_CONCURRENCY = 8`) that assigns
  `<img src>` from `data-src` in small batches — don't go back to setting
  `src` directly in the initial HTML for any view with many cards at once.
- **A bare descendant selector on a popup's card image also matches icons
  nested deep inside it.** The popup's `.popped-card img { width: 340px;
  box-shadow: ...var(--yellow) }` rule was meant for just the card art, but
  also matched every `.keyword-icon` image inside `.popped-rules`/the FAQ
  section (also a descendant of `.popped-card`), stretching each one to
  340px with a yellow ring — looked exactly like a broken image at a
  glance, wasn't one. Fixed by scoping to `.popped-card > img` (direct
  child only). Any time a new element gets nested inside an existing
  "the one big image in here" container, check for this before assuming
  the new element is broken.
- **Toggling the `hidden` property does nothing on an element that also
  has its own `display` set via a class.** An author stylesheet rule (e.g.
  `.bucket-action-row { display: flex }`) always beats the browser's
  default `[hidden] { display: none }`, regardless of selector
  specificity or source order — so `el.hidden = true` silently no-ops on
  anything styled that way. Bit several of the Record page's conditionally
  shown elements at once. Fixed globally in `docs/style.css` with
  `[hidden] { display: none !important; }` at the top of the file, rather
  than hunting down every individual element case-by-case.

- **`.card-tile` needs `content-visibility: auto`** (+ `contain-intrinsic-
  size: auto 480px`, ~one tile's real height). Without it every window
  resize re-lays-out all 170-509 grid tiles, and on Windows a title-bar drag
  out of maximized blocks on that layout - the window froze ~1.4s mid-drag
  (vs ~0.14s with it, same as an empty page; hiding the images alone made
  no difference, it's layout, not image decode). Measured with a scripted
  drag + `--remote-debugging-port` CSS injection; see conversation history.

## Windows dev-environment notes

- `npm install`'s postinstall electron download can silently fail to fully
  extract on this machine (only `LICENSES.chromium.html` ends up in
  `node_modules/electron/dist`). If `npm start` errors with "Electron
  failed to install correctly", the fix that worked: manually
  `Expand-Archive` the cached zip from
  `%LOCALAPPDATA%\electron\Cache\...\electron-v*.zip` into
  `node_modules/electron/dist`, then write `electron.exe` into
  `node_modules/electron/path.txt`.
- This machine's `PowerShell` tool is genuine Windows PowerShell 5.1
  (`System.Drawing` works for screenshots, and for one-off image generation
  — see the app-icon section above); a plain `pwsh` (PowerShell Core)
  session would need `Add-Type -AssemblyName System.Drawing` and may still
  lack `System.Drawing.Common` — prefer the PowerShell tool over Bash for
  anything involving screenshots, Win32 interop, or GDI+ image drawing.
  Note PowerShell 5.1 does **not** support the `` `u{XXXX} `` unicode escape
  (that's PowerShell 6+/Core only) — build non-ASCII characters via
  `[char]0x20AC` etc. instead.
- To visually verify UI changes: launch
  `node_modules\electron\dist\electron.exe .` directly (not `npm start`) if
  you need `Start-Process` with separate stdout/stderr redirection for log
  capture, then screenshot with `System.Drawing` + `CopyFromScreen`
  (windows open maximized, so `Screen.PrimaryScreen.Bounds` covers the window
  rect). Main window controls' approximate screen coordinates shift
  whenever header buttons are added/removed — re-screenshot before
  clicking rather than reusing old coordinates. `main.js` forwards each
  window's renderer `console-message`/`did-fail-load` events to the main
  process's stdout (prefixed `[renderer]` / `[collection-renderer]`) —
  check that log before assuming a click/hover silently no-op'd.
- The Claude Browser tool's `navigate`/`preview_start` refuse a bare
  `file://` path unless it's inside an already-"open" project folder (this
  tripped up local testing of `docs/`) — use a tiny local HTTP server
  (`scripts/serve-docs.js` + `.claude/launch.json`'s `docs-preview` config)
  instead of `file://` URLs.

## Things explicitly *not* wanted (don't re-add)

- No foil-specific tracking (removed early on — Main/Reserve/Extras
  replaced it entirely).
- No auto-redistribution between buckets, no global "auto-fill all" bulk
  button — user found this too risky/unpredictable. The per-row MAX button
  (direct set, single bucket, type-capped) is the agreed replacement.
- "Has Extras" was removed as a Collection-window filter; only **All /
  Full Set / Partial / Missing** remain, and all four are evaluated against
  whichever bucket the Main Set/Reserve Set toggle currently selects —
  including Missing (it means "0 in the active bucket", not "0 everywhere";
  a card can be full in Main and simultaneously "missing" from Reserve).
- The website's write path (Record page) is deliberately delta-queue-only
  (see "Web publish") — don't let it write directly to anything resembling
  the real collection state, even for convenience.
- No auto-flush/auto-sync timer on the Record page while actively clicking
  +/− — tried (a 4s debounce after the last click), explicitly rejected as
  unwanted background activity. Committing staged deltas to GitHub is a
  manual "Commit Trades" click only; see `docs/record.html`.

## Deck tags, groups, AI queue (Deck Builder + `docs/decks.html`)

- **Tag DB** `userData/tag-db.json` (seeded from `src/data/tag-seed.json`; IPC `tags:get/save`). Categories: `archetype`, `creator` (YouTube channels, with `url`), `misc` (includes the locked `misc-featured`). **Color tags (BBG, RBG, YYB…) are never stored** - derived from the Legends, most-represented color first then R,B,G,Y (`colorTagFor()` in `main.js`, `colorTagOf()` in `deckbuilder-tags.js`). Decks hold `deck.tags = {archetype, creator, misc}` (tag ids) and `deck.groupId`; a link's `creatorId` also counts as a creator tag. `decks:setMeta` edits those without bumping `updatedAt`; `decks:save` preserves them if the incoming deck lacks them. Deleting a tag/group prunes decks.
- **Groups** `userData/deck-groups.json` `[{id,name,collapsed}]` (`groups:get/save`). My Decks list is grouped, drag a card onto a group header to move it. `collapsed` is also the site's default open state.
- **Featured** = the `misc-featured` tag, set from the app. The site has no pin/edit controls (read-only); hero falls back to the latest deck if none is tagged.
- **Publish** writes `docs/data/deck-meta.json` (`{groups, tags}` only for published decks/used tags) and stamps each published deck with resolved `tags` + `colorTag`. Site: `?group=<id>` opens that group and minimizes the rest; chips filter by color/archetype/channel/tag; "Tag guide" lists definitions.
- **AI**: `ai.tagDeck` (IPC `ai:tagDeck`) picks archetype tags from the DB definitions (`AI_TAG_CATEGORIES` in `ai.js`; add `'misc'` to widen), using already-tagged decks as examples. Colors/creators are never AI. The queue in `deckbuilder-tags.js` runs "Fill description" (shown only when every description field is empty) and tag jobs one at a time; "Tag untagged" queues all decks lacking an archetype.
- Archetype seed follows community usage (Aggro, Midrange, Control, Tempo, Combo, Ramp, Hand Control, Gear/Equip) - no formal meta exists yet.

### Picture export (Deck Builder → Export → "Save as images")

`src/renderer/deckbuilder-export.js` draws two PNGs **directly on a `<canvas>`** in the Deck Builder window (1600px wide): **Deck** (Legends, every card's art with a ×N badge, sideboard, cost curve, type/color/sellable donuts, tag chips, and a QR code to the deck's own site page `<siteBase>decks.html?id=<deckId>` with the site name under it - drawn with the vendored MIT `src/renderer/vendor/qrcode.js`, since electron-builder only packages `src/`) and **Game Plan** (the `descSections` text with card names highlighted, Key Cards thumbnails, swap plans; skipped when nothing is written). Layout is computed first (`ops` + `height`), then drawn. `deck:saveImages` in `main.js` only asks for a folder and writes the bytes. Card art comes through `cardimg://`, whose handler adds `access-control-allow-origin: *` so drawing it doesn't taint the canvas - keep that header. (An earlier hidden-BrowserWindow + `Page.captureScreenshot` version hung in the real app; don't go back to it.)

### Deck versions (`deckbuilder-versions.js`, ported read-only to `docs/decks.js`)

A deck can hold several versions of its card lists; name, description, tags, group and links are shared. **The deck's top-level `legendCardIds/legendPrintingIds/cards/sideboard/cardPrintings/swapPlans` always hold the ACTIVE version**, so every existing reader (Builder, Deck View, Prep List, AI, export, publish) is unchanged. `deck.versions: [{ id, name, ...those fields }]` + `deck.activeVersionId` are created lazily (a deck that never made a version has an implicit "v1"); `syncActiveVersion()` copies the top level into the active slot before a switch and in `saveDraft()` - anything that reads `deck.versions` directly must sync first. Builder: dropdown + rename (✎) / "+ Version" (copies the current one) / delete next to the deck name. Deck View: dropdown only (switch is saved, like the front-printing switch). Switching shows a summary (`versionDiff()`: Legends / Main Deck / Sideboard rows, −out / +in). `decks:publish` includes every version's printings; the site's detail page has the same dropdown and summary (view-only).

**Hover card** (enlarged card following the cursor): one handler per surface - `onCardTagHover()` in `deckbuilder.js` (`data-card-tag` = display name, `data-hover-card` = cardId, `data-hover-printing` = printing id) and the `data-zoom` handler in `docs/decks.js`. Both use the same size, **320px** (`HOVER_CARD_W` / `.card-tag-pop img` in both CSS files) - keep them in sync.

**Shared description/tags vs. versions**: the description and archetype tags are shared by all versions, so `deck.descVersionIds` / `deck.tagsVersionIds` record which versions they were written (or confirmed) for. Editing the description (editor or AI) or archetype tags resets the list to the current version (`stampDesc`/`stampTags`); "Still fits <version>" adds the current one (`confirmForVersion`); the first "+ Version" stamps existing text for the parent (`stampExistingFor`). `versionWarnings()` flags the current version when it isn't in the list, naming any `@[Card]` the description mentions that only exists in another version - shown in the Builder, the description editor, Deck View and as a My Decks flag; the site shows a "Written for <version>" note instead (no buttons).
