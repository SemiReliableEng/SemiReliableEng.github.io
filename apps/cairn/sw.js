// Cairn Service Worker — bump CACHE alongside APP_VERSION in index.html on
// every UI change. The two are compared on boot and any mismatch surfaces
// on the settings page as a stale-SW tell.
//
// Five caches:
//   CACHE             — app shell (versioned per release; deleted on activate
//                       when superseded).
//   VENDOR_CACHE      — pinned CDN dependencies (Leaflet, Chart.js, Google Fonts);
//                       preserved across app-shell bumps.
//   BASE_TILES_CACHE  — low-zoom Bay Area basemap precached on install so the
//                       map always renders something offline. Versioned only
//                       when the bbox/zoom range changes; survives shell bumps.
//   TILES_CACHE       — runtime + trail-prefetched tiles. Survives shell bumps
//                       so the page-side prefetch (z10-15 along Ridge Trail +
//                       imported hikes) doesn't get wiped on every UI release.
//   RIDGE_CACHE       — static Bay Area Ridge Trail geometry (ridge-trail.json);
//                       preserved across shell bumps.
const CACHE = 'cairn-v42';
const VENDOR_CACHE = 'cairn-vendor-v1';
const BASE_TILES_CACHE = 'cairn-tiles-base-v2';
const TILES_CACHE = 'cairn-tiles-v1';
const RIDGE_CACHE = 'cairn-ridge-v1';

// App shell + local assets precached on install. Relative URLs so this
// works under any path prefix (e.g. /apps/cairn/ on Pages).
//
// Every module that index.html imports must live here. Otherwise the SW's
// CACHE bumps in lockstep with index.html, but the local .mjs imports fall
// through to the runtime fetch path — which on a v(N-1) → vN upgrade can
// serve a stale .mjs from the browser's HTTP cache while serving the new
// index.html from the SW.
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './snapshot.mjs',
  './geo.mjs',
  './shared/personal-sync.mjs',
];

const VENDOR_URLS = [
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
];

// CDN deps are cached into VENDOR_CACHE so they survive app-shell bumps.
const CDN_HOSTS = new Set([
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
]);

// Esri World Topographic basemap tiles — runtime fetches go to TILES_CACHE so they survive
// app-shell version bumps.
const TILE_HOSTS = new Set([
  'server.arcgisonline.com',
  'services.arcgisonline.com',
]);

// ── base-tile precache list (z6-11 over Bay Area bbox) ────────────────
// Generated deterministically at SW load so the URL set lives next to the
// bbox/zoom params it's derived from.
const BASE_TILES = (() => {
  const bbox = { minLat: 36.8, maxLat: 38.5, minLon: -123.5, maxLon: -121.5 };
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
        urls.push(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/${z}/${y}/${x}`);
      }
    }
  }
  return urls;
})();

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const shell = caches.open(CACHE).then((c) =>
      c.addAll(APP_SHELL.map((u) => new Request(u, { cache: 'reload' })))
    );
    const vendor = caches.open(VENDOR_CACHE).then(async (c) => {
      const existing = new Set((await c.keys()).map((r) => r.url));
      await Promise.allSettled(
        VENDOR_URLS
          .filter((u) => !existing.has(u))
          .map(async (u) => {
            const res = await fetch(new Request(u, { mode: 'cors', credentials: 'omit' }));
            if (res.ok) await c.put(u, res);
          })
      );
    });
    const ridge = caches.open(RIDGE_CACHE).then(async (c) => {
      if (!await c.match('./ridge-trail.json')) {
        await c.add('./ridge-trail.json').catch(() => {});
      }
    });
    // Populate base tiles best-effort without blocking or failing APP_SHELL install.
    caches.open(BASE_TILES_CACHE).then(async (c) => {
      const existing = new Set((await c.keys()).map((r) => r.url));
      await Promise.allSettled(
        BASE_TILES
          .filter((u) => !existing.has(u))
          .map((u) => c.add(u).catch(() => {}))
      );
    }).catch(() => {});
    await Promise.all([shell, vendor, ridge]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = new Set([CACHE, VENDOR_CACHE, BASE_TILES_CACHE, TILES_CACHE, RIDGE_CACHE]);
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith('cairn-') && !keep.has(k)).map((k) => caches.delete(k))
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

// Sync-complete notifications fire from the page after the manual Sync Now
// path settles. Clicking the body or the OK action focuses an existing app
// window (or opens one).
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clients) {
      if ('focus' in c) return c.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow('./');
  })());
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

  // CDN vendor dependencies: cache-first, populate into persistent VENDOR_CACHE.
  if (CDN_HOSTS.has(url.hostname)) {
    e.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res.ok && (res.type === 'basic' || res.type === 'cors')) {
            const clone = res.clone();
            caches.open(VENDOR_CACHE).then((c) => c.put(req, clone)).catch(() => {});
          }
          return res;
        }).catch(() => new Response('', { status: 504 }));
      }),
    );
    return;
  }

  // Same-origin app shell + static assets: cache-first, populate on miss.
  // Navigations fall back to index.html when entirely offline so the app
  // still boots.
  if (url.origin === self.location.origin) {
    const targetCache = url.pathname.endsWith('/ridge-trail.json') ? RIDGE_CACHE : CACHE;
    e.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res.ok && (res.type === 'basic' || res.type === 'cors')) {
            const clone = res.clone();
            caches.open(targetCache).then((c) => c.put(req, clone)).catch(() => {});
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
