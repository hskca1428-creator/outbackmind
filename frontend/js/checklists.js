/* NomadMate Checklists (Stage 3).
 * Built-in templates come from /data/checklists.json (part of the offline pack). Ticks are saved on this device with
 * OMStore, so they survive a reload and work with no signal. Checklists the AI generates (the server does not keep
 * them) are saved on this device too and open at #checklists/a/<id>.
 * Routes: #checklists, #checklists/t/<template>, #checklists/a/<id>. Text is always added with textContent.
 */
(function () {
  "use strict";
  var SOURCE_TYPE = { "government": "Government agency", "non-profit": "Non-profit organisation", "motoring-club": "Motoring club (not a government agency)" };
  var data = null, loading = null, root = null, firstRender = true;

  function getJson(url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error(url + " HTTP " + r.status); return r.json(); }); }
  function ready() {
    if (data) return Promise.resolve(data);
    if (!loading) loading = getJson("/data/checklists.json").then(function (d) { data = d; return d; }).catch(function (e) { loading = null; throw e; });
    return loading;
  }
  function store() { return window.OMStore; }

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
  function fmtDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    if (!m) return iso || "";
    try { return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }); } catch (e) { return iso; }
  }
  function fmtStamp(value) {
    if (!value) return "";
    var t = String(value), hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(t);
    var d = new Date(hasZone ? t : t.replace(/\.(\d{3})\d+/, ".$1") + "Z");
    if (isNaN(d.getTime())) return t;
    return d.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function setStatus(msg) { var s = document.getElementById("checklistsStatus"); if (s) s.textContent = msg || ""; }
  function backLink(href, text) { return el("a", { class: "back-link guide-back", href: href }, [icon("i-home"), document.createTextNode(text)]); }

  /* ----------------------------------------------- parse an AI checklist */
  function stripMd(t) { return t.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/`([^`]+)`/g, "$1").trim(); }
  function parseChecklist(text) {
    var blocks = [], n = 0;
    String(text || "").split(/\r?\n/).forEach(function (raw) {
      var line = raw.trim();
      if (!line) return;
      var m;
      if ((m = /^#{1,6}\s+(.*)$/.exec(line))) { blocks.push({ type: "heading", text: stripMd(m[1]) }); return; }
      if ((m = /^\*\*([^*]+)\*\*:?$/.exec(line))) { blocks.push({ type: "heading", text: stripMd(m[1]).replace(/:$/, "") }); return; }
      if ((m = /^(?:[-*\u2022]|\d+[.)])\s+(?:\[[ xX]?\]\s*)?(.*)$/.exec(line)) && m[1]) { blocks.push({ type: "item", text: stripMd(m[1]), key: "i" + n }); n++; return; }
      if ((m = /^\[[ xX]?\]\s*(.+)$/.exec(line))) { blocks.push({ type: "item", text: stripMd(m[1]), key: "i" + n }); n++; return; }
      if (/^[^.!?]{1,70}:$/.test(line)) { blocks.push({ type: "heading", text: stripMd(line).replace(/:$/, "") }); return; }
      blocks.push({ type: "text", text: stripMd(line) });
    });
    return { blocks: blocks, itemCount: n };
  }

  /* --------------------------------------------------- tick list widget */
  /* spec: { kind: "template"|"ai", id, sections:[{title, items:[{key,text,guides?}]}], ticks } */
  function progressText(done, total) { return done + " of " + total + " ticked"; }
  function buildTickList(spec, onChange) {
    var wrap = el("div", { class: "tick-wrap" });
    var total = 0, done = 0;
    spec.sections.forEach(function (s) { total += s.items.length; s.items.forEach(function (i) { if (spec.ticks[i.key]) done++; }); });
    var prog = el("p", { class: "tick-progress", id: "tickProgress", role: "status", "aria-live": "polite", text: progressText(done, total) });
    wrap.appendChild(prog);
    spec.sections.forEach(function (s, si) {
      var sec = el("section", { class: "tick-section", "aria-label": s.title || "Items" });
      if (s.title) sec.appendChild(el("h3", { text: s.title }));
      var ul = el("ul", { class: "tick-list" });
      s.items.forEach(function (it) {
        var id = "tick-" + spec.kind + "-" + si + "-" + it.key;
        var cb = el("input", { type: "checkbox", id: id, "data-key": it.key });
        cb.checked = !!spec.ticks[it.key];
        cb.addEventListener("change", function () {
          if (cb.checked) { spec.ticks[it.key] = true; done++; } else { delete spec.ticks[it.key]; done--; }
          li.classList.toggle("is-done", cb.checked);
          prog.textContent = progressText(done, total);
          if (onChange) onChange(it.key, cb.checked);
        });
        var li = el("li", { class: "tick-item" + (cb.checked ? " is-done" : "") });
        var label = el("label", { class: "tick-label", for: id }, [cb, el("span", { class: "tick-text", text: it.text })]);
        li.appendChild(label);
        if (it.guides && it.guides.length) {
          var g = el("span", { class: "tick-guides" });
          g.appendChild(document.createTextNode("Guide: "));
          it.guides.forEach(function (gr, i) {
            if (i) g.appendChild(document.createTextNode(", "));
            g.appendChild(el("a", { href: "#guides/g/" + gr.id, text: gr.title }));
          });
          li.appendChild(g);
        }
        ul.appendChild(li);
      });
      sec.appendChild(ul);
      wrap.appendChild(sec);
    });
    wrap._reset = function () {
      Array.prototype.forEach.call(wrap.querySelectorAll("input[type=checkbox]"), function (c) { c.checked = false; c.closest("li").classList.remove("is-done"); });
      Object.keys(spec.ticks).forEach(function (k) { delete spec.ticks[k]; });
      done = 0; prog.textContent = progressText(0, total);
    };
    return wrap;
  }

  function specFromAi(rec) {
    var p = parseChecklist(rec.text), sections = [], cur = { title: "", items: [] }, notes = [];
    p.blocks.forEach(function (b) {
      if (b.type === "heading") { if (cur.items.length) sections.push(cur); cur = { title: b.text, items: [] }; }
      else if (b.type === "item") cur.items.push({ key: b.key, text: b.text });
      else notes.push(b.text);
    });
    if (cur.items.length) sections.push(cur);
    return { sections: sections, notes: notes, itemCount: p.itemCount };
  }

  function printSpecTemplate(t, ticks) {
    return {
      title: t.title + " checklist",
      lines: ["From NomadMate by OutbackMind. Last reviewed " + fmtDate(t.last_reviewed) + (t.status === "draft" ? ". DRAFT: not yet signed off." : "."), "Printed " + fmtStamp(new Date().toISOString()) + "."],
      sections: t.sections.map(function (s) { return { heading: s.title, items: s.items.map(function (i) { return { text: i.text, done: !!ticks[i.id] }; }) }; })
        .concat([{ heading: "Sources", paragraphs: t.sources.map(function (s) { return s.name + " - " + s.url; }) }]),
      footer: ["Guidance only. Rules differ between states, so check the local agency. In an emergency, call 000."]
    };
  }
  function printSpecAi(rec, spec) {
    var secs = spec.sections.map(function (s) { return { heading: s.title, items: s.items.map(function (i) { return { text: i.text, done: !!rec.ticks[i.key] }; }) }; });
    if (!secs.length) secs = [{ paragraphs: [rec.text] }];
    return {
      title: "Trip checklist",
      lines: [rec.request ? "For: " + rec.request : "", "Made by the NomadMate AI. Saved on this device " + fmtStamp(rec.saved_at) + ". It is a general suggestion and has not been checked by NomadMate."].filter(Boolean),
      sections: secs,
      footer: ["Guidance only. In an emergency, call 000."]
    };
  }
  function copyText(title, sections, ticksFn) {
    var out = [title, ""];
    sections.forEach(function (s) {
      if (s.title) out.push(s.title);
      s.items.forEach(function (i) { out.push((ticksFn(i) ? "[x] " : "[ ] ") + i.text); });
      out.push("");
    });
    out.push("From NomadMate by OutbackMind. Guidance only.");
    return out.join("\n");
  }
  function actionBtn(label, iconId, cls) {
    return el("button", { type: "button", class: cls || "btn-secondary" }, [iconId ? icon(iconId) : null, document.createTextNode(label)]);
  }
  function flash(btn, text, back) { btn.textContent = ""; btn.appendChild(document.createTextNode(text)); setTimeout(function () { btn.textContent = ""; btn.appendChild(document.createTextNode(back)); }, 1600); }

  /* ------------------------------------------------------------- screens */
  function storageNote() {
    var s = store();
    if (s && s.mode() === "memory") {
      return el("div", { class: "callout callout-warn", role: "note" }, [icon("i-alert"), el("div", {}, [
        el("p", { class: "callout-title", text: "Not saved on this device" }),
        el("p", { text: "This browser is not letting NomadMate save data (private browsing can do this). Ticks work now but will be lost when you close the page." })
      ])]);
    }
    return null;
  }

  function renderHome(d) {
    root.textContent = "";
    var sn = storageNote(); if (sn) root.appendChild(sn);
    var anyDraft = d.templates.some(function (t) { return t.status !== "approved"; });
    root.appendChild(el("div", { class: anyDraft ? "callout callout-draft" : "callout", role: "note" }, [icon("i-alert"), el("div", {}, [
      el("p", { class: "callout-title", text: anyDraft ? (d.status_label_draft || "DRAFT: not yet signed off") : "General guidance only" }),
      el("p", { text: "Tick items as you go. Your ticks are saved on this device and work without signal. Each item links to the guide it comes from, and each checklist lists its official sources." })
    ])]));
    var grid = el("ul", { class: "cat-grid", "aria-label": "Checklists" });
    var tp = store() ? store().allTemplateTicks() : Promise.resolve({});
    return tp.then(function (all) {
      d.templates.forEach(function (t) {
        var ticks = all[t.id] || {}, done = 0;
        t.sections.forEach(function (s) { s.items.forEach(function (i) { if (ticks[i.id]) done++; }); });
        var li = el("li"), a = el("a", { class: "cat-card", href: "#checklists/t/" + t.id });
        a.appendChild(el("span", { class: "cat-title", text: t.title }));
        a.appendChild(el("span", { class: "cat-blurb", text: t.blurb }));
        a.appendChild(el("span", { class: "cat-count", text: t.item_count + " items" + (done ? ", " + done + " ticked" : "") }));
        li.appendChild(a); grid.appendChild(li);
      });
      root.appendChild(grid);
      return store() ? store().listChecklists() : [];
    }).then(function (mine) {
      var h = el("h2", { class: "checklists-sub", text: "Your saved checklists" });
      root.appendChild(h);
      if (!mine.length) {
        root.appendChild(el("p", { class: "guide-empty", text: "Nothing saved yet. When you make a checklist with the generator on the home page (needs signal), it is saved here so you can use it without signal." }));
      } else {
        var ul = el("ul", { class: "guide-list" });
        mine.forEach(function (rec) {
          var n = parseChecklist(rec.text).itemCount, done = Object.keys(rec.ticks || {}).length;
          var li = el("li", { class: "guide-li" });
          li.appendChild(el("a", { class: "guide-title", href: "#checklists/a/" + rec.id, text: rec.request ? rec.request.slice(0, 90) : "Trip checklist" }));
          li.appendChild(el("span", { class: "guide-cat", text: "Saved on this device " + fmtStamp(rec.saved_at) + (n ? ". " + done + " of " + n + " ticked." : ".") }));
          ul.appendChild(li);
        });
        root.appendChild(ul);
      }
      root.appendChild(el("p", { class: "mini-note" }, [document.createTextNode("To make a checklist for your own trip, use "), el("a", { href: "#checklistCard", id: "toGenerator", text: "the checklist generator on the home page" }), document.createTextNode(". It needs signal.")]));
      setStatus("Checklists");
    });
  }

  function sourcesBlock(t) {
    var src = el("section", { class: "guide-source", "aria-label": "Sources and review date" });
    src.appendChild(el("h3", { text: "Sources" }));
    src.appendChild(el("p", { class: "mini-note", text: "This checklist is built from the guides linked on each item. These are the sources of those guides." }));
    var ul = el("ul");
    t.sources.forEach(function (s) {
      var li = el("li");
      li.appendChild(el("a", { href: s.url, target: "_blank", rel: "noopener", text: s.name }));
      li.appendChild(document.createTextNode(" (" + (SOURCE_TYPE[s.type] || "Government agency") + ")"));
      ul.appendChild(li);
    });
    src.appendChild(ul);
    (t.source_notes || []).forEach(function (n) { src.appendChild(el("p", { class: "mini-note", text: "Note: " + n })); });
    src.appendChild(el("p", { class: "guide-reviewed", text: "Last reviewed: " + fmtDate(t.last_reviewed) + "." }));
    src.appendChild(el("p", { class: "mini-note", text: "Links need signal. This is general information and does not replace advice from the land manager, a doctor or emergency services. Call 000 in an emergency." }));
    return src;
  }

  function renderTemplate(d, id) {
    var t = null; d.templates.forEach(function (x) { if (x.id === id) t = x; });
    root.textContent = "";
    if (!t) { root.appendChild(el("p", { class: "guide-empty", text: "That checklist was not found." })); root.appendChild(backLink("#checklists", "All checklists")); return null; }
    root.appendChild(backLink("#checklists", "All checklists"));
    var h = el("h2", { id: "checklistHeading", tabindex: "-1", text: t.title });
    root.appendChild(h);
    var tags = el("div", { class: "guide-tags" });
    if (t.status !== "approved") tags.appendChild(el("span", { class: "tag tag-draft", text: d.status_label_draft || "DRAFT: not yet signed off" }));
    tags.appendChild(el("span", { class: "tag tag-region", text: t.region }));
    root.appendChild(tags);
    root.appendChild(el("p", { class: "guide-lead", text: t.blurb }));
    var sn = storageNote(); if (sn) root.appendChild(sn);
    root.appendChild(el("p", { class: "mini-note saved-note", text: (store() && store().mode() === "indexeddb") ? "Your ticks are saved on this device." : "Your ticks are not being saved on this device." }));
    var ticksP = store() ? store().getTemplateTicks(t.id) : Promise.resolve({});
    return ticksP.then(function (ticks) {
      var sections = t.sections.map(function (s) { return { title: s.title, items: s.items.map(function (i) { return { key: i.id, text: i.text, guides: i.guides }; }) }; });
      var list = buildTickList({ kind: "t", id: t.id, sections: sections, ticks: ticks }, function (key, on) { if (store()) store().setTemplateTick(t.id, key, on); });
      var actions = el("div", { class: "actions tick-actions" });
      var bPrint = actionBtn("Print or save as PDF", "i-download");
      var bCopy = actionBtn("Copy list", "i-copy");
      var bReset = actionBtn("Clear ticks", "i-refresh");
      bPrint.addEventListener("click", function () { window.OMPrint && window.OMPrint.print(printSpecTemplate(t, ticks)); });
      bCopy.addEventListener("click", function () {
        var txt = copyText(t.title + " checklist", sections, function (i) { return !!ticks[i.key]; });
        (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(function () { flash(bCopy, "Copied", "Copy list"); }).catch(function () { flash(bCopy, "Could not copy", "Copy list"); });
      });
      bReset.addEventListener("click", function () { list._reset(); if (store()) store().clearTemplateTicks(t.id); setStatus("Ticks cleared."); });
      [bPrint, bCopy, bReset].forEach(function (b) { actions.appendChild(b); });
      root.appendChild(actions);
      root.appendChild(list);
      root.appendChild(sourcesBlock(t));
      setStatus(t.title);
      return h;
    });
  }

  function renderAi(id) {
    root.textContent = "";
    var s = store();
    if (!s) { root.appendChild(el("p", { class: "guide-empty", text: "Saved checklists are not available." })); return Promise.resolve(null); }
    return s.getChecklist(id).then(function (rec) {
      if (!rec) { root.appendChild(el("p", { class: "guide-empty", text: "That saved checklist was not found on this device." })); root.appendChild(backLink("#checklists", "All checklists")); return null; }
      root.appendChild(backLink("#checklists", "All checklists"));
      var h = el("h2", { id: "checklistHeading", tabindex: "-1", text: rec.request ? rec.request.slice(0, 90) : "Trip checklist" });
      root.appendChild(h);
      root.appendChild(el("div", { class: "callout", role: "note" }, [icon("i-alert"), el("div", {}, [
        el("p", { class: "callout-title", text: "Made by the NomadMate AI" }),
        el("p", { text: "Saved on this device " + fmtStamp(rec.saved_at) + ". It is a general suggestion and has not been checked by NomadMate or against official sources." })
      ])]));
      root.appendChild(renderRecord(rec, { standalone: true }));
      setStatus("Saved checklist");
      return h;
    });
  }

  /* Draws a saved AI checklist (with tick boxes and actions) into a new element. Used here and on the home page. */
  function renderRecord(rec, opts) {
    opts = opts || {};
    var spec = specFromAi(rec), box = el("div", { class: "ai-checklist" });
    if (!spec.sections.length) {
      box.appendChild(el("div", { class: "checklist-plain", text: rec.text }));
      return box;
    }
    var list = buildTickList({ kind: "a" + rec.id, id: rec.id, sections: spec.sections, ticks: rec.ticks || {} }, function (key, on) { if (store()) store().setChecklistTick(rec.id, key, on); });
    var actions = el("div", { class: "actions tick-actions" });
    var bPrint = actionBtn("Print or save as PDF", "i-download"), bCopy = actionBtn("Copy checklist", "i-copy"), bReset = actionBtn("Clear ticks", "i-refresh");
    bPrint.addEventListener("click", function () { window.OMPrint && window.OMPrint.print(printSpecAi(rec, spec)); });
    bCopy.addEventListener("click", function () {
      var txt = copyText("OutbackMind Trip Checklist", spec.sections, function (i) { return !!(rec.ticks || {})[i.key]; });
      (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(function () { flash(bCopy, "Copied", "Copy checklist"); }).catch(function () { flash(bCopy, "Could not copy", "Copy checklist"); });
    });
    bReset.addEventListener("click", function () { list._reset(); if (store()) store().clearChecklistTicks(rec.id); });
    (opts.noCopy ? [bPrint, bReset] : [bPrint, bCopy, bReset]).forEach(function (b) { actions.appendChild(b); });
    if (opts.standalone) {
      var bDel = actionBtn("Delete from this device", null, "btn-secondary btn-danger"), armed = false;
      bDel.addEventListener("click", function () {
        if (!armed) { armed = true; bDel.textContent = "Tap again to delete"; setTimeout(function () { armed = false; bDel.textContent = "Delete from this device"; }, 4000); return; }
        store().deleteChecklist(rec.id).then(function () { location.hash = "#checklists"; });
      });
      actions.appendChild(bDel);
    }
    box.appendChild(actions);
    box.appendChild(list);
    if (spec.notes.length) box.appendChild(el("p", { class: "mini-note", text: spec.notes.join(" ") }));
    return box;
  }

  /* ------------------------------------------------------------ routing */
  function parseHash() {
    var h = location.hash || "", m;
    if ((m = /^#checklists\/t\/([a-z0-9-]+)$/.exec(h))) return { kind: "template", id: m[1] };
    if ((m = /^#checklists\/a\/([A-Za-z0-9_.:|-]+)$/.exec(h))) return { kind: "ai", id: m[1] };
    return { kind: "home" };
  }
  var running = false, again = false;
  // One render at a time: the template and saved-list screens read from IndexedDB before they draw, so two overlapping
  // renders would each append to the same container. A second request that arrives mid-render re-runs afterwards.
  function show() {
    if (!root) return;
    if (running) { again = true; return; }
    running = true;
    var s = store();
    Promise.all([ready(), s ? s.ready : Promise.resolve()]).then(function (r) {
      var d = r[0], route = parseHash(), p;
      if (route.kind === "template") p = renderTemplate(d, route.id);
      else if (route.kind === "ai") p = renderAi(route.id);
      else p = renderHome(d);
      return Promise.resolve(p);
    }).then(function (heading) {
      if (heading && !firstRender) { window.scrollTo(0, 0); try { heading.focus({ preventScroll: true }); } catch (e) { heading.focus(); } }
      firstRender = false;
    }).catch(function () {
      root.textContent = "";
      root.appendChild(el("p", { class: "guide-empty", text: "The checklists could not be loaded. If you are online, reload the page. They are saved on this phone once NomadMate has finished its first load with signal." }));
    }).then(function () {
      running = false;
      if (again) { again = false; show(); }
    });
  }

  function init() {
    root = document.getElementById("checklistsRoot");
    document.addEventListener("om:checklists-shown", show);
    if (/^#checklists(\/|$)/.test(location.hash || "")) show();
    // The generator link scrolls to the card on the home page.
    document.addEventListener("click", function (e) {
      var a = e.target.closest && e.target.closest("#toGenerator");
      if (!a) return;
      e.preventDefault();
      location.hash = "";
      history.replaceState(null, "", location.pathname + location.search);
      document.dispatchEvent(new CustomEvent("om:go-home"));
      setTimeout(function () { var c = document.getElementById("checklistCard"); if (c) { c.scrollIntoView(); } }, 50);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();

  window.OMChecklists = { parseChecklist: parseChecklist, renderRecord: renderRecord, ready: ready };
})();
