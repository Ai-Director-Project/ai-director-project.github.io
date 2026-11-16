// After Dark: shows photo-check alerts and opens the app when one is tapped.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch (err) {}
  e.waitUntil(self.registration.showNotification(m.title || 'Reminder', {
    body: m.body || '⏰ Your check-in is due',
    tag: 'ad-check',
    renotify: true,
    requireInteraction: true,
    icon: 'icon.png',
    data: { id: m.id || '' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const id = (e.notification.data && e.notification.data.id) || '';
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope)) {
        try { await c.focus(); } catch (err) {}
        c.postMessage({ check: id });
        return;
      }
    }
    await self.clients.openWindow('./?check=' + encodeURIComponent(id));
  })());
});
