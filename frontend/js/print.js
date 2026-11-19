/* NomadMate local print / save as PDF (Stage 3).
 * Fills a hidden #printArea with plain text and calls window.print(). The phone's own print dialog then offers
 * "Save as PDF". Works with no signal, so it replaces the server PDF when offline. Text only, built with textContent.
 */
(function () {
  "use strict";
  function area() {
    var a = document.getElementById("printArea");
    if (!a) {
      a = document.createElement("div");
      a.id = "printArea";
      a.className = "print-area";
      a.setAttribute("aria-hidden", "true");
      document.body.appendChild(a);
    }
    return a;
  }
  function add(parent, tag, text, cls) {
    var n = document.createElement(tag);
    n.textContent = text;
    if (cls) n.className = cls;
    parent.appendChild(n);
    return n;
  }
  /* spec: { title, lines:[intro text], sections:[{heading, items:[{text, done}] | paragraphs:[text]}], footer:[text] } */
  function prepare(spec) {
    var a = area();
    a.textContent = "";
    add(a, "h1", spec.title || "NomadMate");
    (spec.lines || []).forEach(function (t) { add(a, "p", t, "print-meta"); });
    (spec.sections || []).forEach(function (s) {
      if (s.heading) add(a, "h2", s.heading);
      if (s.items && s.items.length) {
        var ul = document.createElement("ul");
        ul.className = "print-list";
        s.items.forEach(function (it) { add(ul, "li", (it.done ? "[x] " : "[ ] ") + it.text); });
        a.appendChild(ul);
      }
      (s.paragraphs || []).forEach(function (t) { add(a, "p", t); });
    });
    (spec.footer || []).forEach(function (t) { add(a, "p", t, "print-foot"); });
    return a;
  }
  function print(spec) {
    prepare(spec);
    var cleanup = function () { var a = document.getElementById("printArea"); if (a) a.textContent = ""; window.removeEventListener("afterprint", cleanup); };
    window.addEventListener("afterprint", cleanup);
    try { window.print(); } catch (e) { cleanup(); }
  }
  window.OMPrint = { prepare: prepare, print: print };
})();
