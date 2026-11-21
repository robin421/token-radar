// Token Radar's page logic. It reads window.RADAR (written by main.ts from
// the sealed snapshot), renders the board, and lets a reader sort it, filter
// it, and open any protocol's detail: the model's breakdown and the farm
// plan. No network: every number on the page comes from the snapshot data
// beside it, and the detail view recomputes each implied value from the
// snapshot figures to show it matches the board.

(function () {
  "use strict";

  var DATA = window.RADAR || { meta: {}, rows: [], live: [], calibration: [] };
  var PRE_COLUMNS = [
    { key: "rank", label: "Rank" },
    { key: "name", label: "Protocol" },
    { key: "category", label: "Category" },
    { key: "tvl", label: "TVL" },
    { key: "change", label: "7d" },
    { key: "multiple", label: "Multiple" },
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

  function changeText(change) {
    if (change === null || change === undefined) return '<span class="muted">—</span>';
    var sign = change >= 0 ? "+" : "";
    var cls = change >= 0 ? "up" : "down";
    return '<span class="' + cls + '">' + sign + change.toFixed(1) + "%</span>";
  }

  function multipleText(multiple, peers) {
    return multiple.toFixed(2) + "x" + (peers > 0 ? " <span class=\"muted\">(" + peers + ")</span>" : "");
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
      case "change": return row.change_7d === null || row.change_7d === undefined ? -Infinity : row.change_7d;
      case "multiple": return row.multiple;
      case "implied": return row.implied_value_usd;
      case "mcap": return row.mcap_usd;
      case "ratio": return row.ratio;
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
        "<td>" + row.ratio.toFixed(2) + "x</td>"
      ];
    } else {
      cells = [
        '<td class="rank">' + row.rank + "</td>",
        '<td class="name"><b>' + escapeHtml(row.name) + "</b><span>" + escapeHtml(row.slug) + "</span>" + pill + "</td>",
        "<td>" + escapeHtml(row.category || "—") + "</td>",
        "<td>" + money(row.tvl_usd) + "</td>",
        "<td>" + changeText(row.change_7d) + "</td>",
        "<td>" + multipleText(row.multiple, row.multiple_peers) + "</td>",
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
    return Math.round(row.tvl_usd * row.multiple * row.growth * row.maturity * row.breadth);
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
        "<tr><td>Market cap / TVL</td><td>" + row.ratio.toFixed(3) + "x</td></tr>" +
        "</tbody></table>" +
        "<p>This protocol already has a token, so it is not a farm target. It is shown because its market-cap-to-TVL ratio is one of the peers the category multiples are calibrated from.</p>";
    } else {
      var again = recomputedImplied(row);
      var matches = again === row.implied_value_usd;
      var age = row.age_days === null ? "not reported" : row.age_days + " days";
      var chains = row.chains.length > 0 ? row.chains.join(", ") : "—";
      body.innerHTML =
        "<h2>" + escapeHtml(row.name) + "</h2>" +
        '<p class="sub">' + escapeHtml(row.slug) + " · " + escapeHtml(row.category || "Uncategorized") + " · " + escapeHtml(chains) + "</p>" +
        '<p class="big">' + money(row.implied_value_usd) + "</p>" +
        '<p class="big-label">Implied value · rank ' + row.rank + (row.watchlist ? " · Watchlist" : " · Early") + "</p>" +
        "<h3>Model breakdown</h3>" +
        '<table class="breakdown"><tbody>' +
        "<tr><td>TVL</td><td>" + money(row.tvl_usd) + "</td></tr>" +
        "<tr><td>Category multiple</td><td>" + row.multiple.toFixed(3) + "x (" + row.multiple_peers + " peers)</td></tr>" +
        "<tr><td>Growth (7d " + (row.change_7d === null ? "n/a" : row.change_7d.toFixed(1) + "%") + ")</td><td>" + row.growth.toFixed(3) + "x</td></tr>" +
        "<tr><td>Maturity (" + age + ")</td><td>" + row.maturity.toFixed(3) + "x</td></tr>" +
        "<tr><td>Breadth (" + row.chains.length + " chain" + (row.chains.length === 1 ? "" : "s") + ")</td><td>" + row.breadth.toFixed(3) + "x</td></tr>" +
        "<tr><td>Recomputed from the figures</td><td>" + money(again) + (matches ? ' <span class="check">✓ matches</span>' : "") + "</td></tr>" +
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

  function renderStats() {
    var rows = DATA.rows;
    var implied = rows.map(function (row) { return row.implied_value_usd; }).sort(function (a, b) { return a - b; });
    var total = implied.reduce(function (sum, value) { return sum + value; }, 0);
    var median = implied.length % 2 === 1
      ? implied[Math.floor(implied.length / 2)]
      : (implied[implied.length / 2 - 1] + implied[implied.length / 2]) / 2;
    var watchlist = rows.filter(function (row) { return row.watchlist; }).length;
    $("stats").innerHTML =
      stat("Protocols ranked", String(rows.length)) +
      stat("Watchlist", String(watchlist)) +
      stat("Early finds", String(rows.length - watchlist)) +
      stat("Total implied value", money(total)) +
      stat("Median implied value", money(median));
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
    $("method-text").textContent = "Implied value = TVL × category multiple × growth × maturity × breadth. "
      + "The category multiple is the median market-cap-to-TVL ratio of the live-token protocols in the category, "
      + "shrunk toward the global median of " + (meta.global_median_mcap_tvl || 0).toFixed(3) + "x across "
      + (meta.calibration_peers || 0) + " peers; growth from the seven-day TVL change, maturity from how long the "
      + "protocol has run with no token, breadth from how many chains it spans. The board holds every watchlist "
      + "protocol plus every pre-token protocol below the floor that passes the same no-wrapped, no-staked, "
      + "no-bridge, no-versioned-name rule.";
    renderStats();
    renderCalibration();
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
