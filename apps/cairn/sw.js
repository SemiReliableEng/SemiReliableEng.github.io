// Cairn Service Worker — bump CACHE alongside APP_VERSION in index.html on
// every UI change. The two are compared on boot and any mismatch surfaces
// on the settings page as a stale-SW tell.
//
// Three caches:
//   CACHE             — app shell (versioned per release; deleted on activate
//                       when superseded).
//   BASE_TILES_CACHE  — low-zoom Bay Area basemap precached on install so the
//                       map always renders something offline. Versioned only
//                       when the bbox/zoom range changes; survives shell bumps.
//   TILES_CACHE       — runtime + trail-prefetched tiles. Survives shell bumps
//                       so the page-side prefetch (z10-15 along Ridge Trail +
//                       imported hikes) doesn't get wiped on every UI release.
const CACHE = 'cairn-v15';
const BASE_TILES_CACHE = 'cairn-tiles-base-v1';
const TILES_CACHE = 'cairn-tiles-v1';

// App shell + local assets precached on install. Relative URLs so this
// works under any path prefix (e.g. /apps/cairn/ on Pages).
//
// Every module that index.html imports must live here. Otherwise the SW's
// CACHE bumps in lockstep with index.html, but the local .mjs imports fall
// through to the runtime fetch path — which on a v(N-1) → vN upgrade can
// serve a stale .mjs from the browser's HTTP cache while serving the new
// index.html from the SW. Result: an `import { newExport } from './x.mjs'`
// fails, the module errors out before window.* button bindings run, and
// every onclick="" handler in the HTML lands on `undefined`. The
// only-symptom-on-installed-PWA-not-incognito profile in v14 was exactly
// this; snapshot.mjs had been missing from this list since 948faf0 but the
// hazard was latent until ceef6cf added new required exports.
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './snapshot.mjs',
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

// CartoDB basemap tiles — runtime fetches go to TILES_CACHE so they survive
// app-shell version bumps.
const TILE_HOSTS = new Set([
  'a.basemaps.cartocdn.com',
  'b.basemaps.cartocdn.com',
  'c.basemaps.cartocdn.com',
  'd.basemaps.cartocdn.com',
]);

// ── base-tile precache list (z6-11 over Bay Area bbox) ────────────────
// Generated deterministically at SW load so the URL set lives next to the
// bbox/zoom params it's derived from. Both retina and non-retina variants
// are included because the SW can't read devicePixelRatio reliably; the
// cache cost is small (~3 MB × 2). Subdomain matches Leaflet's
// `(x + y) % subs.length` rule so prefetched URLs hit at runtime.
const BASE_TILES = (() => {
  const bbox = { minLat: 36.8, maxLat: 38.5, minLon: -123.5, maxLon: -121.5 };
  const subs = ['a', 'b', 'c', 'd'];
  const urls = [];
  const lonToX = (lon, z) => Math.floor((lon + 180) / 360 * (1 << z));
  const latToY = (lat, z) => {
    const r = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * (1 << z));
  };
  for (let z = 6; z <= 11; z++) {
    const x0 = lonToX(bbox.minLon, z);
    const x1 = lonToX(bbox.maxLon, z);
    const y0 = latToY(bbox.maxLat, z);
    const y1 = latToY(bbox.minLat, z);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const sub = subs[Math.abs(x + y) % subs.length];
        for (const r of ['', '@2x']) {
          urls.push(`https://${sub}.basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}${r}.png`);
        }
      }
    }
  }
  return urls;
})();

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    // App shell is atomic — any failure aborts the install (correct, we want
    // a known-good shell). Base tiles are best-effort: a missing tile here
    // is recoverable later via runtime fetch + the page's prefetch loop, so
    // a single 404/network blip shouldn't fail the whole SW install.
    const shell = caches.open(CACHE).then((c) => c.addAll(APP_SHELL));
    const base = caches.open(BASE_TILES_CACHE).then(async (c) => {
      const existing = new Set((await c.keys()).map((r) => r.url));
      await Promise.allSettled(
        BASE_TILES
          .filter((u) => !existing.has(u))
          .map((u) => c.add(u).catch(() => {}))
      );
    });
    await Promise.all([shell, base]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = new Set([CACHE, BASE_TILES_CACHE, TILES_CACHE]);
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
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

  // Map tiles: cache-first across all caches (so a base-cache or trail-cache
  // hit short-circuits the network). Misses are written to TILES_CACHE so
  // they survive app-shell version bumps.
  if (TILE_HOSTS.has(url.hostname)) {
    e.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res.ok && (res.type === 'basic' || res.type === 'cors')) {
            const clone = res.clone();
            caches.open(TILES_CACHE).then((c) => c.put(req, clone)).catch(() => {});
          }
          return res;
        }).catch(() => new Response('', { status: 504 }));
      }),
    );
    return;
  }

  // Same-origin app shell + CDN deps: cache-first, populate on miss.
  // Navigations fall back to index.html when entirely offline so the app
  // still boots.
  if (url.origin === self.location.origin || CDN_HOSTS.has(url.hostname)) {
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
