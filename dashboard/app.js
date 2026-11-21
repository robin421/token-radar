// Token Radar's page logic (v3). It reads window.RADAR (written by main.ts
// from the sealed snapshot), renders the board, and lets a reader sort it,
// filter it, and open any protocol's detail: the fitted model's breakdown,
// the token odds, the rank range, the costed farm verdict and the farm
// plan. No network: every number on the page comes from the snapshot data
// beside it, and the detail view recomputes each implied value from its
// two fitted components to show it matches the board.

(function () {
  "use strict";

  var DATA = window.RADAR || { meta: {}, rows: [], live: [], calibration: [], excluded: [] };
  var PRE_COLUMNS = [
    { key: "rank", label: "Rank" },
    { key: "name", label: "Protocol" },
    { key: "category", label: "Category" },
    { key: "tvl", label: "TVL" },
    { key: "odds", label: "Token odds" },
    { key: "expected", label: "Expected value" },
    { key: "implied", label: "Implied value" }
  ];
  var LIVE_COLUMNS = [
    { key: "rank", label: "Rank" },
    { key: "name", label: "Protocol" },
    { key: "category", label: "Category" },
    { key: "tvl", label: "TVL" },
    { key: "mcap", label: "Market cap" },
    { key: "ratio", label: "Mcap / TVL" }
  ];

  var state = {
    kind: "pre",
    scope: "all",
    query: "",
    category: "",
    chain: "",
    sortKey: "rank",
    sortDir: 1,
    selected: null
  };

  function $(id) { return document.getElementById(id); }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function money(value) {
    if (value === null || value === undefined) return "—";
    var abs = Math.abs(value);
    if (abs >= 1000000000) return "$" + (value / 1000000000).toFixed(2).replace(/0$/, "") + "B";
    if (abs >= 1000000) return "$" + (value / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
    if (abs >= 1000) return "$" + (value / 1000).toFixed(1).replace(/\.0$/, "") + "K";
    return "$" + Math.round(value).toLocaleString("en-US");
  }

  function dollars(value) {
    if (value === null || value === undefined) return "—";
    return "$" + value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function pct(value) {
    if (value === null || value === undefined) return "—";
    return (value * 100).toFixed(0) + "%";
  }

  function changeText(change) {
    if (change === null || change === undefined) return '<span class="muted">—</span>';
    var sign = change >= 0 ? "+" : "";
    var cls = change >= 0 ? "up" : "down";
    return '<span class="' + cls + '">' + sign + change.toFixed(1) + "%</span>";
  }

  function verdictClass(verdict) {
    if (verdict === "Farm") return "verdict farm";
    if (verdict === "Farm small") return "verdict small";
    if (verdict === "Watch") return "verdict watch";
    return "verdict skip";
  }

  function columns() {
    return state.kind === "live" ? LIVE_COLUMNS : PRE_COLUMNS;
  }

  function baseRows() {
    if (state.kind === "live") {
      return DATA.live.map(function (peer, index) {
        return {
          slug: peer.slug,
          name: peer.name,
          category: peer.category,
          tvl_usd: peer.tvl_usd,
          mcap_usd: peer.mcap_usd,
          ratio: peer.ratio,
          rank: index + 1,
          live: true
        };
      });
    }
    return DATA.rows;
  }

  function filteredRows() {
    var query = state.query.trim().toLowerCase();
    return baseRows().filter(function (row) {
      if (state.kind === "pre") {
        if (state.scope === "watchlist" && !row.watchlist) return false;
        if (state.scope === "early" && row.watchlist) return false;
      }
      if (state.category && row.category !== state.category) return false;
      if (state.chain && (!row.chains || row.chains.indexOf(state.chain) === -1)) {
        if (!row.chains) return false;
      }
      if (query) {
        var hay = (row.name + " " + row.slug).toLowerCase();
        if (hay.indexOf(query) === -1) return false;
      }
      return true;
    });
  }

  function sortValue(row, key) {
    switch (key) {
      case "rank": return row.rank;
      case "name": return row.name.toLowerCase();
      case "category": return (row.category || "").toLowerCase();
      case "tvl": return row.tvl_usd;
      case "odds": return row.odds;
      case "expected": return row.expected_value_usd;
      case "implied": return row.implied_value_usd;
      case "mcap": return row.mcap_usd;
      case "ratio": return row.ratio === null || row.ratio === undefined ? -Infinity : row.ratio;
      default: return row.rank;
    }
  }

  function sortedRows(rows) {
    var key = state.sortKey;
    var dir = state.sortDir;
    return rows.slice().sort(function (a, b) {
      var va = sortValue(a, key);
      var vb = sortValue(b, key);
      if (va < vb) return -dir;
      if (va > vb) return dir;
      return a.slug < b.slug ? -1 : 1;
    });
  }

  function renderHead() {
    var head = document.querySelector("#board thead tr");
    head.innerHTML = columns().map(function (col) {
      var sorted = state.sortKey === col.key ? ' class="sorted' + (state.sortDir === 1 ? " asc" : "") + '"' : "";
      return '<th data-sort="' + col.key + '" scope="col"' + sorted + '><button type="button">' + col.label + "</button></th>";
    }).join("");
  }

  function rowHtml(row) {
    var pill = row.live ? "" : row.watchlist
      ? '<span class="pill watch">Watchlist</span>'
      : '<span class="pill">Early</span>';
    var cells;
    if (row.live) {
      cells = [
        '<td class="rank">' + row.rank + "</td>",
        '<td class="name"><b>' + escapeHtml(row.name) + "</b><span>" + escapeHtml(row.slug) + "</span></td>",
        "<td>" + escapeHtml(row.category || "—") + "</td>",
        "<td>" + money(row.tvl_usd) + "</td>",
        '<td class="implied">' + money(row.mcap_usd) + "</td>",
        "<td>" + (row.ratio === null ? "—" : row.ratio.toFixed(2) + "x") + "</td>"
      ];
    } else {
      cells = [
        '<td class="rank">' + row.rank + "</td>",
        '<td class="name"><b>' + escapeHtml(row.name) + "</b><span>" + escapeHtml(row.slug) + "</span>" + pill + "</td>",
        "<td>" + escapeHtml(row.category || "—") + "</td>",
        "<td>" + money(row.tvl_usd) + "</td>",
        "<td>" + pct(row.odds) + "</td>",
        '<td class="expected">' + money(row.expected_value_usd) + "</td>",
        '<td class="implied">' + money(row.implied_value_usd) + "</td>"
      ];
    }
    var selected = state.selected === row.slug ? ' class="selected"' : "";
    return '<tr data-slug="' + escapeHtml(row.slug) + '"' + selected + ">" + cells.join("") + "</tr>";
  }

  function renderTable() {
    renderHead();
    var rows = sortedRows(filteredRows());
    $("rows").innerHTML = rows.map(rowHtml).join("");
    var total = baseRows().length;
    $("count").textContent = "Showing " + rows.length + " of " + total
      + (state.kind === "live" ? " live-token protocols (the calibration's evidence)" : " pre-token protocols")
      + ".";
  }

  function recomputedImplied(row) {
    return Math.round(Math.sqrt(row.cat_usd * row.reg_usd));
  }

  function openDetail(slug) {
    var row = null;
    var pool = state.kind === "live" ? baseRows() : DATA.rows;
    for (var i = 0; i < pool.length; i++) {
      if (pool[i].slug === slug) { row = pool[i]; break; }
    }
    if (!row) return;
    state.selected = slug;
    var body = $("drawer-body");
    if (row.live) {
      body.innerHTML =
        "<h2>" + escapeHtml(row.name) + "</h2>" +
        '<p class="sub">' + escapeHtml(row.slug) + " · " + escapeHtml(row.category || "Uncategorized") + "</p>" +
        '<p class="big">' + money(row.mcap_usd) + "</p>" +
        '<p class="big-label">Market cap — token already trades</p>' +
        "<h3>Calibration evidence</h3>" +
        '<table class="breakdown"><tbody>' +
        "<tr><td>TVL</td><td>" + money(row.tvl_usd) + "</td></tr>" +
        "<tr><td>Market cap / TVL</td><td>" + (row.ratio === null ? "—" : row.ratio.toFixed(3) + "x") + "</td></tr>" +
        "</tbody></table>" +
        "<p>This protocol already has a token, so it is not a farm target. It is shown because its market-cap-to-TVL ratio is one of the peers the category multiples are calibrated from.</p>";
    } else {
      var again = recomputedImplied(row);
      var matches = again === row.implied_value_usd;
      var age = row.age_days === null ? "not reported" : row.age_days + " days";
      if (row.age_imputed) age += " (imputed)";
      var chains = row.chains.length > 0 ? row.chains.join(", ") : "—";
      var range = row.rank_lo === row.rank_hi
        ? "#" + row.rank
        : "#" + row.rank_lo + "–#" + row.rank_hi;
      body.innerHTML =
        "<h2>" + escapeHtml(row.name) + "</h2>" +
        '<p class="sub">' + escapeHtml(row.slug) + " · " + escapeHtml(row.category || "Uncategorized") + " · " + escapeHtml(chains) + "</p>" +
        '<p class="big">' + money(row.implied_value_usd) + "</p>" +
        '<p class="big-label">Implied value · rank ' + row.rank + (row.watchlist ? " · Watchlist" : " · Early") + "</p>" +
        "<h3>Model breakdown</h3>" +
        '<table class="breakdown"><tbody>' +
        "<tr><td>TVL</td><td>" + money(row.tvl_usd) + "</td></tr>" +
        "<tr><td>Category multiple</td><td>" + row.multiple.toFixed(3) + "x (" + row.multiple_peers + " peers)</td></tr>" +
        "<tr><td>Category component</td><td>" + money(row.cat_usd) + "</td></tr>" +
        "<tr><td>Regression component</td><td>" + money(row.reg_usd) + "</td></tr>" +
        "<tr><td>Age (" + age + ")</td><td>" + changeText(row.change_7d) + " 7d</td></tr>" +
        "<tr><td>Blended implied (recomputed)</td><td>" + money(again) + (matches ? ' <span class="check">✓ matches</span>' : "") + "</td></tr>" +
        "</tbody></table>" +
        "<h3>Token odds &amp; expected value</h3>" +
        '<table class="breakdown"><tbody>' +
        "<tr><td>Odds it ever issues a token</td><td>" + pct(row.odds) + " (" + row.odds_traded + " of " + row.odds_peers + " peers trade)</td></tr>" +
        "<tr><td>Expected value</td><td>" + money(row.expected_value_usd) + "</td></tr>" +
        "<tr><td>Rank range (200 refits)</td><td>" + range + "</td></tr>" +
        "</tbody></table>" +
        "<h3>Farm verdict</h3>" +
        '<p><span class="' + verdictClass(row.verdict) + '">' + escapeHtml(row.verdict) + "</span></p>" +
        "<p>" + escapeHtml(row.verdict_reason) + "</p>" +
        '<table class="breakdown"><tbody>' +
        "<tr><td>Suggested deposit</td><td>" + dollars(row.deposit_usd) + "</td></tr>" +
        "<tr><td>Gas (first chain)</td><td>" + dollars(row.gas_usd) + "</td></tr>" +
        "<tr><td>Hold for</td><td>" + row.duration_days + " days</td></tr>" +
        "<tr><td>Break-even airdrop</td><td>" + dollars(row.breakeven_usd) + "</td></tr>" +
        "</tbody></table>" +
        "<h3>Farm plan</h3>" +
        '<ol class="steps">' + row.farm_steps.map(function (step) {
          return "<li>" + escapeHtml(step) + "</li>";
        }).join("") + "</ol>";
    }
    $("drawer").hidden = false;
    document.querySelector(".layout").classList.add("open");
    renderTable();
  }

  function closeDetail() {
    state.selected = null;
    $("drawer").hidden = true;
    document.querySelector(".layout").classList.remove("open");
    renderTable();
  }

  function blendValidation() {
    var rows = (DATA.meta && DATA.meta.validation) || [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].name.indexOf("Blend") !== -1) return rows[i];
    }
    return null;
  }

  function renderStats() {
    var rows = DATA.rows;
    var implied = rows.map(function (row) { return row.implied_value_usd; }).sort(function (a, b) { return a - b; });
    var total = implied.reduce(function (sum, value) { return sum + value; }, 0);
    var median = implied.length % 2 === 1
      ? implied[Math.floor(implied.length / 2)]
      : (implied[implied.length / 2 - 1] + implied[implied.length / 2]) / 2;
    var watchlist = rows.filter(function (row) { return row.watchlist; }).length;
    var blend = blendValidation();
    $("stats").innerHTML =
      stat("Protocols ranked", String(rows.length)) +
      stat("Watchlist", String(watchlist)) +
      stat("Early finds", String(rows.length - watchlist)) +
      stat("Total implied value", money(total)) +
      stat("Median implied value", money(median)) +
      (blend ? stat("Held-out median error", (blend.medianPctErr * 100).toFixed(0) + "%") : "") +
      (blend ? stat("Held-out rank correlation", blend.spearman.toFixed(2)) : "");
  }

  function stat(label, value) {
    return '<div class="stat"><b>' + escapeHtml(value) + "</b><span>" + escapeHtml(label) + "</span></div>";
  }

  function renderCalibration() {
    var rows = DATA.calibration.slice().sort(function (a, b) {
      return a.category < b.category ? -1 : 1;
    });
    $("calibration-rows").innerHTML = rows.map(function (entry) {
      return "<tr><td>" + escapeHtml(entry.category) + "</td><td>" + entry.peers + "</td><td>"
        + (entry.peerMedian === null ? "—" : entry.peerMedian.toFixed(3) + "x") + "</td><td>"
        + entry.multiple.toFixed(3) + "x</td></tr>";
    }).join("");
  }

  function renderModel() {
    var meta = DATA.meta || {};
    var fit = meta.fit || { beta: [0, 0, 0], n: 0, median_age_days: 0, r_squared: 0 };
    $("model-equation").textContent = "ln(market cap) = " + fit.beta[0].toFixed(3)
      + " + " + fit.beta[1].toFixed(3) + " · ln(TVL)"
      + " + " + fit.beta[2].toFixed(3) + " · ln(age in days + 1)"
      + ", fitted by least squares on " + fit.n + " traded protocols"
      + " (in-sample R² " + fit.r_squared.toFixed(2) + "). "
      + "The board's implied value is the geometric mean of that fitted value and the "
      + "category-median value (TVL × the category's median market-cap-to-TVL ratio, "
      + "shrunk toward the global median of " + (meta.global_median_mcap_tvl || 0).toFixed(3)
      + "x across " + (meta.calibration_peers || 0) + " peers). "
      + "Rows without a listing date use the fitted protocols' median age of "
      + fit.median_age_days + " days.";
    var rows = meta.validation || [];
    $("validation-rows").innerHTML = rows.map(function (entry) {
      var best = entry.name.indexOf("Blend") !== -1 ? ' class="best"' : "";
      return "<tr" + best + "><td>" + escapeHtml(entry.name) + "</td><td>"
        + (entry.medianPctErr * 100).toFixed(1) + "%</td><td>"
        + entry.spearman.toFixed(3) + "</td><td>"
        + entry.medianLogErr.toFixed(3) + "</td></tr>";
    }).join("");
  }

  function renderCoverage() {
    var meta = DATA.meta || {};
    var cov = meta.coverage || {};
    $("coverage-text").textContent = "The snapshot holds " + (cov.total || 0) + " protocols, and this page accounts for all of them: "
      + (cov.board || 0) + " on the board, " + (cov.live || 0) + " live tokens with a reported market cap, "
      + (cov.recorded_no_mcap || 0) + " that record a token but carry no market cap, "
      + (cov.above_floor || 0) + " above the floor that the house did not list, and "
      + (cov.excluded_below_floor || 0) + " kept off the board by the no-wrapped, no-staked, no-bridge rule. "
      + "The " + ((cov.above_floor || 0) + (cov.excluded_below_floor || 0)) + " kept off are listed below, each with its reason.";
    var excluded = (DATA.excluded || []).slice();
    $("excluded-count").textContent = String(excluded.length);
    $("excluded-rows").innerHTML = excluded.map(function (entry) {
      return "<tr><td>" + escapeHtml(entry.name) + "</td><td>" + escapeHtml(entry.slug) + "</td><td>"
        + escapeHtml(entry.reason) + "</td></tr>";
    }).join("");
  }

  function fillSelects() {
    var categories = {};
    var chains = {};
    DATA.rows.forEach(function (row) {
      if (row.category) categories[row.category] = true;
      row.chains.forEach(function (chain) { chains[chain] = true; });
    });
    var categorySelect = $("category");
    Object.keys(categories).sort().forEach(function (name) {
      var option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      categorySelect.appendChild(option);
    });
    var chainSelect = $("chain");
    Object.keys(chains).sort().forEach(function (name) {
      var option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      chainSelect.appendChild(option);
    });
  }

  function setToggle(group, value) {
    var buttons = document.querySelectorAll("#" + group + " button");
    buttons.forEach(function (button) {
      var on = button.getAttribute(group === "scope" ? "data-scope" : "data-kind") === value;
      button.classList.toggle("on", on);
      button.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function applyHash() {
    var params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    var kind = params.get("kind");
    if (kind === "live" || kind === "pre") state.kind = kind;
    var scope = params.get("scope");
    if (scope === "watchlist" || scope === "early" || scope === "all") state.scope = scope;
    var category = params.get("category");
    if (category) state.category = category;
    var chain = params.get("chain");
    if (chain) state.chain = chain;
    var query = params.get("q");
    if (query) state.query = query;
    $("q").value = state.query;
    $("category").value = state.category;
    $("chain").value = state.chain;
    setToggle("scope", state.scope);
    setToggle("kind", state.kind);
    if (state.kind === "live") { state.sortKey = "mcap"; state.sortDir = -1; }
    renderTable();
    var slug = params.get("row");
    if (slug) openDetail(slug);
  }

  function init() {
    var meta = DATA.meta || {};
    $("asof").textContent = "Snapshot " + (meta.as_of || "") + " · floor " + money(meta.floor_usd || 0);
    $("method-text").textContent = "Implied value is the geometric mean of two fitted values: the category value "
      + "(TVL × the category's median market-cap-to-TVL ratio, shrunk toward the global median) and a least-squares "
      + "fit of log market cap on log TVL and log age. Token odds come from the protocol's peers — same category, "
      + "similar size and age — shrunk toward the snapshot-wide base rate of " + ((meta.odds_base_rate || 0) * 100).toFixed(0)
      + "%. Expected value is implied value × odds. Rank ranges come from " + (meta.refits || 0) + " bootstrap refits of "
      + "the whole model. The board holds every watchlist protocol plus every pre-token protocol below the floor that "
      + "passes the same no-wrapped, no-staked, no-bridge, no-versioned-name rule.";
    renderStats();
    renderCalibration();
    renderModel();
    renderCoverage();
    fillSelects();

    $("q").addEventListener("input", function (event) {
      state.query = event.target.value;
      renderTable();
    });
    $("category").addEventListener("change", function (event) {
      state.category = event.target.value;
      renderTable();
    });
    $("chain").addEventListener("change", function (event) {
      state.chain = event.target.value;
      renderTable();
    });
    document.querySelectorAll("#scope button").forEach(function (button) {
      button.addEventListener("click", function () {
        state.scope = button.getAttribute("data-scope");
        setToggle("scope", state.scope);
        renderTable();
      });
    });
    document.querySelectorAll("#kind button").forEach(function (button) {
      button.addEventListener("click", function () {
        state.kind = button.getAttribute("data-kind");
        setToggle("kind", state.kind);
        state.sortKey = state.kind === "live" ? "mcap" : "rank";
        state.sortDir = state.kind === "live" ? -1 : 1;
        state.selected = null;
        closeDetail();
        renderTable();
      });
    });
    document.querySelector("#board thead").addEventListener("click", function (event) {
      var button = event.target.closest("button");
      if (!button) return;
      var key = button.parentElement.getAttribute("data-sort");
      if (!key) return;
      if (state.sortKey === key) {
        state.sortDir = -state.sortDir;
      } else {
        state.sortKey = key;
        state.sortDir = key === "name" || key === "category" ? 1 : -1;
      }
      renderTable();
    });
    $("rows").addEventListener("click", function (event) {
      var row = event.target.closest("tr");
      if (!row) return;
      openDetail(row.getAttribute("data-slug"));
    });
    $("drawer-close").addEventListener("click", closeDetail);

    applyHash();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
