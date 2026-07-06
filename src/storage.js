/**
 * storage.js
 * Storage areas, deliberately kept separate:
 *   - chrome.storage.sync: small user-configured filter settings, shared
 *     across the user's signed-in Chrome instances.
 *   - chrome.storage.local: everything else, since it can grow larger
 *     (one entry per shop/keyword ever scanned) and has no reason to sync:
 *       - Shop Directory: accumulated public facts about every shop the
 *         extension has ever scanned, from either the live floating panel
 *         or a Keyword Hunter research run.
 *       - Keyword Directory: every keyword ever discovered/analyzed by
 *         Keyword Hunter, with its niche-opportunity analysis.
 *       - Saved items: user bookmarks (keywords or shops) for the Saved tab.
 * Shared by content.js, popup.js, research.js, and dashboard.js so the
 * shape of each store lives in exactly one place.
 */
(function (global) {
  "use strict";

  const DEFAULT_SETTINGS = {
    enabled: true,
    shopAgeFilter: "all", // 'all' | 'new' | '1m' | '2m' | '3m' | '6m' (maximum shop age)
    digitalOnly: false,
    minRating: "",
    minReviews: "",
    minShopTotalSales: "",
    minSalesVelocity: "",
    hideUnavailableData: false,
    debugMode: false,
    panelPosition: null, // { top, left } in px, or null to use the default top-right anchor
    panelMinimized: false,
  };

  const SETTINGS_KEY = "etsyFilterSettings";
  const SHOP_DIRECTORY_KEY = "etsyShopDirectory";
  const KEYWORD_DIRECTORY_KEY = "etsyKeywordDirectory";
  const SAVED_ITEMS_KEY = "etsySavedItems";

  // A field known from an actual card beats one found via a public-page
  // fetch, which beats a confirmed "unavailable", which beats "unknown".
  // Used whenever two observations of the same shop disagree.
  const SOURCE_RANK = { card: 3, public: 2, unavailable: 1, unknown: 0 };
  // Maps each shop-level value field to its companion "<field> came from
  // where" field. Not a naive `${field}Source` concatenation - shopAgeMonths
  // and reviewsCount don't follow that pattern (shopAgeSource, reviewsSource).
  const SHOP_LEVEL_FIELDS = [
    ["shopTotalSales", "shopTotalSalesSource"],
    ["shopAgeMonths", "shopAgeSource"],
    ["rating", "ratingSource"],
    ["reviewsCount", "reviewsSource"],
  ];

  function storageGet(area, key, fallback) {
    return new Promise((resolve) => {
      try {
        chrome.storage[area].get(key, (result) => {
          if (chrome.runtime.lastError) {
            resolve(fallback);
            return;
          }
          resolve(result && result[key] !== undefined ? result[key] : fallback);
        });
      } catch (err) {
        resolve(fallback);
      }
    });
  }

  function storageSet(area, key, value) {
    return new Promise((resolve) => {
      try {
        chrome.storage[area].set({ [key]: value }, () => resolve(value));
      } catch (err) {
        resolve(value);
      }
    });
  }

  // -----------------------------------------------------------------------
  // Filter settings (chrome.storage.sync)
  // -----------------------------------------------------------------------

  function getSettings() {
    return storageGet("sync", SETTINGS_KEY, {}).then((saved) => ({ ...DEFAULT_SETTINGS, ...saved }));
  }

  function saveSettings(partialSettings) {
    return getSettings().then((current) => storageSet("sync", SETTINGS_KEY, { ...current, ...partialSettings }));
  }

  function onSettingsChanged(callback) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync" || !changes[SETTINGS_KEY]) return;
      callback(changes[SETTINGS_KEY].newValue || { ...DEFAULT_SETTINGS });
    });
  }

  // -----------------------------------------------------------------------
  // Shop Directory (chrome.storage.local)
  // Entry shape: { shopUrl, shopName,
  //   shopTotalSales, shopTotalSalesSource,
  //   shopAgeMonths, shopAgeSource,
  //   rating, ratingSource,
  //   reviewsCount, reviewsSource,
  //   observedListingIds: string[] (capped, for de-duplicated counting),
  //   listingsObserved, digitalListingsObserved,
  //   sampleTitles: string[] (capped, for pattern analysis),
  //   sourceKeywords: string[] (capped, which searches surfaced this shop),
  //   firstSeenAt, lastSeenAt }
  // Every field is shop-level (the shop's all-time sales total, age,
  // overall rating/review count) - never a per-product figure, since Etsy
  // doesn't expose one publicly.
  // -----------------------------------------------------------------------

  function getShopDirectory() {
    return storageGet("local", SHOP_DIRECTORY_KEY, {});
  }

  function blankShopDirectoryEntry(shopUrl) {
    return {
      shopUrl,
      shopName: null,
      shopTotalSales: null,
      shopTotalSalesSource: "unknown",
      shopAgeMonths: null,
      shopAgeSource: "unknown",
      rating: null,
      ratingSource: "unknown",
      reviewsCount: null,
      reviewsSource: "unknown",
      observedListingIds: [],
      listingsObserved: 0,
      digitalListingsObserved: 0,
      sampleTitles: [],
      sourceKeywords: [],
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
    };
  }

  /**
   * Merges one observation into a shop directory entry (in memory - callers
   * batch several of these and persist once via saveShopDirectory, so
   * scanning dozens of cards during a scroll never means dozens of separate
   * storage writes).
   */
  function mergeShopObservation(directory, observation) {
    const { shopUrl } = observation;
    if (!shopUrl) return directory;

    const existing = directory[shopUrl] || blankShopDirectoryEntry(shopUrl);
    const merged = { ...existing, lastSeenAt: Date.now() };
    if (observation.shopName) merged.shopName = observation.shopName;

    SHOP_LEVEL_FIELDS.forEach(([field, sourceField]) => {
      const incomingSource = observation[sourceField];
      if (incomingSource === undefined) return;
      const incomingRank = SOURCE_RANK[incomingSource] || 0;
      const existingRank = SOURCE_RANK[merged[sourceField]] || 0;
      if (incomingRank > existingRank) {
        merged[field] = observation[field];
        merged[sourceField] = incomingSource;
      }
    });

    if (observation.listingId && !merged.observedListingIds.includes(observation.listingId)) {
      merged.observedListingIds = [...merged.observedListingIds, observation.listingId].slice(-200);
      merged.listingsObserved = merged.observedListingIds.length;
      if (observation.isDigital) merged.digitalListingsObserved += 1;
      if (observation.listingTitle) {
        merged.sampleTitles = [...merged.sampleTitles, observation.listingTitle].slice(-30);
      }
    }

    if (observation.sourceKeyword && !merged.sourceKeywords.includes(observation.sourceKeyword)) {
      merged.sourceKeywords = [...merged.sourceKeywords, observation.sourceKeyword].slice(-20);
    }

    return { ...directory, [shopUrl]: merged };
  }

  /**
   * Applies a batch of shop observations in one read + one write, instead
   * of one storage round trip per listing card - the whole point being that
   * scrolling past 60 cards costs one write, not 60.
   */
  function upsertShopDirectoryEntries(observations) {
    if (!observations || observations.length === 0) return Promise.resolve({});
    return getShopDirectory().then((directory) => {
      let next = directory;
      observations.forEach((observation) => {
        next = mergeShopObservation(next, observation);
      });
      return storageSet("local", SHOP_DIRECTORY_KEY, next).then(() => next);
    });
  }

  // -----------------------------------------------------------------------
  // Keyword Directory (chrome.storage.local)
  // Entry shape: { keyword, source, discoveredAt, analyzedAt, resultCount,
  //   newShopCount, bestYoungShop, avgReviews, avgRating,
  //   digitalDominancePercent, avgVelocityOfYoungShops,
  //   nicheScore, nicheLabel, nicheReasons, relatedSearches }
  // -----------------------------------------------------------------------

  function getKeywordDirectory() {
    return storageGet("local", KEYWORD_DIRECTORY_KEY, {});
  }

  function upsertKeywordDirectoryEntry(keyword, data) {
    return getKeywordDirectory().then((directory) => {
      const existing = directory[keyword] || { keyword, source: "seed", discoveredAt: Date.now() };
      const merged = { ...existing, ...data, keyword, analyzedAt: Date.now() };
      const next = { ...directory, [keyword]: merged };
      return storageSet("local", KEYWORD_DIRECTORY_KEY, next).then(() => merged);
    });
  }

  /**
   * Records keyword strings as "discovered but not yet analyzed" (e.g. a
   * related-search suggestion found on another keyword's results page),
   * without overwriting an existing, already-analyzed entry.
   */
  function recordDiscoveredKeywords(keywords, source) {
    if (!keywords || keywords.length === 0) return Promise.resolve({});
    return getKeywordDirectory().then((directory) => {
      const next = { ...directory };
      keywords.forEach((keyword) => {
        if (next[keyword]) return;
        next[keyword] = { keyword, source, discoveredAt: Date.now() };
      });
      return storageSet("local", KEYWORD_DIRECTORY_KEY, next).then(() => next);
    });
  }

  // -----------------------------------------------------------------------
  // Saved items (chrome.storage.local) - user bookmarks for the Saved tab.
  // Entry shape: { id, type: 'keyword' | 'shop', savedAt, data }
  // -----------------------------------------------------------------------

  function getSavedItems() {
    return storageGet("local", SAVED_ITEMS_KEY, {});
  }

  function saveItem(type, id, data) {
    return getSavedItems().then((items) => {
      const next = { ...items, [`${type}:${id}`]: { id, type, savedAt: Date.now(), data } };
      return storageSet("local", SAVED_ITEMS_KEY, next).then(() => next);
    });
  }

  function removeSavedItem(type, id) {
    return getSavedItems().then((items) => {
      const next = { ...items };
      delete next[`${type}:${id}`];
      return storageSet("local", SAVED_ITEMS_KEY, next).then(() => next);
    });
  }

  global.EtsyFilterStorage = {
    DEFAULT_SETTINGS,
    getSettings,
    saveSettings,
    onSettingsChanged,
    getShopDirectory,
    upsertShopDirectoryEntries,
    getKeywordDirectory,
    upsertKeywordDirectoryEntry,
    recordDiscoveredKeywords,
    getSavedItems,
    saveItem,
    removeSavedItem,
  };
})(window);
