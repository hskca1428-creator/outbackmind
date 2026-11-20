/* NomadMate home tiles and phone bottom navigation. Both are built from config/home.json and
 * config/nav.json, so wording, order, icons and targets change without any code change.
 * If a config file is missing or invalid, that section simply stays hidden and the rest of the app
 * (top bar, footer links, every screen) works exactly as before.
 * Safe by construction: only textContent is used, hrefs must start with "#", icon names are checked.
 */
(function () {
  "use strict";

  var ROUTE_RE = /^#(emergency|guides|checklists|settings|saved|ask|plans)?(\/.*)?$/;   // routes handled by js/offline.js
  function norm(h) { return h === "#saved" ? "#settings" : h; }   // #saved and #settings are the same screen
  var anchors = {};   // "#ask" -> { id, focus }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function icon(name) {
    if (typeof name !== "string" || !/^[a-z0-9-]+$/.test(name) || !document.getElementById("i-" + name)) return null;
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    var use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#i-" + name);
    svg.appendChild(use);
    return svg;
  }
  function validItem(it) {
    if (!it || typeof it !== "object" || it.enabled === false) return false;
    if (typeof it.id !== "string" || typeof it.href !== "string" || it.href.charAt(0) !== "#") return false;
    if (typeof (it.title || it.label) !== "string" || !(it.title || it.label).trim()) return false;
    if (it.anchor != null && (typeof it.anchor !== "string" || !document.getElementById(it.anchor))) return false;
    if (it.href !== "#" && !it.anchor && !ROUTE_RE.test(it.href)) return false;
    return true;
  }
  function sorted(list) {
    return list.filter(validItem).sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
  }
  function load(path) {
    return fetch(path).then(function (r) { if (!r.ok) throw new Error(path + " " + r.status); return r.json(); }).catch(function () { return null; });
  }
  function register(it) { if (it.anchor) anchors[it.href] = { id: it.anchor, focus: it.focus }; }

  /* ------------------------------------------------------------- tiles */
  function renderTiles(cfg) {
    var box = document.getElementById("homeTiles"), grid = document.getElementById("tileGrid");
    if (!box || !grid || !cfg || cfg.schema !== 1 || !Array.isArray(cfg.tiles)) return;
    var tiles = sorted(cfg.tiles);
    if (!tiles.length) return;
    var labels = cfg.availability_labels || {};
    var title = document.getElementById("homeTilesTitle");
    if (title && typeof cfg.title === "string" && cfg.title.trim()) title.textContent = cfg.title;
    grid.textContent = "";
    tiles.forEach(function (t) {
      register(t);
      var a = el("a", "tile" + (t.tone === "emergency" ? " tile-emergency" : ""));
      a.href = t.href;
      a.setAttribute("data-tile", t.id);
      var ic = icon(t.icon);
      if (ic) { var wrap = el("span", "tile-icon"); wrap.appendChild(ic); a.appendChild(wrap); }
      var body = el("span", "tile-body");
      body.appendChild(el("span", "tile-title", t.title));
      if (typeof t.hint === "string" && t.hint) body.appendChild(el("span", "tile-hint", t.hint));
      var lab = typeof labels[t.availability] === "string" ? labels[t.availability] : "";
      if (lab) body.appendChild(el("span", "tile-avail tile-avail-" + t.availability, lab));
      a.appendChild(body);
      var li = el("li", "tile-item"); li.appendChild(a); grid.appendChild(li);
    });
    box.hidden = false;
  }

  /* ------------------------------------------------------- bottom nav */
  var navItems = [];
  function renderNav(cfg) {
    var nav = document.getElementById("bottomNav"), list = document.getElementById("bottomNavList");
    if (!nav || !list || !cfg || cfg.schema !== 1 || !Array.isArray(cfg.items)) return;
    navItems = sorted(cfg.items).slice(0, 5);
    if (navItems.length < 2) { navItems = []; return; }
    list.textContent = "";
    navItems.forEach(function (it) {
      register(it);
      var a = el("a", "bn-link");
      a.href = it.href;
      a.setAttribute("data-nav", it.id);
      var ic = icon(it.icon);
      if (ic) a.appendChild(ic);
      a.appendChild(el("span", "bn-label", it.label));
      var li = el("li", "bn-item"); li.appendChild(a); list.appendChild(li);
    });
    nav.hidden = false;
    document.documentElement.classList.add("has-bottom-nav");
    markCurrent();
  }

  function currentHref() {
    var h = location.hash || "";
    if (/^#guides(\/|$)/.test(h)) return "#guides";
    if (/^#checklists(\/|$)/.test(h)) return "#checklists";
    if (h === "#settings" || h === "#saved") return "#settings";
    if (h === "#emergency" || h === "#ask" || h === "#plans") return h;
    if (anchors[h]) return h;
    return "#";
  }
  function markCurrent() {
    var cur = currentHref();
    Array.prototype.forEach.call(document.querySelectorAll("#bottomNav .bn-link"), function (a) {
      if (norm(a.getAttribute("href")) === cur) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
  }

  /* ------------------------------------------- anchors on the home screen */
  function goAnchor(hash, focusToo) {
    var a = anchors[hash];
    if (!a) return;
    var target = document.getElementById(a.id);
    if (!target || document.getElementById("view-home").hidden) return;
    target.scrollIntoView({ block: "start" });
    if (focusToo && a.focus) {
      var f = document.getElementById(a.focus);
      if (f && !f.disabled) { try { f.focus({ preventScroll: true }); } catch (e) { f.focus(); } }
    }
  }
  window.addEventListener("hashchange", function () { markCurrent(); goAnchor(location.hash, true); });
  // Tapping the link for the hash you are already on does not fire hashchange, so handle the click too.
  document.addEventListener("click", function (e) {
    var a = e.target.closest ? e.target.closest("#homeTiles a, #bottomNav a") : null;
    if (!a) return;
    var href = a.getAttribute("href");
    if (href === "#") {   // Home: same behaviour as the NomadMate logo
      e.preventDefault();
      if (location.hash) { location.hash = ""; history.replaceState(null, "", location.pathname + location.search); } else { window.scrollTo(0, 0); }
      markCurrent();
      return;
    }
    if (anchors[href] && location.hash === href) { e.preventDefault(); goAnchor(href, true); }
  });

  /* ----------- hide the bar while typing, so it never covers the keyboard */
  var typingTimer = null;
  function isField(t) { return t && /^(TEXTAREA|INPUT|SELECT)$/.test(t.tagName) && t.type !== "checkbox" && t.type !== "radio" && t.type !== "button"; }
  document.addEventListener("focusin", function (e) { if (isField(e.target)) { clearTimeout(typingTimer); document.documentElement.classList.add("is-typing"); } });
  document.addEventListener("focusout", function (e) {
    if (isField(e.target)) { clearTimeout(typingTimer); typingTimer = setTimeout(function () { document.documentElement.classList.remove("is-typing"); }, 250); }
  });

  /* Lists on the Ask and Trip plans screens show the newest few; the limits come from config/home.json "screens". */
  function applyScreens(cfg) {
    var sc = cfg && cfg.screens;
    if (!sc || typeof sc !== "object") return;
    [["recent_questions_limit", "history"], ["saved_plans_limit", "tripHistory"]].forEach(function (pair) {
      var n = sc[pair[0]], box = document.getElementById(pair[1]);
      if (box && typeof n === "number" && n >= 1 && n <= 50) { box.setAttribute("data-limit", String(Math.floor(n))); if (window.OMCollapse && box._omLimit) box._omLimit.refresh(); }
    });
  }

  function init() {
    Promise.all([load("/config/home.json"), load("/config/nav.json")]).then(function (r) {
      renderTiles(r[0]);
      applyScreens(r[0]);
      // No tiles (config missing or invalid): show plain links so every screen is still one tap away.
      var fb = document.getElementById("homeFallback"), tl = document.getElementById("homeTiles");
      if (fb && tl && tl.hidden) fb.hidden = false;
      renderNav(r[1]);
      document.documentElement.removeAttribute("data-nav-boot");   // D3: the early layout hint from index.html is no longer needed
      markCurrent();
      document.dispatchEvent(new CustomEvent("om:home-rendered"));
      if (anchors[location.hash]) setTimeout(function () { goAnchor(location.hash, false); }, 50);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  window.OMHome = { refresh: markCurrent };
})();
