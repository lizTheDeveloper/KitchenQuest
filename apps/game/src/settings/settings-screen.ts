import type { ApiClient } from '../api/client';
import { registerScreen, type AppContext, type Screen } from '../shell/app';
import { deleteOfflineCopy } from '../pwa/register';
import { deleteDeviceData, safeLocalStorage, STORE_KEY, type PlayerSettings } from '../state/store';
import { h } from '../ui/dom';
import { accountSection } from './account-section';
import { installSection } from './install-section';

/** At most this long for each network or browser step of "Delete everything", so the reload always happens. */
const DELETE_STEP_MS = 3000;

const within = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([p, new Promise<null>((resolve) => { setTimeout(() => resolve(null), ms); })]);

function settingsScreen(api: ApiClient): Screen {
  let stops: (() => void)[] = [];
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
        const signedIn = ctx.store.get().account !== null || ctx.store.get().signOutPending;
        const box = h('div', { class: 'confirm-box', role: 'group', 'aria-labelledby': 'delete-heading' },
          heading,
          h('p', null, "This removes your rules, progress and settings from this device, including any recovery copies, and the game's offline copy. It can't be undone."),
          signedIn ? h('p', null, "It also signs this device out. Your account and the rules kept with it aren't deleted.") : null,
          h('div', { class: 'button-row' }, yes, no));
        no.addEventListener('click', () => { box.remove(); askDelete.hidden = false; askDelete.focus(); });
        yes.addEventListener('click', () => {
          yes.disabled = true;
          no.disabled = true;
          void (async () => {
            // Signed in: end the session first, or the next start would sign this device straight back in.
            // Read again now: the account may have changed (another tab, a refresh) since the box opened.
            const nowSignedIn = ctx.store.get().account !== null || ctx.store.get().signOutPending;
            const loggedOut = !nowSignedIn || (await within(api.logout(), DELETE_STEP_MS))?.ok === true;
            const storage = safeLocalStorage();
            if (storage) {
              try {
                deleteDeviceData(storage);
                // The server never heard: keep only the note that a sign-out is owed (see refreshAccount).
                if (!loggedOut) storage.setItem(STORE_KEY, JSON.stringify({ v: 1, signOutPending: true }));
              } catch { /* reload anyway */ }
            }
            // The offline copy too: Kitchen Quest's caches and its service worker. Bounded by its own timeout.
            await deleteOfflineCopy(navigator, 'caches' in window ? window.caches : undefined, DELETE_STEP_MS);
            window.location.hash = '#/kitchen';
            window.location.reload(); // start from a fresh in-memory store too
          })();
        });
        askDelete.hidden = true;
        dataBox.append(box);
        heading.focus();
      });
      dataBox.append(askDelete);

      const install = installSection(el.ownerDocument.defaultView!, ctx.store);
      const account = accountSection(ctx.store, api);
      const dataNote = h('p', null);
      const showDataNote = () => {
        dataNote.textContent = ctx.store.get().account
          ? "Your progress and settings stay on this device. Your rules are kept with your account, with a copy on this device so dishes can be checked offline. Signing out removes that copy."
          : 'Everything Kitchen Quest saves stays on this device.';
      };
      showDataNote();
      stops = [install.stop, account.stop, ctx.store.subscribe(showDataNote)];

      el.append(
        h('h1', null, 'Settings'),
        h('section', { class: 'panel', 'aria-labelledby': 'set-display' },
          h('h2', { id: 'set-display' }, 'Display'),
          h('div', { class: 'field' }, calories, h('label', { for: 'set-calories' }, 'Show calories')),
          h('div', { class: 'field' }, h('label', { for: 'set-motion' }, 'Reduce motion'), motion)),
        h('section', { class: 'panel', 'aria-labelledby': 'set-data' },
          h('h2', { id: 'set-data' }, 'Your data'),
          dataNote,
          dataBox),
        account.el,
        install.el,
      );
    },
    unmount() { for (const stop of stops) stop(); stops = []; },
  };
}

export function registerSettingsScreen(api: ApiClient): void { registerScreen('settings', () => settingsScreen(api)); }
