/**
 * utils.js
 * Pure helper functions shared by content.js.
 * No DOM mutation happens here - only reading/parsing small, already-scoped
 * strings/elements (a single listing card, a single anchor). Callers are
 * responsible for never handing this module a large container or the whole
 * document - see content.js's performance notes.
 * Exposed on window.EtsyFilterUtils so plain <script> content scripts can share it
 * without a bundler or ES module setup.
 */
(function (global) {
  "use strict";

  /**
   * Debounce: delays invoking `fn` until `wait` ms have passed since the last call.
   * Used to avoid running expensive work on every single MutationObserver tick
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
   * Cheap pre-check so callers can skip the full parseSalesText regex when a
   * card obviously has no sales-related text at all.
   */
  function containsSalesKeyword(text) {
    return !!text && /sales|ventes/i.test(text);
  }

  /**
   * Parses free-form sales text into an integer, or null if unavailable.
   * Supports English and French listings:
   *   "1,234 sales"   -> 1234
   *   "123 sales"     -> 123
   *   "10k sales"     -> 10000
   *   "2.5k sales"    -> 2500
   *   "123 ventes"    -> 123
   *   "1 234 ventes"  -> 1234
   * Never guesses/estimates - returns null whenever no matching text is found.
   */
  function parseSalesText(text) {
    if (!containsSalesKeyword(text)) return null;

    // Normalize non-breaking spaces (common in French-locale Etsy pages) to
    // plain spaces so the group-separator pattern below can match them.
    const cleaned = text.replace(/ /g, " ");

    // group1: the integer part, allowing "," or " " as thousands separators
    // group2: optional decimal digits (e.g. the "5" in "2.5k")
    // group3: optional k/m shorthand suffix
    // followed by a lookahead for "sales" or "ventes" (not consumed, so
    // overlapping/adjacent numbers elsewhere in the text are never confused
    // with this one).
    const match = cleaned.match(
      /(\d[\d,\s]*)(?:\.(\d+))?\s*(k|m)?\s*(?=\+?\s*(?:sales|ventes)\b)/i
    );
    if (!match) return null;

    const integerPart = match[1].replace(/[,\s]/g, "");
    const decimalPart = match[2];
    const suffix = (match[3] || "").toLowerCase();

    const numberText = decimalPart ? `${integerPart}.${decimalPart}` : integerPart;
    let value = parseFloat(numberText);
    if (Number.isNaN(value)) return null;

    if (suffix === "k") value *= 1000;
    else if (suffix === "m") value *= 1000000;

    return Math.round(value);
  }

  /**
   * Turns free-form shop-age text into a whole number of months, or null if
   * the text doesn't describe a shop age at all. "New on Etsy" and its
   * variants are treated as month 0 - there is no separate "is new" concept,
   * it's just the youngest possible age bucket. Never guesses: only text
   * that actually names an age (or a "since <date>" that resolves to one)
   * produces a non-null result.
   *   "New on Etsy"              -> 0
   *   "Recently listed"          -> 0
   *   "1 month on Etsy"          -> 1
   *   "2 months on Etsy"         -> 2
   *   "Etsy seller for 1 month"  -> 1
   *   "On Etsy since 2020"       -> computed from today's date
   */
  function parseShopAgeMonths(text) {
    if (!text) return null;
    const normalized = text.trim().toLowerCase();
    if (!normalized) return null;

    const newPatterns = [
      /\bnew on etsy\b/,
      /\brecently listed\b/,
      /\bnew listing\b/,
      /\bnew seller\b/,
      /\bnew shop\b/,
      /^new$/,
    ];
    if (newPatterns.some((re) => re.test(normalized))) return 0;

    const monthsMatch =
      normalized.match(/(\d+)\s*months?\s+on etsy\b/) ||
      normalized.match(/\betsy seller for\s+(\d+)\s*months?\b/);
    if (monthsMatch) {
      const months = parseInt(monthsMatch[1], 10);
      if (!Number.isNaN(months)) return months;
    }

    const sinceMatch = normalized.match(/\bon etsy since\s+([^\n,]+)/);
    if (sinceMatch) {
      const months = monthsSinceDateText(sinceMatch[1]);
      if (months !== null) return months;
    }

    return null;
  }

  /**
   * Resolves free-form date text (e.g. "2020", "May 2020", "January 1, 2020")
   * into a whole number of months elapsed since then. Returns null if the
   * text can't be parsed as a date at all - never a guessed/estimated value.
   */
  function monthsSinceDateText(dateText) {
    if (!dateText) return null;
    const cleaned = dateText.trim().replace(/[.,]+$/, "");
    if (!cleaned) return null;

    let parsed = Date.parse(cleaned);
    if (Number.isNaN(parsed)) {
      const yearOnly = cleaned.match(/^(\d{4})$/);
      if (yearOnly) parsed = Date.parse(`January 1, ${yearOnly[1]}`);
    }
    if (Number.isNaN(parsed)) return null;

    const since = new Date(parsed);
    const now = new Date();
    let months = (now.getFullYear() - since.getFullYear()) * 12 + (now.getMonth() - since.getMonth());
    if (now.getDate() < since.getDate()) months -= 1;
    return Math.max(0, months);
  }

  /**
   * Returns a card's own textContent. Callers must only ever pass a single,
   * already-scoped listing card element here - never a results container or
   * document.body - since textContent walks the entire subtree.
   */
  function getCardText(card) {
    return card.textContent || "";
  }

  /**
   * Finds the first substring in `text` that matches a "sales" pattern and
   * returns the raw matched snippet (useful for display), or null.
   */
  function findSalesSnippet(text) {
    if (!containsSalesKeyword(text)) return null;
    const match = text.match(/([\d,\s]+(?:\.\d+)?\s*[km]?\+?\s*(?:sales|ventes))/i);
    return match ? match[0].trim() : null;
  }

  /**
   * Extracts the numeric Etsy listing id from a card, based on its
   * /listing/<id>/ anchor. Stable across Etsy's frequent class-name changes.
   */
  function extractListingId(card) {
    const anchor = card.querySelector('a[href*="/listing/"]');
    if (!anchor || !anchor.href) return null;
    const match = anchor.href.match(/\/listing\/(\d+)/);
    return match ? match[1] : null;
  }

  /**
   * Returns the canonical (query-stripped) listing page URL for a card, if any.
   */
  function extractListingUrl(card) {
    const anchor = card.querySelector('a[href*="/listing/"]');
    if (!anchor || !anchor.href) return null;
    return anchor.href.split("?")[0];
  }

  /**
   * Extracts shop name + canonical shop URL from a card, if a shop link is
   * visible on it. Many listing cards link to the shop (e.g. in a "by
   * ShopName" byline), which lets us cache shop-level sales data once and
   * reuse it across every card from that same shop instead of fetching per
   * listing.
   */
  function extractShopInfo(card) {
    const anchor = card.querySelector('a[href*="/shop/"]');
    if (!anchor || !anchor.href) return { shopName: null, shopUrl: null };

    const url = anchor.href.split("?")[0];
    const match = url.match(/\/shop\/([^/?#]+)/i);
    let shopName = null;
    if (match) {
      try {
        shopName = decodeURIComponent(match[1]);
      } catch (err) {
        shopName = match[1];
      }
    }
    return { shopName, shopUrl: url };
  }

  global.EtsyFilterUtils = {
    debounce,
    containsSalesKeyword,
    parseSalesText,
    parseShopAgeMonths,
    monthsSinceDateText,
    getCardText,
    findSalesSnippet,
    extractListingId,
    extractListingUrl,
    extractShopInfo,
  };
})(window);
