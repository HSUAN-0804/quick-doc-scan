const CACHE_NAME = "quick-scan-shell-v26";
const SHELL = [
  "./",
  "./index.html?v=26",
  "./styles.css?v=23",
  "./app.js?v=25",
  "./patch-v25.js?v=25",
  "./patch-v26.js?v=26",
  "./manifest.webmanifest?v=24",
  "./icons/apple-touch-icon.png?v=24",
  "./icons/icon-192.png?v=24",
  "./icons/icon-512.png?v=24"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  const isShell = url.origin === location.origin;

  if (isShell) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html?v=26")))
    );
    return;
  }

  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
