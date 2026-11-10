import './styles/tokens.css';
import './styles/components.css';
import { watchAccount } from './api/account';
import { createApiClient } from './api/client';
import { registerCookScreen } from './cook/cook-screen';
import { registerKitchenScreen } from './kitchen/kitchen-screen';
import { captureInstallPrompt } from './pwa/install';
import { deleteOfflineCopy, noteWaitingUpdate, registerServiceWorker, skipServiceWorkerOnce, takeServiceWorkerSkip } from './pwa/register';
import { registerRecipeScreen } from './recipes/recipe-screen';
import { registerRecipesScreen } from './recipes/recipes-screen';
import { registerSettingsScreen } from './settings/settings-screen';
import { mountApp } from './shell/app';
import { registerPlaceholderScreens } from './shell/screens';
import { createStore, safeLocalStorage } from './state/store';
import { registerMapScreen } from './world/map-screen';
import { registerVisitScreen } from './world/visit-screen';

registerPlaceholderScreens();
const api = createApiClient();
registerSettingsScreen(api);
registerRecipesScreen();
registerRecipeScreen();
registerCookScreen();
registerKitchenScreen();
registerMapScreen();
registerVisitScreen();
const session = (() => { try { return window.sessionStorage; } catch { return null; } })();
// Wiped by "Delete everything" in another tab: reload onto the fresh state, without bringing the worker back.
const store = createStore(safeLocalStorage(), window, () => { skipServiceWorkerOnce(session); window.location.reload(); });
mountApp(document, { store, now: () => new Date() });

// Who is signed in, and their rules: on start, when the connection comes back and when the app is shown again.
// Nothing else calls the API on load; a sign-in token in this page's address is never read here (only /auth/verify does, on a tap).
watchAccount(api, store, window, document);

captureInstallPrompt(window);
// Right after "Delete everything" (in this tab or another) this load stays without the offline copy. A worker
// that came back meanwhile (another tab's registration still in flight during the delete) is removed again.
if (takeServiceWorkerSkip(session)) void deleteOfflineCopy(navigator, 'caches' in window ? window.caches : undefined);
else void registerServiceWorker(navigator, import.meta.env.PROD).then((reg) => { if (reg) noteWaitingUpdate(document, reg, navigator); });
