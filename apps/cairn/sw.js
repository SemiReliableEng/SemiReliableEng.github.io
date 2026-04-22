// Cairn Service Worker — bump CACHE alongside APP_VERSION in index.html on
// every UI change. The two are compared on boot and any mismatch surfaces
// on the settings page as a stale-SW tell.
const CACHE = 'cairn-v8';

// App shell + local assets precached on install. Relative URLs so this
// works under any path prefix (e.g. /apps/cairn/ on Pages).
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './shared/personal-sync.mjs',
];

// CDN deps are cached opportunistically on first fetch rather than
// precached — keeps install fast and avoids a hard dependency on every
// CDN being reachable at install time.
const CDN_HOSTS = new Set([
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
]);

// CartoDB basemap tiles — cache-on-view gives offline "where I've been"
// coverage without trying to pre-fetch an entire region.
const TILE_HOSTS = new Set([
  'a.basemaps.cartocdn.com',
  'b.basemaps.cartocdn.com',
  'c.basemaps.cartocdn.com',
  'd.basemaps.cartocdn.com',
]);

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(APP_SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Answer version queries from the page so the settings panel can display
// which CACHE is actually handling fetches. A mismatch with the HTML's
// APP_VERSION signals the SW is stale and next refresh will still serve
// old HTML out of cache.
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'get-cache-version' && e.ports && e.ports[0]) {
    e.ports[0].postMessage({ cache: CACHE });
  }
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // GitHub sync API — always network, never cached. Offline → return an
  // empty 503 so the app's existing offline handling kicks in.
  if (url.hostname === 'api.github.com') {
    e.respondWith(fetch(req).catch(() => new Response('', { status: 503 })));
    return;
  }

  // Same-origin app shell + CDN deps + map tiles: cache-first, populate
  // cache on miss. Network errors fall back to whatever's cached, and
  // navigations ultimately fall back to index.html so the app still
  // boots when entirely offline.
  if (
    url.origin === self.location.origin ||
    CDN_HOSTS.has(url.hostname) ||
    TILE_HOSTS.has(url.hostname)
  ) {
    e.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res.ok && (res.type === 'basic' || res.type === 'cors')) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => {});
          }
          return res;
        }).catch(() => {
          if (req.mode === 'navigate') return caches.match('./index.html');
          return new Response('', { status: 504 });
        });
      }),
    );
  }
});
