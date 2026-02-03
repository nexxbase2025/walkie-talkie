const CACHE = "walkie-v2";
const ASSETS = ["./","./index.html","./style.css","./app.js","./manifest.json","./icon-192.png","./icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => k !== CACHE ? caches.delete(k) : null)))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).catch(() => caches.match("./"))));
});

// Push notifications (Web Push)
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data.json(); }
  catch { data = { title: "Walkie", body: "Alerta", url: "./" }; }

  const title = data.title || "Walkie";
  const options = {
    body: data.body || "Mensaje",
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    data: { url: data.url || "./" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification?.data?.url || "./";
  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of allClients) {
      if ("focus" in c) return c.focus();
    }
    if (clients.openWindow) return clients.openWindow(url);
  })());
});
