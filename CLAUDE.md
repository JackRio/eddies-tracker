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

Two Electron `BrowserWindow`s, both fullscreen-by-default and frameless
(custom title bar, see below), both using the same `preload.js` (so both
get the same `window.api`):

- **Main window** — `src/renderer/index.html` + `renderer.js` + `style.css`.
  The card browser/filter grid where you set Main/Reserve/Extras counts.
- **Collection window** — `src/renderer/collection.html` + `collection.js` +
  `collection.css`. Opened via the "My Collection" button (IPC
  `collection-view:open`). Visual binder: 5 tabs (All/Legend/Unit/Gear/
  Program) × 4 color rows, a rarity-filter sidebar, and a Main Set/Reserve
  Set toggle that changes what every filter on the page means.

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
```

## Custom window chrome

Both windows are created with `frame: false` (plus `icon:` pointing at
`build/icon.png`) — there's no native title bar, so `index.html` and
`collection.html` each draw their own slim `.window-titlebar` strip with
minimize/maximize-restore/close buttons wired to the `window:*` IPC calls
above. `window:toggle-maximize` cycles fullscreen → maximized-windowed →
restored, using whichever `BrowserWindow` actually sent the IPC
(`BrowserWindow.fromWebContents(event.sender)`), not a hardcoded window
reference. If you add a third window, give it the same treatment.

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
   name/set/rarity/etc, so the Record page can search *any* card, not just
   currently-needed ones)
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

- `docs/index.html` + `needed.js` — **Needed** page. Filters, in this
  fixed order top-to-bottom: Main/Reserve toggle → Color chips → Type chips
  → Rarity chips → Set dropdown (defaults to `welcometonightcitybeta`,
  i.e. "Welcome to Night City — Beta", same default as the desktop app).
  Read-only, no GitHub token needed — everything it reads is a plain
  same-origin `fetch()` of a file Pages serves statically.
- `docs/record.html` + `record.js` — **Record** page. Token-gated (shows
  `#token-gate` until a token is saved and passes `verifyToken()`). Search
  box over `catalog.json`, then +/−1 buttons per bucket for the selected
  card, each doing a read-modify-write (`ghGetFile` → append → `ghPutFile`)
  against `docs/data/pending-changes.json`. Shows a running "Pending" list
  of everything queued since the last desktop publish.
- `docs/shared.js` — GitHub Contents API helpers (`ghGetFile`, `ghPutFile`,
  `verifyToken`) and token storage (`localStorage`, key `eddies_gh_token`).
  Always hits `api.github.com` directly (never the Pages CDN), so the `sha`
  used for a PUT is fresh.
- `docs/config.js` — `window.EDDIES_CONFIG = { owner, repo }`. **Currently
  a placeholder** (`owner: 'REPLACE_WITH_GITHUB_USERNAME'`) — the repo
  hasn't been created/connected yet as of this writing. Fill in the real
  owner once known, and set up the git remote (`git remote add origin
  <url>`) before the "Publish Site" button's `git push` will work.
- `docs/data/{needed,catalog,pending-changes}.json` — generated by
  `publish:run`; `pending-changes.json` starts as `[]` and is written to by
  the Record page between publishes.
- `docs/images/` — copied subset of `userData/images/` (only currently- or
  previously-needed printings, not the full 509).

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
  (windows are fullscreen so `Screen.PrimaryScreen.Bounds` = the window
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
