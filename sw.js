importScripts('config.js');

/* Офлайн-кэш: оболочка и словарь — заранее, озвучка — по мере прослушивания. */
const SHELL = `${L.key}-shell-v6`;
const AUDIO = `${L.key}-audio-v1`;
const AUDIO_LIMIT = 1200;                    // сколько озвучек держать офлайн
const SHELL_FILES = [
  './', './index.html', './style.css', './app.js', './config.js', './manifest.json',
  './icons/icon-192-v2.png', './icons/apple-touch-icon-v2.png',
  L.data.words, L.data.alphabet, L.data.audio, L.data.mnemonics,
  ...(L.lessons ? [L.lessons] : []),        // раздел грамматики есть не у всех языков
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== AUDIO).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function trimAudioCache() {
  const cache = await caches.open(AUDIO);
  const keys = await cache.keys();
  if (keys.length > AUDIO_LIMIT) {
    for (const k of keys.slice(0, keys.length - AUDIO_LIMIT)) await cache.delete(k);
  }
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  if (url.pathname.endsWith('.mp3')) {                       // озвучка: сначала кэш, потом сеть
    e.respondWith(caches.open(AUDIO).then(async (cache) => {
      const hit = await cache.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) { cache.put(e.request, res.clone()); trimAudioCache(); }
      return res;
    }));
    return;
  }

  // всё остальное: свежее из сети в обход промежуточных кэшей, при отсутствии связи — из кэша
  e.respondWith(
    fetch(new Request(e.request.url, { cache: 'no-store', credentials: 'same-origin' }))
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
