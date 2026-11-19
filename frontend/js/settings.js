/* NomadMate "Saved data and settings" screen (Stage 3). Route: #settings.
 * Shows what is saved on this device, the offline pack status, storage use, and lets the user back up, restore and
 * clear local data. Wording comes from /data/settings.json. Text is always added with textContent.
 */
(function () {
  "use strict";
  var root = null, cfg = null, loading = null, pendingImport = null;

  function getJson(url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }); }
  function ready() {
    if (cfg) return Promise.resolve(cfg);
    if (!loading) loading = getJson("/data/settings.json").then(function (d) { cfg = d; return d; }).catch(function (e) { loading = null; throw e; });
    return loading;
  }
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
  function icon(id) {
    var ns = "http://www.w3.org/2000/svg", s = document.createElementNS(ns, "svg"), u = document.createElementNS(ns, "use");
    s.setAttribute("class", "icon"); s.setAttribute("aria-hidden", "true"); u.setAttribute("href", "#" + id); s.appendChild(u);
    return s;
  }
  function btn(label, iconId, cls, id) { return el("button", { type: "button", class: cls || "btn-secondary", id: id }, [iconId ? icon(iconId) : null, document.createTextNode(label)]); }
  function fmtDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    if (!m) return iso || "";
    try { return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }); } catch (e) { return iso; }
  }
  function fmtStamp(value) {
    if (!value) return "never";
    var d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return d.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function fmtBytes(n) {
    if (n == null) return "unknown";
    if (n < 1024) return n + " bytes";
    if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }
  function isIos() { return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); }
  function isStandalone() { return !!navigator.standalone || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches); }
  function setStatus(msg) { var s = document.getElementById("settingsStatus"); if (s) s.textContent = msg || ""; }
  function section(title, id) { var s = el("section", { class: "set-section", "aria-labelledby": id }); s.appendChild(el("h2", { id: id, text: title })); return s; }
  function OM() { return window.OM || {}; }

  /* The iPhone eviction note. Also used on the home page under the saved lists. */
  function iosNote(c, withSource) {
    if (!isIos()) return null;
    var e = c.ios_eviction, home = isStandalone();
    var kids = [el("p", { class: "callout-title", text: e.title })];
    if (withSource && e.status !== "approved") kids.push(el("p", {}, [el("span", { class: "tag tag-draft", text: c.status_label_draft || "DRAFT: not yet signed off" })]));
    kids.push(el("p", { text: home ? e.text_home_screen : e.text_safari }));
    if (withSource) {
      kids.push(el("p", { class: "mini-note" }, [document.createTextNode("Source: "),
        el("a", { href: e.source_url, target: "_blank", rel: "noopener noreferrer", text: e.source_name }),
        document.createTextNode(". "), el("a", { href: "#settings", text: "Back up or clear saved data" })]));
    }
    return el("div", { class: "callout callout-warn ios-note", role: "note" }, [icon("i-alert"), el("div", {}, kids)]);
  }

  function render(c) {
    var S = window.OMStore;
    root.textContent = "";
    var frag = document.createDocumentFragment();
    var persistent = S && S.mode() === "indexeddb";

    // --- where data is saved
    var s1 = section("Saved on this device", "setSavedTitle");
    s1.appendChild(el("p", { class: "set-lead", text: c.saved_here }));
    if (!persistent) {
      s1.appendChild(el("div", { class: "callout callout-warn", role: "note", id: "memoryNote" }, [icon("i-alert"), el("div", {}, [
        el("p", { class: "callout-title", text: "Not saved on this device" }),
        el("p", { text: c.memory_mode }),
        S && S.reason() ? el("p", { class: "mini-note", text: S.reason() }) : null
      ])]));
    }
    var dl = el("dl", { class: "set-facts", id: "setFacts" });
    s1.appendChild(dl);
    function fact(k, v, id) { dl.appendChild(el("dt", { text: k })); dl.appendChild(el("dd", { text: v, id: id })); }
    fact("Storage", persistent ? "Saved in this browser (IndexedDB)" : "Memory only, lost when you close the page", "factMode");
    s1.appendChild(el("p", { class: "mini-note", text: c.privacy }));
    frag.appendChild(s1);

    // --- iPhone eviction note
    var ios = iosNote(c);
    var e = c.ios_eviction;
    if (ios) frag.appendChild(ios);
    var evidence = section("About saved data on iPhone", "setIosTitle");
    evidence.appendChild(el("p", { text: e.text_safari }));
    var sp = el("p", { class: "mini-note" });
    sp.appendChild(document.createTextNode("Source: "));
    sp.appendChild(el("a", { href: e.source_url, target: "_blank", rel: "noopener", text: e.source_name }));
    sp.appendChild(document.createTextNode(". " + e.source_note + " Last reviewed " + fmtDate(e.last_reviewed) + "."));
    evidence.appendChild(sp);
    if (e.status !== "approved") evidence.insertBefore(el("p", {}, [el("span", { class: "tag tag-draft", text: "DRAFT: not yet signed off" })]), evidence.children[1]);
    frag.appendChild(evidence);

    // --- offline pack
    var s2 = section("Offline pack", "setPackTitle");
    var packP = el("p", { id: "setPack", text: "Checking..." });
    s2.appendChild(packP);
    var packBtn = btn("Check again", "i-refresh", "btn-secondary", "packCheck");
    packBtn.addEventListener("click", function () { refreshPack(packP); });
    s2.appendChild(el("div", { class: "actions" }, [packBtn]));
    frag.appendChild(s2);

    // --- storage
    var s3 = section("Storage", "setStorageTitle");
    var stP = el("p", { id: "setStorage", text: "Checking..." });
    s3.appendChild(stP);
    var persistBtn = btn("Ask the browser to keep this data", null, "btn-secondary", "persistBtn");
    persistBtn.addEventListener("click", function () {
      S.requestPersist().then(function (v) {
        setStatus(v === null ? "This browser cannot do that." : (v ? "Done. The browser will try to keep your data." : "The browser did not agree. It may still keep your data."));
        refreshStorage(stP);
      });
    });
    s3.appendChild(el("div", { class: "actions" }, [persistBtn]));
    frag.appendChild(s3);

    // --- backup
    var s4 = section("Back up and restore", "setBackupTitle");
    s4.appendChild(el("p", { text: c.backup }));
    var expBtn = btn("Back up now", "i-download", "btn-primary", "exportBtn");
    var file = el("input", { type: "file", id: "importFile", accept: "application/json,.json", class: "sr-only", tabindex: "-1", "aria-hidden": "true" });
    var impBtn = btn("Restore from a backup", "i-refresh", "btn-secondary", "importBtn");
    var impMsg = el("div", { id: "importMsg", class: "status", role: "status", "aria-live": "polite" });
    expBtn.addEventListener("click", function () { doExport(); });
    impBtn.addEventListener("click", function () { file.click(); });
    file.addEventListener("change", function () { if (file.files && file.files[0]) readImport(file.files[0], impMsg); file.value = ""; });
    s4.appendChild(el("div", { class: "actions" }, [expBtn, impBtn, file]));
    s4.appendChild(impMsg);
    frag.appendChild(s4);

    // --- clear
    var s5 = section("Clear saved data", "setClearTitle");
    s5.appendChild(el("p", { text: c.clear }));
    var clearBtn = btn("Clear saved data", null, "btn-secondary btn-danger", "clearBtn");
    var clearMsg = el("div", { id: "clearMsg", class: "status", role: "status", "aria-live": "polite" });
    var armed = false, t;
    clearBtn.addEventListener("click", function () {
      if (!armed) {
        armed = true; clearBtn.textContent = "Tap again to clear";
        clearMsg.textContent = "Tap the button again within 5 seconds to remove everything you saved on this device.";
        t = setTimeout(function () { armed = false; clearBtn.textContent = "Clear saved data"; clearMsg.textContent = ""; }, 5000);
        return;
      }
      clearTimeout(t); armed = false; clearBtn.textContent = "Clear saved data";
      S.clearLocalData().then(function () {
        clearMsg.textContent = "Cleared. Your saved questions, plans, checklists and ticks are gone from this device.";
        document.dispatchEvent(new CustomEvent("om:local-data-changed"));
        refreshCounts(dl);
      });
    });
    s5.appendChild(el("div", { class: "actions" }, [clearBtn]));
    s5.appendChild(clearMsg);
    frag.appendChild(s5);

    root.appendChild(frag);
    refreshCounts(dl); refreshPack(packP); refreshStorage(stP);
  }

  function refreshCounts(dl) {
    var S = window.OMStore;
    if (!S) return;
    Promise.all([S.counts(), S.getMeta("history_synced_at", null), S.getMeta("plans_synced_at", null)]).then(function (r) {
      var c = r[0];
      Array.prototype.slice.call(dl.querySelectorAll(".dyn")).forEach(function (n) { n.parentNode.removeChild(n); });
      function fact(k, v, id) { var a = el("dt", { class: "dyn", text: k }), b = el("dd", { class: "dyn", text: v, id: id }); dl.appendChild(a); dl.appendChild(b); }
      fact("Saved questions", String(c.history) + (r[1] ? " (last updated " + fmtStamp(r[1]) + ")" : ""), "factHistory");
      fact("Saved trip plans", String(c.plans) + (r[2] ? " (last updated " + fmtStamp(r[2]) + ")" : ""), "factPlans");
      fact("Saved AI checklists", String(c.checklists), "factChecklists");
      fact("Ticked checklist items", String(c.ticked_items), "factTicks");
    });
  }
  function refreshPack(p) {
    var om = OM();
    p.textContent = "Checking...";
    var f = om.packStatus ? om.packStatus() : Promise.resolve(null);
    f.then(function () {
      var pack = om.pack;
      if (pack && pack.ready) p.textContent = "Offline pack ready. Version " + pack.version + ", " + pack.files + " files saved on this phone. The guides, checklists and Emergency screen work without signal.";
      else if (pack) p.textContent = "Offline pack not ready yet. Stay online until it finishes, then check again.";
      else p.textContent = "Offline pack status is not available. If you are online, reload the page.";
    });
  }
  function refreshStorage(p) {
    var S = window.OMStore;
    if (!S) { p.textContent = "Not available."; return; }
    S.estimate().then(function (e) {
      var parts = [];
      parts.push(e.supported ? "This site is using about " + fmtBytes(e.usage) + " of about " + fmtBytes(e.quota) + " available." : "This browser does not report storage use.");
      parts.push(e.persisted === true ? "The browser has agreed to keep your data." : (e.persisted === false ? "The browser may clear this data if the phone runs low on space." : ""));
      p.textContent = parts.filter(Boolean).join(" ");
    });
  }

  /* ---------------------------------------------------------- backup */
  function doExport() {
    var S = window.OMStore;
    S.exportData().then(function (d) {
      var cid = (OM().getClientId && OM().getClientId()) || d.client_id;
      if (cid) d.client_id = cid;
      var blob = new Blob([JSON.stringify(d, null, 1)], { type: "application/json" });
      var a = document.createElement("a");
      var ymd = new Date().toISOString().slice(0, 10);
      a.href = URL.createObjectURL(blob); a.download = "nomadmate-backup-" + ymd + ".json";
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); document.body.removeChild(a); }, 1000);
      var n = d.history.length + d.plans.length + d.checklists.length;
      setStatus("Backup file created with " + d.history.length + " questions, " + d.plans.length + " plans and " + d.checklists.length + " checklists.");
      var m = document.getElementById("importMsg"); if (m) m.textContent = "Backup file created (" + n + " saved items). Keep it somewhere private.";
    });
  }
  function finishImport(obj, useId, msg) {
    var S = window.OMStore;
    S.importData(obj, { useClientId: useId }).then(function (r) {
      if (!r.ok) { msg.textContent = r.error; return; }
      var a = r.added;
      msg.textContent = "Restored. Added " + a.history + " questions, " + a.plans + " plans and " + a.checklists + " checklists. Existing items were kept." + (useId && r.client_id ? " This phone now uses the ID from the backup." : "");
      if (useId && r.client_id && OM().setClientId) OM().setClientId(r.client_id);
      document.dispatchEvent(new CustomEvent("om:local-data-changed"));
      var dl = document.getElementById("setFacts"); if (dl) refreshCounts(dl);
    });
  }
  function readImport(f, msg) {
    var S = window.OMStore;
    msg.textContent = "";
    if (f.size > 5 * 1024 * 1024) { msg.textContent = "That file is too big to be a NomadMate backup (over 5 MB)."; return; }
    var rd = new FileReader();
    rd.onerror = function () { msg.textContent = "The file could not be read."; };
    rd.onload = function () {
      var obj;
      try { obj = JSON.parse(String(rd.result)); } catch (e) { msg.textContent = "This file is not a NomadMate backup."; return; }
      var v = S.validateBackup(obj);
      if (v.error) { msg.textContent = v.error; return; }
      var cur = OM().getClientId ? OM().getClientId() : null;
      if (v.data.client_id && cur && v.data.client_id.toLowerCase() !== cur.toLowerCase()) {
        msg.textContent = "";
        var box = el("div", { class: "callout", role: "group", "aria-label": "Which ID to use" }, [icon("i-alert"), el("div", {}, [
          el("p", { class: "callout-title", text: "This backup is from a different NomadMate ID" }),
          el("p", { text: "Using the backup's ID brings back the question history the server holds for that ID. Keeping this phone's ID leaves your server history as it is. Either way, the saved items in the backup are added to this phone." }),
          el("div", { class: "actions" }, [
            (function () { var b = btn("Use the backup's ID", null, "btn-primary", "useBackupId"); b.addEventListener("click", function () { box.remove(); finishImport(obj, true, msg); }); return b; })(),
            (function () { var b = btn("Keep this phone's ID", null, "btn-secondary", "keepMyId"); b.addEventListener("click", function () { box.remove(); finishImport(obj, false, msg); }); return b; })()
          ])
        ])]);
        msg.parentNode.insertBefore(box, msg);
        return;
      }
      finishImport(obj, !cur && !!v.data.client_id, msg);
    };
    rd.readAsText(f);
  }

  function show() {
    if (!root) return;
    var S = window.OMStore;
    Promise.all([ready(), S ? S.ready : Promise.resolve()]).then(function (r) { render(r[0]); setStatus("Saved data and settings"); })
      .catch(function () {
        root.textContent = "";
        root.appendChild(el("p", { class: "guide-empty", text: "This screen could not be loaded. If you are online, reload the page." }));
      });
  }
  function init() {
    root = document.getElementById("settingsRoot");
    document.addEventListener("om:settings-shown", show);
    if (location.hash === "#settings") show();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();

  window.OMSettings = { iosNote: function () { return ready().then(function (c) { return iosNote(c, true); }); }, isIos: isIos, isStandalone: isStandalone };
})();
