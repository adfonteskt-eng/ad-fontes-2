// Service worker: exists for two reasons -- (1) a page needs to be
// controlled by one at all for Chrome/most browsers to consider it an
// installable PWA, and (2) it's the only place a 'push' event (a Web Push
// message arriving while the site isn't even open) can be caught and turned
// into an actual system notification. Deliberately does NOT cache the app
// shell for offline use: ad fontes is a live-data app (chat, notes, reading
// plan progress all depend on a real request reaching server.js), and a
// stale cached index.html/app.js served after a deploy would be a
// confusing, hard-to-diagnose bug for very little offline benefit -- so
// this stays as close to a no-op as it can while still being a real,
// controlling service worker. See public/app.js's registration call and
// README -> PWA & push notifications.

self.addEventListener("install", () => {
  // Activate immediately rather than waiting for every open tab of the old
  // version to close -- there's no cached-version state to lose here (see
  // header comment), so there's nothing to gain by waiting.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// No caching: every request just goes to the network exactly as it would
// with no service worker at all. Present mainly so browsers that still key
// installability off "has a fetch handler" see one; functionally a passthrough.
self.addEventListener("fetch", () => {
  // Intentionally not calling event.respondWith() -- an unhandled fetch
  // event falls through to the browser's normal network request.
});

// A push message's payload is the JSON server.js/lib/push.js sent --
// { title, body, url } (see lib/push.js's sendDailyPassagePush/
// sendReadingPlanReminderPush). Falls back to a generic notification if the
// payload is missing or malformed, rather than silently dropping the push --
// the browser already woke this service worker up for it, so failing to
// show anything at all would be a strictly worse outcome than a vague one.
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // Not valid JSON -- fall through to the generic defaults below.
  }

  const title = payload.title || "ad fontes";
  const options = {
    body: payload.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: payload.url || "/" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Clicking the notification focuses an already-open ad fontes tab if there
// is one, rather than always opening a new one -- most people already have
// the site open in a tab somewhere, and piling up duplicate tabs on every
// notification click would be worse than reusing what's there.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of allClients) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) await client.navigate(targetUrl);
          return;
        }
      }
      await self.clients.openWindow(targetUrl);
    })(),
  );
});
