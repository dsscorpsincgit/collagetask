const CACHE = 'dss-flow-v6-push-notifications';
const SHELL = ['/', '/manifest.webmanifest', '/dsslogo.31878f461bb1d61573f8.jpg', '/pwa-192.png', '/pwa-512.png'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || event.request.url.includes('/api/')) return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.pathname === '/sw.js') return;
  event.respondWith(fetch(event.request, { cache: 'no-store' }).then(response => { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); return response; }).catch(() => caches.match(event.request).then(cached => cached || caches.match('/'))));
});

self.addEventListener('push',event=>{
  let payload={title:'DSS Flow',body:'You have a new update',url:'/',type:'message',tag:'dss-flow'};
  try{if(event.data)payload={...payload,...event.data.json()}}catch{if(event.data)payload.body=event.data.text()}
  event.waitUntil(self.registration.showNotification(payload.title,{body:payload.body,icon:'/pwa-192.png',badge:'/pwa-192.png',tag:payload.tag||`dss-${payload.type}`,renotify:true,vibrate:[180,80,180],data:{url:payload.url||'/'},actions:[{action:'open',title:'Open DSS Flow'}]}));
});

self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const target=new URL(event.notification.data?.url||'/',self.location.origin).href;
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(clients=>{for(const client of clients){if(new URL(client.url).origin===self.location.origin){client.navigate(target);return client.focus()}}return self.clients.openWindow(target)}));
});
