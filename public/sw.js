// Service worker for the phone/web Jarvis. The app shell loads offline; data
// requests go to the network first and fall back to the last copy seen, so the
// plan is still readable without a connection. Writes always need the network.
const SHELL = "jarvis-shell-v1";
const DATA = "jarvis-data-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(["/", "/index.html", "/manifest.webmanifest"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => ![SHELL, DATA].includes(key)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  // Never cache sign-in, session or sync traffic.
  if (url.pathname.startsWith("/api/auth/") || url.pathname === "/api/session") return;

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(DATA).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || new Response(JSON.stringify({ ok: false, offline: true, error: "You're offline." }), { status: 503, headers: { "content-type": "application/json" } })))
    );
    return;
  }

  // App shell and vendor files: serve the cached copy, refresh it in the background.
  event.respondWith(
    caches.open(SHELL).then(async (cache) => {
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => cached || cache.match("/index.html"));
      return cached || network;
    })
  );
});
