// Marginalia Service Worker
const CACHE = 'marginalia-v30';

// First-party app shell. Fetched with cache:'reload' on install (see below).
const APP_SHELL = [
  '/apps/marginalia/',
  '/apps/marginalia/index.html',
  '/apps/marginalia/manifest.json',
  '/apps/marginalia/shared/personal-sync.mjs',
];

// Pinned third-party assets. Versions pinned in URLs (and mirrored in
// index.html), so the URL → bytes mapping is immutable; the browser's HTTP
// cache can be reused across SW upgrades. Tesseract URLs MUST stay in sync
// with the constants in index.html — Tesseract.recognize is configured to
// fetch from these exact paths so SW cache hits cover the worker + WASM core
// + language data the very first time OCR runs on a device (which is the
// offline-in-flight case that motivated pre-caching). ~15MB total install
// download; trades device storage for guaranteed offline OCR.
const VENDORED = [
  'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;1,400&family=DM+Sans:wght@300;400;500&display=swap',
  'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core-simd-lstm.wasm.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core-simd-lstm.wasm',
  'https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz',
];

// Install: cache core assets. APP_SHELL is fetched with cache:'reload' so
// install bypasses the browser's HTTP cache (and any stale CDN edge). Without
// this, a SW that installs in the small window between a Pages deploy
// publishing sw.js and the same deploy propagating index.html through the
// CDN can pre-cache the *old* index.html under the new CACHE name — every
// subsequent normal reload then serves stale HTML even though the version
// line shows the new SW. The hard-reload-shows-vN-but-normal-reload-shows-
// v(N-1) symptom is exactly this race.
//
// VENDORED uses default cache policy: the URLs are version-pinned and
// immutable, so HTTP-cache reuse across SW upgrades avoids re-downloading
// ~15MB of Tesseract assets every time CACHE bumps.
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(APP_SHELL.map(u => new Request(u, { cache: 'reload' })));
    await cache.addAll(VENDORED);
    await self.skipWaiting();
  })());
});

// Message: answer version queries from the page so the settings panel can
// display which CACHE is actually handling fetches. A mismatch between the
// SW's version and the HTML's declared APP_VERSION signals that the SW is
// stale and the next refresh will still serve old HTML out of cache.
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'get-cache-version' && e.ports && e.ports[0]) {
    e.ports[0].postMessage({ cache: CACHE });
  }
});

// Sync-complete notifications fire from the page after the manual Sync Now
// path settles. Clicking the body or the OK action focuses an existing app
// window (or opens one). The click also pumps Chrome's site-engagement
// counter, which is the heuristic that gates auto-grant of
// `navigator.storage.persist()` — see index.html's notifySync().
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clients) {
      if ('focus' in c) return c.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow('/apps/marginalia/');
  })());
});

// Activate: clean up old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: network-first for API calls, cache-first for assets
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always go to network for GitHub API and Google Books API
  if (url.hostname === 'api.github.com' ||
      url.hostname === 'www.googleapis.com' ||
      url.hostname === 'openlibrary.org' ||
      url.hostname === 'covers.openlibrary.org') {
    e.respondWith(fetch(e.request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // Cache-first for fonts and static assets. On offline fetch failure: only
  // fall back to index.html for top-level navigations (deep-link to the
  // installed PWA still opens the app shell). For sub-resources — scripts,
  // WASM, data, images — return a real 503 instead. The previous
  // catch-all-falls-back-to-HTML behavior masked offline failures by serving
  // the HTML body for any uncached request, so Tesseract's worker.min.js
  // fetch (uncached on a device that had never run OCR online) would receive
  // the index.html and die with a JS-parse error instead of a clean network
  // failure that callers could surface meaningfully.
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone));
        }
        return res;
      }).catch(() => {
        if (e.request.mode === 'navigate') {
          return caches.match('/apps/marginalia/index.html');
        }
        return new Response('', { status: 503, statusText: 'Offline' });
      });
    })
  );
});
