// ============================================================================
// sw.js — Service worker. Precaches the full app shell so the site loads
// instantly and works offline after the first visit.
//
// All precache paths are RELATIVE so the worker functions correctly under a
// GitHub Pages subpath (e.g. https://user.github.io/sequence/). The SW's scope
// is its own directory, so relative URLs resolve against that.
//
// NOTE: caching the shell does NOT make multiplayer fully offline — PeerJS
// still needs to reach a signaling broker to set up the WebRTC handshake.
// See js/net.js for self-hosting a broker on the LAN.
// ============================================================================

// Bump this version to invalidate old caches on the next activate. You should
// rarely need to: same-origin assets are stale-while-revalidate, so a redeploy
// heals itself (see the fetch handler).
const CACHE = 'localsequence-v2';

// Core app shell (same-origin). Relative to the SW's scope.
//
// This must list EVERY module in the import graph, not just the entry point: the
// browser resolves `import` statements one file at a time, so a single missing
// module leaves the app unable to boot offline even though everything else is
// cached. Add new js/ files here as they are created.
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/main.js',
  './js/ui.js',
  './js/state.js',
  './js/rules.js',
  './js/board.js',
  './js/net.js',
  './js/util.js',
  './js/config.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable.png',
];

// Cross-origin assets we want available offline (the PeerJS lib). The actual
// font files are cached lazily at runtime on first fetch.
const EXTERNAL = [
  'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Same-origin shell: fail the install if any of these are missing.
    await cache.addAll(SHELL);
    // External libs: best-effort (don't block install if a CDN hiccups).
    await Promise.allSettled(EXTERNAL.map((url) =>
      fetch(url, { mode: 'cors' }).then((r) => r.ok && cache.put(url, r.clone()))
    ));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // A future server's liveness probe must reflect the live server, never a
  // cached result — otherwise the first "online" response would be replayed
  // after the server went down, making a dead server look reachable. Skipping
  // respondWith passes it straight to the network so a real failure rejects.
  if (url.pathname.endsWith('/health')) return;

  const isFont =
    url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  const isCDN = url.hostname === 'unpkg.com';

  // Fonts and the version-pinned PeerJS URL are immutable, so cache-first with
  // no revalidation is right: the bytes behind these URLs never change.
  if (isFont || isCDN) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        // Cache successful & opaque (font) responses for next time.
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      } catch (_) {
        return Response.error();
      }
    })());
    return;
  }

  // Our own assets: stale-while-revalidate. Serve the cache for an instant,
  // offline-capable load, then refresh it in the background so the NEXT load
  // picks up a redeploy on its own.
  //
  // This applies to navigations too, deliberately. Going network-first for HTML
  // while the modules came from cache would serve a new index.html against old
  // js/ — a half-updated app. Updating everything from one cache generation
  // keeps the shell and its import graph in step.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req)
        || (req.mode === 'navigate' ? await cache.match('./index.html') : undefined);

      const fresh = fetch(req).then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      });

      if (cached) {
        // Keep the worker alive long enough to finish the background refresh,
        // and swallow its failure — we already have a good response to return.
        event.waitUntil(fresh.catch(() => {}));
        return cached;
      }
      try {
        return await fresh;
      } catch (_) {
        return (await cache.match('./index.html')) || Response.error();
      }
    })());
  }
  // Everything else (e.g. signaling/WebRTC) falls through to the network.
});
