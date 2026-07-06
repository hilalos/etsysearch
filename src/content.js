/**
 * content.js
 * Injected on Etsy search / market pages. Renders a floating filter panel
 * and hides listing cards that don't match the user's filters.
 *
 * Depends on window.EtsyFilterUtils (utils.js) and window.EtsyFilterStorage
 * (storage.js), both loaded before this file per manifest.json ordering.
 */
(function () {
  "use strict";

  const { debounce, parseSalesText, isNewIndicatorText, getCardText, findSalesSnippet } =
    window.EtsyFilterUtils || {};
  const { getSettings, saveSettings, onSettingsChanged, DEFAULT_SETTINGS } =
    window.EtsyFilterStorage || {};

  if (!debounce || !getSettings) {
    // Dependencies failed to load; nothing we can safely do.
    return;
  }

  const PANEL_ID = "etsy-filter-panel";
  const BADGE_CLASS = "etsy-filter-badge";
  const LIMITATION_NOTE =
    "Sales filtering depends on publicly visible sales data. If Etsy does not display sales numbers on the search page, the extension cannot calculate them accurately.";

  let currentSettings = { ...DEFAULT_SETTINGS };
  let observer = null;
  let isApplying = false;

  function isSearchPage() {
    const path = location.pathname || "";
    return path.includes("/search") || path.includes("/market/");
  }

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

  function findListingCards() {
    const anchors = document.querySelectorAll('a[href*="/listing/"]');
    const cards = new Set();
    anchors.forEach((anchor) => {
      const card = resolveCardFromAnchor(anchor);
      if (card) cards.add(card);
    });
    return Array.from(cards);
  }

  /**
   * Collects short leaf-node text snippets inside a card. Badges like
   * "New on Etsy" are usually their own small element, so scanning leaf
   * text (rather than the whole card's mashed-together textContent)
   * avoids false positives from unrelated copy.
   */
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

  function detectIsNew(card) {
    const leafTexts = getLeafTexts(card);
    return leafTexts.some((text) => isNewIndicatorText(text));
  }

  function detectSales(card) {
    const text = getCardText(card);
    return parseSalesText(text);
  }

  function annotateCard(card, { isNew, sales, visible, filtersActive }) {
    let badge = card.querySelector(`:scope > .${BADGE_CLASS}`);

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

    const salesLabel = sales === null ? "Sales: unavailable" : `Sales: ${sales.toLocaleString()}`;
    badge.textContent = `Matched by Etsy Filter · ${salesLabel}`;
    badge.title = isNew ? "Detected as new on Etsy" : "";
  }

  function showAllCards() {
    findListingCards().forEach((card) => {
      card.style.display = "";
      const badge = card.querySelector(`:scope > .${BADGE_CLASS}`);
      if (badge) badge.remove();
    });
  }

  function applyFilters() {
    if (isApplying) return;
    isApplying = true;

    try {
      if (!currentSettings.enabled) {
        showAllCards();
        updateStatus(null);
        return;
      }

      const cards = findListingCards();
      const minSales = currentSettings.minSales !== "" ? Number(currentSettings.minSales) : null;
      const maxSales = currentSettings.maxSales !== "" ? Number(currentSettings.maxSales) : null;
      const hasValidMin = minSales !== null && !Number.isNaN(minSales);
      const hasValidMax = maxSales !== null && !Number.isNaN(maxSales);
      const filtersActive = currentSettings.newOnEtsyOnly || hasValidMin || hasValidMax;

      let visibleCount = 0;

      cards.forEach((card) => {
        const isNew = detectIsNew(card);
        const sales = detectSales(card);
        let visible = true;

        if (currentSettings.newOnEtsyOnly && !isNew) {
          visible = false;
        }

        if (visible && (hasValidMin || hasValidMax)) {
          if (sales === null) {
            visible = false; // unavailable sales data is hidden whenever a sales range is set
          } else {
            if (hasValidMin && sales < minSales) visible = false;
            if (hasValidMax && sales > maxSales) visible = false;
          }
        }

        card.style.display = visible ? "" : "none";
        annotateCard(card, { isNew, sales, visible, filtersActive });
        if (visible) visibleCount++;
      });

      updateStatus({ visible: visibleCount, total: cards.length });
    } finally {
      isApplying = false;
    }
  }

  const debouncedApplyFilters = debounce(applyFilters, 400);

  // ---------------------------------------------------------------------
  // Floating panel UI
  // ---------------------------------------------------------------------

  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="etsy-filter-header">
        <span class="etsy-filter-title">Etsy Advanced Filter</span>
        <button type="button" class="etsy-filter-collapse" aria-label="Collapse panel">&minus;</button>
      </div>
      <div class="etsy-filter-body">
        <label class="etsy-filter-row etsy-filter-checkbox-row">
          <input type="checkbox" id="etsy-filter-new-only" />
          <span>New on Etsy only</span>
        </label>
        <label class="etsy-filter-row">
          <span>Minimum sales</span>
          <input type="number" min="0" inputmode="numeric" id="etsy-filter-min-sales" placeholder="e.g. 50" />
        </label>
        <label class="etsy-filter-row">
          <span>Maximum sales</span>
          <input type="number" min="0" inputmode="numeric" id="etsy-filter-max-sales" placeholder="e.g. 5000" />
        </label>
        <div class="etsy-filter-actions">
          <button type="button" id="etsy-filter-apply">Apply Filters</button>
          <button type="button" id="etsy-filter-reset">Reset</button>
        </div>
        <div class="etsy-filter-status" id="etsy-filter-status" role="status"></div>
        <div class="etsy-filter-note">${LIMITATION_NOTE}</div>
      </div>
    `;

    document.body.appendChild(panel);

    panel.querySelector(".etsy-filter-collapse").addEventListener("click", () => {
      panel.classList.toggle("etsy-filter-collapsed");
    });

    panel.querySelector("#etsy-filter-apply").addEventListener("click", onApplyClicked);
    panel.querySelector("#etsy-filter-reset").addEventListener("click", onResetClicked);
  }

  function syncPanelFromSettings() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    panel.querySelector("#etsy-filter-new-only").checked = !!currentSettings.newOnEtsyOnly;
    panel.querySelector("#etsy-filter-min-sales").value = currentSettings.minSales || "";
    panel.querySelector("#etsy-filter-max-sales").value = currentSettings.maxSales || "";
    panel.classList.toggle("etsy-filter-disabled", !currentSettings.enabled);
  }

  function readPanelValues() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return {};
    return {
      newOnEtsyOnly: panel.querySelector("#etsy-filter-new-only").checked,
      minSales: panel.querySelector("#etsy-filter-min-sales").value.trim(),
      maxSales: panel.querySelector("#etsy-filter-max-sales").value.trim(),
    };
  }

  function onApplyClicked() {
    const values = readPanelValues();
    currentSettings = { ...currentSettings, ...values };
    saveSettings(values);
    applyFilters();
  }

  function onResetClicked() {
    const cleared = { newOnEtsyOnly: false, minSales: "", maxSales: "" };
    currentSettings = { ...currentSettings, ...cleared };
    syncPanelFromSettings();
    saveSettings(cleared);
    applyFilters();
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

  // ---------------------------------------------------------------------
  // Dynamic content handling (infinite scroll / lazy loading)
  // ---------------------------------------------------------------------

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(() => {
      debouncedApplyFilters();
    });
    observer.observe(document.body, { childList: true, subtree: true });
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

    createPanel();
    syncPanelFromSettings();
    applyFilters();
    startObserver();

    onSettingsChanged((newSettings) => {
      currentSettings = newSettings;
      syncPanelFromSettings();
      applyFilters();
    });
  }

  init().catch(() => {
    /* fail silently: extension should never break the host page */
  });
})();
