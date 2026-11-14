/* Service worker: aplikacja działa offline po pierwszym otwarciu.
   Pliki aplikacji — najpierw sieć (świeża wersja), w razie braku sieci z pamięci.
   Moduł OCR z CDN — z pamięci (duży i niezmienny dla danej wersji). */
const CACHE = 'kontenery-5faafc6';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })),
    );
    return;
  }

  if (url.origin !== self.location.origin || url.pathname.includes('/api/')) return;

  // cache: 'no-cache' — zawsze pytamy serwer, czy plik się zmienił (pamięć HTTP przeglądarki
  // potrafi oddać stary app.js przy nowym index.html i wtedy przyciski nie działają).
  e.respondWith(
    fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' }).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html'))),
  );
});
