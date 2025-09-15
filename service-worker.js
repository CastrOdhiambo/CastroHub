const CACHE_NAME = "castrohub-cache-v1";
const urlsToCache = [
  "/",
  "/index.html",
  "/about.html",
  "/news.html",
  "/entertainment.html",
  "/education.html",
  "/projects.html",
  "/contact.html",
  "/mindspark.html",
  "/profile.html",
  "/assets/css/style.css",
  "/assets/js/main.js"
];

// Install SW and cache files
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(urlsToCache);
    })
  );
});

// Serve cached files
self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});

// Update service worker
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => {
          if (name !== CACHE_NAME) {
            return caches.delete(name);
          }
        })
      );
    })
  );
});
