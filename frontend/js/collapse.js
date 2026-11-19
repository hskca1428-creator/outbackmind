/* NomadMate: compact long text with a "Show full ..." button (UX quick-fix).
 * OMCollapse.attach(el, { label, noClamp, button, observe })
 *   el       the element holding the long text (answer, plan, saved answer)
 *   label    word used in the button: "Show full answer", "Show full plan"
 *   noClamp  optional function. When it returns true the text is shown in full and no button appears
 *            (used for Emergency answers, so safety steps are never hidden)
 *   button   optional existing <button> to use instead of creating one after el
 *   observe  true: re-check whenever the content of el changes
 * The text stays in the page (not display:none), so screen readers and Find in page still reach all of it.
 * No nested scrolling: the text is cut with a fade, and the button expands it in place.
 */
(function () {
  "use strict";
  var uid = 0;

  function attach(el, opts) {
    if (!el || el._omCollapse) return el && el._omCollapse;
    opts = opts || {};
    var label = opts.label || "answer";
    var btn = opts.button || null;
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "collapse-toggle";
      btn.hidden = true;
      if (el.parentNode) el.parentNode.insertBefore(btn, el.nextSibling);
    }
    if (!el.id) el.id = "om-collapse-" + (++uid);
    btn.setAttribute("aria-controls", el.id);
    var expanded = false, lastWidth = -1, measured = false;

    function paint() {
      btn.setAttribute("aria-expanded", expanded ? "true" : "false");
      btn.textContent = expanded ? "Show less" : "Show full " + label;
      el.classList.toggle("is-clamped", !expanded);
    }
    function measure(reset) {
      if (reset) expanded = false;
      if (typeof opts.noClamp === "function" && opts.noClamp()) {
        el.classList.remove("is-clamped"); btn.hidden = true; measured = true; return;
      }
      if (!el.clientWidth) { measured = false; return; }   // not on screen yet; the ResizeObserver tries again
      lastWidth = el.clientWidth;
      if (expanded) { paint(); btn.hidden = false; measured = true; return; }
      el.classList.add("is-clamped");
      var needs = el.scrollHeight > el.clientHeight + 24;
      measured = true;
      if (needs) { paint(); btn.hidden = false; }
      else { el.classList.remove("is-clamped"); btn.hidden = true; }
    }
    btn.addEventListener("click", function () {
      expanded = !expanded;
      paint();
      if (!expanded) {
        // keep the reader's place: bring the top of the text back into view
        var r = el.getBoundingClientRect();
        if (r.top < 0) el.scrollIntoView({ block: "start" });
      }
    });
    if (opts.observe && window.MutationObserver) {
      var pending = false;
      new MutationObserver(function () {
        if (pending) return; pending = true;
        Promise.resolve().then(function () { pending = false; measure(true); });
      }).observe(el, { childList: true, subtree: true, characterData: true });
    }
    if (window.ResizeObserver) {
      new ResizeObserver(function () {
        if (!el.clientWidth) return;
        if (!measured || el.clientWidth !== lastWidth) measure(false);
      }).observe(el);
    }
    var api = { measure: measure, isExpanded: function () { return expanded; }, button: btn };
    el._omCollapse = api;
    measure(true);
    return api;
  }

  window.OMCollapse = { attach: attach };
})();
