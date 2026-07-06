/**
 * content.js
 * Injected on Etsy search / market pages. Renders a floating filter panel
 * that scans listing cards for public shop/listing metadata and hides
 * cards that don't match the user's filters.
 *
 * Important data-model note: Etsy does not expose a per-product sales
 * count anywhere public. Every "N sales" figure we ever detect - on a
 * search card, a listing page, or a shop page - is the SHOP's all-time
 * running total, never that one product's. This file never calculates,
 * infers, or invents a per-product sales number; "shopTotalSales" is the
 * only sales concept anywhere in this codebase.
 *
 * Performance model (see README for the full write-up):
 *   - We observe only the search-results container (not document.body), and
 *     only for childList/subtree so unrelated page activity (ads, lazy
 *     images, recommendation carousels) never triggers our callback.
 *   - Every card is processed at most once: results are cached in a WeakMap
 *     keyed by the card element, so re-renders/mutations elsewhere on the
 *     page never re-run detection on cards we've already looked at.
 *   - Mutation bursts are debounced, and the actual DOM scan/processing runs
 *     inside requestIdleCallback so it never competes with scrolling/painting.
 *   - Style/visibility writes are batched into a single requestAnimationFrame
 *     per pass instead of being interleaved with reads.
 *
 * Navigation model (see README): Etsy's pagination/search can change the URL
 * and swap the results container without a full page reload. We detect that
 * via wrapped history.pushState/replaceState, popstate/hashchange listeners,
 * and a low-frequency polling fallback, then re-detect the results
 * container, reconnect the observer, and reprocess the new page's listings -
 * without losing the user's filter settings or the shop/listing data cache.
 *
 * Depends on window.EtsyFilterUtils (utils.js) and window.EtsyFilterStorage
 * (storage.js), both loaded before this file per manifest.json ordering.
 */
