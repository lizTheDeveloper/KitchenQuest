import './styles/tokens.css';
import './styles/components.css';
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
registerSettingsScreen();
registerRecipesScreen();
registerRecipeScreen();
registerCookScreen();
registerKitchenScreen();
registerMapScreen();
registerVisitScreen();
mountApp(document, { store: createStore(safeLocalStorage(), window, () => window.location.reload()), now: () => new Date() });

captureInstallPrompt(window);
void registerServiceWorker(navigator, import.meta.env.PROD).then((reg) => { if (reg) noteWaitingUpdate(document, reg, navigator); });
