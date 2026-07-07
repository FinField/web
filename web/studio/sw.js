// FinField Studio service worker — offline-first cache for the serverless peer.
//
// P2P step F2: the only hard external dependency of the in-tab engine is
// Pyodide's cold-start WASM download. This service worker makes the SECOND load
// near-instant and fully OFFLINE by caching the app shell AND the Pyodide /
// cryptography WASM. After the first visit a tab boots its whole FinField node
// with no network — a step toward serving the app peer-to-peer: once cached, the
// host that first served the shell is no longer required.
//
// STRATEGY (mirrors the proven molgang serverless SW):
//   • App shell (this origin: html/js/engine wheel/bridge) — cache-first,
//     versioned; a version bump evicts the old shell on activate.
//   • Pyodide CDN assets — stale-while-revalidate in a separate, long-lived
//     cache keyed by the pinned Pyodide version (large, immutable per version).
//   • Everything else — network pass-through. There is deliberately NO /api/*
//     to cache: the engine answers in-tab.
//
// SECURITY: never caches WebRTC frames (not HTTP) or the device wallet seed
// (localStorage/IndexedDB, owned by the page). Only static public assets.

const APP_VERSION = "finfield-studio-v1";
const PYODIDE_VERSION = "0.26.2";
const SHELL_CACHE = `${APP_VERSION}-shell`;
const WASM_CACHE = `finfield-pyodide-${PYODIDE_VERSION}`;
const PYODIDE_HOST = "cdn.jsdelivr.net";

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./fin-engine.js",
  "./manifest.webmanifest",
  "./engine/finfield_engine-0.0.0-py3-none-any.whl",
  "./engine/fin_serverless.py",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.allSettled(SHELL_ASSETS.map((u) => cache.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) =>
      (k === SHELL_CACHE || k === WASM_CACHE) ? Promise.resolve() : caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

const isPyodide = (url) => url.hostname === PYODIDE_HOST && url.pathname.includes("/pyodide/");
const isSameOrigin = (url) => url.origin === self.location.origin;

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // 1) Pyodide runtime/packages: stale-while-revalidate, version-keyed cache.
  if (isPyodide(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(WASM_CACHE);
      const cached = await cache.match(req);
      const network = fetch(req).then((resp) => {
        if (resp && (resp.ok || resp.type === "opaque")) cache.put(req, resp.clone()).catch(() => {});
        return resp;
      }).catch(() => cached);
      return cached || network;
    })());
    return;
  }

  // 2) Same-origin shell: cache-first; navigations fall back to cached index.html
  //    so the app opens offline once installed.
  if (isSameOrigin(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;
      try {
        const resp = await fetch(req);
        if (resp && resp.ok) cache.put(req, resp.clone()).catch(() => {});
        return resp;
      } catch (e) {
        if (req.mode === "navigate") {
          const idx = await cache.match("./index.html");
          if (idx) return idx;
        }
        throw e;
      }
    })());
    return;
  }
  // 3) Cross-origin non-Pyodide (e.g. seed-fact fetch): network pass-through.
});
