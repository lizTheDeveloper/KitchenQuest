import { registerScreen, type AppContext, type Screen } from '../shell/app';
import type { PlayerSettings } from '../state/store';
import { h } from '../ui/dom';

function settingsScreen(): Screen {
  return {
    title: 'Settings',
    mount(el, _route, ctx: AppContext) {
      const set = (patch: Partial<PlayerSettings>) =>
        ctx.store.update((s) => ({ ...s, settings: { ...s.settings, ...patch } }));
      const { settings } = ctx.store.get();

      const calories = h('input', { type: 'checkbox', id: 'set-calories', checked: settings.showCalories });
      calories.checked = settings.showCalories;
      calories.addEventListener('change', () => set({ showCalories: calories.checked }));

      const motion = h('select', { id: 'set-motion' },
        h('option', { value: 'system' }, 'System'), h('option', { value: 'on' }, 'On'), h('option', { value: 'off' }, 'Off'));
      motion.value = settings.reducedMotion;
      motion.addEventListener('change', () => set({ reducedMotion: motion.value as PlayerSettings['reducedMotion'] }));

      el.append(
        h('h1', null, 'Settings'),
        h('section', { class: 'panel', 'aria-labelledby': 'set-display' },
          h('h2', { id: 'set-display' }, 'Display'),
          h('div', { class: 'field' }, calories, h('label', { for: 'set-calories' }, 'Show calories')),
          h('div', { class: 'field' }, h('label', { for: 'set-motion' }, 'Reduce motion'), motion)),
      );
    },
  };
}

export function registerSettingsScreen(): void { registerScreen('settings', settingsScreen); }
