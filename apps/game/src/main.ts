import './styles/tokens.css';
import './styles/components.css';
import { watchAccount } from './api/account';
import { createApiClient } from './api/client';
import { registerKitchenScreen } from './kitchen/kitchen-screen';
import { captureInstallPrompt } from './pwa/install';
import { deleteOfflineCopy, noteWaitingUpdate, registerServiceWorker, skipServiceWorkerOnce, takeServiceWorkerSkip } from './pwa/register';
import { registerRulesScreen } from './rules';
import { initProgress } from './progress';
import { mountApp, registerScreen } from './shell/app';
import { lazyScreen } from './shell/lazy';
import { SCREEN_TITLES } from './shell/titles';
import { registerPlaceholderScreens } from './shell/screens';
import { createStore, safeLocalStorage } from './state/store';

registerPlaceholderScreens();
const api = createApiClient();
// Everything but the kitchen (the landing screen) loads on first visit, so first paint carries only what it draws.
registerScreen('settings', () => lazyScreen(SCREEN_TITLES.settings, async () => (await import('./settings/settings-screen')).settingsScreen(api)));
registerScreen('recipes', () => lazyScreen(SCREEN_TITLES.recipes, async () => (await import('./recipes/recipes-screen')).recipesScreen()));
registerScreen('recipe', () => lazyScreen(SCREEN_TITLES.recipe, async () => (await import('./recipes/recipe-screen')).recipeScreen()));
registerScreen('cook', () => lazyScreen(SCREEN_TITLES.cook, async () => (await import('./cook/cook-screen')).cookScreen()));
registerKitchenScreen();
registerScreen('map', () => lazyScreen(SCREEN_TITLES.map, async () => (await import('./world/map-screen')).mapScreen()));
registerScreen('visit', () => lazyScreen(SCREEN_TITLES.visit, async () => (await import('./world/visit-screen')).visitScreen()));
registerRulesScreen(); // replaces Step 9's placeholder
const session = (() => { try { return window.sessionStorage; } catch { return null; } })();
// Wiped by "Delete everything" in another tab: reload onto the fresh state, without bringing the worker back.
const store = createStore(safeLocalStorage(), window, () => { skipServiceWorkerOnce(session); window.location.reload(); });
mountApp(document, { store, now: () => new Date() });
// Progress (M5 Step 9): the device log, and its one upload on sign-in. Its code loads with the first screen that needs it.
initProgress(api, store, window);

// Who is signed in, and their rules: on start, when the connection comes back and when the app is shown again.
// Nothing else calls the API on load; a sign-in token in this page's address is never read here (only /auth/verify does, on a tap).
watchAccount(api, store, window, document);

captureInstallPrompt(window);
// Right after "Delete everything" (in this tab or another) this load stays without the offline copy. A worker
// that came back meanwhile (another tab's registration still in flight during the delete) is removed again.
if (takeServiceWorkerSkip(session)) void deleteOfflineCopy(navigator, 'caches' in window ? window.caches : undefined);
else void registerServiceWorker(navigator, import.meta.env.PROD).then((reg) => { if (reg) noteWaitingUpdate(document, reg, navigator); });
