import { SCREEN_TITLES } from '../shell/titles';
import type { ApiClient } from '../api/client';
import { type AppContext, type Screen } from '../shell/app';
import { deleteOfflineCopy, skipServiceWorkerOnce } from '../pwa/register';
import { deviceId } from '../state/device-id';
import { deleteDeviceData, safeLocalStorage, STORE_KEY, type PlayerSettings, type PlayerState } from '../state/store';
import { h } from '../ui/dom';
import { content } from '../content';
import { accountSection } from './account-section';
import { installSection } from './install-section';
import { mentorSection } from './mentor-section';
import { voiceSection } from './voice-section';

/** At most this long for each network or browser step of "Delete everything", so the reload always happens. */
const DELETE_STEP_MS = 3000;

const within = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([p, new Promise<null>((resolve) => { setTimeout(() => resolve(null), ms); })]);

/**
 * The first steps of "Delete everything on this device", signed in: M7 Step 9 fix round 3, a Family Table device
 * first tells the server this install left Family Table (`{ on: false }` with its own id, Ruling 17), because its id
 * goes with the device data and could otherwise never lift the account's voice block; then the session ends. Each step
 * is bounded by `ms`, and a failed report never holds the delete up. True when signed out (or never signed in).
 */
export async function signOutBeforeDelete(api: Pick<ApiClient, 'logout' | 'setFamilyTable'>, s: Pick<PlayerState, 'account' | 'signOutPending' | 'settings'>, device: string, ms: number): Promise<boolean> {
  const signedIn = s.account !== null || s.signOutPending;
  if (!signedIn) return true;
  if (s.account !== null && s.settings.familyTable) await within(api.setFamilyTable(false, device).catch(() => null), ms);
  return (await within(api.logout(), ms))?.ok === true;
}

export function settingsScreen(api: ApiClient): Screen {
  let stops: (() => void)[] = [];
  return {
    title: SCREEN_TITLES.settings,
    mount(el, _route, ctx: AppContext) {
      const set = (patch: Partial<PlayerSettings>) =>
        ctx.store.update((s) => ({ ...s, settings: { ...s.settings, ...patch } }));
      const { settings } = ctx.store.get();

      const calories = h('input', { type: 'checkbox', id: 'set-calories', checked: settings.showCalories });
      calories.checked = settings.showCalories;
      calories.addEventListener('change', () => set({ showCalories: calories.checked }));

      // Audit M-14: Use-It-Up nudges "can be turned off". At most one a day, in the kitchen only.
      const rescue = h('input', { type: 'checkbox', id: 'set-rescue', checked: settings.rescueNudges });
      rescue.checked = settings.rescueNudges;
      rescue.addEventListener('change', () => set({ rescueNudges: rescue.checked }));

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
            const now = ctx.store.get();
            // Read before the store stops saving: the device id goes with the data below.
            const device = deviceId();
            // From here on nothing in this tab (a refresh, a setting) may write the data back.
            ctx.store.stopSaving();
            const loggedOut = await signOutBeforeDelete(api, now, device, DELETE_STEP_MS);
            // The offline copy first (Kitchen Quest's caches and its service worker), each bounded by its own
            // timeout: removing the data makes other tabs reload, and they must not find the worker still there.
            await deleteOfflineCopy(navigator, 'caches' in window ? window.caches : undefined, DELETE_STEP_MS);
            const storage = safeLocalStorage();
            if (storage) {
              try {
                deleteDeviceData(storage);
                // The server never heard: keep only the note that a sign-out is owed (see refreshAccount).
                if (!loggedOut) storage.setItem(STORE_KEY, JSON.stringify({ v: 1, signOutPending: true }));
              } catch { /* reload anyway */ }
            }
            let session: Storage | null = null;
            try { session = window.sessionStorage; } catch { /* none */ }
            skipServiceWorkerOnce(session); // this load came after a delete: don't register the worker again
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
      const pan = mentorSection(ctx.store, api, content.bureau.forms);
      // M7 Step 9: Settings → Voice (absent in Family Table, Ruling 9).
      const voice = voiceSection(ctx.store, api);
      const dataNote = h('p', null);
      const showDataNote = () => {
        dataNote.textContent = ctx.store.get().account
          ? "Your progress and settings stay on this device. Your rules are kept with your account, with a copy on this device so dishes can be checked offline. Signing out removes that copy."
          : 'Everything Kitchen Quest saves stays on this device.';
      };
      showDataNote();
      stops = [install.stop, account.stop, pan.stop, voice.stop, ctx.store.subscribe(showDataNote)];

      el.append(
        h('h1', null, 'Settings'),
        h('section', { class: 'panel', 'aria-labelledby': 'set-display' },
          h('h2', { id: 'set-display' }, 'Display'),
          h('div', { class: 'field' }, calories, h('label', { for: 'set-calories' }, 'Show calories')),
          h('div', { class: 'field' }, h('label', { for: 'set-motion' }, 'Reduce motion'), motion),
          h('div', { class: 'field' }, rescue, h('label', { for: 'set-rescue' }, 'Use-it-up suggestions in the kitchen (at most one a day)'))),
        h('section', { class: 'panel', 'aria-labelledby': 'set-data' },
          h('h2', { id: 'set-data' }, 'Your data'),
          dataNote,
          dataBox),
        account.el,
        pan.el,
        voice.el,
        install.el,
      );
    },
    unmount() { for (const stop of stops) stop(); stops = []; },
  };
}

