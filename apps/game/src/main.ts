import './styles/tokens.css';
import './styles/components.css';
import { refreshAccount } from './api/account';
import { createApiClient } from './api/client';
import { registerCookScreen } from './cook/cook-screen';
import { registerKitchenScreen } from './kitchen/kitchen-screen';
import { captureInstallPrompt } from './pwa/install';
import { noteWaitingUpdate, registerServiceWorker } from './pwa/register';
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
const store = createStore(safeLocalStorage(), window, () => window.location.reload());
mountApp(document, { store, now: () => new Date() });

// Who is signed in, and their rules: on start and whenever the connection comes back. Nothing else calls the
// API on load; a sign-in token in this page's address is never read here (only /auth/verify does, on a tap).
void refreshAccount(api, store);
window.addEventListener('online', () => { void refreshAccount(api, store); });

captureInstallPrompt(window);
void registerServiceWorker(navigator, import.meta.env.PROD).then((reg) => { if (reg) noteWaitingUpdate(document, reg, navigator); });
