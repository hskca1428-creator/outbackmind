/* NomadMate early boot hints (moved out of index.html in Stage 4 so the page can use a strict Content Security Policy).
   Must stay a plain blocking script in <head>: it runs before first paint. */
/* D3: tell the stylesheet which screen the address points at, before the first paint, so a deep link does not flash the Home screen first.
   js/offline.js removes this attribute as soon as it has routed. If it never runs, the right screen is still the one showing. */
(function () { var h = location.hash || "", v = "home";
  if (h === "#emergency") v = "emergency"; else if (/^#guides(\/|$)/.test(h)) v = "guides"; else if (/^#checklists(\/|$)/.test(h)) v = "checklists";
  else if (h === "#settings" || h === "#saved") v = "settings"; else if (h === "#ask") v = "ask"; else if (h === "#plans") v = "plans";
  document.documentElement.setAttribute("data-boot", v);
  /* The phone top bar drops its Guides button once the bottom bar is drawn (js/home.js). Start without it, so the top bar keeps one line.
     home.js clears this; the timer clears it too if home.js never runs, so the Guides button can always come back. */
  document.documentElement.setAttribute("data-nav-boot", "1");
  setTimeout(function () { document.documentElement.removeAttribute("data-nav-boot"); }, 5000); })();
