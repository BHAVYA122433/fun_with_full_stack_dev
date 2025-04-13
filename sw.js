const CACHE_NAME = 'study-room-v1';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './offline.html',
    './style.css',
    './script.js',
    './manifest.json',
    './lib/localforage.min.js',
    'https://fonts.googleapis.com/icon?family=Material+Icons',
    'https://unpkg.com/peerjs@1.4.7/dist/peerjs.min.js'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(ASSETS_TO_CACHE))
    );
    self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request)
            .then(response => {
                if (response) {
                    return response;
                }
                return fetch(event.request)
                    .then(response => {
                        if (!response || response.status !== 200 || response.type !== 'basic') {
                            return response;
                        }
                        const responseToCache = response.clone();
                        caches.open(CACHE_NAME)
                            .then(cache => {
                                cache.put(event.request, responseToCache);
                            });
                        return response;
                    })
                    .catch(() => {
                        if (event.request.mode === 'navigate') {
                            return caches.match('./offline.html');
                        }
                    });
            })
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

// Background sync for pending changes
self.addEventListener('sync', event => {
    if (event.tag === 'sync-notes') {
        event.waitUntil(syncNotes());
    } else if (event.tag === 'sync-tasks') {
        event.waitUntil(syncTasks());
    }
});

// Helper function to sync notes
async function syncNotes() {
    try {
        const pendingNotes = await getPendingNotes();
        await Promise.all(pendingNotes.map(note => syncNote(note)));
    } catch (error) {
        console.error('Error syncing notes:', error);
    }
}

// Helper function to sync tasks
async function syncTasks() {
    try {
        const pendingTasks = await getPendingTasks();
        await Promise.all(pendingTasks.map(task => syncTask(task)));
    } catch (error) {
        console.error('Error syncing tasks:', error);
    }
}

// Helper function to get pending notes from IndexedDB
async function getPendingNotes() {
    // Implementation will depend on your IndexedDB structure
    return [];
}

// Helper function to get pending tasks from IndexedDB
async function getPendingTasks() {
    // Implementation will depend on your IndexedDB structure
    return [];
}

// Helper function to sync a single note
async function syncNote(note) {
    // Implementation will depend on your backend API
}

// Helper function to sync a single task
async function syncTask(task) {
    // Implementation will depend on your backend API
}

// Push notification handling
self.addEventListener('push', event => {
    const options = {
        body: event.data.text(),
        icon: '/icons/icon-192x192.png',
        badge: '/icons/badge-72x72.png',
        vibrate: [100, 50, 100],
        data: {
            dateOfArrival: Date.now(),
            primaryKey: 1
        },
        actions: [
            {
                action: 'explore',
                title: 'View Details'
            },
            {
                action: 'close',
                title: 'Close'
            }
        ]
    };

    event.waitUntil(
        self.registration.showNotification('Study App Update', options)
    );
});

// Notification click handling
self.addEventListener('notificationclick', event => {
    event.notification.close();

    if (event.action === 'explore') {
        // Handle explore action
        event.waitUntil(
            clients.matchAll({ type: 'window' })
                .then(windowClients => {
                    if (windowClients.length > 0) {
                        windowClients[0].focus();
                        windowClients[0].navigate('/');
                    } else {
                        clients.openWindow('/');
                    }
                })
        );
    }
});