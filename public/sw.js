// PitaDay Service Worker - PWA Cache + FCM Push Notifications
const CACHE_NAME = 'pitaday-public-v84-1-1';

// CDNリソース（Font Awesome、Google Fonts）
const CDN_ASSETS = [
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+JP:wght@400;500;600;700&display=swap'
];

// ローカルリソース（必ずキャッシュ成功する）
const LOCAL_ASSETS = [
    './',
    './index.html',
    './app.js',
    './tutorial2.js',
    './style.css',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png',
];

// ====== PWA Cache ======
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(async (cache) => {
            // ローカルファイルは必ずキャッシュ（失敗したらインストール中断）
            await cache.addAll(LOCAL_ASSETS);
            // CDNリソースは個別にキャッシュ（1つ失敗しても他は続行）
            for (const url of CDN_ASSETS) {
                try {
                    await cache.add(url);
                } catch (err) {
                    console.warn('[SW] CDNキャッシュ失敗（旧キャッシュから移行予定）:', url, err);
                }
            }
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(async (keyList) => {
            const newCache = await caches.open(CACHE_NAME);
            // 旧キャッシュからCDNリソースを新キャッシュに移行（install時に取得失敗した場合の保険）
            for (const oldKey of keyList) {
                if (oldKey === CACHE_NAME) continue;
                const oldCache = await caches.open(oldKey);
                for (const url of CDN_ASSETS) {
                    const existing = await newCache.match(url);
                    if (!existing) {
                        const oldResponse = await oldCache.match(url);
                        if (oldResponse) {
                            await newCache.put(url, oldResponse);
                            console.log('[SW] 旧キャッシュからCDN移行:', url);
                        }
                    }
                }
                // 移行後に旧キャッシュを削除
                await caches.delete(oldKey);
            }
        })
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    const url = new URL(event.request.url);
    const localAssets = new Set(LOCAL_ASSETS.map(asset => new URL(asset, self.registration.scope).href));
    if (!localAssets.has(url.href) && !CDN_ASSETS.includes(url.href)) return;
    event.respondWith(caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(event.request);
        const refresh = fetch(event.request).then(response => {
            if (response.ok) cache.put(event.request, response.clone());
            return response;
        });
        if (cached) { event.waitUntil(refresh.catch(() => {})); return cached; }
        return refresh;
    }));
});

importScripts('./sw-config.js');
if (!self.PITADAY_CONFIG.demoMode && self.PITADAY_CONFIG.enablePush) {
    importScripts('https://www.gstatic.com/firebasejs/10.9.0/firebase-app-compat.js');
    importScripts('https://www.gstatic.com/firebasejs/10.9.0/firebase-messaging-compat.js');
    firebase.initializeApp(self.PITADAY_CONFIG.firebaseConfig);
    firebase.messaging().onBackgroundMessage(payload => {
        const data = payload.data || {};
        return self.registration.showNotification(data.title || 'PitaDay', {
            body: data.body || '', icon: './icons/icon-192.png', data
        });
    });
}
self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil(self.clients.openWindow(new URL('./?tab=notifications', self.registration.scope).href));
});
