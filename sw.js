/* ============================================================
   KEEPLOCAL — Service Worker (sw.js)
   Offline caching for local-first note taking (ARCH-01)
   ============================================================ */

const CACHE_NAME = 'keeplocal-v1';

const STATIC_ASSETS = [
	'./',
	'index.html',
	'css/styles.css',
	'js/script.js',
	'assets/keeplocal.png',
	'https://unpkg.com/lucide@1.48.0/dist/umd/lucide.min.js',
	'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
	'https://cdn.jsdelivr.net/npm/@editorjs/editorjs@2.31.7',
	'https://cdn.jsdelivr.net/npm/@editorjs/header@2.8.9',
	'https://cdn.jsdelivr.net/npm/@editorjs/nested-list@1.4.3',
	'https://cdn.jsdelivr.net/npm/@editorjs/checklist@1.6.0',
	'https://cdn.jsdelivr.net/npm/@editorjs/quote@2.7.6',
	'https://cdn.jsdelivr.net/npm/@editorjs/warning@1.4.1',
	'https://cdn.jsdelivr.net/npm/@editorjs/delimiter@1.4.2',
	'https://cdn.jsdelivr.net/npm/@editorjs/simple-image@1.6.0',
	'https://cdn.jsdelivr.net/npm/@editorjs/code@2.9.4',
	'https://cdn.jsdelivr.net/npm/@editorjs/inline-code@1.5.2',
	'https://cdn.jsdelivr.net/npm/@editorjs/marker@1.4.0',
	'https://cdn.jsdelivr.net/npm/@editorjs/underline@1.2.1',
	'https://cdn.jsdelivr.net/npm/@editorjs/table@2.4.6',
	'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css',
	'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism.min.css',
	'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js',
	'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/plugins/autoloader/prism-autoloader.min.js'
];

// Install: precache app shell and external CDN scripts
self.addEventListener('install', (event) => {
	event.waitUntil(
		caches.open(CACHE_NAME).then((cache) => {
			return Promise.allSettled(
				STATIC_ASSETS.map((url) =>
					cache.add(url).catch((err) => {
						console.warn(`[SW] Precache failed for ${url}:`, err);
					})
				)
			);
		}).then(() => self.skipWaiting())
	);
});

// Activate: clean up older caches
self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches.keys().then((keys) => {
			return Promise.all(
				keys.map((key) => {
					if (key !== CACHE_NAME) {
						return caches.delete(key);
					}
				})
			);
		}).then(() => self.clients.claim())
	);
});

// Fetch: Stale-While-Revalidate / Cache-First strategy
self.addEventListener('fetch', (event) => {
	// Only handle GET requests
	if (event.request.method !== 'GET') return;

	const url = new URL(event.request.url);

	// Bypass caching for non-http(s) or chrome-extension schemes
	if (!url.protocol.startsWith('http')) return;

	event.respondWith(
		caches.match(event.request).then((cachedResponse) => {
			// If found in cache, return it and optionally update in background
			const fetchPromise = fetch(event.request)
				.then((networkResponse) => {
					if (networkResponse && networkResponse.status === 200) {
						const responseToCache = networkResponse.clone();
						caches.open(CACHE_NAME).then((cache) => {
							cache.put(event.request, responseToCache);
						});
					}
					return networkResponse;
				})
				.catch((err) => {
					// Network failed (offline)
					if (cachedResponse) return cachedResponse;
					throw err;
				});

			return cachedResponse || fetchPromise;
		})
	);
});
