import '../styles/tokens.css';
import '../styles/components.css';
import { createApiClient } from '../api/client';
import { createStore, safeLocalStorage } from '../state/store';
import { startVerifyPage } from './verify-page';

// The verify page's entry. It never registers the service worker (only main.ts does).
startVerifyPage({
  doc: document, location: window.location, history: window.history, client: createApiClient(),
  onSignedIn() {
    // A sign-out that never reached the server must not end this new session on the next app start.
    const store = createStore(safeLocalStorage());
    if (store.get().signOutPending) store.update((s) => ({ ...s, signOutPending: false }));
  },
});
