'use strict';
const CACHE='colin-movie-check-shell-v2.6.1';
const SHELL=['./','index.html','styles.css?v=261','app.js?v=261','manifest.webmanifest','icon-192.png','icon-512.png'];
const ZXING='https://unpkg.com/@zxing/browser@0.2.1/umd/zxing-browser.min.js';
self.addEventListener('install',e=>e.waitUntil((async()=>{const c=await caches.open(CACHE);await c.addAll(SHELL);await Promise.allSettled([c.add(ZXING)]);await self.skipWaiting()})()));
self.addEventListener('activate',e=>e.waitUntil((async()=>{for(const k of await caches.keys())if(k!==CACHE&&k.startsWith('colin-movie-check-shell-'))await caches.delete(k);await self.clients.claim()})()));
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(u.origin===location.origin&&u.pathname.endsWith('/catalog.enc'))return;
  if(e.request.url===ZXING){e.respondWith(caches.match(e.request).then(c=>c||fetch(e.request).then(r=>{const x=r.clone();caches.open(CACHE).then(cache=>cache.put(e.request,x));return r})));return}
  if(u.origin!==location.origin)return;
  e.respondWith(fetch(e.request,{cache:'no-store'}).then(r=>{const x=r.clone();caches.open(CACHE).then(cache=>cache.put(e.request,x));return r}).catch(()=>caches.match(e.request)));
});
