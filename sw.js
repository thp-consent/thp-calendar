// Offline cache for THP Calendar.
// Online: always fetch the latest files from the website (bypassing the browser's 10-minute cache),
// and keep a copy. Offline: use the saved copy. So an update is picked up the next time the app opens.
const VERSION = 'thp-calendar-v3';
const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'request.html', 'request.js', 'manifest.webmanifest',
  'assets/logo.png', 'assets/icon-192.png', 'assets/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const res = await fetch(e.request, { cache: 'no-cache' }); // revalidate with the website every time
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch (_) {
      return (await cache.match(e.request, { ignoreSearch: true })) || (await cache.match('index.html')) || Response.error();
    }
  })());
});
