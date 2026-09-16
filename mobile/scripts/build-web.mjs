import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
const root = new URL('../web-dist/', import.meta.url);
async function walk(dir, prefix = '') {
  const result = [];
  for (const f of await readdir(dir, { withFileTypes: true })) {
    if (f.isDirectory()) result.push(...await walk(new URL(f.name + '/', dir), prefix + f.name + '/'));
    else if (f.name !== 'sw.js') result.push('/' + prefix + f.name);
  }
  return result;
}
const assets = (await walk(root)).sort();
const hash = createHash('sha256');
for (const asset of assets) hash.update(asset).update(await readFile(new URL(asset.slice(1), root)));
const version = hash.digest('hex').slice(0, 16);
await writeFile(new URL('sw.js', root), `
const CACHE = 'aibro-shell-${version}';
const ASSETS = ${JSON.stringify(assets)};
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))));
// Do not skipWaiting: an open editor keeps its matching code until it closes.
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('aibro-shell-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== self.location.origin || (u.pathname.startsWith('/v1/') || u.pathname.startsWith('/api/'))) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(caches.open(CACHE).then(c => c.match('/index.html')).then(r => r || fetch(e.request)));
  } else if (ASSETS.includes(u.pathname)) e.respondWith(caches.open(CACHE).then(c => c.match(u.pathname)).then(r => r || fetch(e.request)));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type:'window', includeUncontrolled:true}).then(windows => {
    const page = windows.find(w => new URL(w.url).origin === self.location.origin);
    return page ? page.focus() : self.clients.openWindow('/');
  }));
});
`);
new Script(await readFile(new URL('sw.js', root), 'utf8'), { filename: 'sw.js' });
console.log('Web shell and offline cache built:', assets.length, 'public assets.');
