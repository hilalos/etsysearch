# Etsy Advanced Search Filter

A Chrome extension (Manifest V3) that adds advanced filtering to Etsy
search result pages: a **Shop Age Filter** (New on Etsy / 1 month / 2
months or newer) and a public-sales-count range filter, using only
publicly visible page data - and it keeps working across pagination, not
just on the first results page.

## Features

- Floating filter panel injected on Etsy search / market pages, and kept
  working across **pagination** (page 1, 2, 3, next/previous, and direct
  `?page=N` URLs), whether Etsy navigates with a full page reload or a
  client-side (SPA-style) transition
- **Shop Age Filter**: All / New on Etsy / 1 month on Etsy or newer / 2
  months on Etsy or newer
  - Level 1 (automatic, free): parsed from any age text already visible on
    the search-result card (`New on Etsy`, `1 month on Etsy`, `2 months on
    Etsy`, `Etsy seller for 1 month`, `On Etsy since <date>`, etc.)
  - Level 2 (opt-in, on click only): the same **Fetch public data** button
    used for sales also looks for shop-age text on the fetched page
- **Minimum public sales** / **Maximum public sales** range filter
  - Level 1 (automatic, free): parsed straight from any sales text already
    visible on the search-result card (English `123 sales` / `1,234 sales`
    / `10k sales` / `2.5k sales`, and French `123 ventes` / `1 234 ventes`)
  - Level 2 (opt-in, on click only): a **Fetch public data** button that
    visits the public listing/shop page for cards where no sales number
    was visible on the card itself, and looks for one there
