import '../../src/styles/tokens.css';
import '../../src/styles/components.css';
import { mountApp, registerScreen } from '../../src/shell/app';
import { registerPlaceholderScreens } from '../../src/shell/screens';
import { createStore } from '../../src/state/store';

registerPlaceholderScreens();
registerScreen('map', () => ({ title: 'Map', mount(el) { el.append(document.createElement('hr')); throw new Error('boom'); } }));
registerScreen('recipes', () => ({ title: 'Recipes', async mount() { throw new Error('async boom'); } }));
mountApp(document, { store: createStore(null), now: () => new Date() });
