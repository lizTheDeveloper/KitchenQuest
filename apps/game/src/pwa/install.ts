import type { PlayerSettings } from '../state/store';

declare global {
  /** Safari on iOS: true when opened from the home screen. */
  interface Navigator { standalone?: boolean }
}

/** iPhone, iPad or iPod; iPadOS asks for the desktop site, so a touch 'Macintosh' is an iPad too. */
export function isIos(ua: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (ua.includes('Macintosh') && maxTouchPoints > 1);
}

/** Running from the home screen (or as an installed app) rather than in a browser tab. */
export function isStandalone(win: { matchMedia(q: string): { matches: boolean }; navigator: { standalone?: boolean } }): boolean {
  return win.matchMedia('(display-mode: standalone)').matches || win.navigator.standalone === true;
}

export function iosNoteVisible(settings: PlayerSettings, env: { ios: boolean; standalone: boolean }): boolean {
  return env.ios && !env.standalone && !settings.iosNoteDismissed;
}

interface BeforeInstallPromptEvent extends Event { prompt(): Promise<unknown> }

let offered: BeforeInstallPromptEvent | null = null;
const watchers = new Set<() => void>();
const changed = () => { for (const f of [...watchers]) f(); };

/**
 * Keep the browser's install offer for Settings → Install, and stop the browser showing its own banner.
 * Kitchen Quest never prompts on its own: only the player's click on the button does.
 */
export function captureInstallPrompt(win: Window): void {
  win.addEventListener('beforeinstallprompt', (ev) => {
    ev.preventDefault();
    offered = ev as BeforeInstallPromptEvent;
    changed();
  });
  win.addEventListener('appinstalled', () => { offered = null; changed(); });
}

export const installOffer = {
  available: (): boolean => offered !== null,
  /** Show the browser's install dialog. The offer can be used once. */
  async prompt(): Promise<void> {
    const ev = offered;
    offered = null;
    changed();
    await ev?.prompt();
  },
  subscribe(fn: () => void): () => void { watchers.add(fn); return () => { watchers.delete(fn); }; },
};
