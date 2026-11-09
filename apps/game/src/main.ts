import './styles/tokens.css';
import './styles/components.css';
import { registerCookScreen } from './cook/cook-screen';
import { registerKitchenScreen } from './kitchen/kitchen-screen';
import { registerRecipeScreen } from './recipes/recipe-screen';
import { registerRecipesScreen } from './recipes/recipes-screen';
import { registerSettingsScreen } from './settings/settings-screen';
import { mountApp } from './shell/app';
import { registerPlaceholderScreens } from './shell/screens';
import { createStore, safeLocalStorage } from './state/store';

registerPlaceholderScreens();
registerSettingsScreen();
registerRecipesScreen();
registerRecipeScreen();
registerCookScreen();
registerKitchenScreen();
mountApp(document, { store: createStore(safeLocalStorage(), window, () => window.location.reload()), now: () => new Date() });
