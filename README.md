# Etsy Opportunity Finder

A Chrome extension (Manifest V3) for finding new, fast-growing
digital-product Etsy shops, using only public Etsy data. It has two parts:

1. **A live floating filter panel** on Etsy search pages that scans
   listing cards for public shop metadata (shop total sales, shop age,
   rating, reviews, digital-product status) and lets you filter by it.
2. **A research dashboard** (Dashboard / Keyword Hunter / Shop Scanner /
   Winners / Saved tabs) for discovering fresh keyword niches, validating
   them against real Etsy search results, and surfacing "viral new store"
   shops worth studying.

Both parts share the same detection code and the same accumulated **Shop
Directory**, so browsing Etsy normally and running keyword research feed
the same growing dataset.

## Important: what this extension does NOT do

**Etsy does not publicly expose a per-product sales count anywhere.**
Every "N sales" figure this extension ever detects - on a search card, a
listing page, or a shop page - is the **shop's all-time running total**,
never a specific product's. This extension:

- Never calculates or estimates sales for an individual product.
- Never invents a shop total, shop age, rating, review count, or keyword
  result count that isn't literally present in Etsy's own public text.
- Never scrapes private/internal Etsy APIs - only `fetch()` against normal
  public page URLs, always opt-in (a button click), always rate-limited.
- Never scans or fetches automatically - not on page load, not on scroll,
  not on a timer. Every network request in this extension traces back to
  a specific button click.

## Part 1: the live floating filter panel

### Scanned fields

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
rating, not a single listing's).

### Derived metrics

**Sales velocity** (approximate sales per day since the shop opened):

```
salesVelocity = shopTotalSales / shopAgeDays
```

`shopAgeDays` is approximated as `shopAgeMonths * 30` (matching the worked
example: 3 months ≈ 90 days). Example: a shop with `260 sales` and
`3 months on Etsy` → `260 / 90 = 2.88 sales/day`. If either value is
unknown, or the shop is brand new (`0` elapsed days), velocity is shown
as unavailable/"too new to calculate" rather than a fabricated or
divide-by-zero number.

**Opportunity score** (per shop): a heuristic (not an official Etsy
metric) combining sales velocity, rating, reviews count, and
digital-product status:

```
opportunityScore =
    salesVelocity * 10
  + (rating - 3) * 5        // 0 if rating unknown
  + log10(reviewsCount+1)*3 // 0 if reviews unknown
  + (isDigital ? 5 : 0)
```

Only computed when `salesVelocity` itself is available. This formula is
intentionally transparent and adjustable - treat it as a starting point.

### Features

- Kept working across **pagination** (page 1, 2, 3, next/previous, and
  direct `?page=N` URLs), whether Etsy navigates with a full page reload
  or a client-side (SPA-style) transition
- **Maximum Shop Age** filter: All / New on Etsy / 1 / 2 / 3 / 6 months or newer
- **Digital products only** checkbox
- **Minimum rating**, **minimum reviews**, **minimum shop total sales**,
  **minimum sales/day velocity** filters, plus a **Hide listings with
  unavailable data** checkbox
- A compact per-card scanner overlay (shown whenever a filter is active)
- **Debug mode** checkbox for console logging of navigation, processing,
  and filtering events
- Toolbar popup to enable/disable the extension, jump to Etsy search, or
  open the research dashboard

### How detection works

