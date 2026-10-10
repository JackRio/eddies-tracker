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
  root). Hero (the featured deck's three Legends), headline numbers
  (`data/stats.json`, `looking.json`, `trade.json`, deck count), **Latest
  videos** (see "Home page videos" below), the featured deck, the freshest
  decks, and tiles explaining each page. Read-only, loads `decks.css` too to
  reuse the `.featured`/`.deck` styles; deck helpers in `home.js` are small
  duplicates of `decks.js`'s (the repo's no-shared-code convention).
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
  **https://cyberpunktcg.help** (custom domain via `docs/CNAME`, DNS pointed at
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
- `docs/assets/keywords/*.svg` + `docs/assets/rarity/*.svg` — same keyword
  badge icons and rarity icons the desktop app uses (`src/renderer/assets/
  keywords/` and `.../rarity/`), duplicated here so the website's
  `renderRulesText()`/rarity filter buttons can reference them too. Keep
  both copies in sync if these ever get regenerated.
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
  step). Nav order: Home, Decks, Trading, Needed, Record. The footer holds
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

### Home page videos (`docs/data/videos.json`)

New uploads from followed YouTube creators are embedded on the Home page. A
static site can't poll, and browsers can't read YouTube's RSS (no CORS), so:
- `scripts/fetch-videos.js` (Node 18+, no deps; `npm run videos`) reads each
  channel's public RSS feed (`youtube.com/feeds/videos.xml?channel_id=…`),
  drops Shorts (HEAD on `/shorts/<id>`), and writes `docs/data/videos.json`
  (`{ channels, videos, checked, updatedAt }`). It only rewrites the file when
  the videos actually change.
- Channels followed = creator tags with a youtube.com URL in the published
  `deck-meta.json` (tag a deck with a new creator in the app → they're
  followed after the next deck publish) **plus** any in
  `docs/data/channels.json` (`{ "channels": [{ "name", "url" }] }`). `@handle`
  URLs are resolved to channel ids from the channel page and remembered.
- `.github/workflows/videos.yml` runs it every 3 hours (and on demand from
  the Actions tab) and commits `videos.json` if it changed, so the Home page
  stays current with the desktop app closed. A new video therefore also
  triggers the "newer version is live" banner on open tabs.
- Playback is a click-to-load facade (thumbnail → `youtube-nocookie.com`
  iframe), so YouTube loads nothing until someone presses play.
- `docs/data/stats.json` (`neededMain`, `neededMainCopies`, …) is written by
  `publish:run` for the Home page's headline numbers.

### Trade page (`docs/trade.html` + `trade.js` — unlisted)

A "cards I'm selling" page shared by URL only (`cyberpunktcg.help/trade.html`).
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
- Custom domain (`cyberpunktcg.help`, moved from `jackrio.lol`) is live, DNS'd straight at GitHub Pages —
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
