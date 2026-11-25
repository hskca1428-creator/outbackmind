/* NomadMate offline fallback page (the "You are offline" screen).
 * Moved out of offline.html so a strict Content Security Policy can apply (script-src 'self').
 * The retry button tries to load the app again. Emergency call links stay in the HTML (plain tel: links, no script). */
(function () {
  "use strict";
  var b = document.getElementById("retry");
  if (b) b.addEventListener("click", function () { location.href = "/"; });
})();
