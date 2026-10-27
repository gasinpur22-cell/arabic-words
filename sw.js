// Офлайн: файлы сайта, шрифты и Firebase кладутся в кеш. Сначала отдаём из кеша,
// параллельно обновляем его из сети, поэтому новая версия сайта появляется со следующего запуска.
const CACHE = "kalimat-v1";
const SHELL = ["./", "index.html", "style.css", "app.js", "words.js", "firebase-config.js", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png"];
const CDN = /^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|www\.gstatic\.com\/firebasejs)\//;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Запросы к базе Firestore не трогаем: у неё свой офлайн-кеш.
  if (url.origin !== location.origin && !CDN.test(req.url)) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(req, { ignoreSearch: url.origin === location.origin });
    const net = fetch(req).then(res => {
      if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
      return res;
    }).catch(() => hit || (req.mode === "navigate" ? cache.match("index.html") : Response.error()));
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    return net;
  }));
});
