import './styles/tokens.css';
import './styles/components.css';
import { registerSettingsScreen } from './settings/settings-screen';
import { mountApp } from './shell/app';
import { registerPlaceholderScreens } from './shell/screens';
import { createStore, safeLocalStorage } from './state/store';

registerPlaceholderScreens();
registerSettingsScreen();
mountApp(document, { store: createStore(safeLocalStorage(), window, () => window.location.reload()), now: () => new Date() });
