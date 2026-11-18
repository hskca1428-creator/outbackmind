/* NomadMate Emergency screen. Renders everything from /data/emergency.json (cached offline by the
 * service worker). All content comes from that file so it can be edited without touching code.
 * Text is inserted with textContent only (never innerHTML).
 */
(function () {
  "use strict";

  var root = document.getElementById("emergencyRoot");
  if (!root) return;

  var SVG_NS = "http://www.w3.org/2000/svg";
  var data = null;
  var cfg = null;
  var gps = { watchId: null, last: null, timer: null, started: false };
  var gpsEls = {};

  /* ---------------------------------------------------------------- helpers */
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") n.className = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else if (attrs[k] === true) n.setAttribute(k, "");
      else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function icon(id, cls) {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "icon" + (cls ? " " + cls : ""));
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    var use = document.createElementNS(SVG_NS, "use");
    use.setAttribute("href", "#" + id);
    svg.appendChild(use);
    return svg;
  }
  function fmtDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    if (!m) return iso || "unknown";
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  }
  function isOverdue(iso, maxDays) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    if (!m) return true;
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    return (Date.now() - d.getTime()) / 86400000 > maxDays;
  }
  function host(url) { try { return new URL(url).host.replace(/^www\./, ""); } catch (e) { return url; } }
  function extLink(url, text) {
    return el("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, [text, icon("i-external", "icon-sm")]);
  }
  function statusLabel() { return (data && data.status_label_draft) || "DRAFT - needs owner sign-off"; }

  function sourceLine(item) {
    var wrap = el("div", { class: "src" });
    var maxAge = (data && data.review_max_age_days) || 365;
    var line1 = el("p", { class: "src-line" });
    line1.appendChild(el("span", { class: "src-k", text: "Last reviewed: " }));
    line1.appendChild(document.createTextNode(fmtDate(item.last_reviewed)));
    if (isOverdue(item.last_reviewed, maxAge)) line1.appendChild(el("span", { class: "tag tag-overdue", text: "Overdue for review" }));
    wrap.appendChild(line1);
    if (item.status !== "approved") wrap.appendChild(el("p", { class: "src-line" }, [el("span", { class: "tag tag-draft", text: statusLabel() })]));
    var line2 = el("p", { class: "src-line" });
    line2.appendChild(el("span", { class: "src-k", text: "Source: " }));
    line2.appendChild(extLink(item.source_url, item.source_name));
    line2.appendChild(el("span", { class: "url", text: " (" + host(item.source_url) + ")" }));
    wrap.appendChild(line2);
    if (item.source_published) wrap.appendChild(el("p", { class: "src-line src-note", text: item.source_published }));
    (item.extra_sources || []).forEach(function (ex) {
      var p = el("p", { class: "src-line" });
      p.appendChild(el("span", { class: "src-k", text: "Also: " }));
      p.appendChild(extLink(ex.source_url, ex.source_name));
      wrap.appendChild(p);
    });
    return wrap;
  }

  function section(id, title, intro) {
    var s = el("section", { class: "em-section", "aria-labelledby": id });
    s.appendChild(el("h2", { id: id, text: title }));
    if (intro) s.appendChild(el("p", { class: "em-intro", text: intro }));
    return s;
  }

  /* --------------------------------------------------------------- call UI */
  function callButton(n, primary) {
    var a = el("a", { class: "call-btn" + (primary ? " call-primary" : ""), href: "tel:" + n.tel, "data-tel": n.tel });
    a.appendChild(icon("i-phone"));
    var t = el("span", { class: "call-text" });
    t.appendChild(el("span", { class: "call-num", text: (primary ? "Call " : "Call ") + n.display }));
    t.appendChild(el("span", { class: "call-label", text: n.label }));
    a.appendChild(t);
    return a;
  }

  function buildCall() {
    var s = section("em-call", "Call for help");
    var nums = data.numbers;
    var primary = nums.filter(function (n) { return n.primary; })[0] || nums[0];
    s.appendChild(el("p", { class: "em-lead", text: "If someone is in danger, call 000 now." }));
    var wrap = el("div", { class: "call-grid" });
    wrap.appendChild(callButton(primary, true));
    s.appendChild(wrap);
    var p0 = el("p", { class: "call-when" }, [primary.when + " " + primary.detail]);
    s.appendChild(p0);
    var others = el("div", { class: "call-others" });
    nums.filter(function (n) { return n !== primary; }).forEach(function (n) {
      var box = el("div", { class: "call-other" });
      box.appendChild(callButton(n, false));
      box.appendChild(el("p", { class: "call-when", text: n.when + (n.detail ? " " + n.detail : "") }));
      others.appendChild(box);
    });
    s.appendChild(others);
    var cav = data.coverage_caveat;
    var note = el("div", { class: "callout callout-warn", role: "note" });
    note.appendChild(icon("i-alert"));
    var body = el("div");
    body.appendChild(el("p", { class: "callout-title", text: "Coverage" }));
    body.appendChild(el("p", { text: cav.text }));
    body.appendChild(sourceLine(cav));
    note.appendChild(body);
    s.appendChild(note);
    return s;
  }

  /* ------------------------------------------------------------------ GPS */
  function toDMS(value, pos, neg) {
    var hemi = value >= 0 ? pos : neg;
    var abs = Math.abs(value);
    var d = Math.floor(abs);
    var mFull = (abs - d) * 60;
    var m = Math.floor(mFull);
    var sec = Math.round((mFull - m) * 60 * 10) / 10;
    if (sec >= 60) { sec = 0; m += 1; }
    if (m >= 60) { m = 0; d += 1; }
    return d + "\u00B0 " + m + "\u2032 " + sec.toFixed(1) + "\u2033 " + hemi;
  }
  function readout(lat, lon) {
    return "Latitude " + Math.abs(lat).toFixed(5) + " degrees " + (lat >= 0 ? "North" : "South") +
      ". Longitude " + Math.abs(lon).toFixed(5) + " degrees " + (lon >= 0 ? "East" : "West") + ".";
  }
  function gpsStatus(msg, isError) {
    gpsEls.status.textContent = msg;
    gpsEls.status.className = "gps-status" + (isError ? " is-error" : "");
  }
  function showFix(pos) {
    var c = pos.coords;
    gps.last = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, ts: pos.timestamp || Date.now() };
    gpsEls.dec.textContent = c.latitude.toFixed(5) + ", " + c.longitude.toFixed(5);
    gpsEls.dms.textContent = toDMS(c.latitude, "N", "S") + ", " + toDMS(c.longitude, "E", "W");
    gpsEls.say.textContent = readout(c.latitude, c.longitude);
    var accTxt = isFinite(c.accuracy) ? "about " + Math.round(c.accuracy) + " metres" : "unknown";
    var good = ((cfg && cfg.gps && cfg.gps.good_accuracy_m) || 50);
    gpsEls.acc.textContent = accTxt + (c.accuracy <= good ? " (good)" : " (still improving: wait in the open if you can)");
    gpsEls.copy.disabled = false;
    gpsEls.result.hidden = false;
    gpsEls.sat.hidden = true;
    gpsStatus("Location found. Accuracy " + accTxt + ".");
    tick();
  }
  function tick() {
    if (!gps.last) return;
    var secs = Math.max(0, Math.round((Date.now() - gps.last.ts) / 1000));
    var t = new Date(gps.last.ts).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" });
    var stale = ((cfg && cfg.gps && cfg.gps.stale_after_s) || 60);
    gpsEls.time.textContent = t + " (" + secs + " second" + (secs === 1 ? "" : "s") + " ago)";
    gpsEls.stale.hidden = secs <= stale;
  }
  function gpsError(err) {
    gpsEls.sat.hidden = true;
    var code = err && err.code;
    if (code === 1) {
      gpsStatus("Location is blocked. To allow it: open this browser's site settings for NomadMate and set Location to Allow (on iPhone: Settings, Privacy and Security, Location Services, then Safari Websites or NomadMate, and choose While Using). Then tap Show my location again. You can still tell the operator the nearest town, road name and landmarks.", true);
      stopGps(true);
    } else if (code === 2) {
      gpsStatus("Your phone could not work out its position. Move into the open with a clear view of the sky and check that Location Services are on. You can still tell the operator the nearest town, road name and landmarks.", true);
    } else if (code === 3) {
      gpsStatus("Still searching for GPS. This can take a minute or more with no signal. Stay in the open and keep this screen open.", false);
      gpsEls.sat.hidden = false;
    } else {
      gpsStatus("Location is not available on this device or browser. Tell the operator the nearest town, road name and landmarks.", true);
      stopGps(true);
    }
  }
  function startGps() {
    if (!("geolocation" in navigator)) { gpsError({ code: 0 }); return; }
    if (gps.watchId != null) return;
    gps.started = true;
    gpsEls.start.hidden = true; gpsEls.stop.hidden = false;
    gpsStatus("Looking for your location...");
    gpsEls.sat.hidden = false;
    var timeout = ((cfg && cfg.gps && cfg.gps.timeout_ms) || 30000);
    gps.watchId = navigator.geolocation.watchPosition(showFix, gpsError, { enableHighAccuracy: true, maximumAge: 5000, timeout: timeout });
    clearInterval(gps.timer);
    gps.timer = setInterval(tick, 1000);
  }
  function stopGps(keepResult) {
    if (gps.watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(gps.watchId);
    gps.watchId = null;
    clearInterval(gps.timer);
    gpsEls.start.hidden = false; gpsEls.stop.hidden = true;
    gpsEls.start.textContent = "";
    gpsEls.start.appendChild(icon("i-pin"));
    gpsEls.start.appendChild(document.createTextNode(gps.last ? "Update my location" : "Show my location"));
    if (!keepResult) { /* keep last fix visible with its age */ }
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy") ? resolve() : reject(new Error("copy failed")); } catch (e) { reject(e); }
      document.body.removeChild(ta);
    });
  }

  function buildLocation() {
    var s = section("em-loc", "My location");
    s.appendChild(el("p", { class: "em-intro", text: data.location_note.text }));
    var panel = el("div", { class: "gps-panel" });
    var actions = el("div", { class: "gps-actions" });
    gpsEls.start = el("button", { type: "button", class: "btn-primary", id: "gpsStart" }, [icon("i-pin"), "Show my location"]);
    gpsEls.stop = el("button", { type: "button", class: "btn-secondary", id: "gpsStop", hidden: true }, ["Stop updating"]);
    gpsEls.copy = el("button", { type: "button", class: "btn-secondary", id: "gpsCopy", disabled: true }, [icon("i-copy"), "Copy coordinates"]);
    actions.appendChild(gpsEls.start); actions.appendChild(gpsEls.stop); actions.appendChild(gpsEls.copy);
    panel.appendChild(actions);
    gpsEls.status = el("p", { class: "gps-status", id: "gpsStatus", role: "status", "aria-live": "polite", text: "Tap Show my location. Your phone will ask permission to use your location. This stays on your phone." });
    panel.appendChild(gpsEls.status);
    gpsEls.sat = el("p", { class: "gps-sat", hidden: true, text: "Waiting for a GPS fix. This works without phone signal but can take a minute or more." });
    panel.appendChild(gpsEls.sat);

    var result = el("dl", { class: "gps-result", hidden: true });
    function row(label, valueEl) { result.appendChild(el("dt", { text: label })); result.appendChild(valueEl); }
    gpsEls.dec = el("dd", { class: "gps-big", id: "gpsDec" });
    gpsEls.dms = el("dd", { id: "gpsDms" });
    gpsEls.say = el("dd", { class: "gps-say", id: "gpsSay" });
    gpsEls.acc = el("dd", { id: "gpsAcc" });
    gpsEls.time = el("dd", { id: "gpsTime" });
    row("Latitude, longitude (decimal degrees)", gpsEls.dec);
    row("Degrees, minutes, seconds", gpsEls.dms);
    row("Read this out to the operator", gpsEls.say);
    row("Accuracy", gpsEls.acc);
    row("Fix time", gpsEls.time);
    gpsEls.result = result;
    panel.appendChild(result);
    gpsEls.stale = el("p", { class: "callout-inline", hidden: true, text: "This location is more than a minute old. If you have moved, tap Update my location." });
    panel.appendChild(gpsEls.stale);
    s.appendChild(panel);

    gpsEls.start.addEventListener("click", startGps);
    gpsEls.stop.addEventListener("click", function () { stopGps(true); gpsStatus("Stopped. The last location stays on screen."); });
    gpsEls.copy.addEventListener("click", function () {
      if (!gps.last) return;
      var txt = gps.last.lat.toFixed(5) + ", " + gps.last.lon.toFixed(5);
      copyText(txt).then(function () { gpsStatus("Copied " + txt); }, function () { gpsStatus("Could not copy. Select the numbers above and copy them by hand.", true); });
    });
    return s;
  }

  function maybeAutoStartGps() {
    if (gps.started || !navigator.permissions || !navigator.permissions.query) return;
    navigator.permissions.query({ name: "geolocation" }).then(function (p) {
      if (p.state === "granted" && !gps.started && !document.getElementById("view-emergency").hidden) startGps();
    }).catch(function () {});
  }

  /* ------------------------------------------------------- operator script */
  function buildScript() {
    var sc = data.operator_script;
    var s = section("em-script", sc.title, sc.intro);
    var ol = el("ol", { class: "steps" });
    sc.steps.forEach(function (t) { ol.appendChild(el("li", { text: t })); });
    s.appendChild(ol);
    s.appendChild(sourceLine(sc));
    return s;
  }

  /* ------------------------------------------------------------- first aid */
  function stateVariants(c) {
    var w = el("div", { class: "state-variants" });
    w.appendChild(el("h3", { class: "sv-title", text: c.state_variants_title || "What each state and territory says" }));
    if (c.state_variants_intro) w.appendChild(el("p", { class: "sv-intro", text: c.state_variants_intro }));
    var ul = el("ul", { class: "sv-list" });
    c.state_variants.forEach(function (v) {
      var li = el("li", { class: "sv-item" });
      li.appendChild(el("p", { class: "sv-head" }, [el("span", { class: "sv-state", text: v.state }), " " + v.agency]));
      li.appendChild(el("p", { class: "sv-engine" }, [el("strong", { text: "Engine: " }), v.engine]));
      if (v.other) li.appendChild(el("p", { class: "sv-other", text: v.other }));
      var src = el("p", { class: "sv-src" });
      src.appendChild(el("span", { class: "src-k", text: "Source: " }));
      src.appendChild(extLink(v.source_url, v.source_name));
      (v.extra_sources || []).forEach(function (ex) {
        src.appendChild(document.createTextNode(" | "));
        src.appendChild(extLink(ex.source_url, ex.source_name));
      });
      li.appendChild(src);
      ul.appendChild(li);
    });
    w.appendChild(ul);
    return w;
  }

  var SEV = { critical: "Life-threatening", high: "Serious", moderate: "Take care" };
  function buildCards() {
    var s = section("em-aid", "First aid", "Tap a card to open it. " + data.global_caveat);
    var banner = buildBanner();
    if (banner) s.insertBefore(banner, s.children[2] || null);
    var maxAge = data.review_max_age_days || 365;
    data.cards.forEach(function (c) {
      var d = el("details", { class: "aid-card sev-" + c.severity, id: "card-" + c.id });
      var sum = el("summary");
      sum.appendChild(icon("i-cross", "aid-icon"));
      var st = el("span", { class: "sum-text" });
      st.appendChild(el("span", { class: "sum-title", text: c.title }));
      var meta = el("span", { class: "sum-meta" });
      meta.appendChild(el("span", { class: "tag tag-sev", text: SEV[c.severity] || c.severity }));
      if (c.status !== "approved") meta.appendChild(el("span", { class: "tag tag-draft", text: statusLabel() }));
      if (isOverdue(c.last_reviewed, maxAge)) meta.appendChild(el("span", { class: "tag tag-overdue", text: "Overdue for review" }));
      st.appendChild(meta);
      sum.appendChild(st);
      sum.appendChild(icon("i-chevron", "chev"));
      d.appendChild(sum);
      var body = el("div", { class: "aid-body" });
      if (c.call_000_first) {
        var strip = el("p", { class: "call-first" }, [icon("i-phone"), el("span", {}, [el("strong", { text: "Call 000 first." }), " Then follow the steps and the operator's instructions."])]);
        body.appendChild(strip);
      }
      body.appendChild(el("p", { class: "aid-when", text: c.when }));
      var ol = el("ol", { class: "steps" });
      c.steps.forEach(function (t) { ol.appendChild(el("li", { text: t })); });
      body.appendChild(ol);
      if (c.do_not && c.do_not.length) {
        var dn = el("ul", { class: "donot" });
        c.do_not.forEach(function (t) { dn.appendChild(el("li", {}, [icon("i-x", "icon-sm"), t])); });
        body.appendChild(dn);
      }
      if (c.state_variants && c.state_variants.length) body.appendChild(stateVariants(c));
      if (c.call_000_if) body.appendChild(el("p", { class: "aid-call-if" }, [el("strong", { text: "Call 000 if: " }), c.call_000_if]));
      body.appendChild(el("p", { class: "aid-caveat", text: data.global_caveat }));
      body.appendChild(sourceLine(c));
      d.appendChild(body);
      s.appendChild(d);
    });
    return s;
  }

  /* ----------------------------------------------------------- state links */
  function linkList(links) {
    var ul = el("ul", { class: "links" });
    links.forEach(function (l) {
      var li = el("li");
      li.appendChild(extLink(l.url, l.label));
      li.appendChild(el("span", { class: "url", text: " " + l.url.replace(/^https:\/\//, "") }));
      ul.appendChild(li);
    });
    return ul;
  }
  function buildStates() {
    var s = section("em-states", "Official warnings and state links", "These links need signal to open. The addresses are shown so you can read them out or note them down. Fire danger, road closures and weather change quickly: always check the official source when you have signal.");
    var label = el("label", { for: "stateSelect", class: "sel-label", text: "Your state or territory" });
    var sel = el("select", { id: "stateSelect" });
    sel.appendChild(el("option", { value: "", text: "Choose..." }));
    var order = ["NSW", "ACT", "VIC", "QLD", "SA", "WA", "TAS", "NT"];
    order.forEach(function (k) { if (data.states[k]) sel.appendChild(el("option", { value: k, text: k + " - " + data.states[k].name })); });
    var out = el("div", { id: "stateLinks", class: "state-links", "aria-live": "polite" });
    function show() {
      out.textContent = "";
      var k = sel.value;
      try { localStorage.setItem("om_state", k); } catch (e) {}
      if (k && data.states[k]) {
        out.appendChild(el("h3", { text: data.states[k].name }));
        out.appendChild(linkList(data.states[k].links));
      } else {
        out.appendChild(el("p", { class: "em-intro", text: "Choose your state or territory to see its official emergency links." }));
      }
    }
    var saved = "";
    try { saved = localStorage.getItem("om_state") || ""; } catch (e) {}
    if (saved && data.states[saved]) sel.value = saved;
    sel.addEventListener("change", show);
    s.appendChild(label); s.appendChild(sel); s.appendChild(out);
    show();
    s.appendChild(el("h3", { text: "National" }));
    s.appendChild(linkList(data.national_links));

    var w = data.warning_levels;
    var wl = el("div", { class: "warn-levels" });
    wl.appendChild(el("h3", { text: w.title }));
    var ul = el("ul", { class: "levels" });
    w.levels.forEach(function (lv) {
      var li = el("li", { class: "lvl lvl-" + lv.colour });
      li.appendChild(el("strong", { text: lv.name + " (" + lv.colour + "): " }));
      li.appendChild(document.createTextNode(lv.meaning));
      ul.appendChild(li);
    });
    wl.appendChild(ul);
    wl.appendChild(sourceLine(w));
    s.appendChild(wl);
    return s;
  }

  /* ---------------------------------------------------------------- footer */
  function buildFooter() {
    var s = el("section", { class: "em-section em-foot", "aria-label": "About this screen" });
    var p = el("p", { id: "emPack", text: "Offline pack: checking..." });
    s.appendChild(p);
    var reviewed = data.cards.map(function (c) { return c.last_reviewed; }).sort();
    s.appendChild(el("p", { text: "Safety content reviewed against official sources: " + fmtDate(reviewed[0]) + (reviewed[reviewed.length - 1] !== reviewed[0] ? " to " + fmtDate(reviewed[reviewed.length - 1]) : "") + "." }));
    s.appendChild(el("p", { text: data.global_caveat }));
    document.addEventListener("om:pack", function (e) { p.textContent = e.detail.text; });
    var ps = document.getElementById("packStatus");
    if (ps && ps.textContent) p.textContent = ps.textContent;
    return s;
  }

  function buildBanner() {
    var drafts = data.cards.filter(function (c) { return c.status !== "approved"; }).length;
    if (!drafts) return null;
    var partial = drafts < data.cards.length;
    var b = el("div", { class: "callout callout-draft", role: "note" });
    b.appendChild(icon("i-alert"));
    b.appendChild(el("div", {}, [
      el("p", { class: "callout-title", text: statusLabel() }),
      el("p", { text: partial
        ? "Most first-aid cards have been signed off. Cards marked DRAFT have not, and still follow the cited official sources. Always follow the 000 operator."
        : "The first-aid wording on this screen has not been signed off yet. It follows the cited official sources. Always follow the 000 operator." })
    ]));
    return b;
  }

  /* ---------------------------------------------------------------- render */
  function render() {
    root.textContent = "";
    root.appendChild(buildCall());
    root.appendChild(buildLocation());
    root.appendChild(buildScript());
    root.appendChild(buildCards());
    root.appendChild(buildStates());
    root.appendChild(buildFooter());
    document.dispatchEvent(new CustomEvent("om:emergency-rendered"));
    if (location.hash === "#emergency") maybeAutoStartGps();
  }

  function renderFallback() {
    root.textContent = "";
    var s = section("em-call", "Call for help");
    s.appendChild(el("p", { class: "em-lead", text: "If someone is in danger, call 000 now." }));
    s.appendChild(el("div", { class: "call-grid" }, [
      callButton({ tel: "000", display: "000", label: "Triple Zero" }, true),
      callButton({ tel: "112", display: "112", label: "112 (mobile phones only)" }, false)
    ]));
    s.appendChild(el("p", { class: "callout callout-warn", text: "With no mobile coverage on any network, a call to 000 or 112 will not connect. The full Emergency screen could not load. Reload this page while you have signal." }));
    root.appendChild(s);
  }

  document.addEventListener("om:emergency-shown", function () { if (data) maybeAutoStartGps(); });
  document.addEventListener("om:emergency-hidden", function () { if (gps.watchId != null) { stopGps(true); gps.started = false; } });
  window.addEventListener("pagehide", function () { if (gps.watchId != null) stopGps(true); });

  var cfgP = fetch("/config/app-config.json").then(function (r) { return r.json(); }).catch(function () { return null; });
  var dataP = fetch("/data/emergency.json").then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
  Promise.all([cfgP, dataP]).then(function (res) { cfg = res[0]; data = res[1]; render(); }).catch(function () { renderFallback(); });
})();
