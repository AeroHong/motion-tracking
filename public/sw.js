// sw.js — 서비스 워커 (PWA 홈 화면 설치용)
// 버전 업데이트 시 CACHE 이름을 바꾸면 구 캐시가 자동 삭제됨
const CACHE = 'motion-v43';
const PRECACHE = ['/', '/index.html', '/style.css', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    // cache:'reload' — 브라우저 HTTP 캐시에 남은 예전 파일을 미리 저장하지 않도록
    caches.open(CACHE).then(c => c.addAll(PRECACHE.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => {
        // 새 버전이 활성화되면 열려 있는 모든 탭에 자동 리로드 요청
        return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
          .then(clients => clients.forEach(client => client.postMessage({ type: 'SW_UPDATED' })));
      })
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Firebase Auth/Firestore/Google — 항상 네트워크 직통
  if (url.hostname.includes('firebase') || url.hostname.includes('google')) {
    e.respondWith(fetch(e.request));
    return;
  }

  // index.html / 루트 — 네트워크 우선, 실패 시 캐시 폴백
  // → 배포 즉시 최신 HTML 수신, 오프라인에서도 구동 가능
  if (url.pathname === '/' || url.pathname.endsWith('.html')) {
    e.respondWith(
      // HTTP 캐시를 거치지 않고 서버에 확인 (navigate 요청은 init을 못 붙여 URL로 다시 요청)
      fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' })
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // JS 파일 — 네트워크 우선 (배포 즉시 최신 버전 반영), 실패 시 캐시 폴백
  if (url.pathname.endsWith('.js')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // CSS / 기타 정적 자산 — 캐시 우선, 없으면 네트워크
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
