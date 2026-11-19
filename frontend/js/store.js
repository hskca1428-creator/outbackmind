/* NomadMate on-device storage (Stage 3).
 * A small hand-written IndexedDB wrapper. No libraries, no network.
 *
 * Stores (database "nomadmate-store", version 1):
 *   meta             key/value: client id mirror, selected state, last saved times
 *   history          copy of GET /history (newest 100)
 *   plans            copy of GET /trip-plans (newest 50)
 *   checklists       checklists the AI generated (the server does not keep them), with tick state (newest 50)
 *   templates_state  tick state for the built-in checklist templates
 *
 * If IndexedDB is not available (some private modes, blocked storage) everything keeps working in memory for this
 * page visit only, and OMStore.mode() returns "memory" so the screens can say "not saved on this device".
 * Every method returns a Promise that RESOLVES (never rejects) so a storage problem can never break the page.
 */
(function () {
  "use strict";
  var DB_NAME = "nomadmate-store";
  var DB_VERSION = 1;
  var STORES = { meta: "key", history: "key", plans: "id", checklists: "id", templates_state: "id" };
  var LIMITS = { history: 100, plans: 50, checklists: 50 };
  var SORT = { history: "created_at", plans: "created_at", checklists: "saved_at" };
  var OPEN_TIMEOUT_MS = 4000;
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var ID_RE = /^[A-Za-z0-9_.:|-]{1,200}$/;

  var db = null;
  var mode = "pending"; // "indexeddb" | "memory" | "pending"
  var reason = "";
  var mem = {};
  Object.keys(STORES).forEach(function (s) { mem[s] = {}; });

  function toMemory(why) { mode = "memory"; reason = why || ""; db = null; }

  function nowIso() { return new Date().toISOString(); }

  var ready = new Promise(function (resolve) {
    var done = false;
    function finish() { if (!done) { done = true; resolve({ mode: mode, reason: reason }); } }
    try {
      if (!window.indexedDB) { toMemory("This browser does not offer IndexedDB."); return finish(); }
      var timer = setTimeout(function () { if (mode === "pending") toMemory("Opening storage took too long."); finish(); }, OPEN_TIMEOUT_MS);
      var req = window.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var d = req.result;
        Object.keys(STORES).forEach(function (name) {
          if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: STORES[name] });
        });
      };
      req.onsuccess = function () {
        clearTimeout(timer);
        if (mode === "memory") { try { req.result.close(); } catch (e) {} return finish(); }
        db = req.result;
        db.onversionchange = function () { try { db.close(); } catch (e) {} toMemory("Storage was changed by another tab."); };
        mode = "indexeddb";
        finish();
      };
      req.onerror = function () { clearTimeout(timer); toMemory("This browser blocked storage (for example in private browsing)."); finish(); };
      req.onblocked = function () { clearTimeout(timer); toMemory("Storage is blocked by another tab."); finish(); };
    } catch (e) {
      toMemory("This browser blocked storage (for example in private browsing).");
      finish();
    }
  });

  // ---- low-level helpers ----------------------------------------------------------------------------------
  function idbRun(storeName, access, fn) {
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction(storeName, access);
        var st = tx.objectStore(storeName);
        var out;
        try { out = fn(st); } catch (e) { resolve({ ok: false, error: e }); return; }
        tx.oncomplete = function () {
          if (out && out.__req) resolve({ ok: true, value: out.__req.result });
          else resolve({ ok: true, value: out });
        };
        tx.onerror = tx.onabort = function () { resolve({ ok: false, error: tx.error }); };
      } catch (e) { resolve({ ok: false, error: e }); }
    });
  }
  function reqWrap(r) { return { __req: r }; }

  function fail(res) {
    // A write or read failed. Keep the page working, and tell the screens.
    api.lastError = (res && res.error && (res.error.name || res.error.message)) || "storage error";
    if (res && res.error && /quota/i.test(String(res.error.name || res.error.message))) api.quotaExceeded = true;
  }

  function getAll(store) {
    return ready.then(function () {
      if (mode === "memory") return Object.keys(mem[store]).map(function (k) { return mem[store][k]; });
      return idbRun(store, "readonly", function (s) { return reqWrap(s.getAll()); }).then(function (r) {
        if (!r.ok) { fail(r); return []; }
        return r.value || [];
      });
    });
  }
  function getOne(store, key) {
    return ready.then(function () {
      if (mode === "memory") return mem[store][key] || null;
      return idbRun(store, "readonly", function (s) { return reqWrap(s.get(key)); }).then(function (r) {
        if (!r.ok) { fail(r); return null; }
        return r.value || null;
      });
    });
  }
  function putMany(store, records) {
    records = (records || []).filter(Boolean);
    if (!records.length) return ready.then(function () { return true; });
    var kp = STORES[store];
    return ready.then(function () {
      if (mode === "memory") { records.forEach(function (rec) { mem[store][rec[kp]] = rec; }); return true; }
      return idbRun(store, "readwrite", function (s) { records.forEach(function (rec) { s.put(rec); }); }).then(function (r) {
        if (!r.ok) { fail(r); return false; }
        return true;
      });
    });
  }
  function deleteKeys(store, keys) {
    keys = keys || [];
    if (!keys.length) return ready.then(function () { return true; });
    return ready.then(function () {
      if (mode === "memory") { keys.forEach(function (k) { delete mem[store][k]; }); return true; }
      return idbRun(store, "readwrite", function (s) { keys.forEach(function (k) { s.delete(k); }); }).then(function (r) {
        if (!r.ok) { fail(r); return false; }
        return true;
      });
    });
  }
  function clearStore(store) {
    return ready.then(function () {
      if (mode === "memory") { mem[store] = {}; return true; }
      return idbRun(store, "readwrite", function (s) { s.clear(); }).then(function (r) { if (!r.ok) { fail(r); return false; } return true; });
    });
  }
  function trim(store) {
    var max = LIMITS[store], field = SORT[store];
    if (!max) return Promise.resolve(true);
    return getAll(store).then(function (all) {
      if (all.length <= max) return true;
      all.sort(function (a, b) { return String(b[field] || "").localeCompare(String(a[field] || "")); });
      var kp = STORES[store];
      return deleteKeys(store, all.slice(max).map(function (x) { return x[kp]; }));
    });
  }
  function newestFirst(store) {
    var field = SORT[store];
    return getAll(store).then(function (all) {
      all.sort(function (a, b) { return String(b[field] || "").localeCompare(String(a[field] || "")); });
      return all;
    });
  }

  // ---- meta -----------------------------------------------------------------------------------------------
  function getMeta(key, def) {
    return getOne("meta", key).then(function (r) { return r && "value" in r ? r.value : def; });
  }
  function setMeta(key, value) {
    return putMany("meta", [{ key: key, value: value, updated: nowIso() }]);
  }

  // ---- history (copy of GET /history) ---------------------------------------------------------------------
  function historyKey(it) { return String(it.created_at || "") + "|" + String(it.mode || "normal") + "|" + String(it.question || "").slice(0, 60); }
  function saveHistory(serverItems) {
    // The server list is the truth for what it holds. Items we saved locally while the server could not be
    // reached are dropped now, because the server list includes them.
    var t = nowIso();
    var recs = (serverItems || []).map(function (it) {
      return { key: historyKey(it), question: String(it.question || ""), mode: it.mode === "emergency" ? "emergency" : "normal", answer: String(it.answer || ""), created_at: String(it.created_at || ""), saved_at: t };
    });
    return getAll("history").then(function (all) {
      var localKeys = all.filter(function (x) { return x.local; }).map(function (x) { return x.key; });
      return deleteKeys("history", localKeys);
    }).then(function () { return putMany("history", recs); })
      .then(function () { return trim("history"); })
      .then(function () { return setMeta("history_synced_at", t); });
  }
  function addLocalHistory(item) {
    var it = { question: item.question, mode: item.mode, answer: item.answer, created_at: item.created_at || nowIso() };
    var rec = { key: historyKey(it), question: String(it.question || ""), mode: it.mode === "emergency" ? "emergency" : "normal", answer: String(it.answer || ""), created_at: it.created_at, saved_at: nowIso(), local: true };
    return putMany("history", [rec]).then(function () { return trim("history"); });
  }
  function listHistory() { return newestFirst("history"); }

  // ---- plans (copy of GET /trip-plans) --------------------------------------------------------------------
  function savePlans(serverItems) {
    var t = nowIso();
    var recs = (serverItems || []).filter(function (p) { return p && p.id != null; }).map(function (p) {
      return { id: "s" + String(p.id), server_id: p.id, request: String(p.request || ""), plan: String(p.plan || ""), created_at: String(p.created_at || ""), saved_at: t };
    });
    return getAll("plans").then(function (all) {
      return deleteKeys("plans", all.filter(function (x) { return x.local; }).map(function (x) { return x.id; }));
    }).then(function () { return putMany("plans", recs); })
      .then(function () { return trim("plans"); })
      .then(function () { return setMeta("plans_synced_at", t); });
  }
  function addLocalPlan(p) {
    var t = nowIso();
    return putMany("plans", [{ id: "l" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), request: String(p.request || ""), plan: String(p.plan || ""), created_at: p.created_at || t, saved_at: t, local: true }])
      .then(function () { return trim("plans"); });
  }
  function listPlans() { return newestFirst("plans"); }

  // ---- AI checklists (not kept by the server) -------------------------------------------------------------
  function saveChecklist(rec) {
    var t = nowIso();
    var r = { id: rec.id || ("c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)), request: String(rec.request || ""), text: String(rec.text || ""), created_at: rec.created_at || t, saved_at: rec.saved_at || t, ticks: rec.ticks || {} };
    return putMany("checklists", [r]).then(function () { return trim("checklists"); }).then(function () { return r; });
  }
  function listChecklists() { return newestFirst("checklists"); }
  function getChecklist(id) { return getOne("checklists", id); }
  // Read-modify-write updates (ticking three boxes quickly) must not overlap, or one tick overwrites another.
  var chain = Promise.resolve();
  function serial(fn) { var p = chain.then(fn); chain = p.then(function () {}, function () {}); return p; }

  function setChecklistTick(id, itemKey, on) {
    return serial(function () { return setChecklistTickNow(id, itemKey, on); });
  }
  function setChecklistTickNow(id, itemKey, on) {
    return getOne("checklists", id).then(function (rec) {
      if (!rec) return false;
      rec.ticks = rec.ticks || {};
      if (on) rec.ticks[itemKey] = true; else delete rec.ticks[itemKey];
      return putMany("checklists", [rec]);
    });
  }
  function clearChecklistTicks(id) { return serial(function () { return clearChecklistTicksNow(id); }); }
  function clearChecklistTicksNow(id) {
    return getOne("checklists", id).then(function (rec) { if (!rec) return false; rec.ticks = {}; return putMany("checklists", [rec]); });
  }
  function deleteChecklist(id) { return deleteKeys("checklists", [id]); }

  // ---- built-in template ticks ----------------------------------------------------------------------------
  function getTemplateTicks(id) { return getOne("templates_state", id).then(function (r) { return (r && r.ticks) || {}; }); }
  function setTemplateTick(id, itemId, on) { return serial(function () { return setTemplateTickNow(id, itemId, on); }); }
  function setTemplateTickNow(id, itemId, on) {
    return getOne("templates_state", id).then(function (rec) {
      rec = rec || { id: id, ticks: {} };
      rec.ticks = rec.ticks || {};
      if (on) rec.ticks[itemId] = true; else delete rec.ticks[itemId];
      rec.updated = nowIso();
      return putMany("templates_state", [rec]);
    });
  }
  function clearTemplateTicks(id) { return serial(function () { return deleteKeys("templates_state", [id]); }); }
  function allTemplateTicks() {
    return getAll("templates_state").then(function (all) { var o = {}; all.forEach(function (r) { o[r.id] = r.ticks || {}; }); return o; });
  }

  // ---- counts, estimate, clear ----------------------------------------------------------------------------
  function counts() {
    var names = ["history", "plans", "checklists", "templates_state"];
    return Promise.all(names.map(getAll)).then(function (res) {
      var o = {};
      names.forEach(function (n, i) { o[n] = res[i].length; });
      o.ticked_items = res[3].reduce(function (n, r) { return n + Object.keys(r.ticks || {}).length; }, 0);
      return o;
    });
  }
  function estimate() {
    var out = { usage: null, quota: null, persisted: null, supported: !!(navigator.storage && navigator.storage.estimate) };
    var p1 = out.supported ? navigator.storage.estimate().then(function (e) { out.usage = e.usage; out.quota = e.quota; }).catch(function () {}) : Promise.resolve();
    var p2 = (navigator.storage && navigator.storage.persisted) ? navigator.storage.persisted().then(function (v) { out.persisted = v; }).catch(function () {}) : Promise.resolve();
    return Promise.all([p1, p2]).then(function () { return out; });
  }
  function requestPersist() {
    if (!(navigator.storage && navigator.storage.persist)) return Promise.resolve(null);
    return navigator.storage.persist().catch(function () { return false; });
  }
  // Clears what you saved on this device. The client id and the offline pack (guides, Emergency screen) are kept.
  function clearLocalData() {
    return Promise.all(["history", "plans", "checklists", "templates_state"].map(clearStore)).then(function () {
      return Promise.all(["history_synced_at", "plans_synced_at"].map(function (k) { return deleteKeys("meta", [k]); }));
    }).then(function () { return true; });
  }

  // ---- export / import ------------------------------------------------------------------------------------
  var BACKUP_KIND = "nomadmate-local-backup";
  function exportData() {
    return Promise.all([getAll("history"), getAll("plans"), getAll("checklists"), getAll("templates_state"), getMeta("client_id", null), getMeta("om_state", null)]).then(function (r) {
      return {
        app: "NomadMate", kind: BACKUP_KIND, schema: 1, exported_at: nowIso(),
        note: "Your NomadMate data from this device. Keep this file private: it contains your questions and plans and the anonymous ID that links to your history on the NomadMate server.",
        client_id: r[4], selected_state: r[5],
        history: r[0].map(function (x) { return { question: x.question, mode: x.mode, answer: x.answer, created_at: x.created_at }; }),
        plans: r[1].map(function (x) { return { id: x.id, request: x.request, plan: x.plan, created_at: x.created_at }; }),
        checklists: r[2].map(function (x) { return { id: x.id, request: x.request, text: x.text, created_at: x.created_at, saved_at: x.saved_at, ticks: x.ticks || {} }; }),
        template_ticks: r[3].map(function (x) { return { id: x.id, ticks: x.ticks || {} }; })
      };
    });
  }

  function str(v, max) { return typeof v === "string" ? v.slice(0, max) : ""; }
  function cleanTicks(t) {
    var o = {}, n = 0;
    if (t && typeof t === "object" && !Array.isArray(t)) {
      Object.keys(t).forEach(function (k) { if (n < 500 && /^[A-Za-z0-9_-]{1,80}$/.test(k) && t[k] === true) { o[k] = true; n++; } });
    }
    return o;
  }
  // Pure: turns an untrusted object into clean records, or { error }.
  function validateBackup(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { error: "This file is not a NomadMate backup." };
    if (obj.kind !== BACKUP_KIND || obj.app !== "NomadMate") return { error: "This file is not a NomadMate backup." };
    if (obj.schema !== 1) return { error: "This backup was made by a different version of NomadMate and cannot be read." };
    var cap = 500, out = { client_id: null, selected_state: null, history: [], plans: [], checklists: [], template_ticks: [] };
    if (obj.client_id != null) {
      if (typeof obj.client_id !== "string" || !UUID_RE.test(obj.client_id)) return { error: "The backup has an invalid ID." };
      out.client_id = obj.client_id.toLowerCase();
    }
    if (typeof obj.selected_state === "string" && /^[A-Z]{2,3}$/.test(obj.selected_state)) out.selected_state = obj.selected_state;
    (Array.isArray(obj.history) ? obj.history.slice(0, cap) : []).forEach(function (x) {
      if (!x || typeof x !== "object" || typeof x.question !== "string") return;
      out.history.push({ question: str(x.question, 4000), mode: x.mode === "emergency" ? "emergency" : "normal", answer: str(x.answer, 40000), created_at: str(x.created_at, 40) });
    });
    (Array.isArray(obj.plans) ? obj.plans.slice(0, cap) : []).forEach(function (x) {
      if (!x || typeof x !== "object" || typeof x.plan !== "string") return;
      out.plans.push({ id: ID_RE.test(String(x.id || "")) ? String(x.id) : null, request: str(x.request, 4000), plan: str(x.plan, 60000), created_at: str(x.created_at, 40) });
    });
    (Array.isArray(obj.checklists) ? obj.checklists.slice(0, cap) : []).forEach(function (x) {
      if (!x || typeof x !== "object" || typeof x.text !== "string") return;
      out.checklists.push({ id: ID_RE.test(String(x.id || "")) ? String(x.id) : null, request: str(x.request, 4000), text: str(x.text, 60000), created_at: str(x.created_at, 40), saved_at: str(x.saved_at, 40), ticks: cleanTicks(x.ticks) });
    });
    (Array.isArray(obj.template_ticks) ? obj.template_ticks.slice(0, 100) : []).forEach(function (x) {
      if (!x || typeof x !== "object" || !/^[a-z0-9-]{1,60}$/.test(String(x.id || ""))) return;
      out.template_ticks.push({ id: x.id, ticks: cleanTicks(x.ticks) });
    });
    return { data: out };
  }

  // Merges a validated backup into this device. Nothing is deleted. options.useClientId sets the client id.
  function importData(obj, options) {
    options = options || {};
    var v = validateBackup(obj);
    if (v.error) return Promise.resolve({ ok: false, error: v.error });
    var d = v.data, t = nowIso(), added = { history: 0, plans: 0, checklists: 0, template_ticks: 0 };
    var hist = d.history.map(function (x) { return { key: historyKey(x), question: x.question, mode: x.mode, answer: x.answer, created_at: x.created_at, saved_at: t, imported: true }; });
    var plans = d.plans.map(function (x, i) { return { id: "i" + (x.id || (Date.now().toString(36) + i)), request: x.request, plan: x.plan, created_at: x.created_at, saved_at: t, imported: true }; });
    var lists = d.checklists.map(function (x, i) { return { id: x.id || ("i" + Date.now().toString(36) + i), request: x.request, text: x.text, created_at: x.created_at || t, saved_at: x.saved_at || t, ticks: x.ticks }; });
    return Promise.all([getAll("history"), getAll("plans"), getAll("checklists"), getAll("templates_state")]).then(function (cur) {
      var have = function (arr, kp) { var s = {}; arr.forEach(function (r) { s[r[kp]] = 1; }); return s; };
      var hh = have(cur[0], "key"), hp = have(cur[1], "id"), hc = have(cur[2], "id");
      hist = hist.filter(function (r) { return !hh[r.key]; });
      plans = plans.filter(function (r) { return !hp[r.id]; });
      lists = lists.filter(function (r) { return !hc[r.id]; });
      added.history = hist.length; added.plans = plans.length; added.checklists = lists.length;
      var curTicks = {}; cur[3].forEach(function (r) { curTicks[r.id] = r.ticks || {}; });
      var tt = d.template_ticks.map(function (x) {
        var merged = {}; var a = curTicks[x.id] || {};
        Object.keys(a).forEach(function (k) { merged[k] = true; }); Object.keys(x.ticks).forEach(function (k) { merged[k] = true; });
        return { id: x.id, ticks: merged, updated: t };
      });
      added.template_ticks = tt.length;
      return Promise.all([putMany("history", hist), putMany("plans", plans), putMany("checklists", lists), putMany("templates_state", tt)]);
    }).then(function () { return Promise.all([trim("history"), trim("plans"), trim("checklists")]); })
      .then(function () {
        if (options.useClientId && d.client_id) return setMeta("client_id", d.client_id);
      }).then(function () {
        if (d.selected_state) return setMeta("om_state", d.selected_state);
      }).then(function () { return { ok: true, added: added, client_id: d.client_id }; });
  }

  var api = {
    ready: ready,
    mode: function () { return mode; },
    reason: function () { return reason; },
    isPersistent: function () { return mode === "indexeddb"; },
    lastError: null, quotaExceeded: false,
    getMeta: getMeta, setMeta: setMeta,
    saveHistory: saveHistory, addLocalHistory: addLocalHistory, listHistory: listHistory,
    savePlans: savePlans, addLocalPlan: addLocalPlan, listPlans: listPlans,
    saveChecklist: saveChecklist, listChecklists: listChecklists, getChecklist: getChecklist,
    setChecklistTick: setChecklistTick, clearChecklistTicks: clearChecklistTicks, deleteChecklist: deleteChecklist,
    getTemplateTicks: getTemplateTicks, setTemplateTick: setTemplateTick, clearTemplateTicks: clearTemplateTicks, allTemplateTicks: allTemplateTicks,
    counts: counts, estimate: estimate, requestPersist: requestPersist, clearLocalData: function () { return serial(clearLocalData); },
    exportData: exportData, importData: function (o, opt) { return serial(function () { return importData(o, opt); }); }, validateBackup: validateBackup,
    limits: LIMITS, uuidRe: UUID_RE
  };
  window.OMStore = api;
})();