**Level 1 - fast, automatic, local:** each listing card's short
badge-like text snippets are scanned once (a single pass over the card's
leaf text nodes) for shop age, rating, reviews count, and a
digital-product indicator. Separately, the card's full text is scanned
for shop total sales. See [Scanned fields](#scanned-fields) above for the
exact phrases matched.

**Level 2 - opt-in, public-page enrichment:** clicking **Fetch public
data** fetches the shop page (preferred - reusable across every card from
that shop) or the listing page, and searches its text for the same four
shop-level facts, using patterns that require more surrounding context
than the card-level versions (a bare decimal floating in a large page of
text is not a trustworthy rating signal on its own). **Digital-product
detection is intentionally Level-1 only** - re-checking it via fetch would
mean a request for nearly every physical-goods listing (the vast majority
of Etsy), which conflicts with the "don't scrape aggressively" rule.

### Filtering logic

- **Maximum Shop Age**: "All" shows everything; every other bucket
  excludes listings with an unknown age (there's no "show anyway" option
  for shop age, since an unknown age means the extension genuinely can't
  tell which bucket it belongs in).
- **Digital products only**: shows only listings where a digital
  indicator was found on the card.
- **Minimum rating / reviews / shop total sales / sales-per-day
  velocity**: each hides listings below the threshold; an unknown value
  is hidden only if **Hide listings with unavailable data** is checked.

### Pagination and dynamic navigation

Etsy's search results can change page (or the query itself) without a
full browser page reload - typically via `history.pushState`/
`replaceState`. Since a content script only runs once per real page load,
this extension actively watches for that kind of navigation:

- Wraps `history.pushState`/`replaceState` to detect client-side route
  changes instantly.
- Listens for `popstate` (back/forward) and `hashchange`.
- Runs a low-frequency (1s) fallback poll checking the URL and whether the
  previously-detected results container is still in the page.

On any detected change: the `MutationObserver` reconnects to a freshly
re-detected results container, page-specific card tracking resets (but
filter settings and everything already learned about shops are kept), the
panel re-injects only if missing, and the new page's listings are
reprocessed automatically - no need to click Apply again.

### Performance model

- **Scoped observation**: observes only the search-results container
  (the smallest common ancestor of all listing cards), never
  `document.body`, so unrelated page activity (ads, lazy images,
  recommendation carousels) never triggers a rescan.
- **Per-card caching**: each card's detected data is stored in a
  `WeakMap` keyed by the card element - scanned exactly once, ever.
- **Debounced, idle-time processing**: mutation bursts are debounced
  (~200-300ms) and actual detection runs inside `requestIdleCallback`.
- **Batched style writes**: visibility/badge updates for all cards happen
  in one `requestAnimationFrame` per pass.
- **Batched Shop Directory writes**: scanning a batch of cards (e.g. one
  scroll's worth) accumulates observations in memory and flushes them to
  `chrome.storage.local` once (debounced ~1.5s), not once per card -
  scrolling past 60 cards costs a handful of writes, not 60. A flush also
  runs on page navigation and on `pagehide`, so nothing is lost.
- **Derived metrics computed on read, never cached**: sales velocity and
  opportunity score depend on fields a later public-data fetch can
  update, so they're recomputed cheaply each filter pass.

## Part 2: the research dashboard

Open it from the toolbar popup's **Open Research Dashboard** button (it
opens `src/dashboard.html` in a new tab - a full extension page, not a
content script, so it works independently of any open Etsy tab, though it
still needs network access to `www.etsy.com` to run research, which
`host_permissions` already grants to every part of the extension).

### Keyword Hunter tab

**Workflow:** enter a seed keyword (e.g. `fitness`), click **Find
Opportunities**. The extension:

1. Generates candidate keyword phrases: the seed itself, `seed a` through
   `seed z`, and `seed for/with/without/template/planner/tracker/
   challenge/printable` (35 total for a one-word seed).
2. Fetches each candidate's real, public Etsy search page - one at a
   time, with a pause between requests (never automatically; only after
   you click the button, and stoppable at any point via the same button,
   which becomes **Stop**).
3. From that one fetch, extracts everything needed for validation: the
   result count, every listing card's shop-level data (reusing the exact
   same detection code as the floating panel), which shops are "young"
   (under 90 days), their sales velocity, and any "related search" query
   links Etsy renders on that page.
4. Computes a **Niche Opportunity Score** (0-100) for the keyword.
5. Ranks all analyzed keywords and shows the top ones as **Top
   Opportunities**, each with its score and a plain-language reason.

**Why not literally use Etsy's autocomplete API?** Etsy does not publish
a documented public autocomplete endpoint. Rather than integrate against
an undocumented, unverified endpoint that could silently break or drift
out of contract, keyword discovery instead uses Etsy's own public search
behavior as the discovery signal: a candidate phrase is only interesting if
Etsy's real search page for it returns meaningful results, and any
"related search" links Etsy renders on that same results page are
collected as bonus discovered keywords (stored with `source:
"related-search"` in the Keyword Directory, viewable but not
automatically analyzed further - re-run Keyword Hunter with one of them as
a new seed if you want to go deeper). This is slower than a dedicated
autocomplete call would be, but it's 100% public-page-based and never
guesses at a private contract - and it means keyword discovery and
keyword validation happen in the *same* fetch instead of two.

