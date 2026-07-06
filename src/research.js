/**
 * research.js
 * The Keyword Hunter / niche-research engine used by the dashboard page.
 * Never runs on its own - only in response to a user clicking "Find
 * Opportunities" in dashboard.js. Everything here is public-page fetches
 * (credentials: 'omit') plus pure computation; no private/internal Etsy
 * APIs, no per-product sales figures anywhere.
 *
 * Keyword discovery note: Etsy does not publish a documented public
 * autocomplete API. Rather than guess at an undocumented endpoint that could
 * silently break, keyword discovery instead fetches the real, public search
 * page for each generated candidate phrase and treats it as "validated" by
 * Etsy's own result count, while also collecting any "related search"
 * style query links Etsy renders on that same page as bonus discovered
 * keywords. See README for the full rationale.
 *
 * Depends on window.EtsyFilterUtils (utils.js) and window.EtsyFilterStorage
 * (storage.js), loaded before this file in dashboard.html.
 */
(function (global) {
  "use strict";

  const {
    parseShopTotalSales,
    parseShopAgeMonths,
    parseRatingFromPageText,
    parseReviewsCountFromPageText,
    extractListingCardsFromRoot,
    extractCardMetadata,
    computeDerivedMetrics,
    extractResultCountFromDocument,
    extractRelatedSearchSuggestions,
    tokenizeTitleWords,
  } = global.EtsyFilterUtils || {};

  const ALPHABET = "abcdefghijklmnopqrstuvwxyz".split("");
  const SUFFIX_PHRASES = [
    "for",
    "with",
    "without",
    "template",
    "planner",
    "tracker",
    "challenge",
    "printable",
  ];

  const YOUNG_SHOP_MAX_DAYS = 90; // "Age: < 90 days" per the Winners/niche-scoring spec

  // -----------------------------------------------------------------------
  // 1. Keyword generation ("fitness a" .. "fitness z", plus fixed suffixes)
  // -----------------------------------------------------------------------

  function generateCandidateKeywords(seed) {
    const trimmedSeed = (seed || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!trimmedSeed) return [];

    const candidates = new Set();
    candidates.add(trimmedSeed);
    ALPHABET.forEach((letter) => candidates.add(`${trimmedSeed} ${letter}`));
    SUFFIX_PHRASES.forEach((suffix) => candidates.add(`${trimmedSeed} ${suffix}`));
    return Array.from(candidates);
  }

  // -----------------------------------------------------------------------
  // 2 & 3. Keyword validation + Niche Opportunity Score
  // -----------------------------------------------------------------------

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
   * 0-100 heuristic combining: how many young (<90 day) shops are already
   * selling, how fast they're selling, how digital-dominated the niche is,
   * and how saturated it looks by result count. Transparent and adjustable
   * - not an official Etsy metric. See README for the worked example this
   * was calibrated against.
   */
  function computeNicheScore({ resultCount, youngShopCount, avgVelocityOfYoungShops, digitalDominancePercent }) {
    const youngShopComponent = Math.min(35, (youngShopCount || 0) * 5);
    const velocityComponent = Math.min(30, (avgVelocityOfYoungShops || 0) * 3);
    const digitalComponent = ((digitalDominancePercent || 0) / 100) * 20;

    let competitionComponent;
    let competitionLabel;
    if (resultCount === null || resultCount === undefined) {
      competitionComponent = 7;
      competitionLabel = "unknown";
    } else if (resultCount < 2000) {
      competitionComponent = 15;
      competitionLabel = "low";
    } else if (resultCount < 15000) {
      competitionComponent = 8;
      competitionLabel = "medium";
    } else if (resultCount < 60000) {
      competitionComponent = 3;
      competitionLabel = "high";
    } else {
      competitionComponent = 0;
      competitionLabel = "saturated";
    }

    const raw = youngShopComponent + velocityComponent + digitalComponent + competitionComponent;
    const score = Math.max(0, Math.min(100, Math.round(raw)));

    let label;
    if (score >= 85) label = "🔥 HOT NICHE";
    else if (score >= 65) label = "✅ GOOD NICHE";
    else if (score >= 40) label = "⚠️ MODERATE";
    else label = "❄️ COLD / SATURATED";

    const youngCount = youngShopCount || 0;
    const reasons = [
      `${youngCount} shop${youngCount === 1 ? "" : "s"} younger than ${YOUNG_SHOP_MAX_DAYS} days`,
      `average velocity ${(avgVelocityOfYoungShops || 0).toFixed(1)} sales/day`,
      `digital score ${Math.round(digitalDominancePercent || 0)}%`,
      `competition ${competitionLabel}`,
    ];

    return { score, label, reasons, competitionLabel };
  }

  /**
   * Fetches the public Etsy search results page for one keyword and derives
   * everything Keyword Validation needs from it: result count, per-shop
   * young/sales/velocity/rating/reviews aggregates, and the niche score.
   * One fetch produces both the "discovery" signal (did Etsy return
   * meaningful results) and the "validation" data - never two requests for
   * the same keyword.
   */
  async function fetchAndAnalyzeKeyword(keyword, shopDirectory, signal) {
    const url = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}`;
    const response = await fetch(url, { credentials: "omit", signal });
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");

    const resultCount = extractResultCountFromDocument(doc);
    const cards = extractListingCardsFromRoot(doc.body || doc);
    const cardMetas = cards.map((card) => extractCardMetadata(card, shopDirectory));

    const seenShopUrls = new Set();
    const youngShops = [];
    cardMetas.forEach((meta) => {
      if (!meta.shopUrl || seenShopUrls.has(meta.shopUrl)) return;
      seenShopUrls.add(meta.shopUrl);
      const derived = computeDerivedMetrics(meta);
      if (derived.shopAgeDays !== null && derived.shopAgeDays < YOUNG_SHOP_MAX_DAYS) {
        youngShops.push({ ...meta, ...derived });
      }
    });

    const ratings = cardMetas.map((m) => m.rating).filter((v) => v !== null && v !== undefined);
    const reviews = cardMetas.map((m) => m.reviewsCount).filter((v) => v !== null && v !== undefined);
    const digitalCount = cardMetas.filter((m) => m.isDigital).length;

    const avgRating = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;
    const avgReviews = reviews.length ? reviews.reduce((a, b) => a + b, 0) / reviews.length : null;
    const digitalDominancePercent = cardMetas.length ? (digitalCount / cardMetas.length) * 100 : null;

    const youngVelocities = youngShops.map((s) => s.salesVelocity).filter((v) => v !== null && v !== undefined);
    const avgVelocityOfYoungShops = youngVelocities.length
      ? youngVelocities.reduce((a, b) => a + b, 0) / youngVelocities.length
      : null;

    let bestYoungShop = null;
    youngShops.forEach((shop) => {
      if (shop.salesVelocity === null || shop.salesVelocity === undefined) return;
      if (!bestYoungShop || shop.salesVelocity > bestYoungShop.salesVelocity) bestYoungShop = shop;
    });

    const relatedSearches = extractRelatedSearchSuggestions(doc, keyword);
    const niche = computeNicheScore({
      resultCount,
      youngShopCount: youngShops.length,
      avgVelocityOfYoungShops: avgVelocityOfYoungShops || 0,
      digitalDominancePercent: digitalDominancePercent || 0,
    });

    return {
      keyword,
      resultCount,
      newShopCount: youngShops.length,
      bestYoungShop: bestYoungShop
        ? {
            shopUrl: bestYoungShop.shopUrl,
            shopName: bestYoungShop.shopName,
            shopAgeDays: bestYoungShop.shopAgeDays,
            shopTotalSales: bestYoungShop.shopTotalSales,
            salesVelocity: bestYoungShop.salesVelocity,
          }
        : null,
      avgReviews,
      avgRating,
      digitalDominancePercent,
      avgVelocityOfYoungShops,
      nicheScore: niche.score,
      nicheLabel: niche.label,
      nicheReasons: niche.reasons,
      competitionLabel: niche.competitionLabel,
      relatedSearches,
      cardMetas, // consumed by the caller for shop-directory upserts + pattern analysis
    };
  }

  // -----------------------------------------------------------------------
  // 5. Product pattern analysis
  // -----------------------------------------------------------------------

  /**
   * Word-frequency analysis across a set of listing titles: "planner
   * appears in 80% of titles". Counts each word once per title (not per
   * occurrence), so a title repeating a word doesn't inflate its share.
   */
  function analyzeTitlePatterns(titles) {
    const validTitles = (titles || []).filter(Boolean);
    if (validTitles.length === 0) return [];

    const docCount = new Map();
    validTitles.forEach((title) => {
      const words = new Set(tokenizeTitleWords(title));
      words.forEach((word) => docCount.set(word, (docCount.get(word) || 0) + 1));
    });

    return Array.from(docCount.entries())
      .map(([word, count]) => ({ word, count, percent: (count / validTitles.length) * 100 }))
      .filter((entry) => entry.count >= 2)
      .sort((a, b) => b.percent - a.percent)
      .slice(0, 15);
  }

  // -----------------------------------------------------------------------
  // 4. Winners: viral new stores
  //    Age < 90 days, sales > 100, velocity > 5/day, digital score > 80%
  // -----------------------------------------------------------------------

  function detectWinners(shopDirectory) {
    const MIN_SALES = 100;
    const MIN_VELOCITY = 5;
    const MIN_DIGITAL_PERCENT = 80;

    return Object.values(shopDirectory || {})
      .map((shop) => {
        const shopAgeDays =
          shop.shopAgeMonths !== null && shop.shopAgeMonths !== undefined ? shop.shopAgeMonths * 30 : null;
        const hasSales = shop.shopTotalSales !== null && shop.shopTotalSales !== undefined;
        const salesVelocity =
          hasSales && shopAgeDays !== null && shopAgeDays > 0 ? shop.shopTotalSales / shopAgeDays : null;
        const digitalScorePercent =
          shop.listingsObserved > 0 ? (shop.digitalListingsObserved / shop.listingsObserved) * 100 : null;
        return { ...shop, shopAgeDays, salesVelocity, digitalScorePercent };
      })
      .filter(
        (shop) =>
          shop.shopAgeDays !== null &&
          shop.shopAgeDays < YOUNG_SHOP_MAX_DAYS &&
          shop.shopTotalSales !== null &&
          shop.shopTotalSales > MIN_SALES &&
          shop.salesVelocity !== null &&
          shop.salesVelocity > MIN_VELOCITY &&
          shop.digitalScorePercent !== null &&
          shop.digitalScorePercent > MIN_DIGITAL_PERCENT
      )
      .sort((a, b) => b.salesVelocity - a.salesVelocity);
  }

  // -----------------------------------------------------------------------
  // 6. Full research workflow: generate -> validate -> rank
  // -----------------------------------------------------------------------

  /**
   * Runs the whole "Find Opportunities" pipeline for a seed keyword.
   * Never starts on its own - only ever called from a user's button click.
   * Uses a small, polite request queue: `concurrency` lanes (default 1),
   * each pausing `delayMs` between its own requests. `isRunningRef.current`
   * is checked every loop iteration so the caller can stop the run early.
   */
  async function runKeywordHunt(seed, options) {
    const { onProgress = () => {}, signal, concurrency = 1, delayMs = 1200, isRunningRef } = options;

    const candidates = generateCandidateKeywords(seed);
    const { getShopDirectory, upsertShopDirectoryEntries, upsertKeywordDirectoryEntry, recordDiscoveredKeywords } =
      global.EtsyFilterStorage;

    let shopDirectory = await getShopDirectory();
    const results = [];
    const queue = candidates.slice();
    let completed = 0;

    async function runLane() {
      while (isRunningRef.current && queue.length > 0) {
        const keyword = queue.shift();
        try {
          const analysis = await fetchAndAnalyzeKeyword(keyword, shopDirectory, signal);
          results.push(analysis);

          const observations = analysis.cardMetas.filter((meta) => meta.shopUrl).map((meta) => ({ ...meta, sourceKeyword: keyword }));
          if (observations.length > 0) {
            shopDirectory = await upsertShopDirectoryEntries(observations);
          }
          if (analysis.relatedSearches.length > 0) {
            await recordDiscoveredKeywords(analysis.relatedSearches, "related-search");
          }

          const { cardMetas, ...persistable } = analysis;
          await upsertKeywordDirectoryEntry(keyword, persistable);
        } catch (err) {
          // Network error or aborted mid-request: skip this keyword, keep going.
        }

        completed++;
        onProgress({ completed, total: candidates.length, keyword });
        if (isRunningRef.current && queue.length > 0) {
          await delay(delayMs, signal);
        }
      }
    }

    const lanes = Array.from({ length: Math.min(concurrency, candidates.length || 1) }, runLane);
    await Promise.all(lanes);

    results.sort((a, b) => (b.nicheScore || 0) - (a.nicheScore || 0));
    return results;
  }

  // -----------------------------------------------------------------------
  // 8. CSV export
  // -----------------------------------------------------------------------

  function escapeCsvValue(value) {
    const str = value === null || value === undefined ? "" : String(value);
    if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
  }

  function buildCsv(rows, columns) {
    const headerLine = columns.map((col) => escapeCsvValue(col.header)).join(",");
    const lines = rows.map((row) => columns.map((col) => escapeCsvValue(row[col.key])).join(","));
    return [headerLine, ...lines].join("\r\n");
  }

  function downloadCsv(filename, csvText) {
    const blob = new Blob([csvText], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  global.EtsyResearch = {
    generateCandidateKeywords,
    computeNicheScore,
    fetchAndAnalyzeKeyword,
    analyzeTitlePatterns,
    detectWinners,
    runKeywordHunt,
    buildCsv,
    downloadCsv,
    YOUNG_SHOP_MAX_DAYS,
  };
})(window);
