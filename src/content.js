/**
 * content.js
 * Injected on Etsy search / market pages. Renders a floating filter panel
 * and hides listing cards that don't match the user's filters.
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
    parseSalesText,
    parseShopAgeMonths,
    getCardText,
    extractListingId,
    extractListingUrl,
    extractShopInfo,
  } = window.EtsyFilterUtils || {};
  const {
    getSettings,
    saveSettings,
    onSettingsChanged,
    getPublicDataCache,
    setCachedPublicDataEntry,
    DEFAULT_SETTINGS,
  } = window.EtsyFilterStorage || {};

  if (!debounce || !getSettings) {
    // Dependencies failed to load; nothing we can safely do.
    return;
  }

  const PANEL_ID = "etsy-filter-panel";
  const BADGE_CLASS = "etsy-filter-badge";
  const LIMITATION_NOTE =
    "Etsy does not always show sales numbers or shop age on search pages. This data may require fetching each public listing/shop page, and may still be unavailable. Nothing here is ever invented or estimated beyond what Etsy's own public text says.";

  const FETCH_CONCURRENCY = 1; // polite default; see README for rationale
  const FETCH_DELAY_MS = 1200; // delay between requests, within the 800-1500ms range
  const NAV_POLL_MS = 1000; // safety-net URL/container-health poll

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
  let inMemoryPublicDataCache = {}; // mirrors chrome.storage.local, key -> {salesCount, salesSource, salesScope, shopAgeMonths, shopAgeSource}
  const attemptedFetchKeys = new Set(); // "do not retry repeatedly in the same session"

  // card element -> { listingId, listingUrl, shopName, shopUrl,
  //                    shopAgeMonths, shopAgeSource,
  //                    salesCount, salesSource, salesScope, lastProcessedAt }
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
  // ---------------------------------------------------------------------

  /**
   * Finds the "card" container for a listing anchor without relying on
   * Etsy's (frequently changing) class names. We anchor on the stable
   * /listing/<id>/ URL pattern instead and walk up to the nearest <li>,
   * falling back to a fixed number of parent hops.
   */
  function resolveCardFromAnchor(anchor) {
    const li = anchor.closest("li");
    if (li) return li;

    let el = anchor;
    for (let i = 0; i < 3 && el.parentElement; i++) {
      el = el.parentElement;
    }
    return el;
  }

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
  // Per-card detection (only ever runs once per card - result is cached)
  // ---------------------------------------------------------------------

  function getLeafTexts(card) {
    const texts = [];
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_ELEMENT, null);
    let node = walker.currentNode;
    let visited = 0;
    while (node && visited < 250) {
      if (node.children.length === 0) {
        const text = (node.textContent || "").trim();
        if (text && text.length <= 40) texts.push(text);
      }
      node = walker.nextNode();
      visited++;
    }
    return texts;
  }

  /**
   * Scans a card's short leaf-node text (badges like "New on Etsy" or
   * "1 month on Etsy" are usually their own small element) for a shop-age
   * indicator. One walk serves both the "new" and "N months" cases, since
   * they're the same underlying concept at different values.
   */
  function detectShopAgeFromCard(card) {
    const leafTexts = getLeafTexts(card);
    for (let i = 0; i < leafTexts.length; i++) {
      const months = parseShopAgeMonths(leafTexts[i]);
      if (months !== null) return months;
    }
    return null;
  }

  /**
   * Extracts everything we can learn about a card from its own (small)
   * subtree, plus anything already known for its shop/listing from the
   * public-data cache. Runs exactly once per card - callers must check
   * cardCache.has(card) first.
   */
  function extractCardMetadata(card) {
    const listingId = extractListingId(card);
    const listingUrl = extractListingUrl(card);
    const { shopName, shopUrl } = extractShopInfo(card);

    const cardAge = detectShopAgeFromCard(card);
    let shopAgeMonths = cardAge;
    let shopAgeSource = cardAge !== null ? "card" : "unknown";

    const cardSales = parseSalesText(getCardText(card));
    let salesCount = null;
    let salesSource = "unknown";
    let salesScope = null;
    if (cardSales !== null) {
      salesCount = cardSales;
      salesSource = "card";
      salesScope = "listing";
    }

    if (shopAgeSource === "unknown" || salesSource === "unknown") {
      const cacheKey = shopUrl || listingUrl;
      const cached = cacheKey ? inMemoryPublicDataCache[cacheKey] : null;
      if (cached) {
        if (salesSource === "unknown" && cached.salesSource) {
          salesCount = cached.salesCount;
          salesSource = cached.salesSource;
          salesScope = cached.salesScope || null;
        }
        if (shopAgeSource === "unknown" && cached.shopAgeSource) {
          shopAgeMonths = cached.shopAgeMonths;
          shopAgeSource = cached.shopAgeSource;
        }
      }
    }

    return {
      listingId,
      listingUrl,
      shopName,
      shopUrl,
      shopAgeMonths,
      shopAgeSource,
      salesCount,
      salesSource,
      salesScope,
      lastProcessedAt: Date.now(),
    };
  }

  // ---------------------------------------------------------------------
  // Idle-time processing queue
  // ---------------------------------------------------------------------

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
        cardCache.set(card, extractCardMetadata(card));
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

  // ---------------------------------------------------------------------
  // Style/visibility updates (batched into a single rAF per pass)
  // ---------------------------------------------------------------------

  function formatShopAge(months) {
    if (months === 0) return "New on Etsy";
    if (months === 1) return "1 month on Etsy";
    return `${months} months on Etsy`;
  }

  function shopAgeStatusLabel(meta) {
    if (meta.shopAgeMonths !== null && meta.shopAgeMonths !== undefined) {
      return `Shop age found: ${formatShopAge(meta.shopAgeMonths)}`;
    }
    if (meta.shopAgeSource === "unavailable") return "Shop age unavailable";
    return "Public page fetch required";
  }

  function salesStatusLabel(meta) {
    if (meta.salesCount !== null && meta.salesCount !== undefined) {
      if (meta.salesSource === "public") {
        const scopeLabel = meta.salesScope === "shop" ? "shop total, public page" : "public page";
        return `Sales: ${meta.salesCount.toLocaleString()} (${scopeLabel})`;
      }
      return `Sales: ${meta.salesCount.toLocaleString()} (found in card)`;
    }
    if (meta.salesSource === "unavailable") return "Sales: unavailable";
    return "Sales: not fetched yet";
  }

  function annotateCard(card, meta, visible, { shopAgeActive, salesActive }) {
    let badge = card.querySelector(`:scope > .${BADGE_CLASS}`);
    const filtersActive = shopAgeActive || salesActive;

    if (!visible || !filtersActive) {
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

    const parts = [];
    if (shopAgeActive) parts.push(shopAgeStatusLabel(meta));
    if (salesActive) parts.push(salesStatusLabel(meta));

    badge.textContent = `Matched by Etsy Filter · ${parts.join(" · ")}`;
    badge.title = "";
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

    if (filter === "new") return known && age === 0;
    if (filter === "1m") return known && age <= 1;
    if (filter === "2m") return known && age <= 2;
    return true;
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

    const minSales = currentSettings.minSales !== "" ? Number(currentSettings.minSales) : null;
    const maxSales = currentSettings.maxSales !== "" ? Number(currentSettings.maxSales) : null;
    const hasMin = minSales !== null && !Number.isNaN(minSales);
    const hasMax = maxSales !== null && !Number.isNaN(maxSales);
    const shopAgeActive = !!currentSettings.shopAgeFilter && currentSettings.shopAgeFilter !== "all";
    const salesActive = hasMin || hasMax;

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
      let visible = true;

      if (shopAgeActive && !passesShopAgeFilter(meta)) {
        visible = false;
      }

      if (visible && salesActive) {
        const salesKnown = meta.salesCount !== null && meta.salesCount !== undefined;
        if (!salesKnown) {
          visible = !currentSettings.hideUnavailableSales;
        } else {
          if (hasMin && meta.salesCount < minSales) visible = false;
          if (hasMax && meta.salesCount > maxSales) visible = false;
        }
      }

      card.style.display = visible ? "" : "none";
      annotateCard(card, meta, visible, { shopAgeActive, salesActive });
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
  // Level 2: optional public-page enrichment (sales + shop age), user-initiated only
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
   * Fetches a public Etsy page and looks for a visible sales count and/or
   * shop-age text in its rendered text. Uses credentials: 'omit' deliberately
   * - we only want whatever a logged-out visitor could see, never an
   * authenticated view.
   */
  async function fetchPublicPageData(url, signal) {
    const response = await fetch(url, { credentials: "omit", signal });
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const text = doc.body ? doc.body.textContent : html;
    return {
      salesCount: parseSalesText(text),
      shopAgeMonths: parseShopAgeMonths(text),
    };
  }

  /**
   * Builds one fetch target per unique shop/listing among currently visible,
   * unresolved cards - never per card. Several cards from the same shop
   * collapse into a single request, and only the currently-loaded, currently
   * visible (not hidden by our own filters), not-yet-attempted set is
   * considered - never the whole page, never automatically. A single fetch
   * is used to resolve BOTH sales and shop age at once.
   */
  function buildFetchTargets() {
    const targetMap = new Map();

    knownCards.forEach((card) => {
      if (!document.contains(card) || card.style.display === "none") return;

      const meta = cardCache.get(card);
      if (!meta) return;

      const needsSales = meta.salesSource === "unknown";
      const needsAge = meta.shopAgeSource === "unknown";
      if (!needsSales && !needsAge) return;

      const key = meta.shopUrl || meta.listingUrl;
      if (!key || attemptedFetchKeys.has(key)) return;

      if (!targetMap.has(key)) {
        targetMap.set(key, {
          key,
          url: meta.shopUrl || meta.listingUrl,
          scope: meta.shopUrl ? "shop" : "listing",
          cards: [],
        });
      }
      targetMap.get(key).cards.push(card);
    });

    return Array.from(targetMap.values());
  }

  async function processFetchTarget(target) {
    attemptedFetchKeys.add(target.key);

    let result = inMemoryPublicDataCache[target.key] || null;
    if (!result) {
      try {
        const { salesCount, shopAgeMonths } = await fetchPublicPageData(
          target.url,
          fetchState.abortController.signal
        );
        result = {
          salesCount,
          salesSource: salesCount !== null ? "public" : "unavailable",
          salesScope: target.scope,
          shopAgeMonths,
          shopAgeSource: shopAgeMonths !== null ? "public" : "unavailable",
        };
      } catch (err) {
        result = {
          salesCount: null,
          salesSource: "unavailable",
          salesScope: target.scope,
          shopAgeMonths: null,
          shopAgeSource: "unavailable",
        };
      }
      inMemoryPublicDataCache[target.key] = result;
      setCachedPublicDataEntry(target.key, result).catch(() => {
        /* best-effort persistence only */
      });
    }

    if (result.salesCount !== null && result.salesCount !== undefined) {
      fetchState.found++;
    } else {
      fetchState.unavailable++;
    }

    target.cards.forEach((card) => {
      const meta = cardCache.get(card) || {};
      const merged = { ...meta, lastProcessedAt: Date.now() };
      if (meta.salesSource === "unknown") {
        merged.salesCount = result.salesCount;
        merged.salesSource = result.salesSource;
        merged.salesScope = result.salesScope;
      }
      if (meta.shopAgeSource === "unknown") {
        merged.shopAgeMonths = result.shopAgeMonths;
        merged.shopAgeSource = result.shopAgeSource;
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
          <legend>Shop Age Filter</legend>
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
            <span>1 month on Etsy or newer</span>
          </label>
          <label class="etsy-filter-row etsy-filter-radio-row">
            <input type="radio" name="etsy-filter-shop-age" value="2m" id="etsy-filter-age-2m" />
            <span>2 months on Etsy or newer</span>
          </label>
        </fieldset>
        <label class="etsy-filter-row">
          <span>Minimum public sales</span>
          <input type="number" min="0" inputmode="numeric" id="etsy-filter-min-sales" placeholder="e.g. 50" />
        </label>
        <label class="etsy-filter-row">
          <span>Maximum public sales</span>
          <input type="number" min="0" inputmode="numeric" id="etsy-filter-max-sales" placeholder="e.g. 5000" />
        </label>
        <label class="etsy-filter-row etsy-filter-checkbox-row">
          <input type="checkbox" id="etsy-filter-hide-unavailable" />
          <span>Hide listings with unavailable sales</span>
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

    panel.querySelector("#etsy-filter-min-sales").value = currentSettings.minSales || "";
    panel.querySelector("#etsy-filter-max-sales").value = currentSettings.maxSales || "";
    panel.querySelector("#etsy-filter-hide-unavailable").checked = !!currentSettings.hideUnavailableSales;
    panel.querySelector("#etsy-filter-debug-mode").checked = !!currentSettings.debugMode;
    panel.classList.toggle("etsy-filter-disabled", !currentSettings.enabled);
  }

  function readPanelValues() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return {};
    const checkedAge = panel.querySelector('input[name="etsy-filter-shop-age"]:checked');
    return {
      shopAgeFilter: checkedAge ? checkedAge.value : "all",
      minSales: panel.querySelector("#etsy-filter-min-sales").value.trim(),
      maxSales: panel.querySelector("#etsy-filter-max-sales").value.trim(),
      hideUnavailableSales: panel.querySelector("#etsy-filter-hide-unavailable").checked,
    };
  }

  function onApplyClicked() {
    const values = readPanelValues();
    currentSettings = { ...currentSettings, ...values };
    saveSettings(values);
    scheduleStyleUpdate();
  }

  function onResetClicked() {
    const cleared = { shopAgeFilter: "all", minSales: "", maxSales: "", hideUnavailableSales: false };
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
          `Sales found: ${fetchState.found}, Unavailable: ${fetchState.unavailable}`
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
    // Page-specific DOM tracking only. Deliberately NOT cleared:
    //   - cardCache (WeakMap): old cards are simply unreachable once dropped
    //     from knownCards, and get garbage-collected naturally.
    //   - inMemoryPublicDataCache / attemptedFetchKeys: shop/listing facts
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
      inMemoryPublicDataCache = await getPublicDataCache();
    } catch (err) {
      inMemoryPublicDataCache = {};
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
