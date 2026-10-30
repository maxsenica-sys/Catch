/// <reference lib="webworker" />
/**
 * Service worker. Two jobs:
 *
 * 1. Open instantly, even offline: the app shell is cached, index.html is
 *    network-first (so a deploy is picked up on the next open) and hashed
 *    assets are cache-first (they never change). /api is never cached.
 * 2. Android share target: "Share → Catch" from any app posts the images
 *    here; they are parked in a cache and the capture screen picks them up.
 *    (iOS does not support web share targets; see docs/IOS-SHORTCUT.md.)
 */
const sw = self as unknown as ServiceWorkerGlobalScope;
export {};

const SHELL = "catch-shell-v1";

sw.addEventListener("install", (event: ExtendableEvent) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/", "/manifest.webmanifest", "/icon.svg"])).then(() => sw.skipWaiting()));
});

sw.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== "catch-share").map((k) => caches.delete(k))))
      .then(() => sw.clients.claim()),
  );
});

sw.addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;

  if (event.request.method === "POST" && url.pathname === "/share") {
    event.respondWith((async () => {
      const form = await event.request.formData();
      const cache = await caches.open("catch-share");
      let i = 0;
      for (const file of form.getAll("image")) {
        if (file instanceof File) await cache.put(`/shared/${Date.now()}-${i++}`, new Response(file, { headers: { "Content-Type": file.type } }));
      }
      return Response.redirect("/#/capture?shared=1", 303);
    })());
    return;
  }

  if (event.request.method !== "GET" || url.pathname.startsWith("/api/") || url.pathname.startsWith("/feeds/")) return;

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(caches.open(SHELL).then(async (cache) => {
      const hit = await cache.match(event.request);
      if (hit) return hit;
      const res = await fetch(event.request);
      if (res.ok) void cache.put(event.request, res.clone());
      return res;
    }));
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok && event.request.mode === "navigate") void caches.open(SHELL).then((c) => c.put("/", res.clone()));
        return res;
      })
      .catch(async () => (await caches.match(event.request)) ?? (await caches.match("/")) ?? Response.error()),
  );
});
