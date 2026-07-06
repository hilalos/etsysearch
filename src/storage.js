/**
 * storage.js
 * Thin wrapper around chrome.storage.sync for the extension's settings.
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
  };

  const STORAGE_KEY = "etsyFilterSettings";

  /**
   * Resolves with the saved settings merged over the defaults.
   */
  function getSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(STORAGE_KEY, (result) => {
          if (chrome.runtime.lastError) {
            resolve({ ...DEFAULT_SETTINGS });
            return;
          }
          const saved = result && result[STORAGE_KEY] ? result[STORAGE_KEY] : {};
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
          chrome.storage.sync.set({ [STORAGE_KEY]: merged }, () => {
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
      if (areaName !== "sync" || !changes[STORAGE_KEY]) return;
      callback(changes[STORAGE_KEY].newValue || { ...DEFAULT_SETTINGS });
    });
  }

  global.EtsyFilterStorage = {
    DEFAULT_SETTINGS,
    getSettings,
    saveSettings,
    onSettingsChanged,
  };
})(window);
