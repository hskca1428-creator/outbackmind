/* NomadMate Guides screen and offline Ask fallback.
 * Reads /data/knowledge.json and /data/synonyms.json (both in the offline pack), searches them on the phone with
 * js/search.js, and draws the Guides screen (#guides, #guides/c/<category>, #guides/g/<guide>).
 * Nothing here calls the network except those two files, so it works without signal.
 * Text is always added with textContent (never innerHTML).
 */
(function () {
  "use strict";

  var OFFLINE_LABEL = "Offline guide match, not an AI answer";
  var SOURCE_TYPE = {
    "government": "Government agency",
    "non-profit": "Non-profit organisation",
    "motoring-club": "Motoring club (not a government agency)"
  };

  var api = null, loading = null, loadError = null;
  var root = null, searchInput = null, resultsStatus = null, lastQuery = "", firstRender = true;

  /* ----------------------------------------------------------------- data */
  function getJson(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error(url + " HTTP " + r.status); return r.json(); });
  }

  function ready() {
    if (api) return Promise.resolve(api);
    if (loading) return loading;
    loading = Promise.all([getJson("/data/knowledge.json"), getJson("/data/synonyms.json").catch(function () { return {}; })])
      .then(function (res) {
        var data = res[0], syn = res[1] || {};
        var byId = {}, cats = {};
        (data.items || []).forEach(function (it) { byId[it.id] = it; });
        (data.categories || []).forEach(function (c) { cats[c.id] = c; });
        var index = window.OMSearch ? window.OMSearch.createIndex(data.items || [], syn) : null;
        api = {
          data: data, byId: byId, cats: cats,
          search: function (q, opts) { return index ? index.search(q, opts) : []; }
        };
        loadError = null;
        return api;
      })
      .catch(function (e) { loading = null; loadError = e; throw e; });
    return loading;
  }

  /* -------------------------------------------------------------- helpers */
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      if (k === "text") n.textContent = attrs[k];
      else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function icon(id, cls) {
    var ns = "http://www.w3.org/2000/svg";
    var s = document.createElementNS(ns, "svg");
    s.setAttribute("class", "icon" + (cls ? " " + cls : ""));
    s.setAttribute("aria-hidden", "true");
    var u = document.createElementNS(ns, "use");
    u.setAttribute("href", "#" + id);
    s.appendChild(u);
    return s;
  }
  function fmtDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    if (!m) return iso || "";
    try {
      return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
    } catch (e) { return iso; }
  }
  function isOverdue(iso, maxAge) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    if (!m) return false;
    return (Date.now() - Date.UTC(+m[1], +m[2] - 1, +m[3])) / 86400000 > (maxAge || 365);
  }
  function draftLabel(item) {
    return item.status === "approved" ? null : (api && api.data.status_label_draft) || "DRAFT: not yet signed off";
  }
  function tagRow(item) {
    var row = el("div", { class: "guide-tags" });
    if (item.region && item.region !== "Australia-wide") row.appendChild(el("span", { class: "tag tag-region", text: item.region }));
    var d = draftLabel(item);
    if (d) row.appendChild(el("span", { class: "tag tag-draft", text: d }));
    if (api && isOverdue(item.last_reviewed, api.data.review_max_age_days)) row.appendChild(el("span", { class: "tag tag-overdue", text: "Overdue for review" }));
    return row;
  }
  function sourceLine(item) {
    var p = el("p", { class: "guide-src" });
    p.appendChild(document.createTextNode("Source: " + item.source_name + ". Reviewed " + fmtDate(item.last_reviewed) + "."));
    return p;
  }

  /* Body text: "- " lines become a list, "1. " lines a numbered list, the rest paragraphs. */
  function renderBody(text) {
    var box = el("div", { class: "guide-body" });
    var list = null, listKind = null;
    String(text || "").split(/\n/).forEach(function (raw) {
      var line = raw.trim();
      if (!line) { list = null; return; }
      var b = /^-\s+(.*)$/.exec(line), n = /^(\d+)\.\s+(.*)$/.exec(line);
      if (b || n) {
        var kind = b ? "ul" : "ol";
        if (!list || listKind !== kind) { list = el(kind); box.appendChild(list); listKind = kind; }
        list.appendChild(el("li", { text: b ? b[1] : n[2] }));
      } else {
        list = null;
        box.appendChild(el("p", { text: line }));
      }
    });
    return box;
  }

  function extLink(url, label) {
    var a = el("a", { href: url, target: "_blank", rel: "noopener noreferrer" });
    a.appendChild(document.createTextNode(label));
    a.appendChild(icon("i-external", "icon-sm"));
    a.appendChild(el("span", { class: "sr-only", text: " (opens in a new tab, needs signal)" }));
    return a;
  }

  /* --------------------------------------------------------------- screens */
  function backLink(href, label) {
    var a = el("a", { class: "back-link guide-back", href: href });
    a.appendChild(icon("i-home"));
    a.appendChild(document.createTextNode(label));
    return a;
  }

  function guideListItem(item, extra) {
    var li = el("li", { class: "guide-li" });
    var a = el("a", { class: "guide-link", href: "#guides/g/" + item.id });
    a.appendChild(el("span", { class: "guide-title", text: item.title }));
    li.appendChild(a);
    if (extra) li.appendChild(extra);
    li.appendChild(tagRow(item));
    li.appendChild(sourceLine(item));
    return li;
  }

  function setStatus(text) { if (resultsStatus) resultsStatus.textContent = text; }

  function renderHome() {
    root.textContent = "";
    var d = api.data;
    var anyDraft = (d.items || []).some(function (i) { return i.status !== "approved"; });
    var note = el("div", { class: anyDraft ? "callout callout-draft" : "callout", role: "note" }, [
      icon("i-alert"),
      el("div", {}, [
        el("p", { class: "callout-title", text: anyDraft ? (d.status_label_draft || "DRAFT: not yet signed off") : "General guidance only" }),
        el("p", { text: "These guides are saved on this phone and work without signal. Each one shows its official source and the date it was last reviewed. They are general guidance only. Rules differ between states, so check the local agency. In an emergency, call 000." })
      ])
    ]);
    root.appendChild(note);
    var grid = el("ul", { class: "cat-grid", "aria-label": "Guide topics" });
    d.categories.forEach(function (c) {
      if (!c.count) return;
      var li = el("li");
      var a = el("a", { class: "cat-card", href: "#guides/c/" + c.id });
      a.appendChild(el("span", { class: "cat-title", text: c.title }));
      a.appendChild(el("span", { class: "cat-blurb", text: c.blurb }));
      a.appendChild(el("span", { class: "cat-count", text: c.count + (c.count === 1 ? " guide" : " guides") }));
      li.appendChild(a);
      grid.appendChild(li);
    });
    root.appendChild(grid);
    setStatus("");
  }

  function renderCategory(id) {
    var c = api.cats[id];
    root.textContent = "";
    if (!c) { renderNotFound("That topic was not found."); return; }
    root.appendChild(backLink("#guides", "All guide topics"));
    var h = el("h2", { id: "guideHeading", tabindex: "-1", text: c.title });
    root.appendChild(h);
    root.appendChild(el("p", { class: "guide-lead", text: c.blurb }));
    var ul = el("ul", { class: "guide-list" });
    api.data.items.filter(function (it) { return it.category === id; }).forEach(function (it) { ul.appendChild(guideListItem(it)); });
    root.appendChild(ul);
    setStatus(c.title + ": " + c.count + " guides.");
    return h;
  }

  function renderNotFound(msg) {
    root.appendChild(el("p", { class: "guide-empty", text: msg }));
    root.appendChild(backLink("#guides", "All guide topics"));
  }

  function renderDetail(id) {
    var it = api.byId[id];
    root.textContent = "";
    if (!it) { renderNotFound("That guide was not found."); return; }
    var cat = api.cats[it.category];
    root.appendChild(backLink(cat ? "#guides/c/" + cat.id : "#guides", cat ? "Back to " + cat.title : "All guide topics"));
    var h = el("h2", { id: "guideHeading", tabindex: "-1", text: it.title });
    root.appendChild(h);
    root.appendChild(tagRow(it));
    if (it.caveat) root.appendChild(el("p", { class: "callout-inline", text: it.caveat }));
    root.appendChild(renderBody(it.text));
    if (it.kind === "card") {
      var open = el("button", { type: "button", class: "btn-primary guide-open-card" }, [icon("i-alert"), document.createTextNode("Open on the Emergency screen")]);
      open.addEventListener("click", function () {
        if (window.OM) window.OM.openCard = it.card_id ? "card-" + it.card_id : null;
        location.hash = "#emergency";
      });
      root.appendChild(el("p", { class: "mini-note", text: "This is the same wording as the Emergency screen. The Emergency screen is the quickest way to use it in a crisis." }));
      root.appendChild(open);
    }
    var src = el("section", { class: "guide-source", "aria-label": "Source and review date" });
    src.appendChild(el("h3", { text: "Source" }));
    var p = el("p");
    p.appendChild(extLink(it.source_url, it.source_name));
    src.appendChild(p);
    src.appendChild(el("p", { class: "mini-note", text: "Source type: " + (SOURCE_TYPE[it.source_type] || "Government agency") + "." }));
    if (it.extra_sources && it.extra_sources.length) {
      src.appendChild(el("p", { class: "guide-also", text: "Also checked:" }));
      var ul = el("ul");
      it.extra_sources.forEach(function (e) { ul.appendChild(el("li", {}, [extLink(e.source_url, e.source_name)])); });
      src.appendChild(ul);
    }
    (it.source_notes || []).forEach(function (n) { src.appendChild(el("p", { class: "mini-note", text: "Note: " + n })); });
    src.appendChild(el("p", { class: "guide-reviewed", text: "Last reviewed: " + fmtDate(it.last_reviewed) + "." }));
    src.appendChild(el("p", { class: "mini-note", text: "Links need signal. This guide is general information and does not replace advice from the land manager, a doctor or emergency services. Call 000 in an emergency." }));
    root.appendChild(src);
    setStatus(it.title);
    return h;
  }

  function renderResults(q) {
    var res = api.search(q, { limit: 8 });
    root.textContent = "";
    var ul = el("ul", { class: "guide-list guide-results" });
    res.forEach(function (r) {
      var cat = api.cats[r.item.category];
      var extra = el("p", { class: "guide-snippet", text: r.snippet });
      var li = guideListItem(r.item, extra);
      if (cat) li.insertBefore(el("span", { class: "guide-cat", text: cat.title }), li.firstChild.nextSibling);
      ul.appendChild(li);
    });
    if (!res.length) {
      root.appendChild(el("p", { class: "guide-empty", text: "No saved guide matched. Try fewer or different words, or browse the topics below." }));
      root.appendChild(el("p", {}, [el("a", { href: "#emergency", text: "Open the Emergency screen" })]));
    } else {
      root.appendChild(ul);
    }
    setStatus(res.length ? res.length + (res.length === 1 ? " guide found." : " guides found.") : "No guides found.");
  }

  /* ------------------------------------------------------------- routing */
  function parseHash() {
    var h = location.hash || "";
    var m = /^#guides\/c\/([a-z0-9-]+)$/.exec(h);
    if (m) return { kind: "category", id: m[1] };
    m = /^#guides\/g\/([a-z0-9-]+)$/.exec(h);
    if (m) return { kind: "guide", id: m[1] };
    return { kind: "home" };
  }

  function show(opts) {
    if (!root) return;
    var searchBox = document.getElementById("guideSearchWrap");
    ready().then(function () {
      var r = parseHash(), heading = null;
      var q = searchInput ? searchInput.value.trim() : "";
      if (r.kind === "home" && q) { renderResults(q); }
      else if (r.kind === "home") renderHome();
      else if (r.kind === "category") heading = renderCategory(r.id);
      else heading = renderDetail(r.id);
      if (searchBox) searchBox.hidden = r.kind === "guide";
      if (heading && !firstRender) { window.scrollTo(0, 0); try { heading.focus({ preventScroll: true }); } catch (e) { heading.focus(); } }
      firstRender = false;
    }).catch(function () {
      root.textContent = "";
      root.appendChild(el("p", { class: "guide-empty", text: "The guides could not be loaded. If you are online, reload the page. They are saved on this phone once NomadMate has finished its first load with signal." }));
      root.appendChild(el("p", {}, [el("a", { href: "#emergency", text: "Open the Emergency screen" })]));
    });
  }

  function onSearchInput() {
    var q = searchInput.value.trim();
    if (q === lastQuery) return;
    lastQuery = q;
    if (parseHash().kind !== "home") { location.hash = "#guides"; return; }  // hashchange re-renders with the query
    show();
  }

  /* --------------------------------------------------------- Ask fallback */
  /* Fills `container` with the top guide matches for a question. Always labelled as not an AI answer. */
  function renderAskMatch(container, question) {
    return ready().then(function () {
      var res = api.search(question, { limit: 3 });
      container.textContent = "";
      var list = el("div", { class: "ask-matches" });
      res.forEach(function (r) {
        var m = el("div", { class: "ask-match" });
        m.appendChild(el("a", { class: "ask-match-title", href: "#guides/g/" + r.item.id, text: r.item.title }));
        m.appendChild(el("p", { class: "guide-snippet", text: r.snippet }));
        m.appendChild(tagRow(r.item));
        m.appendChild(sourceLine(r.item));
        list.appendChild(m);
      });
      if (!res.length) container.appendChild(el("p", { text: "No saved guide matched your words. Try fewer or different words." }));
      else container.appendChild(list);
      container.appendChild(el("p", { class: "mini-note", text: "These are saved guides on this phone, picked by matching your words. They may not answer your exact question. Your question was not sent or saved." }));
      container.appendChild(el("p", {}, [el("a", { href: "#guides", text: "Browse all guides" }), document.createTextNode(" | "), el("a", { href: "#emergency", text: "Open the Emergency screen" })]));
      return res;
    }).catch(function () {
      container.textContent = "";
      container.appendChild(el("p", { text: "The saved guides could not be loaded. Open the Emergency screen if someone needs help now." }));
      container.appendChild(el("p", {}, [el("a", { href: "#emergency", text: "Open the Emergency screen" })]));
      return [];
    });
  }

  /* ------------------------------------------------------------------ init */
  function init() {
    root = document.getElementById("guidesRoot");
    searchInput = document.getElementById("guideSearch");
    resultsStatus = document.getElementById("guideStatus");
    if (searchInput) {
      var t = null;
      searchInput.addEventListener("input", function () { clearTimeout(t); t = setTimeout(onSearchInput, 120); });
      searchInput.addEventListener("search", onSearchInput);
      var form = document.getElementById("guideSearchForm");
      if (form) form.addEventListener("submit", function (e) { e.preventDefault(); onSearchInput(); });
    }
    document.addEventListener("om:guides-shown", function () { show(); });
    // offline.js may already have routed to #guides before this file attached its listener.
    if (/^#guides(\/|$)/.test(location.hash || "")) show();
    // Warm the data so the first search is instant, even if the phone drops signal straight after.
    ready().catch(function () {});
  }

  window.OMGuides = { ready: ready, renderAskMatch: renderAskMatch, label: OFFLINE_LABEL, search: function (q, o) { return ready().then(function () { return api.search(q, o); }); } };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
