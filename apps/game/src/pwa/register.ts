import { h } from '../ui/dom';

/** Register the service worker in production builds. Null in dev, where the browser lacks support, or on failure. */
export async function registerServiceWorker(nav: Navigator, prod: boolean): Promise<ServiceWorkerRegistration | null> {
  if (!prod || !('serviceWorker' in nav)) return null;
  try {
    return await nav.serviceWorker.register('./sw.js', { scope: '/' });
  } catch (err) {
    console.warn('Offline play is unavailable: the service worker did not register.', err);
    return null;
  }
}

const UPDATE_NOTE = "A new edition of the Bureau's handbook is ready. It'll be used next time you open Kitchen Quest.";

function showUpdateNote(doc: Document): void {
  if (doc.getElementById('sw-update-note')) return;
  const ok = h('button', { type: 'button', class: 'btn btn-secondary' }, 'Got it');
  const note = h('div', { class: 'notice update-note', role: 'status', id: 'sw-update-note' }, h('p', null, UPDATE_NOTE), ok);
  ok.addEventListener('click', () => note.remove());
  doc.getElementById('screen')?.before(note);
}

/**
 * A new worker waits (no skipWaiting) until every Kitchen Quest tab closes, so an open cook session is never
 * switched mid-recipe. While one waits, say so once.
 */
export function noteWaitingUpdate(doc: Document, reg: ServiceWorkerRegistration, nav: Navigator): void {
  if (reg.waiting) { showUpdateNote(doc); return; }
  reg.addEventListener('updatefound', () => {
    const worker = reg.installing;
    worker?.addEventListener('statechange', () => {
      // With no controller this is the first install, not an update.
      if (worker.state === 'installed' && nav.serviceWorker.controller) showUpdateNote(doc);
    });
  });
}