**Keyword Opportunity Score** (0-100), combining:

```
youngShopComponent = min(35, youngShopCount * 5)
velocityComponent  = min(30, avgVelocityOfYoungShops * 3)
digitalComponent   = (digitalDominancePercent / 100) * 20
competitionComponent:
  resultCount <  2,000  -> 15  (low competition)
  resultCount < 15,000  ->  8  (medium)
  resultCount < 60,000  ->  3  (high)
  resultCount >= 60,000 ->  0  (saturated)
  resultCount unknown   ->  7  (neutral)

score = clamp(0, 100, round(sum of the above))
label: >=85 "🔥 HOT NICHE", >=65 "✅ GOOD NICHE",
       >=40 "⚠️ MODERATE", else "❄️ COLD / SATURATED"
```

"Young" means shop age under 90 days. This is a transparent, adjustable
heuristic - not an official Etsy metric - calibrated against the example
of a keyword with 7 young shops, 10 sales/day average velocity, 95%
digital dominance, and medium competition scoring in the low-90s/"HOT".

### Shop Scanner tab

A live view of the entire **Shop Directory** - every shop this extension
has ever scanned, from either the floating panel or a Keyword Hunter run
- sorted by opportunity score. Nothing is fetched from this tab; it only
renders what's already stored. Includes a **Save** button per row and an
**Export Shops CSV** button.

### Winners tab

Automatically filters the Shop Directory for **viral new stores**:

- Shop age **< 90 days**
- Shop total sales **> 100**
- Sales velocity **> 5/day**
- Digital-product share **> 80%** (of the listings from that shop this
  extension has actually observed, not an assumption)

Also shows **Winning patterns**: words that repeat across winning shops'
listing titles (e.g. `"planner" appears in 80% of winning titles`),
computed by counting each word once per title (not per occurrence) so a
title repeating a word doesn't inflate its own share.

### Saved tab

Bookmarks - keywords or shops saved via the **★ Save** button anywhere
else in the dashboard - with a **Remove** button to unsave.

### CSV export

- **Keywords** (`etsy-keyword-opportunities.csv`): keyword, score,
  competition, best shop, sales velocity.
- **Shops** (`etsy-shop-scanner.csv`): shop, url, sales, age, reviews,
  rating, score.

## Ethical usage / rate limiting

Every network request in this extension - from the floating panel's
**Fetch public data** button and from the dashboard's **Find
Opportunities** button - follows the same rules:

- **Never automatic.** Nothing fetches on page load, scroll, or a timer.
  Every request traces back to a button click.
- **Deduplicated.** The floating panel dedupes fetches by shop (multiple
  cards from the same shop collapse into one request). Keyword Hunter
  dedupes by keyword (never re-fetches the same candidate twice) and
  reuses the shared Shop Directory so a shop already fully known from
  earlier browsing isn't re-derived from a fetch.
- **One request at a time** (configurable up to 2), with a **~1.2 second
  pause** between requests - deliberately slow, not a bulk scrape. A
  35-candidate Keyword Hunter run takes roughly a minute, by design.
- **No retries within a session** for the floating panel's fetch queue -
  once a shop has been checked, it won't be re-fetched again until reload.
- **Persistently cached** in `chrome.storage.local` (the Shop Directory
  and Keyword Directory), so a shop or keyword already analyzed is never
  re-fetched again on a future visit or run either.
- **No credentials sent**: fetches use `credentials: 'omit'`, so only
  whatever a logged-out visitor could publicly see is ever read.
- **Stoppable** at any time (**Stop fetching** / **Stop** buttons).
- **No re-fetching for digital-product detection** - stays Level-1
  (card-only) specifically to avoid a request for nearly every listing.
- Uses only `fetch()` against normal public Etsy page URLs - no private
  APIs, no paid third-party APIs, no headless browsing, no CAPTCHA
  bypassing, no per-product sales calculation.

