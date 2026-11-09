import { registerScreen, type AppContext, type Screen } from '../shell/app';
import { deleteDeviceData, safeLocalStorage, type PlayerSettings } from '../state/store';
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

      const dataBox = h('div', { id: 'data-box' });
      const askDelete = h('button', { type: 'button', class: 'btn btn-secondary', id: 'delete-data' }, 'Delete Kitchen Quest data on this device');
      askDelete.addEventListener('click', () => {
        const heading = h('h3', { id: 'delete-heading', tabindex: -1 }, 'Delete everything on this device?');
        const yes = h('button', { type: 'button', class: 'btn btn-primary', id: 'delete-confirm' }, 'Delete everything');
        const no = h('button', { type: 'button', class: 'btn btn-secondary', id: 'delete-cancel' }, 'Keep my data');
        const box = h('div', { class: 'confirm-box', role: 'group', 'aria-labelledby': 'delete-heading' },
          heading,
          h('p', null, "This removes your rules, progress and settings from this device, including any recovery copies. It can't be undone."),
          h('div', { class: 'button-row' }, yes, no));
        no.addEventListener('click', () => { box.remove(); askDelete.hidden = false; askDelete.focus(); });
        yes.addEventListener('click', () => {
          const storage = safeLocalStorage();
          if (storage) { try { deleteDeviceData(storage); } catch { /* reload anyway */ } }
          window.location.hash = '#/kitchen';
          window.location.reload(); // start from a fresh in-memory store too
        });
        askDelete.hidden = true;
        dataBox.append(box);
        heading.focus();
      });
      dataBox.append(askDelete);

      el.append(
        h('h1', null, 'Settings'),
        h('section', { class: 'panel', 'aria-labelledby': 'set-display' },
          h('h2', { id: 'set-display' }, 'Display'),
          h('div', { class: 'field' }, calories, h('label', { for: 'set-calories' }, 'Show calories')),
          h('div', { class: 'field' }, h('label', { for: 'set-motion' }, 'Reduce motion'), motion)),
        h('section', { class: 'panel', 'aria-labelledby': 'set-data' },
          h('h2', { id: 'set-data' }, 'Your data'),
          h('p', null, 'Everything Kitchen Quest saves stays on this device.'),
          dataBox),
      );
    },
  };
}

export function registerSettingsScreen(): void { registerScreen('settings', settingsScreen); }
