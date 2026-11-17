/* NomadMate kill switch service worker.
 *
 * ROLLBACK USE ONLY: to remove the offline service worker from every installed copy,
 * copy this file over sw.js on the server (cp sw-killswitch.js sw.js). On their next online
 * visit the browser sees a changed sw.js, installs this, which deletes all caches, unregisters
 * itself and reloads open pages so they load straight from the network.
 */
self.addEventListener('install', function (event) {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(function (k) { return caches.delete(k); }));
    } catch (e) { /* ignore */ }
    try { await self.registration.unregister(); } catch (e) { /* ignore */ }
    try {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      clients.forEach(function (c) { try { c.navigate(c.url); } catch (e) { /* ignore */ } });
    } catch (e) { /* ignore */ }
  })());
});

// Never serve anything from cache: pass every request straight to the network.
self.addEventListener('fetch', function () { /* no respondWith: browser default */ });
