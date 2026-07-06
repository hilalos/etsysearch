/**
 * dashboard.js
 * Wires up the Etsy Opportunity Finder dashboard page: tab switching, the
 * Keyword Hunter research workflow, the Shop Scanner directory view, the
 * Winners (viral new store) view, and Saved bookmarks.
 *
 * This page only ever fetches Etsy pages in response to the user clicking
 * "Find Opportunities" (see research.js) - never automatically, never on
 * load. Everything else here just reads/renders what's already stored.
 */
(function () {
  "use strict";

  const { computeDerivedMetrics } = window.EtsyFilterUtils;
  const {
    getShopDirectory,
    getKeywordDirectory,
    getSavedItems,
    saveItem,
    removeSavedItem,
  } = window.EtsyFilterStorage;
  const { runKeywordHunt, detectWinners, analyzeTitlePatterns, buildCsv, downloadCsv } = window.EtsyResearch;

  const HUNT_CONCURRENCY = 1; // polite default; matches the floating panel's own fetch queue
  const HUNT_DELAY_MS = 1200;

  const huntState = { running: false, isRunningRef: { current: false } };

  // -----------------------------------------------------------------------
  // Formatting helpers
  // -----------------------------------------------------------------------

  function formatShopAge(months) {
    if (months === null || months === undefined) return "unknown";
    if (months === 0) return "New on Etsy";
    if (months === 1) return "1 month";
    return `${months} months`;
  }

  function formatNumber(value, digits) {
    if (value === null || value === undefined || Number.isNaN(value)) return "—";
    return digits !== undefined ? value.toFixed(digits) : value.toLocaleString();
  }

  function formatPercent(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return "—";
    return `${Math.round(value)}%`;
  }

  function shopDigitalScorePercent(shop) {
    if (!shop.listingsObserved) return null;
    return (shop.digitalListingsObserved / shop.listingsObserved) * 100;
  }

  // -----------------------------------------------------------------------
  // Tabs
  // -----------------------------------------------------------------------

  function initTabs() {
    const tabs = document.querySelectorAll(".dash-tab");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        tabs.forEach((t) => t.classList.remove("active"));
        document.querySelectorAll(".dash-panel").forEach((p) => p.classList.remove("active"));
        tab.classList.add("active");
        document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");

        if (tab.dataset.tab === "shop-scanner") renderShopScanner();
        if (tab.dataset.tab === "winners") renderWinners();
        if (tab.dataset.tab === "saved") renderSaved();
        if (tab.dataset.tab === "dashboard") renderDashboardOverview();
      });
    });
  }

  // -----------------------------------------------------------------------
  // Dashboard overview
  // -----------------------------------------------------------------------

  async function renderDashboardOverview() {
    const [shopDirectory, keywordDirectory] = await Promise.all([getShopDirectory(), getKeywordDirectory()]);
    const shops = Object.values(shopDirectory);
    const keywords = Object.values(keywordDirectory).filter((k) => k.nicheScore !== undefined);
    const winners = detectWinners(shopDirectory);

    document.getElementById("stat-shops").textContent = shops.length;
    document.getElementById("stat-keywords").textContent = keywords.length;
    document.getElementById("stat-winners").textContent = winners.length;

    const topNiches = keywords.sort((a, b) => (b.nicheScore || 0) - (a.nicheScore || 0)).slice(0, 5);
    const nicheBody = document.querySelector("#dashboard-top-niches tbody");
    nicheBody.innerHTML = "";
    topNiches.forEach((k) => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${escapeHtml(k.keyword)}</td>
        <td>${formatNumber(k.nicheScore)} ${k.nicheLabel || ""}</td>
        <td>${formatNumber(k.resultCount)}</td>
        <td>${formatNumber(k.newShopCount)}</td>
      `;
      nicheBody.appendChild(row);
    });

    const topWinners = winners.slice(0, 5);
    const winnersBody = document.querySelector("#dashboard-top-winners tbody");
    winnersBody.innerHTML = "";
    topWinners.forEach((shop) => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${escapeHtml(shop.shopName || shop.shopUrl)}</td>
        <td>${shop.shopAgeDays !== null ? `${shop.shopAgeDays}d` : "—"}</td>
        <td>${formatNumber(shop.shopTotalSales)}</td>
        <td>${formatNumber(shop.salesVelocity, 2)}/day</td>
      `;
      winnersBody.appendChild(row);
    });
  }

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = value === null || value === undefined ? "" : String(value);
    return div.innerHTML;
  }

  // -----------------------------------------------------------------------
  // Keyword Hunter
  // -----------------------------------------------------------------------

  function renderTopOpportunities(results) {
    const wrap = document.getElementById("top-opportunities");
    const list = document.getElementById("top-opportunities-list");
    const top = results.slice(0, 5);
    if (top.length === 0) {
      wrap.style.display = "none";
      return;
    }
    wrap.style.display = "";
    list.innerHTML = "";
    top.forEach((result) => {
      const item = document.createElement("li");
      item.innerHTML = `
        <div class="dash-opportunity-keyword">${escapeHtml(result.keyword)}</div>
        <div class="dash-opportunity-score">Score: ${formatNumber(result.nicheScore)} ${result.nicheLabel || ""}</div>
        <div class="dash-opportunity-reason">${escapeHtml((result.nicheReasons || []).join(" · "))}</div>
      `;
      list.appendChild(item);
    });
  }

  function renderKeywordResultsTable(results) {
    const body = document.querySelector("#keyword-results-table tbody");
    body.innerHTML = "";
    results.forEach((result) => {
      const row = document.createElement("tr");
      const bestShop = result.bestYoungShop;
      row.innerHTML = `
        <td>${escapeHtml(result.keyword)}</td>
        <td>${formatNumber(result.nicheScore)} ${result.nicheLabel || ""}</td>
        <td>${formatNumber(result.resultCount)}</td>
        <td>${formatNumber(result.newShopCount)}</td>
        <td>${bestShop ? escapeHtml(bestShop.shopName || bestShop.shopUrl) : "—"}</td>
        <td>${formatNumber(result.avgVelocityOfYoungShops, 2)}/day</td>
        <td>${formatNumber(result.avgRating, 1)}</td>
        <td>${formatNumber(result.avgReviews, 0)}</td>
        <td>${formatPercent(result.digitalDominancePercent)}</td>
        <td><button type="button" class="dash-save-btn" data-type="keyword" data-id="${escapeHtml(result.keyword)}">★ Save</button></td>
      `;
      body.appendChild(row);
    });

    body.querySelectorAll(".dash-save-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const keyword = btn.dataset.id;
        const data = results.find((r) => r.keyword === keyword);
        saveItem("keyword", keyword, data);
        btn.textContent = "✓ Saved";
        btn.disabled = true;
      });
    });
  }

  async function loadExistingKeywordResults() {
    const directory = await getKeywordDirectory();
    const analyzed = Object.values(directory)
      .filter((k) => k.nicheScore !== undefined)
      .sort((a, b) => (b.nicheScore || 0) - (a.nicheScore || 0));
    if (analyzed.length > 0) {
      renderTopOpportunities(analyzed);
      renderKeywordResultsTable(analyzed);
    }
  }

  function setHuntButtonState(running) {
    const btn = document.getElementById("find-opportunities-btn");
    btn.textContent = running ? "Stop" : "Find Opportunities";
  }

  function setHuntProgress(text) {
    document.getElementById("keyword-hunt-progress").textContent = text;
  }

  async function onFindOpportunitiesClicked() {
    if (huntState.running) {
      huntState.isRunningRef.current = false;
      setHuntButtonState(false);
      setHuntProgress("Stopped.");
      return;
    }

    const seed = document.getElementById("seed-keyword-input").value.trim();
    if (!seed) {
      setHuntProgress("Enter a seed keyword first.");
      return;
    }

    huntState.running = true;
    huntState.isRunningRef.current = true;
    setHuntButtonState(true);
    setHuntProgress("Starting…");

    try {
      const results = await runKeywordHunt(seed, {
        isRunningRef: huntState.isRunningRef,
        concurrency: HUNT_CONCURRENCY,
        delayMs: HUNT_DELAY_MS,
        onProgress: ({ completed, total, keyword }) => {
          setHuntProgress(`Analyzed ${completed} / ${total} keywords… (${keyword})`);
        },
      });
      setHuntProgress(`Done. Analyzed ${results.length} keywords.`);
      renderTopOpportunities(results);
      renderKeywordResultsTable(results);
    } catch (err) {
      setHuntProgress("Something went wrong - see the console for details.");
      // eslint-disable-next-line no-console
      console.error("[Etsy Opportunity Finder] keyword hunt failed", err);
    } finally {
      huntState.running = false;
      huntState.isRunningRef.current = false;
      setHuntButtonState(false);
    }
  }

  async function onExportKeywordsCsvClicked() {
    const directory = await getKeywordDirectory();
    const rows = Object.values(directory)
      .filter((k) => k.nicheScore !== undefined)
      .map((k) => ({
        keyword: k.keyword,
        score: k.nicheScore,
        competition: k.competitionLabel || "",
        bestShop: k.bestYoungShop ? k.bestYoungShop.shopName || k.bestYoungShop.shopUrl : "",
        salesVelocity: k.avgVelocityOfYoungShops !== null && k.avgVelocityOfYoungShops !== undefined ? k.avgVelocityOfYoungShops.toFixed(2) : "",
      }));
    const csv = buildCsv(rows, [
      { key: "keyword", header: "keyword" },
      { key: "score", header: "score" },
      { key: "competition", header: "competition" },
      { key: "bestShop", header: "best shop" },
      { key: "salesVelocity", header: "sales velocity" },
    ]);
    downloadCsv("etsy-keyword-opportunities.csv", csv);
  }

  // -----------------------------------------------------------------------
  // Shop Scanner
  // -----------------------------------------------------------------------

  function shopRowHtml(shop, derived) {
    return `
      <td><a href="${escapeHtml(shop.shopUrl)}" target="_blank" rel="noopener">${escapeHtml(shop.shopName || shop.shopUrl)}</a></td>
      <td>${shop.shopTotalSales !== null && shop.shopTotalSales !== undefined ? formatNumber(shop.shopTotalSales) : "—"}</td>
      <td>${formatShopAge(shop.shopAgeMonths)}</td>
      <td>${formatNumber(shop.rating, 1)}</td>
      <td>${formatNumber(shop.reviewsCount)}</td>
      <td>${formatNumber(derived.salesVelocity, 2)}${derived.salesVelocity !== null ? "/day" : ""}</td>
      <td>${formatPercent(shopDigitalScorePercent(shop))}</td>
      <td>${formatNumber(derived.opportunityScore, 1)}</td>
      <td><button type="button" class="dash-save-btn" data-type="shop" data-id="${escapeHtml(shop.shopUrl)}">★ Save</button></td>
    `;
  }

  async function renderShopScanner() {
    const directory = await getShopDirectory();
    const shops = Object.values(directory).map((shop) => ({ shop, derived: computeDerivedMetrics(shop) }));
    shops.sort((a, b) => (b.derived.opportunityScore || -Infinity) - (a.derived.opportunityScore || -Infinity));

    const body = document.querySelector("#shop-scanner-table tbody");
    body.innerHTML = "";
    shops.forEach(({ shop, derived }) => {
      const row = document.createElement("tr");
      row.innerHTML = shopRowHtml(shop, derived);
      body.appendChild(row);
    });
    wireSaveButtons(body, directory);
  }

  function wireSaveButtons(container, shopDirectory) {
    container.querySelectorAll(".dash-save-btn[data-type='shop']").forEach((btn) => {
      btn.addEventListener("click", () => {
        const shopUrl = btn.dataset.id;
        saveItem("shop", shopUrl, shopDirectory[shopUrl]);
        btn.textContent = "✓ Saved";
        btn.disabled = true;
      });
    });
  }

  async function onExportShopsCsvClicked() {
    const directory = await getShopDirectory();
    const rows = Object.values(directory).map((shop) => {
      const derived = computeDerivedMetrics(shop);
      return {
        shop: shop.shopName || "",
        url: shop.shopUrl,
        sales: shop.shopTotalSales !== null && shop.shopTotalSales !== undefined ? shop.shopTotalSales : "",
        age: formatShopAge(shop.shopAgeMonths),
        reviews: shop.reviewsCount !== null && shop.reviewsCount !== undefined ? shop.reviewsCount : "",
        rating: shop.rating !== null && shop.rating !== undefined ? shop.rating : "",
        score: derived.opportunityScore !== null ? derived.opportunityScore.toFixed(1) : "",
      };
    });
    const csv = buildCsv(rows, [
      { key: "shop", header: "shop" },
      { key: "url", header: "url" },
      { key: "sales", header: "sales" },
      { key: "age", header: "age" },
      { key: "reviews", header: "reviews" },
      { key: "rating", header: "rating" },
      { key: "score", header: "score" },
    ]);
    downloadCsv("etsy-shop-scanner.csv", csv);
  }

  // -----------------------------------------------------------------------
  // Winners
  // -----------------------------------------------------------------------

  async function renderWinners() {
    const directory = await getShopDirectory();
    const winners = detectWinners(directory);

    const body = document.querySelector("#winners-table tbody");
    body.innerHTML = "";
    winners.forEach((shop) => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${escapeHtml(shop.shopName || shop.shopUrl)}</td>
        <td><a href="${escapeHtml(shop.shopUrl)}" target="_blank" rel="noopener">link</a></td>
        <td>${formatNumber(shop.listingsObserved)}</td>
        <td>${formatNumber(shop.shopTotalSales)}</td>
        <td>${shop.shopAgeDays}d</td>
        <td>${formatNumber(shop.reviewsCount)}</td>
        <td>${formatNumber(shop.rating, 1)}</td>
        <td>${formatNumber(shop.salesVelocity, 2)}/day</td>
        <td>${escapeHtml((shop.sourceKeywords || []).join(", "))}</td>
        <td><button type="button" class="dash-save-btn" data-type="shop" data-id="${escapeHtml(shop.shopUrl)}">★ Save</button></td>
      `;
      body.appendChild(row);
    });
    wireSaveButtons(body, directory);

    const patterns = analyzeTitlePatterns(winners.flatMap((shop) => shop.sampleTitles || []));
    const patternList = document.getElementById("winning-patterns-list");
    patternList.innerHTML = "";
    if (patterns.length === 0) {
      patternList.innerHTML = "<li>Not enough winning shops yet to find a pattern.</li>";
    } else {
      patterns.forEach((pattern) => {
        const item = document.createElement("li");
        item.textContent = `"${pattern.word}" appears in ${Math.round(pattern.percent)}% of winning titles`;
        patternList.appendChild(item);
      });
    }
  }

  // -----------------------------------------------------------------------
  // Saved
  // -----------------------------------------------------------------------

  async function renderSaved() {
    const saved = await getSavedItems();
    const entries = Object.values(saved);

    const keywordBody = document.querySelector("#saved-keywords-table tbody");
    keywordBody.innerHTML = "";
    entries
      .filter((entry) => entry.type === "keyword")
      .forEach((entry) => {
        const row = document.createElement("tr");
        row.innerHTML = `
          <td>${escapeHtml(entry.id)}</td>
          <td>${formatNumber(entry.data && entry.data.nicheScore)}</td>
          <td><button type="button" class="dash-unsave-btn" data-type="keyword" data-id="${escapeHtml(entry.id)}">Remove</button></td>
        `;
        keywordBody.appendChild(row);
      });

    const shopBody = document.querySelector("#saved-shops-table tbody");
    shopBody.innerHTML = "";
    entries
      .filter((entry) => entry.type === "shop")
      .forEach((entry) => {
        const shop = entry.data || {};
        const row = document.createElement("tr");
        row.innerHTML = `
          <td><a href="${escapeHtml(entry.id)}" target="_blank" rel="noopener">${escapeHtml(shop.shopName || entry.id)}</a></td>
          <td>${formatNumber(shop.shopTotalSales)}</td>
          <td>${formatShopAge(shop.shopAgeMonths)}</td>
          <td><button type="button" class="dash-unsave-btn" data-type="shop" data-id="${escapeHtml(entry.id)}">Remove</button></td>
        `;
        shopBody.appendChild(row);
      });

    document.querySelectorAll(".dash-unsave-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await removeSavedItem(btn.dataset.type, btn.dataset.id);
        renderSaved();
      });
    });
  }

  // -----------------------------------------------------------------------
  // Init
  // -----------------------------------------------------------------------

  function init() {
    initTabs();
    document.getElementById("find-opportunities-btn").addEventListener("click", onFindOpportunitiesClicked);
    document.getElementById("export-keywords-csv-btn").addEventListener("click", onExportKeywordsCsvClicked);
    document.getElementById("export-shops-csv-btn").addEventListener("click", onExportShopsCsvClicked);
    document.getElementById("refresh-shop-scanner-btn").addEventListener("click", renderShopScanner);
    document.getElementById("refresh-winners-btn").addEventListener("click", renderWinners);

    renderDashboardOverview();
    loadExistingKeywordResults();
  }

  init();
})();
