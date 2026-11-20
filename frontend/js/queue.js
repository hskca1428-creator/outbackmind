/* NomadMate saved-question queue (Stage 4).
 *
 * When there is no signal, a Normal Mode question can be SAVED on this phone with an explicit button
 * ("Save to send when online"). When the connection returns, saved questions are sent one at a time and the
 * answers are kept here until the traveller removes them.
 *
 * Rules (all enforced here, not only in the screen):
 *   - Emergency Mode is NEVER saved or queued. add() refuses it. Emergency content is offline and one tap away.
 *   - Nothing is sent without the traveller having pressed the save button. Nothing is sent silently.
 *   - The same question is not saved twice (duplicate submits are ignored).
 *   - Sequential sending, with back-off for "service busy" (429) and for server problems (5xx).
 *   - Sending happens while the app is open: on start-up, when the connection returns, and when the app regains focus.
 *     (iPhone has no Background Sync, so the app cannot send while closed. This code does not rely on it anywhere.)
 *
 * Storage: localStorage, one key, JSON, capped by item count and text size (see config/app-config.json "queue").
 * The key is created only when something is saved, and removed when the list is empty.
 * If localStorage is blocked, the list lives in memory for this visit only and OMQueue.persistent() is false.
 *
 * Events on document: om:queue-changed {items}, om:queue-answered {item}.
 */
