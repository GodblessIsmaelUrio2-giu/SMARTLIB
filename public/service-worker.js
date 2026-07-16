// Minimal service worker — required by Chrome for the "Install app" prompt.
// Caches the app shell so pages still load offline; API calls always go to the network.

const CACHE_NAME = 'smartlib-pass-v2';
const APP_SHELL = [
  '/index.html',
  '/dashboard.html',
  '/librarian-login.html',
  '/profile.html',
  '/assets/style.css',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls — always hit the network fresh.
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      return (
        cached ||
        fetch(event.request).then((response) => {
          // Cache a copy of same-origin GET requests for next time.
          if (event.request.method === 'GET' && url.origin === location.origin) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
      );
    })
  );
});