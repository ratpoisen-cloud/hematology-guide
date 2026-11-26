const CACHE_NAME = 'gem-ref-v46';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/search-engine.js',
  './js/storage.js',
  './js/offline-books.js',
  './js/reader.js',
  './js/custom-materials.js',
  './data/catalog.json',
  './icons/icon.svg',
  './icons/favicon-32.png',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          // Сохраняем офлайн-книги пользователей (gem-book-*), удаляем только старые версии оболочки
          if (key !== CACHE_NAME && !key.startsWith('gem-book-')) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).then((networkResponse) => {
        // Кэшируем только базовую оболочку, не забивая память нескачанными учебниками
        const url = new URL(event.request.url);
        const isHeavyBookAsset = url.pathname.includes('/images/') || url.pathname.includes('/pdfs/') || url.pathname.endsWith('.fb2');
        if (networkResponse && networkResponse.status === 200 && !isHeavyBookAsset && event.request.method === 'GET') {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return networkResponse;
      });
    })
  );
});
