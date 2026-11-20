/* NomadMate saved-question list on the Ask screen (Stage 4). Draws js/queue.js state in plain words:
 * Queued, Sending, Answered, Failed (with Retry), plus Cancel / Remove. Also puts a "n waiting" badge on the
 * Ask tile and the Ask tab, and a small, polite notice when a saved question has been answered.
 * Answer text is drawn by the function given to OMQueueUI.setAnswerRenderer (the Ask screen's own safe formatter). */
(function () {
  "use strict";
  var Q = window.OMQueue;
  var renderAnswer = null;
  var toastTimer = null;
  var LABEL = { queued: "Queued", sending: "Sending\u2026", answered: "Answered", failed: "Failed" };
  var open = {};   // answers the traveller has opened, kept across redraws

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function online() { return !window.OM || !window.OM.isOnline || (window.OM.isOnline() && !(window.OM.state && window.OM.state.checked === false)); }
  function when(iso) {
    var d = new Date(iso); if (isNaN(d)) return "";
    var t = d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
    var same = d.toDateString() === new Date().toDateString();
    return same ? t : d.toLocaleDateString("en-AU", { day: "numeric", month: "short" }) + ", " + t;
  }
  function live(msg) { var l = $("queueLive"); if (l) { l.textContent = ""; setTimeout(function () { l.textContent = msg; }, 30); } }

  function metaText(it) {
    if (it.status === "queued") return it.note || (online() ? "Saved " + when(it.created_at) + ". Sending in a moment." : "Saved " + when(it.created_at) + ". Will send when you are back online.");
    if (it.status === "sending") return "Sending now. Please keep the app open.";
    if (it.status === "answered") return "Answered " + when(it.answered_at) + ". Also saved under Recent questions.";
    return (it.error || "This question was not sent.") + " Your question is still saved here.";
  }

  function draw() {
    var panel = $("queuePanel"), ul = $("queueList");
    if (!panel || !ul || !Q) return;
    var items = Q.list();
    panel.hidden = items.length === 0;
    ul.textContent = "";
    items.forEach(function (it) {
      var li = el("li", "queue-item"); li.setAttribute("data-status", it.status); li.setAttribute("data-id", it.id);
      var top = el("div", "queue-item-top");
      top.appendChild(el("span", "queue-chip queue-chip-" + it.status, LABEL[it.status] || it.status));
      top.appendChild(el("span", "queue-q", it.question));
      li.appendChild(top);
      li.appendChild(el("p", "queue-meta", metaText(it)));
      var acts = el("div", "queue-actions");
      function btn(label, fn, aria) { var b = el("button", "tool-btn", label); b.type = "button"; b.setAttribute("aria-label", label + ": " + it.question.slice(0, 60)); b.addEventListener("click", fn); acts.appendChild(b); return b; }
      if (it.status === "queued") btn("Cancel", function () { Q.cancel(it.id); live("Question cancelled."); });
      if (it.status === "failed") { btn("Retry", function () { Q.retry(it.id); live("Trying again."); }); btn("Remove", function () { Q.remove(it.id); live("Question removed."); }); }
      if (it.status === "answered") {
        var det = el("details", "queue-answer");
        if (open[it.id]) det.open = true;
        det.addEventListener("toggle", function () { open[it.id] = det.open; });
        det.appendChild(el("summary", "", "Show answer"));
        var body = el("div", "queue-answer-body");
        if (renderAnswer) body.innerHTML = renderAnswer(it); else body.textContent = it.answer;
        det.appendChild(body);
        li.appendChild(det);
        btn("Remove", function () { Q.remove(it.id); live("Answer removed from this list."); });
      }
      if (acts.childNodes.length) li.appendChild(acts);
      ul.appendChild(li);
    });
    badges();
  }

  function badges() {
    if (!Q) return;
    var n = Q.pendingCount();
    [["[data-tile=ask] .tile-body", "tile-badge"], ["[data-nav=ask]", "nav-badge"]].forEach(function (p) {
      var host = document.querySelector(p[0]); if (!host) return;
      var b = host.querySelector(".queue-badge");
      if (n <= 0) { if (b) b.remove(); return; }
      if (!b) { b = el("span", "queue-badge " + p[1]); host.appendChild(b); }
      b.textContent = n + " waiting";
    });
  }

  function toast(text) {
    var t = $("queueToast"), tx = $("queueToastText");
    if (!t || !tx) return;
    var emergency = $("view-emergency") && !$("view-emergency").hidden;
    live(text);
    if (emergency) return;   // never put anything over the Emergency screen
    tx.textContent = text; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 12000);
  }

  if (Q) {
    document.addEventListener("om:queue-changed", draw);
    document.addEventListener("om:connectivity", draw);
    document.addEventListener("om:home-rendered", badges);
    document.addEventListener("om:queue-answered", function () {
      var onAsk = $("view-ask") && !$("view-ask").hidden;
      toast(onAsk ? "Your saved question was answered. It is in the list below." : "Your saved question was answered.");
    });
    var close = $("queueToastClose"); if (close) close.addEventListener("click", function () { $("queueToast").hidden = true; });
    var link = $("queueToastLink"); if (link) link.addEventListener("click", function () { $("queueToast").hidden = true; });
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", draw); else draw();
  }

  window.OMQueueUI = { setAnswerRenderer: function (fn) { renderAnswer = fn; draw(); }, redraw: draw, announce: live };
})();
