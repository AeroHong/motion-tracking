// sw.js — 최소 서비스 워커 (PWA 홈 화면 설치용)
const CACHE = 'motion-v1';
const PRECACHE = ['/', '/index.html', '/style.css', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Firebase Auth/Firestore는 항상 네트워크 우선
  const url = new URL(e.request.url);
  if (url.hostname.includes('firebase') || url.hostname.includes('google')) {
    e.respondWith(fetch(e.request));
    return;
  }
  // 나머지: 캐시 우선 → 네트워크 폴백
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
