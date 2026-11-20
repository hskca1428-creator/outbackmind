/* NomadMate offline layer: config, connection state, "Needs signal" states, routing between the
 * app, the Emergency screen and the Guides screen, service worker registration and the update prompt.
 * No libraries. Exposes window.OM for the inline app script and js/emergency.js.
 */
(function () {
  "use strict";

  var DEFAULT_API = "https://api.outbackmind.au";
  var cfg = null;
  var state = { online: navigator.onLine !== false, apiDown: false, checked: false };
  var els = {};
  var probeTimer = null;
  var reloadRequested = false;
  var swReg = null;

  function $(id) { return document.getElementById(id); }

  /* ---------------------------------------------------------------- config */
  var configReady = fetch("/config/app-config.json", { cache: "no-store" })
    .then(function (r) { if (!r.ok) throw new Error("config " + r.status); return r.json(); })
    .then(function (c) { cfg = c; return c; })
    .catch(function () { cfg = null; return null; });

  function apiBase() {
    var b = cfg && typeof cfg.apiBase === "string" && /^https:\/\//.test(cfg.apiBase) ? cfg.apiBase : DEFAULT_API;
    return b.replace(/\/+$/, "");
  }
  function probeSettings() {
    var p = (cfg && cfg.probe) || {};
    return { path: p.path || "/config/app-config.json", interval: p.interval_ms || 30000, timeout: p.timeout_ms || 4000 };
  }

  /* ----------------------------------------------------- connection state */
  function render() {
    var pill = els.connPill;
    if (pill) {
      var text, icon, cls;
      if (!state.checked && state.online) { text = "Checking"; icon = "#i-wifi"; cls = "is-checking"; }
      else if (!state.online) { text = "Offline"; icon = "#i-wifi-off"; cls = "is-offline"; }
      else if (state.apiDown) { text = "Service unreachable"; icon = "#i-alert"; cls = "is-degraded"; }
      else { text = "Online"; icon = "#i-wifi"; cls = "is-online"; }
      pill.className = "conn-pill " + cls;
      els.connText.textContent = text;
      pill.querySelector("use").setAttribute("href", icon);
    }
    document.documentElement.classList.toggle("is-offline", !state.online);
    var ob = $("offlineBanner");
    if (ob) ob.hidden = state.online;
    applyNeedsSignal();
  }

  function setOnline(online) {
    var changed = state.online !== online || !state.checked;
    var wasOnline = state.online;
    state.online = online;
    state.checked = true;
    if (online) { /* keep apiDown until an API call succeeds */ } else { state.apiDown = false; }
    render();
    if (changed) {
      document.dispatchEvent(new CustomEvent("om:connectivity", {
        detail: { online: online, apiDown: state.apiDown, changed: wasOnline !== online }
      }));
    }
  }

  function probe() {
    var s = probeSettings();
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, s.timeout);
    return fetch(s.path + "?probe=" + Date.now(), { cache: "no-store", signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) {
        clearTimeout(timer);
        // forget an old "service unreachable" flag after a minute so the pill does not stay stuck
        if (r.ok && state.apiDown && Date.now() - (state.apiDownAt || 0) > 60000) state.apiDown = false;
        setOnline(r.ok);
      })
      .catch(function () { clearTimeout(timer); setOnline(false); });
  }

  function startProbing() {
    probe();
    clearInterval(probeTimer);
    probeTimer = setInterval(function () { if (!document.hidden) probe(); }, probeSettings().interval);
  }

  window.addEventListener("offline", function () { setOnline(false); });
  window.addEventListener("online", function () { probe(); });
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) { probe(); if (swReg) swReg.update().catch(function () {}); }
  });

  function reportApiFailure() { state.apiDownAt = Date.now(); if (!state.apiDown) { state.apiDown = true; render(); } }
  function reportApiSuccess() { if (state.apiDown || !state.online) { state.apiDown = false; state.online = true; state.checked = true; render(); } }

  /* ---------------------------------------------------- "Needs signal" UI */
  function applyNeedsSignal() {
    var cards = document.querySelectorAll("[data-needs-network]");
    var offline = !state.online;
    Array.prototype.forEach.call(cards, function (card) {
      var note = card.querySelector(":scope > .needs-signal");
      if (!note) {
        note = document.createElement("div");
        note.className = "needs-signal";
        note.setAttribute("role", "note");
        note.hidden = true;
        var svgNS = "http://www.w3.org/2000/svg";
        var svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("class", "icon");
        svg.setAttribute("aria-hidden", "true");
        var use = document.createElementNS(svgNS, "use");
        use.setAttribute("href", "#i-wifi-off");
        svg.appendChild(use);
        var body = document.createElement("div");
        var strong = document.createElement("strong");
        strong.textContent = "Needs signal. ";
        var span = document.createElement("span");
        span.textContent = (card.getAttribute("data-offline-label") || "This feature") + " needs an internet connection. It will work again when you are back in signal. ";
        var link = document.createElement("a");
        link.href = "#emergency";
        link.textContent = "Open the offline Emergency screen";
        body.appendChild(strong); body.appendChild(span); body.appendChild(link);
        note.appendChild(svg); note.appendChild(body);
        card.insertBefore(note, card.firstChild);
      }
      note.hidden = !offline;
      card.classList.toggle("is-needs-signal", offline);
      var controls = card.querySelectorAll("button, textarea, input, select");
      Array.prototype.forEach.call(controls, function (c) {
        if (offline) {
          if (!c.disabled) { c.disabled = true; c.setAttribute("data-om-disabled", "1"); }
        } else if (c.getAttribute("data-om-disabled") === "1") {
          c.disabled = false; c.removeAttribute("data-om-disabled");
        }
      });
    });
  }

  /* --------------------------------------------------------------- routing */
  function currentView() {
    var h = location.hash || "";
    if (h === "#emergency") return "emergency";
    if (/^#guides(\/|$)/.test(h)) return "guides";
    if (/^#checklists(\/|$)/.test(h)) return "checklists";
    if (h === "#settings" || h === "#saved") return "settings";
    if (h === "#ask") return "ask";
    if (h === "#plans") return "plans";
    return "home";
  }
  var lastView = null;
  var TITLES = { emergency: "Emergency | NomadMate by OutbackMind", guides: "Guides | NomadMate by OutbackMind", checklists: "Checklists | NomadMate by OutbackMind", settings: "Saved | NomadMate by OutbackMind", ask: "Ask | NomadMate by OutbackMind", plans: "Trip plans | NomadMate by OutbackMind", home: "NomadMate by OutbackMind" };
  function route() {
    var v = currentView();
    var home = $("view-home"), em = $("view-emergency"), gd = $("view-guides"), cl = $("view-checklists"), st = $("view-settings"), ak = $("view-ask"), pl = $("view-plans");
    if (!home || !em) return;
    home.hidden = v !== "home";
    em.hidden = v !== "emergency";
    if (gd) gd.hidden = v !== "guides";
    if (cl) cl.hidden = v !== "checklists";
    if (st) st.hidden = v !== "settings";
    // Ask and Trip plans have their own screens. If this page has no such screen (old cached page), show the home screen instead.
    if (ak) ak.hidden = v !== "ask";
    if (pl) pl.hidden = v !== "plans";
    if (!ak && v === "ask") home.hidden = false;
    if (!pl && v === "plans") home.hidden = false;
    document.title = TITLES[v] || TITLES.home;
    if (els.emergencyBtn) {
      if (v === "emergency") els.emergencyBtn.setAttribute("aria-current", "page"); else els.emergencyBtn.removeAttribute("aria-current");
    }
    if (els.guidesBtn) {
      if (v === "guides") els.guidesBtn.setAttribute("aria-current", "page"); else els.guidesBtn.removeAttribute("aria-current");
    }
    if (lastView !== null && lastView !== v) {
      window.scrollTo(0, 0);
      var target = v === "emergency" ? $("emergencyTitle") : (v === "guides" ? $("guidesTitle") : (v === "checklists" ? $("checklistsTitle") : (v === "settings" ? $("settingsTitle") : (v === "ask" ? ($("askTitle") || $("main")) : (v === "plans" ? ($("plansTitle") || $("main")) : $("main"))))));
      if (target) { try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); } }
    }
    if (v === "emergency") document.dispatchEvent(new CustomEvent("om:emergency-shown"));
    else document.dispatchEvent(new CustomEvent("om:emergency-hidden"));
    if (v === "guides") document.dispatchEvent(new CustomEvent("om:guides-shown"));
    if (v === "checklists") document.dispatchEvent(new CustomEvent("om:checklists-shown"));
    if (v === "settings") document.dispatchEvent(new CustomEvent("om:settings-shown"));
    if (v === "ask") document.dispatchEvent(new CustomEvent("om:ask-shown"));
    if (v === "plans") document.dispatchEvent(new CustomEvent("om:plans-shown"));
    lastView = v;
    document.documentElement.removeAttribute("data-boot");   // D3: the early screen hint in index.html has done its job
  }
  window.addEventListener("hashchange", route);

  /* ------------------------------------------------------ service worker */
  function showUpdate(worker) {
    var bar = $("updateBar");
    if (!bar) return;
    bar.hidden = false;
    bar.setAttribute("data-waiting", "1");
    bar._worker = worker;
  }

  function wireUpdateBar() {
    var reload = $("updateReload"), later = $("updateLater");
    if (reload) reload.addEventListener("click", function () {
      var w = ($("updateBar") || {})._worker || (swReg && swReg.waiting);
      if (w) { reloadRequested = true; w.postMessage({ type: "SKIP_WAITING" }); } else { location.reload(); }
    });
    if (later) later.addEventListener("click", function () { $("updateBar").hidden = true; });
  }

  function trackInstalling(reg) {
    function watch(worker) {
      if (!worker) return;
      worker.addEventListener("statechange", function () {
        if (worker.state === "installed" && navigator.serviceWorker.controller) showUpdate(worker);
      });
    }
    if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
    watch(reg.installing);
    reg.addEventListener("updatefound", function () { watch(reg.installing); });
  }

  function killServiceWorker() {
    var had = !!navigator.serviceWorker.controller;
    return navigator.serviceWorker.getRegistrations()
      .then(function (regs) { return Promise.all(regs.map(function (r) { return r.unregister(); })); })
      .then(function () { return window.caches ? caches.keys() : []; })
      .then(function (keys) { return Promise.all(keys.filter(function (k) { return k.indexOf("om-") === 0; }).map(function (k) { return caches.delete(k); })); })
      .then(function () {
        if (had && !sessionStorage.getItem("om_killed")) { sessionStorage.setItem("om_killed", "1"); location.reload(); }
      });
  }

  function registerSW(c) {
    if (!("serviceWorker" in navigator)) { setPack("Offline pack: not supported in this browser."); return; }
    if (c && c.offline && c.offline.enabled === false) { killServiceWorker().catch(function () {}); setPack("Offline pack: switched off by NomadMate."); return; }
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (reloadRequested) { reloadRequested = false; location.reload(); }
    });
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).then(function (reg) {
      swReg = reg;
      trackInstalling(reg);
      reg.update().catch(function () {});
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
      return navigator.serviceWorker.ready;
    }).then(function () { refreshPackStatus(); }).catch(function () { setPack("Offline pack: could not be installed. Reload while you have signal."); });
  }

  function setPack(text) { if (els.packStatus) els.packStatus.textContent = text; document.dispatchEvent(new CustomEvent("om:pack", { detail: { text: text } })); }

  function refreshPackStatus() {
    return new Promise(function (resolve) {
      var ctl = navigator.serviceWorker && navigator.serviceWorker.controller;
      var target = ctl || (swReg && (swReg.active || swReg.waiting || swReg.installing));
      if (!target) { setPack("Offline pack: not ready yet. Stay online for a moment, then reload."); return resolve(null); }
      var ch = new MessageChannel();
      var done = false;
      ch.port1.onmessage = function (e) {
        done = true;
        var d = e.data || {};
        var ok = d.cached > 0;
        window.OM.pack = { ready: ok, version: d.version, files: d.cached };
        setPack(ok ? "Offline pack ready (version " + d.version + ", " + d.cached + " files). Works without signal." : "Offline pack: not ready yet. Stay online for a moment, then reload.");
        resolve(d);
      };
      setTimeout(function () { if (!done) { setPack("Offline pack: status unknown."); resolve(null); } }, 3000);
      target.postMessage({ type: "GET_STATUS" }, [ch.port2]);
    });
  }

  /* ------------------------------------------------------------ install UI */
  function initInstall() {
    var area = $("installArea"), and = $("installAndroid"), ios = $("installIos");
    var standalone = (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
    if (standalone) return;
    var deferred = null;
    window.addEventListener("beforeinstallprompt", function (e) {
      e.preventDefault(); deferred = e;
      if (and) and.hidden = false; if (area) area.hidden = false;
    });
    window.addEventListener("appinstalled", function () { if (area) area.hidden = true; deferred = null; });
    var btn = $("installBtn");
    if (btn) btn.addEventListener("click", function () {
      if (!deferred) return;
      deferred.prompt();
      deferred.userChoice.finally(function () { deferred = null; if (area) area.hidden = true; });
    });
    var ua = navigator.userAgent || "";
    var isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    var isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
    var dismissed = false;
    try { dismissed = localStorage.getItem("om_ios_dismissed") === "1"; } catch (e) {}
    if (isIOS && isSafari && !dismissed && ios && area) { ios.hidden = false; area.hidden = false; }
    var d = $("iosDismiss");
    if (d) d.addEventListener("click", function () {
      try { localStorage.setItem("om_ios_dismissed", "1"); } catch (e) {}
      ios.hidden = true; if (and.hidden) area.hidden = true;
    });
  }

  /* ------------------------------------------------------------------ init */
  window.OM = {
    apiBase: apiBase,
    isOnline: function () { return state.online; },
    state: state,
    configReady: configReady,
    config: function () { return cfg; },
    reportApiFailure: reportApiFailure,
    reportApiSuccess: reportApiSuccess,
    probe: probe,
    packStatus: refreshPackStatus,
    pack: null,
    openCard: null
  };

  function init() {
    els.connPill = $("connPill"); els.connText = $("connText"); els.emergencyBtn = $("emergencyBtn"); els.guidesBtn = $("guidesBtn"); els.packStatus = $("packStatus");
    var brand = $("brandLink"), back = $("backHome"), backG = $("backHomeGuides");
    var backs = [brand, back, backG].concat(Array.prototype.slice.call(document.querySelectorAll(".back-home")));
    backs.forEach(function (a) { if (a) a.addEventListener("click", function (e) { e.preventDefault(); if (location.hash) { location.hash = ""; history.replaceState(null, "", location.pathname + location.search); route(); } else { window.scrollTo(0, 0); } }); });
    wireUpdateBar();
    initInstall();
    render();
    route();
    configReady.then(function (c) { startProbing(); registerSW(c); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
