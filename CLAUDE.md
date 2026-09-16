# Cyberpunk TCG Tracker — Project Reference

Personal Electron desktop app that tracks a collection of the real, official
**Cyberpunk TCG** (published by Weird Co., licensed by CD Projekt Red). Card
data comes live from the public card-database API behind cyberpunktcg.com.
This doc exists so a new session can make changes without re-reading the
whole codebase — read this first, then only open the specific file you need
to touch.

## Run it

```bash
npm install
npm start
```

No build step, no bundler, no TypeScript — plain CommonJS/vanilla JS loaded
directly by Electron.

## Architecture at a glance

Two Electron `BrowserWindow`s, both fullscreen, both using the same
`preload.js` (so both get the same `window.api`):

- **Main window** — `src/renderer/index.html` + `renderer.js` + `style.css`.
  The card browser/filter grid where you set Main/Reserve/Extras counts.
- **Collection window** — `src/renderer/collection.html` + `collection.js` +
  `collection.css`. Opened via the "My Collection" button (IPC
  `collection-view:open`). Read-only visual binder: 4 tabs (Legend/Unit/
  Gear/Program) × 4 color rows, showing only cards with Main > 0.

All Node-side logic (API fetching, file I/O, image caching, backups) lives
in `src/main.js` and is exposed to both renderers through `src/preload.js`'s
`window.api` (contextIsolation is on, nodeIntegration is off — renderers
have zero direct Node/fs access, everything goes through IPC).

## Data model

**Printings, not cards.** The card API's bulk list endpoint collapses each
unique card to one default printing. This app instead fetches each card's
*detail* endpoint (`/api/cards/cyberpunk/<slug>`) to get its full
`printings` array — one entry per set/art variant (e.g. "V: Streetkid" has 5
printings across Retail/Beta/etc). Everything in this app — the grid, the
collection tracking, the Collection window — operates at the **printing**
level. A printing's `id` is what keys `collection.json`, not the card's own
`cardId`. `main.js`'s `flattenPrintings()` is where this happens.

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
- Deck-legal cap: **Legend = 1**, **Unit/Gear/Program = 3**. Each bucket row
  has a "MAX" button next to `+` (Main and Reserve only, not Extras) that
  directly sets that bucket to the type's cap — it does **not** move copies
  between buckets. There is deliberately no "auto-fill/redistribute" feature
  and no global bulk-mutate button — that was tried and explicitly rejected
  as too risky; don't re-add it without being asked.
- An entry is deleted from `collection.json` once all three buckets hit 0.

## netdeck.gg API (undocumented, reverse-engineered)

Base: `https://api.netdeck.gg/api/cards/cyberpunk`

- `GET ?limit=100&offset=N` — paginated bulk list (100/page max), each item
  missing its `printings` array.
- `GET /<slug>` — full card detail including `printings[]`, each printing
  has `id, collector_number, image_url, set, rarity, finish, artist`.
- `GET /filters` — available filter values (color/type/rarity/set/etc),
  useful if adding new filter UI. There are **15 sets** and **9 rarities**
  in the pool (see `RARITY_ORDER` in `renderer.js` for the full list and the
  intended common→rare visual ordering).
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
- `images/<printingId>.webp` — cached card art.
- `backups/collection-<ISO timestamp>.json` — rotating backups, **max 3**,
  oldest auto-pruned on every save (`collection:backup` IPC). A restore
  (`collection:restoreBackup`) backs up the *current* state first too, so
  restoring is itself undoable.

## IPC surface (`preload.js` → `window.api`)

```
getCards()                          cards:get
refreshCards()                      cards:refresh
getCollection()                     collection:get
setCollection(id, bucket, value)    collection:set     bucket ∈ main|reserve|extras
openCollectionView()                collection-view:open
backupCollection()                  collection:backup
listBackups()                       collection:listBackups
restoreBackup(filename)             collection:restoreBackup
```

## Known CSS gotchas (already solved, don't reintroduce)

- **`overflow-x: auto` + `overflow-y: visible` silently forces vertical
  clipping too** (browsers collapse the pair to auto/auto). This bit the
  Collection window's fan-stack rows. Fixed by *not* trying to raise the
  hovered card in place at all — `collection.js`'s hover handler instead
  spawns a `position: fixed` "ghost" element appended to `<body>` (see
  `showGhost`/`hideGhost`/`.fan-ghost`), which lives outside any clipping
  ancestor. The real card just fades its own `<img>` to `opacity: 0`
  underneath. If you touch the fan/carousel hover effect, keep this pattern.
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
  (`System.Drawing` works for screenshots); a plain `pwsh` (PowerShell
  Core) session would need `Add-Type -AssemblyName System.Drawing` and may
  still lack `System.Drawing.Common` — prefer the PowerShell tool over Bash
  for anything involving screenshots or Win32 interop.
- To visually verify UI changes: launch
  `node_modules\electron\dist\electron.exe .` directly (not `npm start`) if
  you need `Start-Process` with separate stdout/stderr redirection for log
  capture, then screenshot with `System.Drawing` + `CopyFromScreen`
  (windows are fullscreen so `Screen.PrimaryScreen.Bounds` = the window
  rect). Main window controls' approximate screen coordinates shift
  whenever header buttons are added/removed — re-screenshot before
  clicking rather than reusing old coordinates.

## Things explicitly *not* wanted (don't re-add)

- No foil-specific tracking (removed early on — Main/Reserve/Extras
  replaced it entirely).
- No auto-redistribution between buckets, no global "auto-fill all" bulk
  button — user found this too risky/unpredictable. The per-row MAX button
  (direct set, single bucket, type-capped) is the agreed replacement.
- "Has Extras" was removed as a Collection-window filter; only **All /
  Full Set / Partial** remain, where Full Set means `main >= cap` for that
  card's type.
