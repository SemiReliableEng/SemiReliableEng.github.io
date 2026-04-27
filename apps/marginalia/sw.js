// Marginalia Service Worker
const CACHE = 'marginalia-v26';
const ASSETS = [
  '/apps/marginalia/',
  '/apps/marginalia/index.html',
  '/apps/marginalia/manifest.json',
  '/apps/marginalia/shared/personal-sync.mjs',
  'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;1,400&family=DM+Sans:wght@300;400;500&display=swap'
];

// Install: cache core assets
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
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

  // Cache-first for fonts and static assets
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match('/apps/marginalia/index.html'));
    })
  );
});