## Data rules

- Every figure comes from Etsy's own public HTML: search result pages,
  listing pages, and shop pages. Nothing is estimated, extrapolated, or
  invented when data isn't visible - it's labeled unavailable instead.
- There is **no per-product sales figure anywhere** in this extension.
  Shop total sales is the only sales concept that exists; sales velocity
  and opportunity/niche scores are derived only from that shop-wide total.
- Keyword discovery never uses a private/internal API - see
  [Keyword Hunter](#keyword-hunter-tab) above for exactly what it uses
  instead of Etsy's undocumented autocomplete.
- A shop is analyzed at most once per unique fact per source - the Shop
  Directory always prefers a value found directly on a card over one from
  a public-page fetch, and a fetch over a confirmed "unavailable", so a
  shop already fully known is never redundantly re-derived.

## Limitations

- Shop total sales, shop age, rating, and reviews count are shown as
  **"not fetched yet"** / **"unavailable"** when Etsy doesn't expose them
  and a public-data fetch hasn't resolved them (or found nothing).
- Sales velocity and opportunity/niche scores are only computable once
  the underlying shop-level facts are known and the shop isn't brand new
  - otherwise they're shown as unavailable, never guessed.
- The opportunity score (per-shop) and niche score (per-keyword) are
  transparent, adjustable heuristics - **not** official Etsy metrics.
- Rating and reviews count are treated as shop-wide figures; if a specific
  listing's actual stats differ meaningfully from its shop's overall
  numbers, this extension won't distinguish that.
- Keyword discovery's "related search" suggestions depend on Etsy
  actually rendering that UI on a given results page; if it doesn't, only
  the deterministic seed + a-z + suffix-list candidates are analyzed.
- The digital-product share used for Winners detection is based only on
  the listings from that shop this extension has actually observed so
  far (via browsing or research runs), not the shop's entire catalog.
- Etsy's page structure can change at any time; all detection relies on
  visible text patterns and may miss badges/phrasing not covered yet.
- The floating panel only activates on Etsy search (`/search`) and market
  (`/market/...`) pages. The dashboard works independently in its own tab.
- This extension only reads data already rendered in public page HTML. It
  does not call any private Etsy APIs, does not use any paid APIs, and
  does not perform aggressive or bulk scraping.

## Installation (Chrome developer mode)

1. Download or clone this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked**.
5. Select the project's root folder (the one containing `manifest.json`).
6. The extension icon should appear in your toolbar.

## Project structure

```
/manifest.json       Manifest V3 configuration
/src/content.js       Floating panel: scoped observation, pagination/navigation
                       detection, caching/idle processing, public-data fetch queue,
                       and batched Shop Directory writes
/src/utils.js         Pure, document-agnostic parsing/detection helpers (shop total
                       sales, shop age, rating, reviews, digital indicator, card
                       discovery, derived metrics) - shared by content.js and research.js
/src/storage.js       chrome.storage.sync (settings) + chrome.storage.local
                       (Shop Directory, Keyword Directory, Saved items)
/src/research.js      Keyword Hunter engine: keyword generation, fetch+analyze
                       pipeline, niche scoring, pattern analysis, Winners detection,
                       CSV export - used only by the dashboard, never automatically
/src/dashboard.html   Research dashboard markup (Dashboard / Keyword Hunter /
/src/dashboard.js     Shop Scanner / Winners / Saved tabs)
/src/dashboard.css
/src/popup.html       Toolbar popup markup
/src/popup.js         Toolbar popup logic (enable/disable, open Etsy, open dashboard)
/src/popup.css
/src/styles.css       Styles for the injected filter panel and scanner overlay
/icons/               Extension icons (16/48/128px)
```

## Permissions

- `storage`: to persist filter settings (`chrome.storage.sync`) and the
  Shop Directory / Keyword Directory / Saved items (`chrome.storage.local`).
- `host_permissions` for `https://www.etsy.com/*`: required so the
  content script and the dashboard page can both fetch Etsy's own public
  search/listing/shop pages.

No other permissions are requested. No data is sent anywhere outside your
own browser talking directly to Etsy's public pages.
