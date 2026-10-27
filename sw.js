// Офлайн. При каждом выпуске меняй VERSION: новая версия скачивается целиком в свой кеш
// и включается только когда скачана вся, поэтому старые и новые файлы никогда не смешиваются.
const VERSION = "2026-10-27-1";
const CACHE = "kalimat-" + VERSION;
// Фото всех слов берём из словаря, чтобы они были в кеше заранее.
self.window = self;
importScripts("words.js");
const PHOTOS = (self.WORDS || []).map(w => w.photo && w.photo.src).filter(Boolean);
const SHELL = [
  "./", "index.html", "style.css", "app.js", "words.js", "firebase-config.js", "manifest.webmanifest",
  "icons/icon.svg", "icons/icon-180.png", "icons/icon-192.png",
  "fonts/fonts.css",
  "fonts/golos-text-cyrillic.woff2", "fonts/golos-text-latin.woff2",
  "fonts/unbounded-cyrillic.woff2", "fonts/unbounded-latin.woff2",
  "fonts/scheherazade-new-400-arabic.woff2", "fonts/scheherazade-new-400-latin.woff2",
  "fonts/scheherazade-new-700-arabic.woff2", "fonts/scheherazade-new-700-latin.woff2",
  ...PHOTOS
];
const FIREBASE = /^https:\/\/www\.gstatic\.com\/firebasejs\//;

self.addEventListener("install", e => {
  // cache: "reload" — мимо HTTP-кеша браузера, иначе GitHub Pages может отдать старый файл.
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith("kalimat-") && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Страница: сначала сеть (не дольше 3 секунд), иначе из кеша. Остальное: сначала кеш.
function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)); }

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const own = url.origin === location.origin;
  // Запросы к базе Firestore не трогаем: у неё свой офлайн-кеш.
  if (!own && !FIREBASE.test(req.url)) return;

  if (req.mode === "navigate") {
    e.respondWith(Promise.race([fetch(req), timeout(3000)])
      .catch(() => caches.match("index.html", { cacheName: CACHE }).then(r => r || fetch(req))));
    return;
  }
  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(req, { ignoreSearch: own });
    if (hit) return hit;
    const res = await fetch(req);
    if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
    return res;
  }));
});
