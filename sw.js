// SVUA: работает без интернета. Оболочка и каталог — из кеша (обновляются в фоне), постеры — кеш после первого показа.
const SHELL = "svua-shell-v6";
const POSTERS = "svua-posters-v1";
const FILES = ["./", "index.html", "style.css?v=6", "app.js?v=6", "config.js?v=6", "films.json", "manifest.webmanifest", "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL && k !== POSTERS).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.hostname === "st.kp.yandex.net") {           // постеры
    e.respondWith(caches.open(POSTERS).then(async c => {
      const hit = await c.match(e.request); if (hit) return hit;
      const r = await fetch(e.request); if (r.ok || r.type === "opaque") c.put(e.request, r.clone()); return r;
    }));
    return;
  }
  if (url.origin !== location.origin) return;           // база оценок и прочее — напрямую
  e.respondWith(caches.open(SHELL).then(async c => {    // свои файлы: сначала сеть (быстрые обновления), без интернета — из кеша
    try {
      const r = await fetch(e.request, { cache: "no-cache" });
      if (r.ok) c.put(e.request, r.clone());
      return r;
    } catch {
      return (await c.match(e.request)) || (await c.match("./"));
    }
  }));
});