- **Hide listings with unavailable sales** checkbox, so you decide whether
  unresolved listings stay visible (default) or get filtered out. (Shop-age
  buckets other than "All" always exclude unknown ages by definition - see
  [Filtering logic](#how-shop-age-and-sales-filtering-works) below.)
- Live status line showing how many listings are visible after filtering,
  plus a fetch-progress line ("Fetched 6 / 40 visible listings — Sales
  found: 12, Unavailable: 28")
- Automatically re-applies filters as new listings load in via infinite
  scroll or pagination, without ever rescanning listings it has already
  processed
- **Debug mode** checkbox for console logging of navigation, processing,
  and filtering events (see [Debug mode](#debug-mode) below)
- Settings persist via `chrome.storage.sync`; fetched public data (sales +
  shop age) is cached in `chrome.storage.local` so the same shop/listing is
  never re-fetched, even across pagination or a later visit
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
3. Optionally pick a **Shop Age Filter** bucket, and/or enter a **Minimum
   public sales** / **Maximum public sales** value, and decide whether to
   check **Hide listings with unavailable sales**.
4. Click **Apply Filters**. Non-matching listings are hidden
   (`display: none`); matching listings stay in place and get a small
   "Matched by Etsy Filter" label showing their shop-age/sales status.
5. If you want more listings to have data, click **Fetch public data**.
   This visits the public listing/shop page for currently visible listings
   still missing sales and/or shop-age data, one at a time with a pause
   between each (see [Ethical usage](#ethical-usage--rate-limiting)
   below). Click **Stop fetching** to cancel at any point.
6. Click **Reset** to clear all filters and show every listing again.
7. Go to page 2, page 3, or click next/previous - the panel and your
   filters stay in place and reapply automatically to the new page's
   listings.
8. Use the extension's toolbar popup to enable/disable filtering entirely,
   or to open a new Etsy search tab.

Your filter settings are saved automatically and restored the next time
you visit Etsy.

## Pagination and dynamic navigation

Etsy's search results can change page (or the query itself) without a full
browser page reload - typically via `history.pushState`/`replaceState`.
Since a content script only runs once per real page load, this extension
actively watches for that kind of navigation instead of assuming it will
be re-injected:

- Wraps `history.pushState` and `history.replaceState` to detect
  client-side route changes the instant they happen.
- Listens for `popstate` (back/forward) and `hashchange`.
- Runs a low-frequency (1s) fallback poll that checks both the URL and
  whether the previously-detected results container is still in the page,
  in case some other navigation mechanism slips past the hooks above.

On any detected change, the extension:

1. Disconnects the old `MutationObserver` and re-detects the search-results
   container from scratch (Etsy may have replaced it wholesale).
2. Clears its page-specific listing-card tracking (so old, now-removed
   cards are dropped) - but **keeps** your filter settings and the
   shop/listing data already learned from public fetches, since those
   remain valid on a new page of the same search.
3. Re-injects the filter panel only if it's missing (never a duplicate).
4. Reprocesses and re-filters the new page's listings automatically -
   there's no need to click **Apply Filters** again.

## How shop-age and sales filtering works

Etsy search result cards usually do **not** show a shop's age or a sales
count at all - typically only the shop name, price, and rating are
visible there. This extension never invents or estimates either value; it
only surfaces data that is actually present somewhere in publicly visible
Etsy text.

### Shop age

**Level 1 - fast, automatic, local:** each listing card's short badge-like
text snippets are scanned for phrases like `New on Etsy`, `Recently
listed`, `1 month on Etsy`, `2 months on Etsy`, `Etsy seller for 1 month`,
or `On Etsy since <date>` (in which case the age is computed in months
from today's date). This normalizes to a whole number of months
(`New on Etsy` = 0), or stays unknown ("Public page fetch required") if no
such text is found on the card.

**Level 2 - opt-in, public-page enrichment:** clicking **Fetch public
data** looks for the same phrases on the fetched public listing/shop page.

**Filtering logic:**

- **All**: shows every listing regardless of age.
- **New on Etsy**: shows only listings with a known age of exactly 0 months.
- **1 month on Etsy or newer**: shows listings with a known age `<= 1` month.
- **2 months on Etsy or newer**: shows listings with a known age `<= 2` months.

Listings with an unknown age are always excluded once you pick anything
other than "All" - there is no "show unavailable anyway" option for shop
age, since a shop's age being unknown means the extension genuinely cannot
tell whether it belongs in that bucket.

### Sales

**Level 1 - fast, automatic, local:** every listing card's own text is
scanned once for a sales pattern (`123 sales`, `1,234 sales`, `10k sales`,
`2.5k sales`, and the French equivalents `123 ventes` / `1 234 ventes`).
Shorthand is normalized (`10k` → `10000`, `2.5k` → `2500`, `1,234` → `1234`,
`1 234` → `1234`). If the card itself has no such text, the listing is
marked **"Sales: not fetched yet"**.

**Level 2 - opt-in, public-page enrichment:** the same **Fetch public
data** click that looks for shop age also searches the fetched page for a
sales pattern. If found, it's labeled **"Sales: N (public page)"**; a
shop-page number is labeled **"shop total, public page"** since it
reflects the shop's total sales, not necessarily that one listing. If
nothing matching is found, the listing is labeled **"Sales: unavailable"**
and is not retried again in the same browsing session.

Unlike shop age, sales has an explicit **Hide listings with unavailable
sales** checkbox: unresolved listings stay visible by default when a sales
range is set, and only get hidden if you turn that on.

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
Etsy search pages noticeably slow to scroll, and broke down entirely once
the user changed pages. The current version fixes this with:

- **Scoped observation**: instead of `document.body`, the extension finds
  the actual search-results container (the smallest common ancestor of
  all listing cards) and observes only that. A short-lived bootstrap
  observer on `document.body` handles the brief window before Etsy has
  rendered any results yet, then disconnects itself once the real
  container is found - and reconnects automatically to a fresh container
  whenever pagination replaces it (see
  [Pagination and dynamic navigation](#pagination-and-dynamic-navigation)).
- **Per-card caching**: each card's detected data (`listingId`, `shopName`,
  `shopUrl`, `shopAgeMonths`, `shopAgeSource`, `salesCount`,
  `salesSource`, `lastProcessedAt`) is stored in a `WeakMap` keyed by the
  card element. A card is only ever scanned once - later mutations
  elsewhere on the page never re-trigger detection on cards already in the
  cache, and cards that scroll (or page) out of the DOM are
  garbage-collected automatically along with their cache entry.
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
  and only leaf-node text under 40 characters is checked for shop-age
  badges, so detection stays proportional to one card's size, not the
  whole page.
- **Cheap navigation detection**: the pushState/replaceState hooks and
  popstate/hashchange listeners are near-instant and add no polling
  overhead; the fallback safety-net poll only compares a URL string and
  checks one element's DOM membership once per second.

## Debug mode

Check **Debug mode (console logs)** in the panel to log, under the
`[Etsy Filter][debug]` prefix in the DevTools console:

- Navigation detection events (current URL, detected page number)
- Observer reconnect events (when the results container changes and the
  `MutationObserver` is reattached)
- Each processing batch (listings processed, skipped because already
  cached, time spent, listings remaining)
- Each filter pass (listings detected vs. currently visible)

Debug logging is also always on automatically when the extension is
loaded unpacked (developer mode), regardless of the checkbox, so you don't
need to remember to enable it while developing.

## Ethical usage / rate limiting

The optional public-page fetch is designed to be conservative:

- **Never automatic.** It only runs when you click **Fetch public data**,
  never on page load, scroll, or pagination.
- **Only currently visible, currently loaded listings** - never listings
  further down that haven't loaded via infinite scroll yet, and never
  listings already hidden by your own filters.
- **Deduplicated by shop.** Multiple listings from the same shop collapse
  into a single request to that shop's page, instead of one request per
  listing - and that one request resolves both sales and shop age at once.
- **One request at a time** (configurable up to 2), with a **1.2 second
  pause** between requests - deliberately slow, not a bulk scrape.
- **No retries within a session** - once a shop/listing has been checked
  (found or unavailable), it won't be re-fetched again until you reload
  the page.
- **Persistently cached** in `chrome.storage.local`, so once a shop/listing
  has been checked, it's never fetched again on future visits, pages, or
  searches either.
- **No credentials sent**: fetches use `credentials: 'omit'`, so only
  whatever a logged-out visitor could publicly see is ever read.
- **Stoppable** at any time via the **Stop fetching** button.
- Uses only `fetch()` against normal public Etsy page URLs - no private
  APIs, no paid third-party APIs, no headless browsing, no CAPTCHA
  bypassing.

## Limitations

**Etsy does not always show sales numbers or shop age on search pages.**
Both depend on publicly visible text, which may require fetching each
public listing/shop page, and may still be unavailable even then. In that
case:

- Shop age is shown as **"Public page fetch required"** until fetched, or
  **"Shop age unavailable"** if fetching found nothing. Picking any Shop
  Age Filter bucket other than "All" excludes these automatically.
- Sales is shown as **"not fetched yet"** or **"unavailable"**; whether
  unresolved listings stay visible when a sales range is set is controlled
  by the separate **Hide listings with unavailable sales** checkbox.
- The extension **never invents or estimates** a sales number or shop age
  that isn't actually present in the page.
- A sales number found on a shop page reflects that **shop's total
  sales**, not necessarily sales of the specific listing you're looking
  at - the badge and status labels always say which is which.

Additionally:

- The extension only activates on Etsy search (`/search`) and market
  (`/market/...`) pages.
- Etsy's page structure can change at any time; shop-age and sales
  detection rely on visible text patterns and may miss badges that use
  wording not covered by the current patterns.
- The navigation-detection hooks (pushState/replaceState wrapping) are
  defensive/best-effort; if they somehow miss a particular navigation, the
  1-second fallback poll still catches it shortly after.
- This extension only reads data already rendered in public page HTML. It
  does not call any private Etsy APIs, does not use any paid APIs, and
  does not perform aggressive or bulk scraping.

## Project structure

```
/manifest.json       Manifest V3 configuration
/src/content.js       Injected on Etsy search pages: panel UI, scoped observation,
                       pagination/navigation detection, caching/idle processing,
                       and the public-data (sales + shop age) fetch queue
/src/utils.js         Pure parsing/detection helpers (sales text, shop-age text,
                       debounce, listing/shop URL extraction)
/src/storage.js       chrome.storage.sync (settings) + chrome.storage.local (public data cache)
/src/popup.html       Toolbar popup markup
/src/popup.js         Toolbar popup logic
/src/popup.css        Toolbar popup styling
/src/styles.css       Styles for the injected filter panel and match badges
/icons/               Extension icons (16/48/128px)
```

## Permissions

- `storage`: to persist filter settings (`chrome.storage.sync`) and the
  public-data cache (`chrome.storage.local`).
- `host_permissions` for `https://www.etsy.com/*`: required so the
  content script can run on Etsy search pages, and so the optional
  public-data fetch can reach Etsy's own listing/shop pages.

No other permissions are requested. No data is sent anywhere outside your
own browser talking directly to Etsy's public pages.
