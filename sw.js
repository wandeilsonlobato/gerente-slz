// Service worker: deixa o app funcionando offline e instalável no celular.
// Ao alterar arquivos do app, aumente a versão para forçar a atualização do cache.
const VERSAO = 'portal-slz-v22';
const ARQUIVOS = [
  './',
  './index.html',
  './logo-slz.png',
  './vendor/supabase.min.js',
  './vendor/jszip.min.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSAO).then(c => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(chaves => Promise.all(chaves.filter(k => k !== VERSAO).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Rede primeiro (pega sempre a versão mais nova, sem usar o cache do navegador); sem internet, usa o cache.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then(resp => {
        const copia = resp.clone();
        caches.open(VERSAO).then(c => c.put(e.request, copia));
        return resp;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html')))
  );
});

// Aviso de documento novo (só os devs recebem). Vários do mesmo condomínio viram um aviso só, com a contagem.
self.addEventListener('push', e => {
  let a;
  try { a = e.data.json(); } catch (err) { a = { titulo: 'Portal SLZ', corpo: e.data ? e.data.text() : 'Documento novo' }; }
  const tag = 'doc-' + (a.condominio_id || 'geral');
  e.waitUntil(self.registration.getNotifications({ tag }).then(abertas => {
    const ant = abertas[0] && abertas[0].data;
    const qtd = ((ant && ant.qtd) || 0) + 1;
    return self.registration.showNotification(qtd > 1 ? `${a.titulo} · ${qtd} documentos novos` : `${a.titulo} · documento novo`, {
      body: a.corpo,
      icon: './icons/icon-192.png',
      tag,
      renotify: true,
      data: Object.assign({}, a, { qtd })
    });
  }));
});

// Tocar no aviso: abre (ou traz para frente) o Portal já no documento.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const a = e.notification.data || {};
  const url = new URL('./', self.registration.scope);
  if (a.documento_id) {
    url.searchParams.set('doc', a.documento_id);
    url.searchParams.set('condo', a.condominio_id);
    url.searchParams.set('mes', a.competencia);
  }
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(janelas => {
    const aberta = janelas.find(c => c.url.startsWith(self.registration.scope));
    if (aberta) { aberta.postMessage(Object.assign({ tipo: 'abrir-doc' }, a)); return aberta.focus(); }
    return self.clients.openWindow(url.href);
  }));
});
