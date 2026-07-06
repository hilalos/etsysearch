/**
 * storage.js
 * Two storage areas are used, deliberately kept separate:
 *   - chrome.storage.sync: small user-configured filter settings, shared
 *     across the user's signed-in Chrome instances.
 *   - chrome.storage.local: the public-sales-data cache keyed by shop/listing
 *     URL. This can grow larger (one entry per fetched shop/listing) and has
 *     no reason to sync across devices, so it stays local.
 * Shared by both content.js and popup.js so the shape of the settings
 * object lives in exactly one place.
 */
(function (global) {
  "use strict";

  const DEFAULT_SETTINGS = {
    enabled: true,
    newOnEtsyOnly: false,
    minSales: "",
    maxSales: "",
    hideUnavailableSales: false,
  };

  const SETTINGS_KEY = "etsyFilterSettings";
  const SALES_CACHE_KEY = "etsyFilterSalesCache";

  /**
   * Resolves with the saved settings merged over the defaults.
   */
  function getSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(SETTINGS_KEY, (result) => {
          if (chrome.runtime.lastError) {
            resolve({ ...DEFAULT_SETTINGS });
            return;
          }
          const saved = result && result[SETTINGS_KEY] ? result[SETTINGS_KEY] : {};
          resolve({ ...DEFAULT_SETTINGS, ...saved });
        });
      } catch (err) {
        resolve({ ...DEFAULT_SETTINGS });
      }
    });
  }

  /**
   * Persists a partial settings update, merged with whatever is already saved.
   */
  function saveSettings(partialSettings) {
    return getSettings().then((current) => {
      const merged = { ...current, ...partialSettings };
      return new Promise((resolve) => {
        try {
          chrome.storage.sync.set({ [SETTINGS_KEY]: merged }, () => {
            resolve(merged);
          });
        } catch (err) {
          resolve(merged);
        }
      });
    });
  }

  /**
   * Subscribes to live changes made from another context (e.g. popup <-> content script).
   */
  function onSettingsChanged(callback) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync" || !changes[SETTINGS_KEY]) return;
      callback(changes[SETTINGS_KEY].newValue || { ...DEFAULT_SETTINGS });
    });
  }

  /**
   * Returns the full public-sales cache: { [shopUrlOrListingUrl]: { salesCount, source, scope, fetchedAt } }
   */
  function getSalesCache() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(SALES_CACHE_KEY, (result) => {
          if (chrome.runtime.lastError) {
            resolve({});
            return;
          }
          resolve((result && result[SALES_CACHE_KEY]) || {});
        });
      } catch (err) {
        resolve({});
      }
    });
  }

  /**
   * Stores/updates a single cache entry, keyed by shop URL (preferred, since
   * it's reusable across every listing from that shop) or listing URL.
   */
  function setCachedSalesEntry(key, entry) {
    return getSalesCache().then((cache) => {
      const merged = { ...cache, [key]: { ...entry, fetchedAt: Date.now() } };
      return new Promise((resolve) => {
        try {
          chrome.storage.local.set({ [SALES_CACHE_KEY]: merged }, () => {
            resolve(merged[key]);
          });
        } catch (err) {
          resolve(merged[key]);
        }
      });
    });
  }

  global.EtsyFilterStorage = {
    DEFAULT_SETTINGS,
    getSettings,
    saveSettings,
    onSettingsChanged,
    getSalesCache,
    setCachedSalesEntry,
  };
})(window);
