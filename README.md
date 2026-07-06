# Etsy Advanced Search Filter

A Chrome extension (Manifest V3) that scans Etsy search result pages for
public shop/listing metadata - shop total sales, shop age, rating, reviews,
and digital-product status - and lets you filter listings by it, plus a
derived **sales velocity** and **opportunity score**. It uses only
publicly visible page data, keeps working across pagination, and never
calculates or invents a per-product sales figure (Etsy doesn't expose one).

## Important: what this extension does NOT do

**Etsy does not publicly expose a per-product sales count anywhere.**
Every "N sales" figure this extension ever detects - on a search card, a
listing page, or a shop page - is the **shop's all-time running total**,
never a specific product's. This extension:

- Never calculates or estimates sales for an individual product.
- Never invents a shop total, shop age, rating, or review count that isn't
  literally present in Etsy's own public text.
- Never scrapes private/internal Etsy APIs - only `fetch()` against normal
  public page URLs, opt-in, rate-limited (see below).

## Scanned fields

For each listing card, the scanner extracts (when visible):

| Field | Example | Scope |
|---|---|---|
| Listing title | "Handmade Ceramic Mug" | per listing |
| Listing URL | `/listing/12345/...` | per listing |
| Shop name | "CoolCeramicsShop" | per shop |
| Shop URL | `/shop/CoolCeramicsShop` | per shop |
| Rating | `4.8` | shop-wide |
| Reviews count | `(31)` | shop-wide |
| Shop total sales | `260 sales` | shop-wide |
| Shop age | `3 months on Etsy` / `New on Etsy` | shop-wide |
| Digital product | Yes/No | per listing |

Rating and reviews count are treated as shop-wide stats (matching how
Etsy's own star-rating badge on a search card reflects the shop's overall
rating, not a single listing's) - so, like shop total sales and shop age,
they're cached and reused across every card from the same shop.

## Derived metrics

**Sales velocity** (approximate sales per day since the shop opened):

```
salesVelocity = shopTotalSales / shopAgeDays
```

`shopAgeDays` is approximated as `shopAgeMonths * 30` (matching the worked
example: 3 months ≈ 90 days). Example: a shop with `260 sales` and
`3 months on Etsy` → `260 / 90 = 2.88 sales/day`. If either shopTotalSales
or shopAgeDays is unknown, or the shop is brand new (`0` elapsed days,
i.e. "New on Etsy"), velocity is shown as unavailable/"too new to
calculate" rather than a fabricated or divide-by-zero number.

**Opportunity score**: a heuristic (not an official Etsy metric) combining
sales velocity, rating, reviews count, and digital-product status, meant
to surface shops that are relatively young but already showing traction:

```
opportunityScore =
    salesVelocity * 10
  + (rating - 3) * 5        // 0 if rating unknown
  + log10(reviewsCount+1)*3 // 0 if reviews unknown
  + (isDigital ? 5 : 0)
```

Only computed when `salesVelocity` itself is available (rating/reviews/
digital are optional modifiers that default to a neutral 0 contribution
when unknown). This formula is intentionally transparent and adjustable -
treat it as a starting point, not a definitive ranking.

## Features

- Floating filter panel injected on Etsy search / market pages, kept
  working across **pagination** (page 1, 2, 3, next/previous, and direct
  `?page=N` URLs), whether Etsy navigates with a full page reload or a
  client-side (SPA-style) transition
- **Maximum Shop Age** filter: All / New on Etsy / 1 / 2 / 3 / 6 months or newer
- **Digital products only** checkbox
- **Minimum rating**, **minimum reviews**, **minimum shop total sales**,
  **minimum sales/day velocity** filters
- **Hide listings with unavailable data** checkbox for the four minimum
  filters above (shop age always excludes unknowns once a bucket other
  than "All" is picked - see [Filtering logic](#filtering-logic))
- A compact per-card **scanner overlay** (shown whenever any filter above
  is active) displaying shop name, product title, rating/reviews, shop
  total sales, shop age, sales/day velocity, digital status, and
  opportunity score
- Live status line showing how many listings are visible after filtering,
  plus a fetch-progress line ("Fetched 6 / 40 visible listings — Data
  found: 12, Unavailable: 28")
- Automatically re-applies filters as new listings load in via infinite
  scroll or pagination, without ever rescanning listings already processed
- **Debug mode** checkbox for console logging of navigation, processing,
  and filtering events
- Settings persist via `chrome.storage.sync`; fetched public data (shop
  total sales, shop age, rating, reviews) is cached in
  `chrome.storage.local` so the same shop is never re-fetched, even across
  pagination or a later visit
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
3. Pick a **Maximum Shop Age** bucket, and/or set **Digital products
   only**, **Minimum rating**, **Minimum reviews**, **Minimum shop total
   sales**, and/or **Minimum sales/day velocity**. Decide whether to check
   **Hide listings with unavailable data**.
4. Click **Apply Filters**. Non-matching listings are hidden
   (`display: none`); matching listings stay in place and get a compact
   scanner overlay with all of the fields above.
5. If you want more listings to have complete data, click **Fetch public
   data**. This visits the public shop (or listing) page for currently
   visible listings still missing shop-level data, one at a time with a
   pause between each (see [Ethical usage](#ethical-usage--rate-limiting)
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

## How detection works

Etsy search result cards usually do **not** show a shop's total sales,
age, rating, or review count in full - visibility varies by card and
listing. This extension never invents or estimates any of these; it only
surfaces data that is actually present somewhere in publicly visible Etsy
text.

**Level 1 - fast, automatic, local:** each listing card's short badge-like
text snippets are scanned once (a single pass over the card's leaf text
nodes) for:

- Shop age: `New on Etsy`, `Recently listed`, `1 month on Etsy`,
  `2 months on Etsy`, `Etsy seller for 1 month`, `On Etsy since <date>`
  (age computed in months from today's date)
- Rating: a short leaf that is itself just a number 1-5 (with or without
  "out of 5 stars"/"stars"), e.g. `4.8`
- Reviews count: `(31)`, `31 reviews`, `(1,234 reviews)`
- Digital product: `Digital Download`, `Instant Download`, `Digital File`,
  `Printable`, etc.

Separately, the card's full text is scanned for shop total sales
(`123 sales`, `1,234 sales`, `10k sales`, `2.5k sales`, and the French
equivalents `123 ventes` / `1 234 ventes`), normalizing shorthand
(`10k` → `10000`, `2.5k` → `2500`).

**Level 2 - opt-in, public-page enrichment:** clicking **Fetch public
data** fetches the shop page (preferred, since it's reusable across every
card from that shop) or the listing page, and searches its text for the
same four shop-level facts (shop total sales, shop age, rating, reviews
count) using patterns that require more context than the card-level
versions (e.g. rating requires "out of 5"/"stars" nearby, since a bare
decimal in a full page of text is not a trustworthy signal on its own).
**Digital-product detection is intentionally Level-1 only** - it is not
re-checked via fetch, because doing so would mean a request for nearly
every physical-goods listing (the vast majority of Etsy), which conflicts
with the "don't scrape aggressively" requirement. If a card's own text
doesn't show a digital indicator, it's treated as not-digital.

Listing "cards" and shop/listing URLs are identified by locating anchor
links that point to `/listing/<id>/...` and `/shop/<name>` and walking up
to the nearest natural container (`<li>` element or a few parent levels
up), rather than relying on Etsy's CSS class names, which can change
without notice.

## Filtering logic

- **Maximum Shop Age**:
  - **All**: shows every listing regardless of age.
  - **New on Etsy**: shows only listings with a known age of exactly 0 months.
  - **1/2/3/6 months or newer**: shows listings with a known age `<=` that
    many months.
  - Listings with an unknown age are always excluded once you pick
    anything other than "All" - there's no "show unavailable anyway"
    option for shop age, since an unknown age means the extension
    genuinely cannot tell whether it belongs in that bucket.
- **Digital products only**: shows only listings where a digital indicator
  was found on the card.
- **Minimum rating / minimum reviews / minimum shop total sales / minimum
  sales/day velocity**: each hides listings below the threshold. When the
  underlying value is unknown, the listing is hidden only if **Hide
  listings with unavailable data** is checked; otherwise it stays visible
  (labeled as unavailable) so you're not silently losing listings the
  extension simply hasn't resolved yet.

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
  whenever pagination replaces it.
- **Per-card caching**: each card's detected data (listing title/URL, shop
  name/URL, shop age, shop total sales, rating, reviews, digital status,
  `lastProcessedAt`) is stored in a `WeakMap` keyed by the card element. A
  card is only ever scanned once - later mutations elsewhere on the page
  never re-trigger detection on cards already in the cache, and cards that
  scroll (or page) out of the DOM are garbage-collected automatically
  along with their cache entry.
- **Debounced, idle-time processing**: mutation bursts are debounced
  (~200-300ms), and the actual scan/detection work runs inside
  `requestIdleCallback` (falling back to `setTimeout` if unavailable) so it
  never competes with scrolling or rendering. If there's more to process
  than fits in one idle slot, the rest continues in the next idle callback.
- **Batched style writes**: visibility/badge updates for all known cards
  are grouped into a single `requestAnimationFrame` callback per filtering
  pass, instead of writing styles interleaved with reads.
- **Scoped text scans only**: leaf-node text (under 40 characters) is
  scanned per-card in a single tree walk for shop age, rating, reviews,
  and digital status together; the whole-card text is scanned separately
  (and only once) for shop total sales. Neither ever touches the results
  container or `document.body`.
- **Cheap navigation detection**: the pushState/replaceState hooks and
  popstate/hashchange listeners are near-instant and add no polling
  overhead; the fallback safety-net poll only compares a URL string and
  checks one element's DOM membership once per second.
- **Derived metrics computed on read, not cached**: sales velocity and
  opportunity score depend on fields that can change after a public-data
  fetch resolves, so they're recomputed cheaply each filter pass instead
  of risking a stale cached value.

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
  listing - and that one request resolves shop total sales, shop age,
  rating, and reviews all at once.
- **One request at a time** (configurable up to 2), with a **1.2 second
  pause** between requests - deliberately slow, not a bulk scrape.
- **No retries within a session** - once a shop/listing has been checked
  (found or unavailable), it won't be re-fetched again until you reload
  the page.
- **Persistently cached** in `chrome.storage.local`, so once a shop has
  been checked, it's never fetched again on future visits, pages, or
  searches either.
- **No credentials sent**: fetches use `credentials: 'omit'`, so only
  whatever a logged-out visitor could publicly see is ever read.
- **Stoppable** at any time via the **Stop fetching** button.
- **No re-fetching for digital-product detection** - that stays Level-1
  (card-only) specifically to avoid a request for nearly every listing.
- Uses only `fetch()` against normal public Etsy page URLs - no private
  APIs, no paid third-party APIs, no headless browsing, no CAPTCHA
  bypassing.

## Limitations

- Shop total sales, shop age, rating, and reviews count are shown as
  **"not fetched yet"** / **"unavailable"** when Etsy doesn't expose them
  on the card and a public-data fetch hasn't resolved them (or found
  nothing). The extension **never invents or estimates** any of these.
- Sales velocity and opportunity score are only computable once shop total
  sales and shop age are both known and the shop isn't brand new (0
  elapsed days) - otherwise they're shown as unavailable/"too new to
  calculate", never a divide-by-zero or guessed number.
- **There is no per-product sales figure anywhere in this extension.**
  Etsy does not expose one publicly, and no formula here attempts to
  derive or approximate one from a shop's total.
- The opportunity score is a transparent heuristic combining sales
  velocity, rating, reviews, and digital status - it is **not** an
  official Etsy metric, and its weights are a starting point you may want
  to adjust for your own use case.
- Rating and reviews count are treated as shop-wide figures. If a specific
  listing has meaningfully different stats from its shop's overall
  numbers, this extension won't distinguish that.
- The extension only activates on Etsy search (`/search`) and market
  (`/market/...`) pages.
- Etsy's page structure can change at any time; all detection relies on
  visible text patterns and may miss badges that use wording not covered
  by the current patterns.
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
                       derived-metrics computation, and the public-data fetch queue
/src/utils.js         Pure parsing/detection helpers (shop total sales, shop age,
                       rating, reviews, digital indicator, debounce, URL extraction)
/src/storage.js       chrome.storage.sync (settings) + chrome.storage.local (public data cache)
/src/popup.html       Toolbar popup markup
/src/popup.js         Toolbar popup logic
/src/popup.css        Toolbar popup styling
/src/styles.css       Styles for the injected filter panel and scanner overlay
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
