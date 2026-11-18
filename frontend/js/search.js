/* NomadMate offline guide search. No libraries, no network.
 * Lowercase, strip punctuation, drop stopwords, light stemming, synonym expansion, then BM25-lite
 * scoring with a boost for title and tag matches. Works in the browser (window.OMSearch) and in Node (tests).
 *
 *   var index = OMSearch.createIndex(items, synonymsJson);
 *   index.search("snake bite", { limit: 5 })  ->  [{ item, score, snippet }]
 */
(function (root) {
  "use strict";

  var K1 = 1.2, B = 0.75;
  var W_TITLE = 3, W_TAGS = 2.5, W_TEXT = 1;
  var SYN_WEIGHT = 0.55;

  function normalise(s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .replace(/[\u2018\u2019\u02bc']/g, "")   // k'gari -> kgari
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  /* Very light stemmer: plurals, -ing, -ed, doubled consonant, trailing e. The same function is used for the
   * documents and the query, so both sides always agree even if the "stem" is not a real word. */
  function stem(w) {
    if (w.length < 4 || /^[0-9]/.test(w)) return w;
    if (w.length > 4 && /ies$/.test(w)) w = w.slice(0, -3) + "y";
    else if (/(ss|us|is)$/.test(w)) { /* glass, bus, basis: leave */ }
    else if (/(s|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2);
    else if (/s$/.test(w)) w = w.slice(0, -1);
    if (w.length > 5 && /ing$/.test(w)) w = w.slice(0, -3);
    else if (w.length > 4 && /ed$/.test(w)) w = w.slice(0, -2);
    if (/([b-df-hj-np-tv-z])\1$/.test(w) && !/(ll|ss|ff|zz)$/.test(w)) w = w.slice(0, -1);
    if (w.length > 3 && /e$/.test(w)) w = w.slice(0, -1);
    return w;
  }

  function tokens(s, stop) {
    var out = [];
    var parts = normalise(s).split(" ");
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p || (stop && stop[p])) continue;
      out.push(stem(p));
    }
    return out;
  }

  function buildStop(list) {
    var o = {};
    (list || []).forEach(function (w) { o[normalise(w)] = true; });
    return o;
  }

  /* Each synonym group becomes a list of phrases; each phrase a list of stems. */
  function buildGroups(groups) {
    return (groups || []).map(function (g) {
      return g.map(function (term) { return tokens(term, null); }).filter(function (p) { return p.length; });
    });
  }

  function containsPhrase(qTokens, phrase) {
    if (phrase.length > qTokens.length) return false;
    for (var i = 0; i + phrase.length <= qTokens.length; i++) {
      var ok = true;
      for (var j = 0; j < phrase.length; j++) if (qTokens[i + j] !== phrase[j]) { ok = false; break; }
      if (ok) return true;
    }
    return false;
  }

  function expand(qTokens, groups) {
    var weights = {};
    qTokens.forEach(function (t) { weights[t] = 1; });
    groups.forEach(function (g) {
      var hit = false;
      for (var i = 0; i < g.length && !hit; i++) hit = containsPhrase(qTokens, g[i]);
      if (!hit) return;
      g.forEach(function (phrase) {
        phrase.forEach(function (t) { if (!(t in weights)) weights[t] = SYN_WEIGHT; });
      });
    });
    return weights;
  }

  function count(arr) {
    var m = {};
    for (var i = 0; i < arr.length; i++) m[arr[i]] = (m[arr[i]] || 0) + 1;
    return m;
  }

  function bestSnippet(text, wanted) {
    var lines = String(text).split(/\n+/);
    var best = "", bestScore = -1;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/^\s*(?:-|\d+\.)\s*/, "").trim();
      if (line.length < 12) continue;
      var tk = tokens(line, null), seen = {}, sc = 0;
      for (var j = 0; j < tk.length; j++) {
        var w = wanted[tk[j]];
        if (w && !seen[tk[j]]) { seen[tk[j]] = 1; sc += w; }
      }
      if (sc > bestScore) { bestScore = sc; best = line; }
    }
    if (!best) best = String(text).replace(/\s+/g, " ").trim();
    if (best.length > 220) best = best.slice(0, 217).replace(/\s+\S*$/, "") + "...";
    return best;
  }

  function createIndex(items, synonyms) {
    var syn = synonyms || {};
    var stop = buildStop(syn.stopwords);
    var groups = buildGroups(syn.groups);
    var docs = [], df = {}, totalLen = 0;
    (items || []).forEach(function (it) {
      var tt = tokens(it.title, stop), tg = tokens((it.tags || []).join(" "), stop), tx = tokens(it.text, stop);
      var ct = count(tt), cg = count(tg), cx = count(tx);
      var all = {};
      [ct, cg, cx].forEach(function (c) { for (var k in c) all[k] = 1; });
      for (var k in all) df[k] = (df[k] || 0) + 1;
      var len = W_TITLE * tt.length + W_TAGS * tg.length + tx.length;
      totalLen += len;
      docs.push({ item: it, ct: ct, cg: cg, cx: cx, len: len, titleSet: ct });
    });
    var N = docs.length || 1;
    var avg = (totalLen / N) || 1;

    function idf(t) {
      var n = df[t] || 0;
      return Math.log(1 + (N - n + 0.5) / (n + 0.5));
    }

    function search(query, opts) {
      opts = opts || {};
      var limit = opts.limit || 5;
      var base = tokens(query, stop);
      if (!base.length) return [];
      var uniqueBase = base.filter(function (t, i) { return base.indexOf(t) === i; });
      var weights = expand(uniqueBase, groups);
      var results = [];
      docs.forEach(function (d) {
        var score = 0, matchedBase = 0;
        for (var t in weights) {
          var tf = W_TITLE * (d.ct[t] || 0) + W_TAGS * (d.cg[t] || 0) + (d.cx[t] || 0);
          if (!tf) continue;
          var part = idf(t) * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * d.len / avg));
          score += weights[t] * part;
        }
        if (score <= 0) return;
        uniqueBase.forEach(function (t) {
          if (d.ct[t] || d.cg[t] || d.cx[t]) matchedBase++;
        });
        // Documents that match more of the words the person actually typed rank higher.
        var coverage = matchedBase / uniqueBase.length;
        score *= 0.35 + 0.65 * coverage;
        // All typed words appear in the title: strong signal.
        var inTitle = uniqueBase.every(function (t) { return d.ct[t]; });
        if (inTitle) score *= 1.4;
        // Title is exactly what was typed (for example "snake bite"): put it first.
        if (inTitle && Object.keys(d.ct).length === uniqueBase.length) score *= 1.8;
        // Small nudge for emergency cards, which are the safest answer to urgent questions.
        if (d.item.kind === "card") score *= 1.1;
        results.push({ item: d.item, score: score, matched: matchedBase, of: uniqueBase.length });
      });
      results.sort(function (a, b) { return b.score - a.score || (a.item.title < b.item.title ? -1 : 1); });
      var wanted = weights;
      return results.slice(0, limit).map(function (r) {
        r.snippet = bestSnippet(r.item.text, wanted);
        return r;
      });
    }

    return { search: search, size: docs.length };
  }

  var api = { createIndex: createIndex, tokens: function (s) { return tokens(s, null); }, stem: stem, normalise: normalise };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.OMSearch = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
