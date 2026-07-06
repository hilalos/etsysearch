/**
 * utils.js
 * Pure helper functions shared by content.js.
 *
 * Important correction baked into this module: Etsy does not expose a
 * per-product sales count anywhere public. Every "N sales" figure visible
 * on Etsy (on a search card, a listing page, or a shop page) is the SHOP's
 * running total, not that one product's. Every function here that detects
 * a sales number is named/documented accordingly - there is no per-listing
 * sales concept anywhere in this codebase.
 *
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
   * Cheap pre-check so callers can skip the full parseShopTotalSales regex
   * when a card obviously has no sales-related text at all.
   */
  function containsShopSalesKeyword(text) {
    return !!text && /sales|ventes/i.test(text);
  }

  /**
   * Parses free-form text into the shop's total sales count, or null if
   * unavailable. This is always the SHOP's all-time total (the only sales
   * figure Etsy ever publicly shows), never a per-product number - Etsy does
   * not expose that anywhere public, and this codebase never estimates it.
   * Supports English and French listings:
   *   "1,234 sales"   -> 1234
   *   "123 sales"     -> 123
   *   "10k sales"     -> 10000
   *   "2.5k sales"    -> 2500
   *   "123 ventes"    -> 123
   *   "1 234 ventes"  -> 1234
   * Never guesses/estimates - returns null whenever no matching text is found.
   */
  function parseShopTotalSales(text) {
    if (!containsShopSalesKeyword(text)) return null;

    // Normalize non-breaking spaces (common in French-locale Etsy pages) to
    // plain spaces so the group-separator pattern below can match them.
    const cleaned = text.replace(/ /g, " ");

    // Leading (?<![a-zA-Z0-9]) stops the number from starting mid-token - e.g.
    // a shop name ending in a digit ("MyShop2") sitting right before the real
    // figure would otherwise glue onto it across the intervening whitespace,
    // since group1 below (correctly) treats whitespace as a thousands
    // separator for French-style grouping like "1 234 ventes".
    // group1: the integer part, allowing "," or " " as thousands separators
    // group2: optional decimal digits (e.g. the "5" in "2.5k")
    // group3: optional k/m shorthand suffix
    // followed by a lookahead for "sales" or "ventes" (not consumed, so
    // overlapping/adjacent numbers elsewhere in the text are never confused
    // with this one).
    const match = cleaned.match(
      /(?<![a-zA-Z0-9])(\d[\d,\s]*)(?:\.(\d+))?\s*(k|m)?\s*(?=\+?\s*(?:sales|ventes)\b)/i
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
   * Rating parser for a SHORT, already-isolated leaf of text (e.g. one leaf
   * node from a card's own subtree). Anchored to the whole string, so a
   * leaf that is just "4.8" is trusted as a rating - short isolated leaves
   * next to a shop/listing link are a strong signal on Etsy's cards, where
   * the star icon itself is a graphic with no accompanying text.
   * Constrained to a plausible 1.0-5.0 range. Returns null otherwise.
   */
  function parseRatingFromLeafText(text) {
    if (!text) return null;
    const normalized = text.trim();
    if (!normalized) return null;
    const match = normalized.match(/^([1-5](?:\.\d)?)\s*(?:out of 5\s*stars?|stars?)?$/i);
    if (!match) return null;
    const value = parseFloat(match[1]);
    if (Number.isNaN(value) || value < 1 || value > 5) return null;
    return value;
  }

  /**
   * Rating parser for a large, unstructured page of text (e.g. a fetched
   * listing/shop page's full body text). Unlike the leaf-text variant, this
   * requires explicit "out of 5" / "stars" context, since a bare decimal
   * floating in a large blob of text (prices, dimensions, etc.) is not a
   * trustworthy signal on its own.
   */
  function parseRatingFromPageText(text) {
    if (!text) return null;
    const match = text.match(/\b([1-5](?:\.\d)?)\s*(?:out of 5\s*stars?|stars?)\b/i);
    if (!match) return null;
    const value = parseFloat(match[1]);
    if (Number.isNaN(value) || value < 1 || value > 5) return null;
    return value;
  }

  /**
   * Reviews-count parser for a short, already-isolated leaf of text, e.g.
   * "(31)", "31 reviews", "(1,234 reviews)". Anchored to the whole string.
   * The bare "(31)" form (no "reviews" word) is Etsy's most common card-level
   * presentation - it appears right next to the star rating.
   */
  function parseReviewsCountFromLeafText(text) {
    if (!text) return null;
    const normalized = text.trim();
    if (!normalized) return null;

    const match =
      normalized.match(/^\(([\d,]+)\)$/) ||
      normalized.match(/^\(([\d,]+)\s*reviews?\)$/i) ||
      normalized.match(/^([\d,]+)\s*reviews?$/i);
    if (!match) return null;

    const value = parseInt(match[1].replace(/,/g, ""), 10);
    return Number.isNaN(value) ? null : value;
  }

  /**
   * Reviews-count parser for a large, unstructured page of text. Requires
   * the word "reviews" nearby, since a bare parenthetical number is too
   * ambiguous in a full page of text.
   */
  function parseReviewsCountFromPageText(text) {
    if (!text) return null;
    const match = text.match(/(?<![a-zA-Z0-9])([\d,]+)\s*reviews\b/i);
    if (!match) return null;
    const value = parseInt(match[1].replace(/,/g, ""), 10);
    return Number.isNaN(value) ? null : value;
  }

  /**
   * Returns true if the text names a digital/downloadable product. Works
   * equally well on a short card leaf or a full fetched page, since it
   * always requires one of a small set of specific phrases (no bare-word
   * matching that could misfire on unrelated text).
   */
  function isDigitalIndicatorText(text) {
    if (!text) return false;
    const normalized = text.trim().toLowerCase();
    if (!normalized) return false;
    const patterns = [
      /\bdigital download\b/,
      /\binstant download\b/,
      /\bdigital file\b/,
      /\bdigital product\b/,
      /\bdownloadable\b/,
      /\bprintable\b/,
    ];
    return patterns.some((re) => re.test(normalized));
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
   * Best-effort listing title extraction: prefers an aria-label/title
   * attribute on the listing anchor (Etsy commonly sets one of these for
   * accessibility, often with the fuller, non-truncated title), then a
   * heading-like descendant, then falls back to the anchor's own text.
   */
  function extractListingTitle(card) {
    const anchor = card.querySelector('a[href*="/listing/"]');
    if (!anchor) return null;

    const ariaLabel = anchor.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    const titleAttr = anchor.getAttribute("title");
    if (titleAttr && titleAttr.trim()) return titleAttr.trim();

    const heading = anchor.querySelector('h2, h3, [class*="title" i]');
    if (heading && heading.textContent && heading.textContent.trim()) {
      return heading.textContent.trim();
    }

    const text = anchor.textContent && anchor.textContent.trim();
    return text || null;
  }

  /**
   * Extracts shop name + canonical shop URL from a card, if a shop link is
   * visible on it. Many listing cards link to the shop (e.g. in a "by
   * ShopName" byline), which lets us cache shop-level data (total sales,
   * age, rating, reviews) once and reuse it across every card from that
   * same shop instead of fetching per listing.
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

  // -----------------------------------------------------------------------
  // Document-agnostic card discovery + extraction. Every function below only
  // uses standard DOM traversal (closest/querySelectorAll/parentElement),
  // which works identically on the live page document AND on a detached
  // document produced by `new DOMParser().parseFromString(html, "text/html")`
  // - so the same logic drives both the live floating-panel scanner
  // (content.js) and the research engine's fetched-page analysis (research.js).
  // -----------------------------------------------------------------------

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
   * Scans any root node (a live results container, or a fetched/parsed
   * document's body) for listing anchors and returns the deduplicated set
   * of card elements.
   */
  function extractListingCardsFromRoot(root) {
    if (!root || typeof root.querySelectorAll !== "function") return [];
    const anchors = root.querySelectorAll('a[href*="/listing/"]');
    const cards = new Set();
    anchors.forEach((anchor) => {
      const card = resolveCardFromAnchor(anchor);
      if (card) cards.add(card);
    });
    return Array.from(cards);
  }

  /**
   * Collects short leaf-node text snippets inside a card (badges like
   * "New on Etsy", "4.8", "(31)", or "Digital Download" are each usually
   * their own small element).
   */
  function getLeafTexts(card) {
    const doc = card.ownerDocument || document;
    const texts = [];
    const walker = doc.createTreeWalker(card, NodeFilter.SHOW_ELEMENT, null);
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
   * Scans a card's short leaf-node text once for shop age, rating, reviews
   * count, and a digital-product indicator. One tree walk covers all four,
   * instead of four separate passes over the same card.
   */
  function detectCardLevelSignals(card) {
    const leafTexts = getLeafTexts(card);
    let shopAgeMonths = null;
    let rating = null;
    let reviewsCount = null;
    let isDigital = false;

    for (let i = 0; i < leafTexts.length; i++) {
      const text = leafTexts[i];
      if (shopAgeMonths === null) {
        const months = parseShopAgeMonths(text);
        if (months !== null) shopAgeMonths = months;
      }
      if (rating === null) {
        const r = parseRatingFromLeafText(text);
        if (r !== null) rating = r;
      }
      if (reviewsCount === null) {
        const rv = parseReviewsCountFromLeafText(text);
        if (rv !== null) reviewsCount = rv;
      }
      if (!isDigital && isDigitalIndicatorText(text)) isDigital = true;
    }

    return { shopAgeMonths, rating, reviewsCount, isDigital };
  }

  /**
   * Extracts everything we can learn about a card from its own (small)
   * subtree, plus anything already known for its shop from `shopDirectory`
   * (an object keyed by shopUrl/listingUrl - see storage.js). Runs exactly
   * once per card; callers scanning a live, ever-growing page should check
   * their own cache before calling this again for the same card.
   * Digital-product detection is always card-level only - see README.
   */
  function extractCardMetadata(card, shopDirectory) {
    const listingId = extractListingId(card);
    const listingUrl = extractListingUrl(card);
    const listingTitle = extractListingTitle(card);
    const { shopName, shopUrl } = extractShopInfo(card);

    const cardSignals = detectCardLevelSignals(card);

    let shopAgeMonths = cardSignals.shopAgeMonths;
    let shopAgeSource = shopAgeMonths !== null ? "card" : "unknown";

    let rating = cardSignals.rating;
    let ratingSource = rating !== null ? "card" : "unknown";

    let reviewsCount = cardSignals.reviewsCount;
    let reviewsSource = reviewsCount !== null ? "card" : "unknown";

    const cardSales = parseShopTotalSales(getCardText(card));
    let shopTotalSales = cardSales;
    let shopTotalSalesSource = cardSales !== null ? "card" : "unknown";

    const anyUnknown =
      shopAgeSource === "unknown" ||
      ratingSource === "unknown" ||
      reviewsSource === "unknown" ||
      shopTotalSalesSource === "unknown";

    if (anyUnknown && shopDirectory) {
      const cacheKey = shopUrl || listingUrl;
      const cached = cacheKey ? shopDirectory[cacheKey] : null;
      if (cached) {
        if (shopTotalSalesSource === "unknown" && cached.shopTotalSalesSource) {
          shopTotalSales = cached.shopTotalSales;
          shopTotalSalesSource = cached.shopTotalSalesSource;
        }
        if (shopAgeSource === "unknown" && cached.shopAgeSource) {
          shopAgeMonths = cached.shopAgeMonths;
          shopAgeSource = cached.shopAgeSource;
        }
        if (ratingSource === "unknown" && cached.ratingSource) {
          rating = cached.rating;
          ratingSource = cached.ratingSource;
        }
        if (reviewsSource === "unknown" && cached.reviewsSource) {
          reviewsCount = cached.reviewsCount;
          reviewsSource = cached.reviewsSource;
        }
      }
    }

    return {
      listingId,
      listingUrl,
      listingTitle,
      shopName,
      shopUrl,
      shopAgeMonths,
      shopAgeSource,
      shopTotalSales,
      shopTotalSalesSource,
      rating,
      ratingSource,
      reviewsCount,
      reviewsSource,
      isDigital: cardSignals.isDigital,
      lastProcessedAt: Date.now(),
    };
  }

  const DAYS_PER_MONTH = 30; // matches the worked example: 3 months ~= 90 days

  /**
   * salesVelocity = shopTotalSales / shopAgeDays (shopAgeDays ~= shopAgeMonths * 30).
   * Returns null when either input is unknown, or when shopAgeDays is 0 (a
   * brand-new "New on Etsy" shop) - a shop with ~0 elapsed days has no
   * meaningful velocity yet, and this never divides by zero or fabricates one.
   * opportunityScore is a transparent per-shop heuristic combining velocity,
   * rating, reviews, and digital status - see README for the exact formula
   * and its rationale; it is not an official Etsy metric.
   */
  function computeDerivedMetrics(meta) {
    const shopAgeDays =
      meta.shopAgeMonths !== null && meta.shopAgeMonths !== undefined
        ? meta.shopAgeMonths * DAYS_PER_MONTH
        : null;

    const hasSales = meta.shopTotalSales !== null && meta.shopTotalSales !== undefined;
    const hasAgeDays = shopAgeDays !== null && shopAgeDays > 0;
    const salesVelocity = hasSales && hasAgeDays ? meta.shopTotalSales / shopAgeDays : null;

    const digitalScore = meta.isDigital ? 1 : 0;

    let opportunityScore = null;
    if (salesVelocity !== null) {
      const ratingComponent =
        meta.rating !== null && meta.rating !== undefined ? (meta.rating - 3) * 5 : 0;
      const reviewsComponent =
        meta.reviewsCount !== null && meta.reviewsCount !== undefined
          ? Math.log10(meta.reviewsCount + 1) * 3
          : 0;
      const digitalComponent = digitalScore * 5;
      opportunityScore = salesVelocity * 10 + ratingComponent + reviewsComponent + digitalComponent;
    }

    return { shopAgeDays, salesVelocity, digitalScore, opportunityScore };
  }

  /**
   * Best-effort extraction of the search-results count Etsy shows near the
   * top of a search page (e.g. "12,000 results"). Returns null if no such
   * text is found - never guessed.
   */
  function extractResultCountFromDocument(doc) {
    if (!doc || !doc.body) return null;
    const text = doc.body.textContent || "";
    const match = text.match(/([\d,]+)\+?\s*results?\b/i);
    if (!match) return null;
    const value = parseInt(match[1].replace(/,/g, ""), 10);
    return Number.isNaN(value) ? null : value;
  }

  /**
   * Etsy does not offer a documented public autocomplete API, so keyword
   * discovery instead uses this: any "related search" style query link
   * Etsy renders directly on a real, public search-results page (anchors
   * pointing to /search?q=...) is a genuine, publicly-visible suggested
   * phrase. Short, phrase-like link text only; the original query itself is
   * excluded. This is 100% public-page text, never a private/internal API.
   */
  function extractRelatedSearchSuggestions(doc, excludeQuery) {
    if (!doc || typeof doc.querySelectorAll !== "function") return [];
    const anchors = Array.from(doc.querySelectorAll('a[href*="/search?q="], a[href*="/search/?q="]'));
    const excludeNormalized = (excludeQuery || "").trim().toLowerCase();
    const seen = new Set();
    const suggestions = [];

    anchors.forEach((anchor) => {
      const text = (anchor.textContent || "").trim();
      if (!text || text.length > 60) return;
      const normalized = text.toLowerCase();
      if (normalized === excludeNormalized || seen.has(normalized)) return;
      seen.add(normalized);
      suggestions.push(text);
    });

    return suggestions.slice(0, 20);
  }

  const TITLE_STOPWORDS = new Set([
    "the", "a", "an", "and", "or", "for", "with", "of", "to", "in", "on", "by",
    "your", "my", "is", "are", "this", "that", "set", "you", "our",
  ]);

  /**
   * Tokenizes a listing title into lowercase words for pattern-frequency
   * analysis, dropping very short words and common stopwords.
   */
  function tokenizeTitleWords(title) {
    if (!title) return [];
    return title
      .toLowerCase()
      .split(/[^a-z0-9']+/i)
      .map((word) => word.trim())
      .filter((word) => word.length >= 3 && !TITLE_STOPWORDS.has(word));
  }

  global.EtsyFilterUtils = {
    debounce,
    containsShopSalesKeyword,
    parseShopTotalSales,
    parseShopAgeMonths,
    monthsSinceDateText,
    parseRatingFromLeafText,
    parseRatingFromPageText,
    parseReviewsCountFromLeafText,
    parseReviewsCountFromPageText,
    isDigitalIndicatorText,
    getCardText,
    extractListingId,
    extractListingUrl,
    extractListingTitle,
    extractShopInfo,
    resolveCardFromAnchor,
    extractListingCardsFromRoot,
    getLeafTexts,
    detectCardLevelSignals,
    extractCardMetadata,
    computeDerivedMetrics,
    extractResultCountFromDocument,
    extractRelatedSearchSuggestions,
    tokenizeTitleWords,
  };
})(window);
