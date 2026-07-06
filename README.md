# Etsy Advanced Search Filter

A Chrome extension (Manifest V3) that adds advanced filtering to Etsy
search result pages: a "New on Etsy only" filter, and a sales-count
range filter, using only publicly visible page data.

## Features

- Floating filter panel injected on Etsy search / market pages
- **New on Etsy only** checkbox — hides listings that don't show a
  "New on Etsy", "Recently listed", "New listing/shop/seller" badge
- **Minimum sales** / **Maximum sales** range filter, parsed from any
  visible sales text on the listing card (e.g. `123 sales`,
  `1,234 sales`, `10k sales`, `2.5k sales`)
- Live status line showing how many listings are visible after filtering
- Automatically re-applies filters as new listings load in via infinite
  scroll (MutationObserver + debouncing, so it doesn't slow down the page)
- Settings persist across sessions via `chrome.storage.sync`
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
4. Optionally enter a **Minimum sales** and/or **Maximum sales** value.
5. Click **Apply Filters**. Non-matching listings are hidden
   (`display: none`); matching listings stay in place and get a small
   "Matched by Etsy Filter" label with their detected sales count.
6. Click **Reset** to clear all filters and show every listing again.
7. Use the extension's toolbar popup to enable/disable filtering entirely,
   or to open a new Etsy search tab.

Your filter settings are saved automatically and restored the next time
you visit Etsy.

## How detection works

- **New on Etsy**: the extension scans short text snippets inside each
  listing card for phrases like "New on Etsy", "Recently listed", "New
  listing", "New shop", "New seller", or a standalone "New" badge.
- **Sales count**: the extension scans each listing card's visible text
  for a number immediately followed by the word "sales", and normalizes
  shorthand suffixes (`10k` → `10000`, `2.5k` → `2500`, `1,234` → `1234`).
- Listing "cards" are identified by locating anchor links that point to
  `/listing/<id>/...` and walking up to the nearest natural container
  (`<li>` element or a few parent levels up), rather than relying on
  Etsy's CSS class names, which can change without notice.

## Limitations

**Etsy does not always expose exact sales numbers on search result
pages.** Sales filtering depends on publicly visible sales data. If Etsy
does not display sales numbers on the search page, the extension cannot
calculate them accurately. In that case:

- The listing is treated as having **unavailable** sales data.
- If you have set a minimum or maximum sales filter, listings with
  unavailable sales data are hidden (since it's not possible to confirm
  they fall inside your requested range).
- If no sales range filter is set, listings with unavailable sales data
  are shown normally, just without a sales count label.
- The extension **never invents or estimates** a sales number that isn't
  actually present in the page.

Additionally:

- The extension only activates on Etsy search (`/search`) and market
  (`/market/...`) pages.
- Etsy's page structure can change at any time; the "New on Etsy" and
  sales detection rely on visible text patterns and may miss badges that
  use wording not covered by the current patterns.
- This extension only reads data already rendered in the page's HTML. It
  does not call any private Etsy APIs and does not perform any
  aggressive scraping.

## Project structure

```
/manifest.json       Manifest V3 configuration
/src/content.js       Injected on Etsy search pages: panel UI + filtering logic
/src/utils.js         Pure parsing/detection helpers (sales text, new badges, debounce)
/src/storage.js       chrome.storage.sync wrapper shared by content script and popup
/src/popup.html       Toolbar popup markup
/src/popup.js         Toolbar popup logic
/src/popup.css        Toolbar popup styling
/src/styles.css       Styles for the injected filter panel and match badges
/icons/               Extension icons (16/48/128px)
```

## Permissions

- `storage`: to persist filter settings via `chrome.storage.sync`.
- `host_permissions` for `https://www.etsy.com/*`: required so the
  content script can run on Etsy search pages.

No other permissions are requested, and no data ever leaves your browser.