(function () {
  "use strict";
  var KEY = "om_queue_v1";
  var CLIENT_KEY = "outbackmind_client_id";
  var DEFAULTS = {
    enabled: true,
    max_items: 20,
    max_question_chars: 1000,
    max_answer_chars: 8000,
    max_attempts: 5,
    send_timeout_ms: 60000,
    backoff_s: [30, 60, 120, 300],
    rate_limit_wait_s: 60,
    keep_answered: 5,
    stale_sending_s: 90
  };
  var mem = null;          // used only if localStorage is blocked
  var persistent = true;
  var flushing = false;
  var timer = null;

  function OMx() { return window.OM || null; }
  function conf() {
    var c = (OMx() && OMx().config && OMx().config()) || null;
    var q = (c && c.queue && typeof c.queue === "object") ? c.queue : {};
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      var v = q[k], d = DEFAULTS[k];
      if (Array.isArray(d)) out[k] = (Array.isArray(v) && v.length && v.every(function (x) { return typeof x === "number" && x > 0; })) ? v : d;
      else if (typeof d === "boolean") out[k] = typeof v === "boolean" ? v : d;
      else out[k] = (typeof v === "number" && isFinite(v) && v >= 0) ? v : d;
    });
    return out;
  }
  function now() { return Date.now(); }
  function iso() { return new Date().toISOString(); }
  function norm(s) { return String(s || "").replace(/\s+/g, " ").trim().toLowerCase(); }
  function newId() { return "q" + now().toString(36) + Math.random().toString(36).slice(2, 7); }

  // ---- storage ---------------------------------------------------------------------------------------------
  function read() {
    if (!persistent) return (mem || []).slice();
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter(function (x) { return x && typeof x.id === "string" && typeof x.question === "string"; }) : [];
    } catch (e) {
      if (e && e.name === "SecurityError") { persistent = false; mem = []; return []; }
      return [];
    }
  }
  function write(items) {
    if (!persistent) { mem = items.slice(); return true; }
    try {
      if (!items.length) localStorage.removeItem(KEY); else localStorage.setItem(KEY, JSON.stringify(items));
      return true;
    } catch (e) {
      if (e && e.name === "QuotaExceededError") return false;
      persistent = false; mem = items.slice(); return true;
    }
  }
  function changed() { try { document.dispatchEvent(new CustomEvent("om:queue-changed", { detail: { items: list() } })); } catch (e) {} }
  function save(items) { var ok = write(items); changed(); schedule(); return ok; }

  function prune(items, c) {
    // Keep only the newest answered items (the answers are also in Recent questions on Ask).
    var answered = items.filter(function (x) { return x.status === "answered"; })
      .sort(function (a, b) { return String(b.answered_at || "").localeCompare(String(a.answered_at || "")); });
    var drop = {};
    answered.slice(c.keep_answered).forEach(function (x) { drop[x.id] = 1; });
    return items.filter(function (x) { return !drop[x.id]; });
  }
  function list() {
    return read().sort(function (a, b) { return String(a.created_at).localeCompare(String(b.created_at)); });
  }
  function pendingCount() { return read().filter(function (x) { return x.status === "queued" || x.status === "sending"; }).length; }
  function find(items, id) { for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i]; return null; }

  // ---- adding ----------------------------------------------------------------------------------------------
  function add(input) {
    var c = conf();
    if (!c.enabled) return { ok: false, reason: "disabled", message: "Saving questions to send later is switched off." };
    var mode = input && input.mode === "emergency" ? "emergency" : "normal";
    if (mode === "emergency") return { ok: false, reason: "emergency", message: "Emergency questions are never saved for later. Open the Emergency screen." };
    var q = String((input && input.question) || "").replace(/\s+/g, " ").trim();
    if (!q) return { ok: false, reason: "empty", message: "Please enter a question." };
    if (q.length > c.max_question_chars) return { ok: false, reason: "too-long", message: "That question is too long to save. Please keep it under " + c.max_question_chars + " characters." };
    var items = read();
    var dup = items.filter(function (x) { return (x.status === "queued" || x.status === "sending" || x.status === "failed") && norm(x.question) === norm(q); })[0];
    if (dup) return { ok: false, reason: "duplicate", item: dup, message: "That question is already saved." };
    items = prune(items, c);
    var open = items.filter(function (x) { return x.status !== "answered"; }).length;
    if (open >= c.max_items) return { ok: false, reason: "full", message: "Your list is full (" + c.max_items + " questions). Cancel or remove one first." };
    // make room by dropping the oldest answered item if the list is at the cap
    while (items.length >= c.max_items) {
      var old = items.filter(function (x) { return x.status === "answered"; }).sort(function (a, b) { return String(a.answered_at).localeCompare(String(b.answered_at)); })[0];
      if (!old) break;
      items = items.filter(function (x) { return x.id !== old.id; });
    }
    var item = { id: newId(), kind: "ask", question: q, mode: "normal", status: "queued", created_at: iso(), attempts: 0, next_try_at: 0, note: "" };
    items.push(item);
    if (!save(items)) return { ok: false, reason: "storage", message: "This phone has no room to save it. Remove something in Saved, then try again." };
    return { ok: true, item: item };
  }

  // ---- user actions ----------------------------------------------------------------------------------------
  function cancel(id) {
    var items = read(), it = find(items, id);
    if (!it || it.status === "sending") return false;
    if (it.status !== "queued") return false;
    save(items.filter(function (x) { return x.id !== id; }));
    return true;
  }
  function remove(id) {
    var items = read(), it = find(items, id);
    if (!it || it.status === "sending" || it.status === "queued") return false;
    save(items.filter(function (x) { return x.id !== id; }));
    return true;
  }
  function retry(id) {
    var items = read(), it = find(items, id);
    if (!it || it.status !== "failed") return false;
    it.status = "queued"; it.attempts = 0; it.next_try_at = 0; it.error = ""; it.note = "";
    save(items);
    flush();
    return true;
  }
  function clearAll() { mem = []; try { localStorage.removeItem(KEY); } catch (e) {} changed(); schedule(); }

  // ---- sending ---------------------------------------------------------------------------------------------
  function clientId() { try { return localStorage.getItem(CLIENT_KEY) || ""; } catch (e) { return ""; } }
  function apiBase() { return OMx() && OMx().apiBase ? OMx().apiBase() : "https://api.outbackmind.au"; }
  // Online means: the connection check has run at least once and says online. Nothing is sent before that first check
  // (the page assumes "online" for a moment while it starts), so a phone with no signal never tries to send.
  function online() {
    var o = OMx();
    if (!o || !o.isOnline) return true;
    if (o.state && o.state.checked === false) return false;
    return o.isOnline();
  }
  function backoff(c, n) { var a = c.backoff_s; return a[Math.min(Math.max(n - 1, 0), a.length - 1)] * 1000; }

  function update(id, patch) {
    var items = read(), it = find(items, id);
    if (!it) return null;
    Object.keys(patch).forEach(function (k) { it[k] = patch[k]; });
    save(items);
    return it;
  }
  function recoverStale() {
    var c = conf(), items = read(), ch = false;
    items.forEach(function (x) {
      if (x.status === "sending" && (!x.sending_since || now() - x.sending_since > c.stale_sending_s * 1000)) { x.status = "queued"; x.note = ""; ch = true; }
    });
    if (ch) save(items);
  }
  function plainStatus(e) {
    var s = e && e.status;
    if (s === 429) return "The service is busy. NomadMate will try again soon.";
    if (s >= 500) return "NomadMate had a problem on its side.";
    if (e && e.serverDetail) return e.serverDetail;
    return "Something went wrong, so this question was not sent.";
  }

  function sendOne(it, c) {
    var ctl = ("AbortController" in window) ? new AbortController() : null;
    var to = ctl ? setTimeout(function () { ctl.abort(); }, c.send_timeout_ms) : null;
    return fetch(apiBase() + "/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Client-Id": clientId() },
      body: JSON.stringify({ question: it.question, mode: "normal" }),
      signal: ctl ? ctl.signal : undefined
    }).then(function (resp) {
      if (to) clearTimeout(to);
      return resp.json().catch(function () { return null; }).then(function (data) { return { resp: resp, data: data }; });
    }, function (err) { if (to) clearTimeout(to); throw err; });
  }

  function runFlush() {
    var c = conf();
    if (!c.enabled || !online() || !clientId()) return Promise.resolve();
    recoverStale();
    var next = list().filter(function (x) { return x.status === "queued" && (x.next_try_at || 0) <= now(); })[0];
    if (!next) return Promise.resolve();
    update(next.id, { status: "sending", sending_since: now(), note: "" });
    return sendOne(next, c).then(function (r) {
      var resp = r.resp, data = r.data;
      if (resp.ok && data && typeof data.answer === "string") {
        if (OMx() && OMx().reportApiSuccess) OMx().reportApiSuccess();
        var done = update(next.id, { status: "answered", answered_at: iso(), answer: data.answer.slice(0, c.max_answer_chars), gear: Array.isArray(data.recommended_gear) ? data.recommended_gear.slice(0, 12) : [], error: "", note: "", sending_since: 0 });
        var items = prune(read(), c); write(items);
        try { document.dispatchEvent(new CustomEvent("om:queue-answered", { detail: { item: done } })); } catch (e) {}
        changed();
        return runFlush();
      }
      var err = { status: resp.status };
      var d = data && data.detail;
      if (typeof d === "string" && d.length > 0 && d.length <= 200 && !/[{}<>]/.test(d)) err.serverDetail = d;
      var attempts = (next.attempts || 0) + 1;
      if (resp.status === 429) {
        if (/tomorrow|today's limit/i.test(err.serverDetail || "")) { update(next.id, { status: "failed", error: err.serverDetail, sending_since: 0 }); return runFlush(); }
        update(next.id, { status: "queued", next_try_at: now() + c.rate_limit_wait_s * 1000 * Math.min(Math.pow(2, next.attempts || 0), 8), note: "The service is busy. NomadMate will try again soon.", attempts: attempts, sending_since: 0 });
        return; // stop this pass; the timer retries later
      }
      if (resp.status >= 500) {
        if (attempts >= c.max_attempts) { update(next.id, { status: "failed", error: plainStatus(err), attempts: attempts, sending_since: 0 }); return runFlush(); }
        update(next.id, { status: "queued", next_try_at: now() + backoff(c, attempts), note: "NomadMate had a problem. It will try again soon.", attempts: attempts, sending_since: 0 });
        return;
      }
      update(next.id, { status: "failed", error: plainStatus(err), attempts: attempts, sending_since: 0 });
      return runFlush();
    }, function () {
      // No signal after all (or the request timed out). Not the traveller's fault and not an attempt: back to the list.
      update(next.id, { status: "queued", note: "Waiting for signal.", sending_since: 0 });
      if (OMx() && OMx().reportApiFailure) OMx().reportApiFailure();
    });
  }

  function flush() {
    if (flushing) return Promise.resolve();
    flushing = true;
    var run = function () { return runFlush(); };
    var p;
    if (navigator.locks && navigator.locks.request) {
      p = navigator.locks.request("om-queue-flush", { ifAvailable: true }, function (lock) { return lock ? run() : undefined; });
    } else p = run();
    return Promise.resolve(p).catch(function () {}).then(function () { flushing = false; schedule(); });
  }

  function schedule() {
    if (timer) { clearTimeout(timer); timer = null; }
    var due = read().filter(function (x) { return x.status === "queued" && x.next_try_at > now(); }).map(function (x) { return x.next_try_at; });
    if (!due.length) return;
    var wait = Math.max(1000, Math.min.apply(null, due) - now());
    timer = setTimeout(function () { timer = null; flush(); }, wait);
  }

  // ---- wiring ----------------------------------------------------------------------------------------------
  function start() {
    recoverStale();
    changed();
    flush();
  }
  document.addEventListener("om:connectivity", function (e) { if (e.detail && e.detail.online) flush(); });
  window.addEventListener("online", function () { setTimeout(flush, 800); });
  window.addEventListener("focus", function () { flush(); });
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") flush(); });
  window.addEventListener("storage", function (e) { if (e.key === KEY) changed(); });
  if (OMx() && OMx().configReady) OMx().configReady.then(start); else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();

  window.OMQueue = {
    enabled: function () { return conf().enabled; },
    config: conf,
    add: add, list: list, cancel: cancel, remove: remove, retry: retry, flush: flush, clearAll: clearAll,
    pendingCount: pendingCount,
    persistent: function () { return persistent; },
    storageKey: KEY
  };
})();
