'use strict';
const CACHE='colin-movie-check-shell-v2.1';
const SHELL=['./','index.html','styles.css','app.js','manifest.webmanifest','icon-192.png','icon-512.png'];
const EXTERNAL=new Set([
  'https://unpkg.com/@zxing/browser@0.2.1/umd/zxing-browser.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js'
]);
self.addEventListener('install',e=>e.waitUntil((async()=>{
  const c=await caches.open(CACHE);
  await c.addAll(SHELL);
  await Promise.allSettled([...EXTERNAL].map(u=>c.add(u)));
  await self.skipWaiting();
})()));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(u.origin===location.origin && u.pathname.endsWith('/catalog.enc')) return;
  if(EXTERNAL.has(e.request.url)){
    e.respondWith(caches.match(e.request).then(c=>c||fetch(e.request).then(r=>{const x=r.clone();caches.open(CACHE).then(cache=>cache.put(e.request,x));return r})));
    return;
  }
  if(u.origin!==location.origin) return;
  e.respondWith(fetch(e.request).then(r=>{const x=r.clone();caches.open(CACHE).then(cache=>cache.put(e.request,x));return r}).catch(()=>caches.match(e.request)));
});
