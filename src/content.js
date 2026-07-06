/**
 * content.js
 * Injected on Etsy search / market pages. Renders the "Etsy Opportunity
 * Finder" floating panel: a compact, self-contained feed of scored shop
 * opportunities found on the current search page - never an overlay on top
 * of Etsy's own product cards.
 *
 * Important data-model note: Etsy does not expose a per-product sales
 * count anywhere public. Every "N sales" figure we ever detect - on a
 * search card, a listing page, or a shop page - is the SHOP's all-time
 * running total, never that one product's. This file never calculates,
 * infers, or invents a per-product sales number; "shopTotalSales" is the
 * only sales concept anywhere in this codebase.
 *
 * UX model (see README): the panel guides a single loop - Start Research
 * -> Analyze -> Find Winners -> Save. Filters live in a separate Settings
 * view, not the main view, so a first-time user sees only a "Start
 * Research" call to action, not a wall of technical controls.
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
 *   - Feed re-renders are batched into a single requestAnimationFrame per pass.
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
    getSavedItems,
    saveItem,
    removeSavedItem,
    DEFAULT_SETTINGS,
  } = window.EtsyFilterStorage || {};

  if (!debounce || !getSettings) {
    // Dependencies failed to load; nothing we can safely do.
    return;
  }

  const PANEL_ID = "eof-panel";
  const LIMITATION_NOTE =
    "All data comes from Etsy's own public pages - shop total sales, shop age, rating, and reviews. Nothing is invented, and there is no per-product sales figure anywhere (Etsy doesn't expose one).";

  const FETCH_CONCURRENCY = 1; // polite default; see README for rationale
  const FETCH_DELAY_MS = 1200; // delay between requests, within the 800-1500ms range
  const NAV_POLL_MS = 1000; // safety-net URL/container-health poll
  const DIRECTORY_FLUSH_DEBOUNCE_MS = 1500; // batch shop-directory writes, not one per card
  const CARD_DISPLAY_LIMIT = 20; // keep the feed compact/scannable
  const HOT_SCORE_THRESHOLD = 80;
  const STRONG_SCORE_THRESHOLD = 50;

  // Unpacked/dev-loaded extensions have no "update_url" in their manifest;
  // Chrome Web Store installs do. Debug mode is only ever shown/available in
  // that case - it never appears in the main UI otherwise.
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
    console.log(`[Etsy Opportunity Finder][debug] ${label}`, data);
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
  let hasStartedResearch = false; // session-only; never persisted, never auto-triggered
  let currentView = "main"; // 'main' | 'settings' | 'saved'

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

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = value === null || value === undefined ? "" : String(value);
    return div.innerHTML;
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

    scheduleFeedUpdate();
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
  // Scoring + formatting helpers for the results feed
  // ---------------------------------------------------------------------

  function scoreTier(score) {
    if (score === null || score === undefined) return null;
    if (score >= HOT_SCORE_THRESHOLD) return "hot";
    if (score >= STRONG_SCORE_THRESHOLD) return "strong";
    return "emerging";
  }

  function formatAgeShort(months) {
    if (months === null || months === undefined) return "Unknown";
    if (months === 0) return "New";
    if (months === 1) return "1 month";
    return `${months} months`;
  }

  function formatSalesShort(meta) {
    if (meta.shopTotalSales !== null && meta.shopTotalSales !== undefined) {
      return meta.shopTotalSales.toLocaleString();
    }
    return meta.shopTotalSalesSource === "unavailable" ? "Unavailable" : "Unknown";
  }

  function formatVelocityShort(derived) {
    return derived.salesVelocity !== null ? `${derived.salesVelocity.toFixed(1)} sales/day` : "—";
  }

  function formatRatingShort(meta) {
    const ratingPart = meta.rating !== null && meta.rating !== undefined ? meta.rating.toFixed(1) : "—";
    const reviewsPart =
      meta.reviewsCount !== null && meta.reviewsCount !== undefined ? ` (${meta.reviewsCount})` : "";
    return `⭐${ratingPart}${reviewsPart}`;
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

  /**
   * Computes the current filtered, deduplicated (one card per shop), sorted
   * (best opportunity score first) list the results feed should show.
   */
  function getFilteredSortedOpportunities() {
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

    const seenShopUrls = new Set();
    const opportunities = [];
    const stale = [];

    knownCards.forEach((card) => {
      if (!document.contains(card)) {
        stale.push(card);
        return;
      }
      const meta = cardCache.get(card);
      if (!meta || !meta.shopUrl || seenShopUrls.has(meta.shopUrl)) return;

      let passes = true;
      if (shopAgeActive && !passesShopAgeFilter(meta)) passes = false;
      if (passes && digitalActive && !meta.isDigital) passes = false;

      if (passes && hasMinRating) {
        if (meta.rating === null || meta.rating === undefined) passes = !currentSettings.hideUnavailableData;
        else if (meta.rating < minRating) passes = false;
      }
      if (passes && hasMinReviews) {
        if (meta.reviewsCount === null || meta.reviewsCount === undefined) passes = !currentSettings.hideUnavailableData;
        else if (meta.reviewsCount < minReviews) passes = false;
      }
      if (passes && hasMinSales) {
        if (meta.shopTotalSales === null || meta.shopTotalSales === undefined) passes = !currentSettings.hideUnavailableData;
        else if (meta.shopTotalSales < minShopTotalSales) passes = false;
      }

      const derived = computeDerivedMetrics(meta);
      if (passes && hasMinVelocity) {
        if (derived.salesVelocity === null) passes = !currentSettings.hideUnavailableData;
        else if (derived.salesVelocity < minSalesVelocity) passes = false;
      }

      if (!passes) return;
      seenShopUrls.add(meta.shopUrl);
      opportunities.push({ meta, derived });
    });

    stale.forEach((card) => knownCards.delete(card));
    opportunities.sort((a, b) => (b.derived.opportunityScore ?? -Infinity) - (a.derived.opportunityScore ?? -Infinity));
    return opportunities;
  }

  // ---------------------------------------------------------------------
  // Results feed rendering (batched into a single rAF per pass)
  // ---------------------------------------------------------------------

  function buildResultCardElement(meta, derived, isSaved) {
    const card = document.createElement("div");
    const tier = scoreTier(derived.opportunityScore);
    card.className = `eof-card${tier ? ` eof-tier-${tier}` : ""}`;

    const scoreEmoji = tier === "hot" ? "🔥" : tier === "strong" ? "🚀" : "⭐";
    // The underlying opportunityScore formula (see utils.js) is intentionally
    // uncapped for internal ranking, but displaying "Score 320" reads as
    // broken - shown score is clamped to a familiar 0-100 scale.
    const scoreText =
      derived.opportunityScore !== null ? Math.min(100, Math.max(0, Math.round(derived.opportunityScore))) : "—";

    card.innerHTML = `
      <div class="eof-card-score">${scoreEmoji} Score ${scoreText}</div>
      <div class="eof-card-shop">${escapeHtml(meta.shopName || "Unknown shop")}</div>
      <div class="eof-card-stats">
        <div class="eof-card-stat"><span>Age</span><b>${escapeHtml(formatAgeShort(meta.shopAgeMonths))}</b></div>
        <div class="eof-card-stat"><span>Sales</span><b>${escapeHtml(formatSalesShort(meta))}</b></div>
        <div class="eof-card-stat"><span>Growth</span><b>${escapeHtml(formatVelocityShort(derived))}</b></div>
        <div class="eof-card-stat"><span>Rating</span><b>${escapeHtml(formatRatingShort(meta))}</b></div>
        <div class="eof-card-stat"><span>Digital</span><b>${meta.isDigital ? "YES" : "NO"}</b></div>
      </div>
      <div class="eof-card-actions">
        <button type="button" class="eof-btn eof-open-btn">Open Shop</button>
        <button type="button" class="eof-btn eof-save-btn" ${isSaved ? "disabled" : ""}>${isSaved ? "✓ Saved" : "★ Save"}</button>
      </div>
    `;

    card.querySelector(".eof-open-btn").addEventListener("click", () => {
      if (meta.shopUrl) window.open(meta.shopUrl, "_blank", "noopener");
    });

    const saveBtn = card.querySelector(".eof-save-btn");
    if (!isSaved) {
      saveBtn.addEventListener("click", () => {
        saveItem("shop", meta.shopUrl, {
          shopUrl: meta.shopUrl,
          shopName: meta.shopName,
          shopTotalSales: meta.shopTotalSales,
          shopAgeMonths: meta.shopAgeMonths,
          rating: meta.rating,
          reviewsCount: meta.reviewsCount,
          isDigital: meta.isDigital,
        });
        saveBtn.textContent = "✓ Saved";
        saveBtn.disabled = true;
      });
    }

    return card;
  }

  function renderResultsFeed() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    const heroSection = panel.querySelector("#eof-hero");
    const progressSection = panel.querySelector("#eof-progress");
    const statsRow = panel.querySelector("#eof-stats-row");
    const resultsEl = panel.querySelector("#eof-results");
    const startBtn = panel.querySelector("#eof-start-btn");

    if (!currentSettings.enabled) {
      heroSection.querySelector("#eof-hint").textContent = "Extension disabled - enable it from the toolbar popup.";
      startBtn.style.display = "none";
      progressSection.style.display = "none";
      statsRow.style.display = "none";
      resultsEl.innerHTML = "";
      return;
    }
    startBtn.style.display = "";

    if (fetchState.running) {
      const label = panel.querySelector("#eof-progress-label");
      const bar = panel.querySelector("#eof-progress-bar");
      const count = panel.querySelector("#eof-progress-count");
      label.textContent = fetchState.total > 0 ? "Analyzing shops..." : "Scanning Etsy...";
      const pct = fetchState.total > 0 ? Math.round((fetchState.fetched / fetchState.total) * 100) : 8;
      bar.style.width = `${pct}%`;
      count.textContent = fetchState.total > 0 ? `${fetchState.fetched} / ${fetchState.total} shops analyzed` : "";
      progressSection.style.display = "";
      statsRow.style.display = "none";
      startBtn.textContent = "⏹ Stop Research";
      return;
    }

    progressSection.style.display = "none";
    startBtn.textContent = hasStartedResearch ? "🔄 Refresh Research" : "🚀 Start Research";

    if (!hasStartedResearch) {
      statsRow.style.display = "none";
      resultsEl.innerHTML = "";
      return;
    }

    const opportunities = getFilteredSortedOpportunities();

    let hotCount = 0;
    let strongCount = 0;
    let velocitySum = 0;
    let velocityCount = 0;
    opportunities.forEach(({ derived }) => {
      const tier = scoreTier(derived.opportunityScore);
      if (tier === "hot") hotCount++;
      else if (tier === "strong") strongCount++;
      if (derived.salesVelocity !== null) {
        velocitySum += derived.salesVelocity;
        velocityCount++;
      }
    });

    panel.querySelector("#eof-stat-hot").textContent = hotCount;
    panel.querySelector("#eof-stat-strong").textContent = strongCount;
    panel.querySelector("#eof-stat-avg-velocity").textContent =
      velocityCount > 0 ? (velocitySum / velocityCount).toFixed(1) : "—";
    statsRow.style.display = "";

    getSavedItems()
      .then((saved) => {
        const savedShopUrls = new Set(
          Object.values(saved)
            .filter((entry) => entry.type === "shop")
            .map((entry) => entry.id)
        );

        resultsEl.innerHTML = "";
        if (opportunities.length === 0) {
          resultsEl.innerHTML =
            '<div class="eof-empty">No shops match your filters yet. Try adjusting Settings, or scroll for more listings.</div>';
          return;
        }

        opportunities.slice(0, CARD_DISPLAY_LIMIT).forEach(({ meta, derived }) => {
          resultsEl.appendChild(buildResultCardElement(meta, derived, savedShopUrls.has(meta.shopUrl)));
        });

        if (opportunities.length > CARD_DISPLAY_LIMIT) {
          const more = document.createElement("div");
          more.className = "eof-empty";
          more.textContent = `Showing top ${CARD_DISPLAY_LIMIT} of ${opportunities.length} matching shops.`;
          resultsEl.appendChild(more);
        }
      })
      .catch(() => {
        /* leave the feed as-is on a storage read failure */
      });

    logDebug("feed rendered", {
      url: location.href,
      page: getPageNumberFromUrl(),
      knownShops: opportunities.length,
      hotCount,
      strongCount,
    });
  }

  function scheduleFeedUpdate() {
    if (styleUpdateScheduled) return;
    styleUpdateScheduled = true;
    requestAnimationFrame(() => {
      styleUpdateScheduled = false;
      renderResultsFeed();
    });
  }

  // ---------------------------------------------------------------------
  // Level 2: optional public-page enrichment, user-initiated only ("Start
  // Research" / "Refresh Research"). Resolves shop total sales, shop age,
  // rating, and reviews count - all shop-level facts, dedupable across
  // every card from the same shop. Digital-product detection is
  // intentionally card-level only (see README): re-checking it via fetch
  // would mean a request for nearly every physical-goods card, which
  // conflicts with the "don't scrape aggressively" requirement.
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
   * collapse into a single request, and only the currently-loaded set is
   * considered - never the whole page, never automatically.
   */
  function buildFetchTargets() {
    const targetMap = new Map();

    knownCards.forEach((card) => {
      if (!document.contains(card)) return;

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

    scheduleFeedUpdate();
  }

  async function startResearch() {
    hasStartedResearch = true;

    if (fetchState.running) {
      fetchState.running = false;
      if (fetchState.abortController) fetchState.abortController.abort();
      scheduleFeedUpdate();
      return;
    }

    const targets = buildFetchTargets();
    if (targets.length === 0) {
      scheduleFeedUpdate(); // nothing to fetch - show whatever's already known
      return;
    }

    fetchState.running = true;
    fetchState.abortController = new AbortController();
    fetchState.total = targets.length;
    fetchState.fetched = 0;
    fetchState.found = 0;
    fetchState.unavailable = 0;
    scheduleFeedUpdate();

    // FETCH_CONCURRENCY lanes pull from the same shared queue, each pausing
    // FETCH_DELAY_MS between its own requests - polite pacing even at
    // concurrency 2.
    const queue = targets.slice();
    async function runLane() {
      while (fetchState.running && queue.length > 0) {
        const target = queue.shift();
        await processFetchTarget(target);
        fetchState.fetched++;
        scheduleFeedUpdate();
        if (fetchState.running && queue.length > 0) {
          await delay(FETCH_DELAY_MS, fetchState.abortController.signal);
        }
      }
    }

    const lanes = Array.from({ length: Math.min(FETCH_CONCURRENCY, targets.length) }, runLane);
    await Promise.all(lanes);

    fetchState.running = false;
    scheduleFeedUpdate();
  }

  // ---------------------------------------------------------------------
  // Floating panel UI
  // ---------------------------------------------------------------------

  function panelTemplate() {
    return `
      <div class="eof-header" id="eof-drag-handle">
        <span class="eof-title">🔥 Etsy Opportunity Finder</span>
        <button type="button" class="eof-icon-btn" id="eof-minimize-btn" aria-label="Minimize">&minus;</button>
      </div>
      <div class="eof-nav">
        <button type="button" class="eof-nav-btn" data-view="dashboard" id="eof-nav-dashboard">📊 Dashboard</button>
        <button type="button" class="eof-nav-btn" data-view="settings" id="eof-nav-settings">⚙️ Settings</button>
        <button type="button" class="eof-nav-btn" data-view="saved" id="eof-nav-saved">⭐ Saved</button>
      </div>
      <div class="eof-body">
        <div class="eof-view active" id="eof-view-main">
          <div class="eof-section" id="eof-hero">
            <h3 class="eof-section-title">Search Analysis</h3>
            <p class="eof-hint" id="eof-hint">Find new Etsy shops making money fast on this page.</p>
            <button type="button" class="eof-primary-btn" id="eof-start-btn">🚀 Start Research</button>
            <div class="eof-progress" id="eof-progress" style="display: none">
              <div class="eof-progress-label" id="eof-progress-label"></div>
              <div class="eof-progress-track"><div class="eof-progress-fill" id="eof-progress-bar"></div></div>
              <div class="eof-progress-count" id="eof-progress-count"></div>
            </div>
          </div>
          <div class="eof-stats-row" id="eof-stats-row" style="display: none">
            <div class="eof-stat eof-stat-hot"><b id="eof-stat-hot">0</b><span>🔥 Hot</span></div>
            <div class="eof-stat eof-stat-strong"><b id="eof-stat-strong">0</b><span>🚀 Strong</span></div>
            <div class="eof-stat eof-stat-avg"><b id="eof-stat-avg-velocity">0</b><span>Avg sales/day</span></div>
          </div>
          <div class="eof-results" id="eof-results"></div>
        </div>

        <div class="eof-view" id="eof-view-settings">
          <h3 class="eof-section-title">Settings</h3>
          <fieldset class="eof-fieldset">
            <legend>Shop age</legend>
            <label class="eof-radio-row"><input type="radio" name="eof-shop-age" value="all" id="eof-age-all" /><span>Any</span></label>
            <label class="eof-radio-row"><input type="radio" name="eof-shop-age" value="new" id="eof-age-new" /><span>New</span></label>
            <label class="eof-radio-row"><input type="radio" name="eof-shop-age" value="1m" id="eof-age-1m" /><span>&lt;1 month</span></label>
            <label class="eof-radio-row"><input type="radio" name="eof-shop-age" value="3m" id="eof-age-3m" /><span>&lt;3 months</span></label>
            <label class="eof-radio-row"><input type="radio" name="eof-shop-age" value="6m" id="eof-age-6m" /><span>&lt;6 months</span></label>
          </fieldset>
          <div class="eof-field-grid">
            <label class="eof-field"><span>Min. sales</span><input type="number" min="0" id="eof-min-sales" /></label>
            <label class="eof-field"><span>Min. reviews</span><input type="number" min="0" id="eof-min-reviews" /></label>
            <label class="eof-field"><span>Min. rating</span><input type="number" min="1" max="5" step="0.1" id="eof-min-rating" /></label>
            <label class="eof-field"><span>Min. sales/day</span><input type="number" min="0" step="0.01" id="eof-min-velocity" /></label>
          </div>
          <label class="eof-checkbox-row"><input type="checkbox" id="eof-digital-only" /><span>Digital products only</span></label>
          <label class="eof-checkbox-row"><input type="checkbox" id="eof-hide-unavailable" /><span>Hide shops with unavailable data</span></label>
          <div class="eof-actions">
            <button type="button" class="eof-primary-btn" id="eof-apply-btn">Apply</button>
            <button type="button" class="eof-secondary-btn" id="eof-reset-btn">Reset</button>
          </div>
          <label class="eof-checkbox-row eof-debug-row" id="eof-debug-row" style="display: none">
            <input type="checkbox" id="eof-debug-mode" /><span>Debug mode (console logs)</span>
          </label>
          <p class="eof-note">${LIMITATION_NOTE}</p>
        </div>

        <div class="eof-view" id="eof-view-saved">
          <h3 class="eof-section-title">Saved shops</h3>
          <div class="eof-saved-list" id="eof-saved-list"></div>
        </div>
      </div>
    `;
  }

  function createPanel() {
    if (document.getElementById(PANEL_ID)) return; // never create a second panel

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = panelTemplate();
    document.body.appendChild(panel);

    if (isDevMode) panel.querySelector("#eof-debug-row").style.display = "";

    panel.querySelector("#eof-minimize-btn").addEventListener("click", () => {
      const minimized = !panel.classList.contains("eof-minimized");
      setMinimized(panel, minimized);
      saveSettings({ panelMinimized: minimized });
    });

    panel.querySelector("#eof-nav-dashboard").addEventListener("click", () => {
      window.open(chrome.runtime.getURL("src/dashboard.html"), "_blank");
    });
    panel.querySelector("#eof-nav-settings").addEventListener("click", () => {
      setView(currentView === "settings" ? "main" : "settings");
    });
    panel.querySelector("#eof-nav-saved").addEventListener("click", () => {
      setView(currentView === "saved" ? "main" : "saved");
    });

    panel.querySelector("#eof-start-btn").addEventListener("click", startResearch);
    panel.querySelector("#eof-apply-btn").addEventListener("click", onApplyClicked);
    panel.querySelector("#eof-reset-btn").addEventListener("click", onResetClicked);
    panel.querySelector("#eof-debug-mode").addEventListener("change", (event) => {
      currentSettings = { ...currentSettings, debugMode: event.target.checked };
      saveSettings({ debugMode: event.target.checked });
    });

    makeDraggable(panel, panel.querySelector("#eof-drag-handle"));
  }

  function setView(view) {
    currentView = view;
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    ["main", "settings", "saved"].forEach((v) => {
      const el = panel.querySelector(`#eof-view-${v}`);
      if (el) el.classList.toggle("active", v === view);
    });
    panel.querySelectorAll(".eof-nav-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === view && view !== "dashboard");
    });

    if (view === "saved") renderSavedView();
  }

  function renderSavedView() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const list = panel.querySelector("#eof-saved-list");
    list.innerHTML = '<div class="eof-empty">Loading…</div>';

    getSavedItems()
      .then((saved) => {
        const shops = Object.values(saved).filter((entry) => entry.type === "shop");
        list.innerHTML = "";
        if (shops.length === 0) {
          list.innerHTML = '<div class="eof-empty">No saved shops yet. Save one from your research results.</div>';
          return;
        }
        shops.forEach((entry) => {
          const shop = entry.data || {};
          const row = document.createElement("div");
          row.className = "eof-saved-row";
          row.innerHTML = `
            <div class="eof-saved-info">
              <div class="eof-saved-shop">${escapeHtml(shop.shopName || entry.id)}</div>
              <div class="eof-saved-meta">${
                shop.shopTotalSales !== null && shop.shopTotalSales !== undefined
                  ? `${shop.shopTotalSales.toLocaleString()} sales`
                  : ""
              }</div>
            </div>
            <div class="eof-saved-actions">
              <button type="button" class="eof-btn eof-open-btn">Open</button>
              <button type="button" class="eof-btn eof-remove-btn">Remove</button>
            </div>
          `;
          row.querySelector(".eof-open-btn").addEventListener("click", () => {
            window.open(entry.id, "_blank", "noopener");
          });
          row.querySelector(".eof-remove-btn").addEventListener("click", () => {
            removeSavedItem("shop", entry.id).then(renderSavedView);
          });
          list.appendChild(row);
        });
      })
      .catch(() => {
        list.innerHTML = '<div class="eof-empty">Couldn\'t load saved shops.</div>';
      });
  }

  function setMinimized(panel, minimized) {
    panel.classList.toggle("eof-minimized", minimized);
    const btn = panel.querySelector("#eof-minimize-btn");
    if (btn) btn.innerHTML = minimized ? "&#9633;" : "&minus;";
  }

  /**
   * Basic pointer-based drag on the header, constrained to the viewport.
   * Position is persisted (debounced to drag-end only, not per pixel) so
   * the panel reopens where the user left it.
   */
  function makeDraggable(panel, handle) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startTop = 0;
    let startLeft = 0;

    handle.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return; // don't drag when clicking the minimize button
      dragging = true;
      const rect = panel.getBoundingClientRect();
      startX = event.clientX;
      startY = event.clientY;
      startTop = rect.top;
      startLeft = rect.left;
      panel.style.right = "auto";
      panel.style.top = `${startTop}px`;
      panel.style.left = `${startLeft}px`;
      if (handle.setPointerCapture) handle.setPointerCapture(event.pointerId);
    });

    handle.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - 40);
      panel.style.left = `${Math.min(Math.max(0, startLeft + dx), maxLeft)}px`;
      panel.style.top = `${Math.min(Math.max(0, startTop + dy), maxTop)}px`;
    });

    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      const rect = panel.getBoundingClientRect();
      saveSettings({ panelPosition: { top: rect.top, left: rect.left } });
    };
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
  }

  function applyPanelPosition(panel) {
    const pos = currentSettings.panelPosition;
    if (pos && typeof pos.top === "number" && typeof pos.left === "number") {
      panel.style.top = `${pos.top}px`;
      panel.style.left = `${pos.left}px`;
      panel.style.right = "auto";
    }
  }

  function syncPanelFromSettings() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    const shopAgeValue = currentSettings.shopAgeFilter || "all";
    const radio = panel.querySelector(`input[name="eof-shop-age"][value="${shopAgeValue}"]`);
    if (radio) radio.checked = true;
    else panel.querySelector("#eof-age-all").checked = true; // e.g. legacy "2m" value, no longer offered here

    panel.querySelector("#eof-digital-only").checked = !!currentSettings.digitalOnly;
    panel.querySelector("#eof-min-sales").value = currentSettings.minShopTotalSales || "";
    panel.querySelector("#eof-min-reviews").value = currentSettings.minReviews || "";
    panel.querySelector("#eof-min-rating").value = currentSettings.minRating || "";
    panel.querySelector("#eof-min-velocity").value = currentSettings.minSalesVelocity || "";
    panel.querySelector("#eof-hide-unavailable").checked = !!currentSettings.hideUnavailableData;
    panel.querySelector("#eof-debug-mode").checked = !!currentSettings.debugMode;

    applyPanelPosition(panel);
    setMinimized(panel, !!currentSettings.panelMinimized);
  }

  function readSettingsFromPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return {};
    const checkedAge = panel.querySelector('input[name="eof-shop-age"]:checked');
    return {
      shopAgeFilter: checkedAge ? checkedAge.value : "all",
      digitalOnly: panel.querySelector("#eof-digital-only").checked,
      minShopTotalSales: panel.querySelector("#eof-min-sales").value.trim(),
      minReviews: panel.querySelector("#eof-min-reviews").value.trim(),
      minRating: panel.querySelector("#eof-min-rating").value.trim(),
      minSalesVelocity: panel.querySelector("#eof-min-velocity").value.trim(),
      hideUnavailableData: panel.querySelector("#eof-hide-unavailable").checked,
    };
  }

  function onApplyClicked() {
    const values = readSettingsFromPanel();
    currentSettings = { ...currentSettings, ...values };
    saveSettings(values);
    setView("main");
    scheduleFeedUpdate();
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
    scheduleFeedUpdate();
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
    //   - currentSettings / hasStartedResearch: the user's filters and
    //     research state must survive page navigation.
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
      scheduleFeedUpdate();
    });
  }

  init().catch(() => {
    /* fail silently: extension should never break the host page */
  });
})();
