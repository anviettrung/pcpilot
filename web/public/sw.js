// Service worker PcPilot: lưu vỏ trang (HTML, JS, CSS, icon) để mở được app từ màn hình chính ngay cả khi máy chủ
// của trang đang tắt; trang sau đó tự nối tới sidecar các máy còn lại. Luôn lấy bản mới từ mạng trước.
const CACHE = 'pcpilot-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
// Bỏ bộ đệm của bản trước (tên CACHE khác).
self.addEventListener('activate', (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  ),
);

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname === '/ws' || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const net = fetch(req).then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      });
      // Mạng chậm (máy chủ tắt thì Tailscale có thể treo lâu): sau 4 giây dùng bản đã lưu nếu có.
      const timeout = new Promise((r) => setTimeout(r, 4000, null));
      try {
        const res = await Promise.race([net, timeout]);
        if (res) return res;
      } catch {}
      const hit = await cache.match(req, { ignoreSearch: url.pathname === '/' });
      return hit ?? net;
    })(),
  );
});
