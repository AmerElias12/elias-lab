/* ===========================================================================
   sw.js — what makes the notebook installable as an app

   A phone will only offer "Install" for a site that has a service worker,
   so this exists first of all to be there. What it does is deliberately
   small: every request goes to the network, and a copy of the answer is
   kept. The copy is used only when the network does not answer, so the app
   still opens — to its sign-in screen and whatever was loaded last — in a
   basement cold room with no signal.

   The network always wins when it is there. A cache that answered first
   would be faster, and would also mean a fix that was pushed an hour ago is
   not the code somebody is running, which for this site has been the more
   expensive mistake.

   Only this site's own files are kept. The lab's data comes from Supabase,
   on another origin, and is never stored here: what is in the database
   stays in the database.
   ======================================================================== */
var CACHE = 'elias-lab-shell-v1';

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      // The page's files carry ?v= tags; offline, any version will do.
      return caches.match(req).then(function (hit) { return hit || caches.match(req, { ignoreSearch: true }); })
        .then(function (hit) { return hit || Response.error(); });
    })
  );
});
