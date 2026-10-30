/* Service worker: cho app mở được khi mạng yếu / mất mạng.
   Khi sửa app, tăng số phiên bản CACHE để máy NPP tải bản mới. */
const CACHE = 'quet-xuat-kho-v2.3.0';
const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'zxing-worker.js',
  'tesseract.min.js',
  'lib/zxing-reader.js',
  'lib/zxing_reader.wasm',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(ASSETS.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Google Apps Script (gửi/nhận dữ liệu) → luôn đi mạng, không cache
  if (/(^|\.)script\.google(usercontent)?\.com$/.test(url.hostname) || url.hostname.endsWith('googleusercontent.com')) return;
  // Trang chính: ưu tiên mạng (để nhận bản mới), mất mạng thì dùng bản đã lưu
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) { const c = await caches.open(CACHE); c.put('index.html', res.clone()); }
        return res;
      } catch (err) {
        return (await caches.match('index.html')) || (await caches.match('./')) || Response.error();
      }
    })());
    return;
  }
  const cacheable = url.origin === self.location.origin || /^fonts\.(googleapis|gstatic)\.com$/.test(url.hostname) || url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'unpkg.com';
  if (!cacheable) return;
  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok || res.type === 'opaque') { const c = await caches.open(CACHE); c.put(req, res.clone()); }
    return res;
  })());
});