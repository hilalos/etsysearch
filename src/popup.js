/**
 * popup.js
 * Wires up the toolbar popup: enable/disable toggle, "Open Etsy Search"
 * shortcut, and a status line describing whether the extension is active
 * on the current tab.
 */
(function () {
  "use strict";

  const { getSettings, saveSettings } = window.EtsyFilterStorage;

  const ETSY_SEARCH_URL = "https://www.etsy.com/search";
  const ETSY_ACTIVE_PATTERN = /^https:\/\/www\.etsy\.com\/(.*\/)?(search|market)/;

  const toggle = document.getElementById("enable-toggle");
  const statusEl = document.getElementById("popup-status");
  const openBtn = document.getElementById("open-etsy-btn");
  const openDashboardBtn = document.getElementById("open-dashboard-btn");

  function isEtsySearchUrl(url) {
    return !!url && ETSY_ACTIVE_PATTERN.test(url);
  }

  function renderStatus(activeOnTab) {
    if (activeOnTab) {
      statusEl.textContent = "Active on this Etsy search page.";
      statusEl.className = "popup-status active";
    } else {
      statusEl.textContent = "Inactive - active only on Etsy search pages.";
      statusEl.className = "popup-status inactive";
    }
  }

  async function init() {
    const settings = await getSettings();
    toggle.checked = !!settings.enabled;

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const currentTab = tabs && tabs[0];
      renderStatus(isEtsySearchUrl(currentTab && currentTab.url));
    });

    toggle.addEventListener("change", () => {
      saveSettings({ enabled: toggle.checked });
    });

    openBtn.addEventListener("click", () => {
      chrome.tabs.create({ url: ETSY_SEARCH_URL });
    });

    openDashboardBtn.addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("src/dashboard.html") });
    });
  }

  init();
})();