(function () {
  "use strict";

  const {
    debounce,
    parseShopTotalSales,
    parseShopAgeMonths,
    parseRatingFromPageText,
    parseReviewsCountFromPageText,
    resolveCardFromAnchor,
    extractCardMetadata,
    computeDerivedMetrics,
  } = window.EtsyFilterUtils || {};
  const {
    getSettings,
    saveSettings,
    onSettingsChanged,
    getShopDirectory,
    upsertShopDirectoryEntries,
    DEFAULT_SETTINGS,
  } = window.EtsyFilterStorage || {};

  if (!debounce || !getSettings) {
    // Dependencies failed to load; nothing we can safely do.
    return;
  }

  const PANEL_ID = "etsy-filter-panel";
  const BADGE_CLASS = "etsy-filter-badge";
  const LIMITATION_NOTE =
    "Etsy does not always show shop total sales, shop age, rating, or reviews on search pages. This data may require fetching each public listing/shop page, and may still be unavailable. Nothing here is ever invented, estimated, or calculated per-product - Etsy has no public per-product sales figure.";

  const FETCH_CONCURRENCY = 1; // polite default; see README for rationale
  const FETCH_DELAY_MS = 1200; // delay between requests, within the 800-1500ms range
  const NAV_POLL_MS = 1000; // safety-net URL/container-health poll
  const DIRECTORY_FLUSH_DEBOUNCE_MS = 1500; // batch shop-directory writes, not one per card

  // Unpacked/dev-loaded extensions have no "update_url" in their manifest;
  // Chrome Web Store installs do. Debug logging is also always-on in that
  // case, on top of the explicit "Debug mode" panel checkbox.
  const isDevMode = (() => {
    try {
      return !("update_url" in chrome.runtime.getManifest());
    } catch (err) {
      return false;
    }
  })();

  function logDebug(label, data) {
    if (!isDevMode && !currentSettings.debugMode) return;
    // eslint-disable-next-line no-console
    console.log(`[Etsy Filter][debug] ${label}`, data);
  }

  let currentSettings = { ...DEFAULT_SETTINGS };
  // Mirrors chrome.storage.local's Shop Directory, key (shopUrl or listingUrl)
  // -> shop-level facts: { shopTotalSales, shopTotalSalesSource, shopAgeMonths,
  // shopAgeSource, rating, ratingSource, reviewsCount, reviewsSource, ... }
  let inMemoryShopDirectory = {};
  const attemptedFetchKeys = new Set(); // "do not retry repeatedly in the same session"

  // card element -> {
  //   listingId, listingUrl, listingTitle, shopName, shopUrl,
  //   shopAgeMonths, shopAgeSource,
  //   shopTotalSales, shopTotalSalesSource,
  //   rating, ratingSource, reviewsCount, reviewsSource,
  //   isDigital, lastProcessedAt,
  // }
  const cardCache = new WeakMap();
  const knownCards = new Set(); // iterable companion to the WeakMap (WeakMaps aren't iterable)
  const pendingCards = new Set(); // discovered but not yet processed

  let resultsContainer = null;
  let containerObserver = null;
  let bootstrapObserver = null;
  let styleUpdateScheduled = false;
  let lastKnownUrl = location.href;

  const fetchState = {
    running: false,
    abortController: null,
    total: 0,
    fetched: 0,
    found: 0,
    unavailable: 0,
  };

  function isSearchPage() {
    const path = location.pathname || "";
    return path.includes("/search") || path.includes("/market/");
  }

  function getPageNumberFromUrl() {
    try {
      const params = new URLSearchParams(location.search);
      const page = parseInt(params.get("page"), 10);
      return Number.isFinite(page) && page > 0 ? page : 1;
    } catch (err) {
      return 1;
    }
  }

  // ---------------------------------------------------------------------
  // Card discovery (scoped, never touches the whole document per pass)
  // resolveCardFromAnchor/extractCardMetadata/computeDerivedMetrics live in
  // utils.js now, shared with research.js's fetched-page analysis.
  // ---------------------------------------------------------------------

  /**
   * Locates the smallest common ancestor of every currently-visible listing
   * card. That element - the actual results grid/list wrapper - is what we
   * scope MutationObserver and querySelectorAll to, instead of
   * document.body. On a typical search page this excludes the header, nav,
   * footer, and recommendation carousels entirely.
   */
  function findResultsContainer() {
    const anchors = document.querySelectorAll('a[href*="/listing/"]');
    if (anchors.length === 0) return null;

    const cards = new Set();
    anchors.forEach((anchor) => {
      const card = resolveCardFromAnchor(anchor);
      if (card) cards.add(card);
    });
    const cardArray = Array.from(cards);
    if (cardArray.length === 0) return null;

    let ancestor = cardArray[0].parentElement;
    while (ancestor && !cardArray.every((card) => ancestor.contains(card))) {
      ancestor = ancestor.parentElement;
    }
    return ancestor || document.body;
  }

  /**
   * Scans only the results container (not the whole document) for listing
   * anchors, and queues any card we haven't seen before. Cards already in
   * `knownCards` are skipped immediately - this is what keeps repeated
   * mutations (e.g. one new page of infinite-scroll results) cheap.
   */
  function discoverNewCards(container) {
    const anchors = container.querySelectorAll('a[href*="/listing/"]');
    anchors.forEach((anchor) => {
      const card = resolveCardFromAnchor(anchor);
      if (card && !knownCards.has(card)) {
        knownCards.add(card);
        pendingCards.add(card);
      }
    });
  }

  // ---------------------------------------------------------------------
  // Idle-time processing queue
  // ---------------------------------------------------------------------

  // Shop observations from this batch, flushed to the shared Shop Directory
  // once per batch instead of once per card (see storage.js).
  let pendingDirectoryObservations = [];

  function processPendingCards(deadline) {
    const start = performance.now();
    let processed = 0;
    let skipped = 0;

    const iterator = pendingCards.values();
    let next = iterator.next();
    while (!next.done) {
      const card = next.value;
      pendingCards.delete(card);

      if (cardCache.has(card)) {
        skipped++;
      } else if (document.contains(card)) {
        const meta = extractCardMetadata(card, inMemoryShopDirectory);
        cardCache.set(card, meta);
        if (meta.shopUrl) pendingDirectoryObservations.push(meta);
        processed++;
      }

      const outOfTime =
        deadline && typeof deadline.timeRemaining === "function" && deadline.timeRemaining() <= 0;
      if (outOfTime && pendingCards.size > 0) break;

      next = iterator.next();
    }

    logDebug("processed batch", {
      url: location.href,
      page: getPageNumberFromUrl(),
      processed,
      skippedCached: skipped,
      ms: Math.round(performance.now() - start),
      remaining: pendingCards.size,
      knownListings: knownCards.size,
    });

    scheduleStyleUpdate();
    if (pendingDirectoryObservations.length > 0) scheduleDirectoryFlush();

    if (pendingCards.size > 0) {
      scheduleIdleProcessing();
    }
  }

  function runIdleProcessing() {
    if ("requestIdleCallback" in window) {
      requestIdleCallback(processPendingCards, { timeout: 1000 });
    } else {
      setTimeout(() => processPendingCards(null), 0);
    }
  }

  const scheduleIdleProcessing = debounce(runIdleProcessing, 200);

  /**
   * Writes accumulated shop observations to the shared Shop Directory in one
   * read+write, instead of one storage round trip per card - so scrolling
   * past dozens of cards costs a handful of writes, not dozens.
   */
  function flushDirectoryObservations() {
    if (pendingDirectoryObservations.length === 0) return;
    const batch = pendingDirectoryObservations;
    pendingDirectoryObservations = [];
    upsertShopDirectoryEntries(batch)
      .then((next) => {
        inMemoryShopDirectory = next;
      })
      .catch(() => {
        /* best-effort persistence only */
      });
  }

  const scheduleDirectoryFlush = debounce(flushDirectoryObservations, DIRECTORY_FLUSH_DEBOUNCE_MS);

  // ---------------------------------------------------------------------
  // Style/visibility updates (batched into a single rAF per pass)
  // ---------------------------------------------------------------------

  function formatShopAge(months) {
    if (months === 0) return "New on Etsy";
    if (months === 1) return "1 month on Etsy";
    return `${months} months on Etsy`;
  }

  function shopAgeLabel(meta) {
    if (meta.shopAgeMonths !== null && meta.shopAgeMonths !== undefined) {
      return formatShopAge(meta.shopAgeMonths);
    }
    if (meta.shopAgeSource === "unavailable") return "unavailable";
    return "not fetched yet";
  }

  function shopTotalSalesLabel(meta) {
    if (meta.shopTotalSales !== null && meta.shopTotalSales !== undefined) {
      const sourceLabel = meta.shopTotalSalesSource === "public" ? " (public page)" : "";
      return `${meta.shopTotalSales.toLocaleString()} sales${sourceLabel}`;
    }
    if (meta.shopTotalSalesSource === "unavailable") return "unavailable";
    return "not fetched yet";
  }

  function ratingReviewsLabel(meta) {
    const ratingPart = meta.rating !== null && meta.rating !== undefined ? meta.rating.toFixed(1) : "—";
    const reviewsPart =
      meta.reviewsCount !== null && meta.reviewsCount !== undefined
        ? meta.reviewsCount.toLocaleString()
        : "—";
    return `★ ${ratingPart} (${reviewsPart})`;
  }

  function salesVelocityLabel(meta, derived) {
    if (derived.salesVelocity !== null) return `${derived.salesVelocity.toFixed(2)}/day`;
    if (meta.shopAgeMonths === 0) return "too new to calculate";
    return "unavailable";
  }

  function opportunityScoreLabel(derived) {
    return derived.opportunityScore !== null ? derived.opportunityScore.toFixed(1) : "unavailable";
  }

  function truncate(text, maxLen) {
    if (!text) return text;
    return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
  }

  /**
   * Builds the scanner's per-card display lines: shop name, product title,
   * rating/reviews, shop total sales, shop age, sales/day velocity, digital
   * status, and opportunity score - everything the scanner is required to
   * show, laid out compactly.
   */
  function buildScannerLines(meta, derived) {
    const lines = [];
    lines.push(`Shop: ${meta.shopName || "unknown"}`);
    if (meta.listingTitle) lines.push(truncate(meta.listingTitle, 48));
    lines.push(ratingReviewsLabel(meta));
    lines.push(`Sales: ${shopTotalSalesLabel(meta)} · Age: ${shopAgeLabel(meta)}`);
    lines.push(`Velocity: ${salesVelocityLabel(meta, derived)}`);
    lines.push(`Digital: ${meta.isDigital ? "Yes" : "No"} · Opportunity: ${opportunityScoreLabel(derived)}`);
    return lines;
  }

  function annotateCard(card, meta, derived, visible, scannerActive) {
    let badge = card.querySelector(`:scope > .${BADGE_CLASS}`);

    if (!visible || !scannerActive) {
      if (badge) badge.remove();
      return;
    }

    if (!badge) {
      badge = document.createElement("div");
      badge.className = BADGE_CLASS;
      if (window.getComputedStyle(card).position === "static") {
        card.classList.add("etsy-filter-card-anchor");
      }
      card.appendChild(badge);
    }

    badge.textContent = ""; // clear previous lines before rebuilding
    buildScannerLines(meta, derived).forEach((line) => {
      const lineEl = document.createElement("div");
      lineEl.className = "etsy-filter-badge-line";
      lineEl.textContent = line;
      badge.appendChild(lineEl);
    });
  }

  function removeBadge(card) {
    const badge = card.querySelector(`:scope > .${BADGE_CLASS}`);
    if (badge) badge.remove();
  }

  function passesShopAgeFilter(meta) {
    const filter = currentSettings.shopAgeFilter;
    if (!filter || filter === "all") return true;

    const age = meta.shopAgeMonths;
    const known = age !== null && age !== undefined;
    if (!known) return false;

    if (filter === "new") return age === 0;
    const thresholds = { "1m": 1, "2m": 2, "3m": 3, "6m": 6 };
    const threshold = thresholds[filter];
    return threshold !== undefined ? age <= threshold : true;
  }

  function applyFiltersToAllKnownCards() {
    if (!currentSettings.enabled) {
      knownCards.forEach((card) => {
        card.style.display = "";
        removeBadge(card);
      });
      updateStatus(null);
      return;
    }

    const minRating = currentSettings.minRating !== "" ? Number(currentSettings.minRating) : null;
    const minReviews = currentSettings.minReviews !== "" ? Number(currentSettings.minReviews) : null;
    const minShopTotalSales =
      currentSettings.minShopTotalSales !== "" ? Number(currentSettings.minShopTotalSales) : null;
    const minSalesVelocity =
      currentSettings.minSalesVelocity !== "" ? Number(currentSettings.minSalesVelocity) : null;

    const hasMinRating = minRating !== null && !Number.isNaN(minRating);
    const hasMinReviews = minReviews !== null && !Number.isNaN(minReviews);
    const hasMinSales = minShopTotalSales !== null && !Number.isNaN(minShopTotalSales);
    const hasMinVelocity = minSalesVelocity !== null && !Number.isNaN(minSalesVelocity);

    const shopAgeActive = !!currentSettings.shopAgeFilter && currentSettings.shopAgeFilter !== "all";
    const digitalActive = !!currentSettings.digitalOnly;
    const scannerActive =
      shopAgeActive || digitalActive || hasMinRating || hasMinReviews || hasMinSales || hasMinVelocity;

    let visibleCount = 0;
    let total = 0;
    const stale = [];

    knownCards.forEach((card) => {
      if (!document.contains(card)) {
        stale.push(card);
        return;
      }

      const meta = cardCache.get(card);
      if (!meta) return; // still pending processing; next pass will pick it up

      total++;
      const derived = computeDerivedMetrics(meta);
      let visible = true;

      if (shopAgeActive && !passesShopAgeFilter(meta)) visible = false;

      if (visible && digitalActive && !meta.isDigital) visible = false;

      if (visible && hasMinRating) {
        if (meta.rating === null || meta.rating === undefined) {
          visible = !currentSettings.hideUnavailableData;
        } else if (meta.rating < minRating) {
          visible = false;
        }
      }

      if (visible && hasMinReviews) {
        if (meta.reviewsCount === null || meta.reviewsCount === undefined) {
          visible = !currentSettings.hideUnavailableData;
        } else if (meta.reviewsCount < minReviews) {
          visible = false;
        }
      }

      if (visible && hasMinSales) {
        if (meta.shopTotalSales === null || meta.shopTotalSales === undefined) {
          visible = !currentSettings.hideUnavailableData;
        } else if (meta.shopTotalSales < minShopTotalSales) {
          visible = false;
        }
      }

      if (visible && hasMinVelocity) {
        if (derived.salesVelocity === null) {
          visible = !currentSettings.hideUnavailableData;
        } else if (derived.salesVelocity < minSalesVelocity) {
          visible = false;
        }
      }

      card.style.display = visible ? "" : "none";
      annotateCard(card, meta, derived, visible, scannerActive);
      if (visible) visibleCount++;
    });

    stale.forEach((card) => knownCards.delete(card));
    updateStatus({ visible: visibleCount, total });
    updateFetchUI();

    logDebug("filter pass", {
      url: location.href,
      page: getPageNumberFromUrl(),
      detectedListings: total,
      filteredVisible: visibleCount,
    });
  }

  function scheduleStyleUpdate() {
    if (styleUpdateScheduled) return;
    styleUpdateScheduled = true;
    requestAnimationFrame(() => {
      styleUpdateScheduled = false;
      applyFiltersToAllKnownCards();
    });
  }

  // ---------------------------------------------------------------------
  // Level 2: optional public-page enrichment, user-initiated only.
  // Resolves shop total sales, shop age, rating, and reviews count - all
  // shop-level facts, dedupable across every card from the same shop.
  // Digital-product detection is intentionally card-level only (see
  // README): re-checking it via fetch would mean a request for nearly
  // every physical-goods card, which conflicts with the "don't scrape
  // aggressively" requirement.
  // ---------------------------------------------------------------------

  function delay(ms, signal) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true }
        );
      }
    });
  }

  /**
   * Fetches a public Etsy page and looks for shop total sales, shop age,
   * rating, and reviews count in its rendered text. Uses credentials: 'omit'
   * deliberately - we only want whatever a logged-out visitor could see,
   * never an authenticated view.
   */
  async function fetchPublicPageData(url, signal) {
    const response = await fetch(url, { credentials: "omit", signal });
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const text = doc.body ? doc.body.textContent : html;
    return {
      shopTotalSales: parseShopTotalSales(text),
      shopAgeMonths: parseShopAgeMonths(text),
      rating: parseRatingFromPageText(text),
      reviewsCount: parseReviewsCountFromPageText(text),
    };
  }

  /**
   * Builds one fetch target per unique shop/listing among currently visible,
   * unresolved cards - never per card. Several cards from the same shop
   * collapse into a single request, and only the currently-loaded, currently
   * visible (not hidden by our own filters), not-yet-attempted set is
   * considered - never the whole page, never automatically.
   */
  function buildFetchTargets() {
    const targetMap = new Map();

    knownCards.forEach((card) => {
      if (!document.contains(card) || card.style.display === "none") return;

      const meta = cardCache.get(card);
      if (!meta) return;

      const needsShopLevelData =
        meta.shopTotalSalesSource === "unknown" ||
        meta.shopAgeSource === "unknown" ||
        meta.ratingSource === "unknown" ||
        meta.reviewsSource === "unknown";
      if (!needsShopLevelData) return;

      const key = meta.shopUrl || meta.listingUrl;
      if (!key || attemptedFetchKeys.has(key)) return;

      if (!targetMap.has(key)) {
        targetMap.set(key, {
          key,
          url: meta.shopUrl || meta.listingUrl,
          cards: [],
        });
      }
      targetMap.get(key).cards.push(card);
    });

    return Array.from(targetMap.values());
  }

  async function processFetchTarget(target) {
    attemptedFetchKeys.add(target.key);

    let result = inMemoryShopDirectory[target.key] || null;
    if (!result) {
      try {
        const fetched = await fetchPublicPageData(target.url, fetchState.abortController.signal);
        result = {
          shopTotalSales: fetched.shopTotalSales,
          shopTotalSalesSource: fetched.shopTotalSales !== null ? "public" : "unavailable",
          shopAgeMonths: fetched.shopAgeMonths,
          shopAgeSource: fetched.shopAgeMonths !== null ? "public" : "unavailable",
          rating: fetched.rating,
          ratingSource: fetched.rating !== null ? "public" : "unavailable",
          reviewsCount: fetched.reviewsCount,
          reviewsSource: fetched.reviewsCount !== null ? "public" : "unavailable",
        };
      } catch (err) {
        result = {
          shopTotalSales: null,
          shopTotalSalesSource: "unavailable",
          shopAgeMonths: null,
          shopAgeSource: "unavailable",
          rating: null,
          ratingSource: "unavailable",
          reviewsCount: null,
          reviewsSource: "unavailable",
        };
      }
      inMemoryShopDirectory[target.key] = result;
      // A shared shop-directory entry is keyed by shopUrl; the rare
      // listing-only fallback target (no shop link found on the card) has
      // no shop to attribute this to, so it's cached in-memory for this
      // session only, not persisted to the shared directory.
      const firstMeta = target.cards[0] && cardCache.get(target.cards[0]);
      if (firstMeta && firstMeta.shopUrl) {
        upsertShopDirectoryEntries([{ shopUrl: firstMeta.shopUrl, shopName: firstMeta.shopName, ...result }]).catch(
          () => {
            /* best-effort persistence only */
          }
        );
      }
    }

    const foundSomething =
      (result.shopTotalSales !== null && result.shopTotalSales !== undefined) ||
      (result.shopAgeMonths !== null && result.shopAgeMonths !== undefined) ||
      (result.rating !== null && result.rating !== undefined) ||
      (result.reviewsCount !== null && result.reviewsCount !== undefined);
    if (foundSomething) fetchState.found++;
    else fetchState.unavailable++;

    target.cards.forEach((card) => {
      const meta = cardCache.get(card) || {};
      const merged = { ...meta, lastProcessedAt: Date.now() };
      if (meta.shopTotalSalesSource === "unknown") {
        merged.shopTotalSales = result.shopTotalSales;
        merged.shopTotalSalesSource = result.shopTotalSalesSource;
      }
      if (meta.shopAgeSource === "unknown") {
        merged.shopAgeMonths = result.shopAgeMonths;
        merged.shopAgeSource = result.shopAgeSource;
      }
      if (meta.ratingSource === "unknown") {
        merged.rating = result.rating;
        merged.ratingSource = result.ratingSource;
      }
      if (meta.reviewsSource === "unknown") {
        merged.reviewsCount = result.reviewsCount;
        merged.reviewsSource = result.reviewsSource;
      }
      cardCache.set(card, merged);
    });

    scheduleStyleUpdate();
  }

  async function startPublicDataFetch() {
    if (fetchState.running) return;

    const targets = buildFetchTargets();
    if (targets.length === 0) {
      setFetchProgressText("No visible listings need fetching.");
      return;
    }

    fetchState.running = true;
    fetchState.abortController = new AbortController();
    fetchState.total = targets.length;
    fetchState.fetched = 0;
    fetchState.found = 0;
    fetchState.unavailable = 0;
    updateFetchUI();

    // FETCH_CONCURRENCY lanes pull from the same shared queue, each pausing
    // FETCH_DELAY_MS between its own requests - polite pacing even at
    // concurrency 2.
    const queue = targets.slice();
    async function runLane() {
      while (fetchState.running && queue.length > 0) {
        const target = queue.shift();
        await processFetchTarget(target);
        fetchState.fetched++;
        updateFetchUI();
        if (fetchState.running && queue.length > 0) {
          await delay(FETCH_DELAY_MS, fetchState.abortController.signal);
        }
      }
    }

    const lanes = Array.from({ length: Math.min(FETCH_CONCURRENCY, targets.length) }, runLane);
    await Promise.all(lanes);

    fetchState.running = false;
    updateFetchUI();
  }

  function stopPublicDataFetch() {
    if (!fetchState.running) return;
    fetchState.running = false;
    if (fetchState.abortController) fetchState.abortController.abort();
    updateFetchUI();
  }

  // ---------------------------------------------------------------------
  // Floating panel UI
  // ---------------------------------------------------------------------

  function createPanel() {
    if (document.getElementById(PANEL_ID)) return; // never create a second panel

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="etsy-filter-header">
        <span class="etsy-filter-title">Etsy Advanced Filter</span>
        <button type="button" class="etsy-filter-collapse" aria-label="Collapse panel">&minus;</button>
      </div>
      <div class="etsy-filter-body">
        <fieldset class="etsy-filter-fieldset">
          <legend>Maximum Shop Age</legend>
          <label class="etsy-filter-row etsy-filter-radio-row">
            <input type="radio" name="etsy-filter-shop-age" value="all" id="etsy-filter-age-all" />
            <span>All</span>
          </label>
          <label class="etsy-filter-row etsy-filter-radio-row">
            <input type="radio" name="etsy-filter-shop-age" value="new" id="etsy-filter-age-new" />
            <span>New on Etsy</span>
          </label>
          <label class="etsy-filter-row etsy-filter-radio-row">
            <input type="radio" name="etsy-filter-shop-age" value="1m" id="etsy-filter-age-1m" />
            <span>1 month or newer</span>
          </label>
          <label class="etsy-filter-row etsy-filter-radio-row">
            <input type="radio" name="etsy-filter-shop-age" value="2m" id="etsy-filter-age-2m" />
            <span>2 months or newer</span>
          </label>
          <label class="etsy-filter-row etsy-filter-radio-row">
            <input type="radio" name="etsy-filter-shop-age" value="3m" id="etsy-filter-age-3m" />
            <span>3 months or newer</span>
          </label>
          <label class="etsy-filter-row etsy-filter-radio-row">
            <input type="radio" name="etsy-filter-shop-age" value="6m" id="etsy-filter-age-6m" />
            <span>6 months or newer</span>
          </label>
        </fieldset>
        <label class="etsy-filter-row etsy-filter-checkbox-row">
          <input type="checkbox" id="etsy-filter-digital-only" />
          <span>Digital products only</span>
        </label>
        <label class="etsy-filter-row">
          <span>Minimum rating (1-5)</span>
          <input type="number" min="1" max="5" step="0.1" id="etsy-filter-min-rating" placeholder="e.g. 4.5" />
        </label>
        <label class="etsy-filter-row">
          <span>Minimum reviews</span>
          <input type="number" min="0" inputmode="numeric" id="etsy-filter-min-reviews" placeholder="e.g. 10" />
        </label>
        <label class="etsy-filter-row">
          <span>Minimum shop total sales</span>
          <input type="number" min="0" inputmode="numeric" id="etsy-filter-min-shop-sales" placeholder="e.g. 50" />
        </label>
        <label class="etsy-filter-row">
          <span>Minimum sales/day velocity</span>
          <input type="number" min="0" step="0.01" id="etsy-filter-min-velocity" placeholder="e.g. 1.5" />
        </label>
        <label class="etsy-filter-row etsy-filter-checkbox-row">
          <input type="checkbox" id="etsy-filter-hide-unavailable" />
          <span>Hide listings with unavailable data</span>
        </label>
        <div class="etsy-filter-actions">
          <button type="button" id="etsy-filter-apply">Apply Filters</button>
          <button type="button" id="etsy-filter-reset">Reset</button>
        </div>
        <div class="etsy-filter-fetch-row">
          <button type="button" id="etsy-filter-fetch-btn">Fetch public data</button>
          <div class="etsy-filter-fetch-progress" id="etsy-filter-fetch-progress"></div>
        </div>
        <div class="etsy-filter-status" id="etsy-filter-status" role="status"></div>
        <label class="etsy-filter-row etsy-filter-checkbox-row etsy-filter-debug-row">
          <input type="checkbox" id="etsy-filter-debug-mode" />
          <span>Debug mode (console logs)</span>
        </label>
        <div class="etsy-filter-note">${LIMITATION_NOTE}</div>
      </div>
    `;

    document.body.appendChild(panel);

    panel.querySelector(".etsy-filter-collapse").addEventListener("click", () => {
      panel.classList.toggle("etsy-filter-collapsed");
    });

    panel.querySelector("#etsy-filter-apply").addEventListener("click", onApplyClicked);
    panel.querySelector("#etsy-filter-reset").addEventListener("click", onResetClicked);
    panel.querySelector("#etsy-filter-fetch-btn").addEventListener("click", () => {
      if (fetchState.running) {
        stopPublicDataFetch();
      } else {
        startPublicDataFetch();
      }
    });
    panel.querySelector("#etsy-filter-debug-mode").addEventListener("change", (event) => {
      currentSettings = { ...currentSettings, debugMode: event.target.checked };
      saveSettings({ debugMode: event.target.checked });
    });
  }

  function syncPanelFromSettings() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    const shopAgeValue = currentSettings.shopAgeFilter || "all";
    const radio = panel.querySelector(`input[name="etsy-filter-shop-age"][value="${shopAgeValue}"]`);
    if (radio) radio.checked = true;

    panel.querySelector("#etsy-filter-digital-only").checked = !!currentSettings.digitalOnly;
    panel.querySelector("#etsy-filter-min-rating").value = currentSettings.minRating || "";
    panel.querySelector("#etsy-filter-min-reviews").value = currentSettings.minReviews || "";
    panel.querySelector("#etsy-filter-min-shop-sales").value = currentSettings.minShopTotalSales || "";
    panel.querySelector("#etsy-filter-min-velocity").value = currentSettings.minSalesVelocity || "";
    panel.querySelector("#etsy-filter-hide-unavailable").checked = !!currentSettings.hideUnavailableData;
    panel.querySelector("#etsy-filter-debug-mode").checked = !!currentSettings.debugMode;
    panel.classList.toggle("etsy-filter-disabled", !currentSettings.enabled);
  }

  function readPanelValues() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return {};
    const checkedAge = panel.querySelector('input[name="etsy-filter-shop-age"]:checked');
    return {
      shopAgeFilter: checkedAge ? checkedAge.value : "all",
      digitalOnly: panel.querySelector("#etsy-filter-digital-only").checked,
      minRating: panel.querySelector("#etsy-filter-min-rating").value.trim(),
      minReviews: panel.querySelector("#etsy-filter-min-reviews").value.trim(),
      minShopTotalSales: panel.querySelector("#etsy-filter-min-shop-sales").value.trim(),
      minSalesVelocity: panel.querySelector("#etsy-filter-min-velocity").value.trim(),
      hideUnavailableData: panel.querySelector("#etsy-filter-hide-unavailable").checked,
    };
  }

  function onApplyClicked() {
    const values = readPanelValues();
    currentSettings = { ...currentSettings, ...values };
    saveSettings(values);
    scheduleStyleUpdate();
  }

  function onResetClicked() {
    const cleared = {
      shopAgeFilter: "all",
      digitalOnly: false,
      minRating: "",
      minReviews: "",
      minShopTotalSales: "",
      minSalesVelocity: "",
      hideUnavailableData: false,
    };
    currentSettings = { ...currentSettings, ...cleared };
    syncPanelFromSettings();
    saveSettings(cleared);
    scheduleStyleUpdate();
  }

  function updateStatus(info) {
    const statusEl = document.getElementById("etsy-filter-status");
    if (!statusEl) return;

    if (!currentSettings.enabled) {
      statusEl.textContent = "Extension disabled";
      return;
    }
    if (!info) {
      statusEl.textContent = "";
      return;
    }
    statusEl.textContent = `${info.visible} of ${info.total} listings visible`;
  }

  function setFetchProgressText(text) {
    const progressEl = document.getElementById("etsy-filter-fetch-progress");
    if (progressEl) progressEl.textContent = text;
  }

  function updateFetchUI() {
    const btn = document.getElementById("etsy-filter-fetch-btn");
    if (btn) btn.textContent = fetchState.running ? "Stop fetching" : "Fetch public data";

    if (fetchState.total > 0) {
      setFetchProgressText(
        `Fetched ${fetchState.fetched} / ${fetchState.total} visible listings — ` +
          `Data found: ${fetchState.found}, Unavailable: ${fetchState.unavailable}`
      );
    }
  }

  // ---------------------------------------------------------------------
  // Dynamic content handling (infinite scroll / lazy loading)
  // ---------------------------------------------------------------------

  const debouncedOnMutation = debounce(() => {
    const container = ensureContainer();
    if (!container) return;
    discoverNewCards(container);
    if (pendingCards.size > 0) scheduleIdleProcessing();
  }, 300);

  function startContainerObserver(container) {
    if (containerObserver) containerObserver.disconnect();
    containerObserver = new MutationObserver(debouncedOnMutation);
    // Scoped to the results container only - never document.body - and only
    // childList/subtree (no attributes/characterData) so lazy-loaded image
    // swaps and unrelated attribute churn never wake this callback.
    containerObserver.observe(container, { childList: true, subtree: true });
    logDebug("observer reconnected", {
      url: location.href,
      page: getPageNumberFromUrl(),
      containerTag: container.tagName,
      containerId: container.id || null,
    });
  }

  function startBootstrapObserver() {
    if (bootstrapObserver) return; // avoid duplicate observers
    bootstrapObserver = new MutationObserver(
      debounce(() => {
        const found = ensureContainer();
        if (found) {
          discoverNewCards(found);
          scheduleIdleProcessing();
        }
      }, 300)
    );
    bootstrapObserver.observe(document.body, { childList: true, subtree: true });
  }

  /**
   * Resolves (and lazily (re)detects) the results container. Returns null
   * only during the brief window before Etsy has rendered any results yet.
   */
  function ensureContainer() {
    if (resultsContainer && document.contains(resultsContainer)) return resultsContainer;

    const found = findResultsContainer();
    if (found) {
      resultsContainer = found;
      startContainerObserver(resultsContainer);
      if (bootstrapObserver) {
        bootstrapObserver.disconnect();
        bootstrapObserver = null;
      }
    }
    return resultsContainer;
  }

  // ---------------------------------------------------------------------
  // Navigation handling: Etsy pagination/search may change the URL and/or
  // swap the results container without a full page reload (client-side
  // routing). We detect that from several independent signals and re-run
  // discovery/processing on the new page while keeping filter settings and
  // the shop/listing data cache intact.
  // ---------------------------------------------------------------------

  function teardownForNavigation() {
    if (containerObserver) {
      containerObserver.disconnect();
      containerObserver = null;
    }
    if (bootstrapObserver) {
      bootstrapObserver.disconnect();
      bootstrapObserver = null;
    }
    resultsContainer = null;
    flushDirectoryObservations(); // don't lose scan data for cards about to be dropped
    // Page-specific DOM tracking only. Deliberately NOT cleared:
    //   - cardCache (WeakMap): old cards are simply unreachable once dropped
    //     from knownCards, and get garbage-collected naturally.
    //   - inMemoryShopDirectory / attemptedFetchKeys: shop/listing facts
    //     already learned remain valid on other pages of the same search and
    //     should never be re-fetched.
    //   - currentSettings: the user's filters must survive page navigation.
    knownCards.clear();
    pendingCards.clear();
  }

  function handleNavigationChange(forceReprocess) {
    const urlChanged = location.href !== lastKnownUrl;
    if (!urlChanged && !forceReprocess) return;

    lastKnownUrl = location.href;
    logDebug("navigation detected", { url: location.href, page: getPageNumberFromUrl() });

    if (!isSearchPage()) {
      teardownForNavigation();
      const existingPanel = document.getElementById(PANEL_ID);
      if (existingPanel) existingPanel.remove();
      return;
    }

    teardownForNavigation();
    createPanel(); // idempotent: re-injects only if missing
    syncPanelFromSettings();

    const container = ensureContainer();
    if (container) {
      discoverNewCards(container);
      scheduleIdleProcessing();
    } else {
      startBootstrapObserver();
    }

    logDebug("reprocessed after navigation", {
      url: location.href,
      page: getPageNumberFromUrl(),
      detectedListings: knownCards.size,
    });
  }

  function startNavigationWatcher() {
    const checkNow = () => {
      const containerBroken = !!resultsContainer && !document.contains(resultsContainer);
      handleNavigationChange(containerBroken);
    };

    // pushState/replaceState fire no native event, so we wrap them to learn
    // about client-side route changes the instant they happen. Wrapped
    // defensively: if another script already wrapped these (or a strict CSP
    // blocks reassignment), we fail silently and rely on the poll below.
    try {
      ["pushState", "replaceState"].forEach((methodName) => {
        const original = history[methodName];
        if (typeof original !== "function") return;
        history[methodName] = function wrapped(...args) {
          const result = original.apply(this, args);
          queueMicrotask(checkNow);
          return result;
        };
      });
    } catch (err) {
      /* fall back to popstate/hashchange/poll below */
    }

    window.addEventListener("popstate", checkNow);
    window.addEventListener("hashchange", checkNow);

    // Safety net: catches any navigation mechanism the hooks above miss
    // (e.g. a future Etsy routing approach), at a low, cheap frequency.
    setInterval(checkNow, NAV_POLL_MS);
  }

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------

  async function init() {
    if (!isSearchPage()) return;

    try {
      currentSettings = await getSettings();
    } catch (err) {
      currentSettings = { ...DEFAULT_SETTINGS };
    }

    try {
      inMemoryShopDirectory = await getShopDirectory();
    } catch (err) {
      inMemoryShopDirectory = {};
    }

    createPanel();
    syncPanelFromSettings();

    const container = ensureContainer();
    if (container) {
      discoverNewCards(container);
      scheduleIdleProcessing();
    } else {
      // Etsy hasn't rendered results yet. This is a short-lived bootstrap
      // observer on document.body just to notice when results appear; it
      // disconnects itself the moment ensureContainer() finds a scoped
      // container, so it never runs for the lifetime of the page.
      startBootstrapObserver();
    }

    startNavigationWatcher();
    window.addEventListener("pagehide", flushDirectoryObservations);

    onSettingsChanged((newSettings) => {
      currentSettings = newSettings;
      syncPanelFromSettings();
      scheduleStyleUpdate();
    });
  }

  init().catch(() => {
    /* fail silently: extension should never break the host page */
  });
})();
