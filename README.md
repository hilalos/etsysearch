# Etsy Advanced Search Filter

A Chrome extension (Manifest V3) that adds advanced filtering to Etsy
search result pages: a "New on Etsy only" filter, and a public-sales-count
range filter, using only publicly visible page data.

## Features

- Floating filter panel injected on Etsy search / market pages
- **New on Etsy only** checkbox — hides listings that don't show a
  "New on Etsy", "Recently listed", "New listing/shop/seller" badge
- **Minimum public sales** / **Maximum public sales** range filter
  - Level 1 (automatic, free): parsed straight from any sales text already
    visible on the search-result card (English `123 sales` / `1,234 sales`
    / `10k sales` / `2.5k sales`, and French `123 ventes` / `1 234 ventes`)
  - Level 2 (opt-in, on click only): a **Fetch public sales data** button
    that visits the public listing/shop page for cards where no sales
    number was visible on the card itself, and looks for one there
- **Hide listings with unavailable sales** checkbox, so you decide whether
  unresolved listings stay visible (default) or get filtered out
- Live status line showing how many listings are visible after filtering,
  plus a fetch-progress line ("Fetched 6 / 40 visible listings — Sales
  found: 12, Unavailable: 28")
- Automatically re-applies filters as new listings load in via infinite
  scroll, without ever rescanning listings it has already processed
- Settings persist via `chrome.storage.sync`; fetched public sales data is
  cached in `chrome.storage.local` so the same shop/listing is never
  re-fetched on a later visit
- Toolbar popup to enable/disable the extension and jump to Etsy search

## Installation (Chrome developer mode)

1. Download or clone this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked**.
5. Select the project's root folder (the one containing `manifest.json`).
6. The extension icon should appear in your toolbar.

## Usage

1. Go to an Etsy search page, e.g. `https://www.etsy.com/search?q=candles`
   or a market page like `https://www.etsy.com/market/handmade_jewelry`.
2. A floating **Etsy Advanced Filter** panel appears in the top-right
   corner of the page.
3. Optionally check **New on Etsy only**.
4. Optionally enter a **Minimum public sales** and/or **Maximum public
   sales** value, and decide whether to check **Hide listings with
   unavailable sales**.
5. Click **Apply Filters**. Non-matching listings are hidden
   (`display: none`); matching listings stay in place and get a small
   "Matched by Etsy Filter" label showing their sales status.
6. If you want more listings to have sales data, click **Fetch public
   sales data**. This visits the public listing/shop page for currently
   visible listings that don't already show a sales number, one at a time
   with a pause between each (see [Ethical usage](#ethical-usage--rate-limiting)
   below). Click **Stop fetching** to cancel at any point.
7. Click **Reset** to clear all filters and show every listing again.
8. Use the extension's toolbar popup to enable/disable filtering entirely,
   or to open a new Etsy search tab.

Your filter settings are saved automatically and restored the next time
you visit Etsy.

## How sales detection works

Etsy search result cards usually do **not** show a sales count at all -
only the shop name, price, and rating are typically visible there. This
extension never invents or estimates a number; it only surfaces sales
counts that are actually present somewhere in publicly visible Etsy text.

**Level 1 - fast, automatic, local:** every listing card's own text is
scanned once for a sales pattern (`123 sales`, `1,234 sales`, `10k sales`,
`2.5k sales`, and the French equivalents `123 ventes` / `1 234 ventes`).
Shorthand is normalized (`10k` → `10000`, `2.5k` → `2500`, `1,234` → `1234`,
`1 234` → `1234`). If the card itself has no such text, the listing is
marked **"Not fetched yet"** rather than guessed at.

**Level 2 - opt-in, public-page enrichment:** clicking **Fetch public
sales data** fetches the public listing page or shop page (whichever URL
is already visible on the card) for listings still marked "not fetched
yet", and searches the same sales pattern in that page's text. If found,
it is labeled **"Sales: N (public page)"**; a shop-page number is labeled
**"shop total, public page"** since it reflects the shop's total sales,
not necessarily that one listing. If nothing matching is found, the
listing is labeled **"Sales: unavailable"** and is not retried again in
the same browsing session.

Listing "cards" and shop/listing URLs are identified by locating anchor
links that point to `/listing/<id>/...` and `/shop/<name>` and walking up
to the nearest natural container (`<li>` element or a few parent levels
up), rather than relying on Etsy's CSS class names, which can change
without notice.

## Performance improvements

Earlier versions of this extension observed `document.body` with
`subtree: true` and re-scanned and re-detected every listing on every
single DOM mutation - including mutations from unrelated page activity
(ads, lazy-loaded images, recommendation carousels), which made large
Etsy search pages noticeably slow to scroll. The current version fixes
this with:

- **Scoped observation**: instead of `document.body`, the extension finds
  the actual search-results container (the smallest common ancestor of
  all listing cards) and observes only that. A short-lived bootstrap
  observer on `document.body` handles the brief window before Etsy has
  rendered any results yet, then disconnects itself permanently once the
  real container is found.
- **Per-card caching**: each card's detected data (`listingId`, `shopName`,
  `shopUrl`, `isNewOnEtsy`, `salesCount`, `salesSource`, `lastProcessedAt`)
  is stored in a `WeakMap` keyed by the card element. A card is only ever
  scanned once - later mutations elsewhere on the page never re-trigger
  detection on cards already in the cache, and cards that scroll out of
  the DOM are garbage-collected automatically along with their cache entry.
- **Debounced, idle-time processing**: mutation bursts are debounced
  (~200-300ms), and the actual scan/detection work runs inside
  `requestIdleCallback` (falling back to `setTimeout` if unavailable) so it
  never competes with scrolling or rendering. If there's more to process
  than fits in one idle slot, the rest continues in the next idle callback.
- **Batched style writes**: visibility/badge updates for all known cards
  are grouped into a single `requestAnimationFrame` callback per filtering
  pass, instead of writing styles interleaved with reads.
- **Scoped text scans only**: `textContent` is only ever read from a single
  listing card - never from the results container or `document.body` -
  and only leaf-node text under 40 characters is checked for "New on Etsy"
  badges, so detection stays proportional to one card's size, not the
  whole page.
- **Dev-mode performance logging**: when the extension is loaded unpacked
  (as in developer mode - detected via the absence of `update_url` in
  the manifest, which Chrome Web Store installs always have), each
  processing batch logs to the console: `[Etsy Filter][perf] processed
  batch { processed, skippedCached, ms, remaining }`.

## Ethical usage / rate limiting

The optional public-page fetch is designed to be conservative:

- **Never automatic.** It only runs when you click **Fetch public sales
  data**, never on page load or scroll.
- **Only currently visible, currently loaded listings** - never listings
  further down that haven't loaded via infinite scroll yet, and never
  listings already hidden by your own filters.
- **Deduplicated by shop.** Multiple listings from the same shop collapse
  into a single request to that shop's page, instead of one request per
  listing.
- **One request at a time** (configurable up to 2), with a **1.2 second
  pause** between requests - deliberately slow, not a bulk scrape.
- **No retries within a session** - once a shop/listing has been checked
  (found or unavailable), it won't be re-fetched again until you reload
  the page.
- **Persistently cached** in `chrome.storage.local`, so once a shop/listing
  has been checked, it's never fetched again on future visits either.
- **No credentials sent**: fetches use `credentials: 'omit'`, so only
  whatever a logged-out visitor could publicly see is ever read.
- **Stoppable** at any time via the **Stop fetching** button.
- Uses only `fetch()` against normal public Etsy page URLs - no private
  APIs, no paid third-party APIs, no headless browsing, no CAPTCHA
  bypassing.

## Limitations

**Etsy does not always show sales numbers on search pages.** Sales
filtering depends on publicly visible sales data, which may require
fetching each public listing/shop page, and may still be unavailable even
then. In that case:

- The listing is treated as having **unavailable** sales data (or "not
  fetched yet" before you've used the fetch button).
- If you have set a minimum or maximum sales filter, listings with
  unavailable sales data stay visible by default; check **Hide listings
  with unavailable sales** if you'd rather they be hidden.
- The extension **never invents or estimates** a sales number that isn't
  actually present in the page.
- A number found on a shop page reflects that **shop's total sales**, not
  necessarily sales of the specific listing you're looking at - the badge
  and status labels always say which is which.

Additionally:

- The extension only activates on Etsy search (`/search`) and market
  (`/market/...`) pages.
- Etsy's page structure can change at any time; the "New on Etsy" and
  sales detection rely on visible text patterns and may miss badges that
  use wording not covered by the current patterns.
- This extension only reads data already rendered in public page HTML. It
  does not call any private Etsy APIs, does not use any paid APIs, and
  does not perform aggressive or bulk scraping.

## Project structure

```
/manifest.json       Manifest V3 configuration
/src/content.js       Injected on Etsy search pages: panel UI, scoped observation,
                       caching/idle processing, and the public-sales fetch queue
/src/utils.js         Pure parsing/detection helpers (sales text, new badges, debounce,
                       listing/shop URL extraction)
/src/storage.js       chrome.storage.sync (settings) + chrome.storage.local (sales cache)
/src/popup.html       Toolbar popup markup
/src/popup.js         Toolbar popup logic
/src/popup.css        Toolbar popup styling
/src/styles.css       Styles for the injected filter panel and match badges
/icons/               Extension icons (16/48/128px)
```

## Permissions

- `storage`: to persist filter settings (`chrome.storage.sync`) and the
  public-sales cache (`chrome.storage.local`).
- `host_permissions` for `https://www.etsy.com/*`: required so the
  content script can run on Etsy search pages, and so the optional
  public-sales fetch can reach Etsy's own listing/shop pages.

No other permissions are requested. No data is sent anywhere outside your
own browser talking directly to Etsy's public pages.
