const CACHE = 'dss-flow-v5-internal-meetings';
const SHELL = ['/', '/manifest.webmanifest', '/dsslogo.31878f461bb1d61573f8.jpg', '/pwa-192.png', '/pwa-512.png'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || event.request.url.includes('/api/')) return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.pathname === '/sw.js') return;
  event.respondWith(fetch(event.request, { cache: 'no-store' }).then(response => { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); return response; }).catch(() => caches.match(event.request).then(cached => cached || caches.match('/'))));
});
