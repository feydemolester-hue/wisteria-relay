// Minimal service worker: lets Wisteria install as an app and open offline.
// Network-first for the page itself so updates show up right away.
const CACHE = 'wisteria-v1';
const SHELL = ['./', 'index.html', 'manifest.json', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE).map(x => caches.delete(x)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return; // CDNs, relay, Spotify: untouched
  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html')))
  );
});

// Incoming-call notification buttons: tell the open page what was pressed (or open it if it was closed).
self.addEventListener('notificationclick', e => {
  const d = e.notification.data || {}; e.notification.close();
  if (!d.call) return;
  // Clicking the button OR the notification itself answers the call; only "Decline" declines.
  const act = e.action === 'decline' ? 'decline' : 'accept';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async cs => {
    const c = cs.find(x => 'focus' in x);
    if (act === 'decline') { cs.forEach(x => x.postMessage({ wisteriaCall: act, from: d.from })); return; }
    if (c) {
      try { await c.focus(); } catch {}   // restores a minimized window and brings it to the front
      cs.forEach(x => x.postMessage({ wisteriaCall: 'accept', from: d.from }));
      return;
    }
    // page was closed: open it and let it answer as soon as the call invite arrives
    return self.clients.openWindow('./?answer=' + encodeURIComponent(d.from || ''));
  }));
});
