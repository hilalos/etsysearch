/**
 * utils.js
 * Pure helper functions shared by content.js.
 * No DOM mutation happens here - only reading/parsing.
 * Exposed on window.EtsyFilterUtils so plain <script> content scripts can share it
 * without a bundler or ES module setup.
 */
(function (global) {
  "use strict";

  /**
   * Debounce: delays invoking `fn` until `wait` ms have passed since the last call.
   * Used to avoid running the filter pass on every single MutationObserver tick
   * during infinite scroll.
   */
  function debounce(fn, wait) {
    let timer = null;
    return function debounced(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  /**
   * Parses free-form sales text into an integer, or null if unavailable.
   * Handles:
   *   "1,234 sales" -> 1234
   *   "123 sales"   -> 123
   *   "10k sales"   -> 10000
   *   "2.5k sales"  -> 2500
   *   "1.2m sales"  -> 1200000
   */
  function parseSalesText(text) {
    if (!text) return null;
    const cleaned = text.replace(/ /g, " ").trim();

    // Look for a number (with optional comma/decimal) followed by an optional k/m suffix,
    // then eventually the word "sales" (case-insensitive) somewhere nearby.
    const match = cleaned.match(/([\d,]+(?:\.\d+)?)\s*(k|m)?\s*(?=\+?\s*sales)/i);
    if (!match) return null;

    const numberPart = match[1].replace(/,/g, "");
    const suffix = (match[2] || "").toLowerCase();
    let value = parseFloat(numberPart);
    if (Number.isNaN(value)) return null;

    if (suffix === "k") value *= 1000;
    else if (suffix === "m") value *= 1000000;

    return Math.round(value);
  }

  /**
   * Returns true if the given text looks like a "new listing / new shop" indicator.
   */
  function isNewIndicatorText(text) {
    if (!text) return false;
    const normalized = text.trim().toLowerCase();
    if (!normalized) return false;

    const patterns = [
      /\bnew on etsy\b/,
      /\brecently listed\b/,
      /\bnew listing\b/,
      /\bnew seller\b/,
      /\bnew shop\b/,
      /^new$/,
    ];

    return patterns.some((re) => re.test(normalized));
  }

  /**
   * Walks all text nodes/attributes of an element and returns the concatenated
   * visible text, cheaply, for pattern matching. Avoids using innerText which
   * forces layout.
   */
  function getCardText(card) {
    return card.textContent || "";
  }

  /**
   * Finds the first substring in `text` that matches a "sales" pattern and
   * returns the raw matched snippet (useful for display), or null.
   */
  function findSalesSnippet(text) {
    if (!text) return null;
    const match = text.match(/([\d,]+(?:\.\d+)?\s*[km]?\+?\s*sales)/i);
    return match ? match[0].trim() : null;
  }

  global.EtsyFilterUtils = {
    debounce,
    parseSalesText,
    isNewIndicatorText,
    getCardText,
    findSalesSnippet,
  };
})(window);
