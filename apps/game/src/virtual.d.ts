declare module 'virtual:kq-content' {
  import type { ClientContent } from './content/types';
  const content: ClientContent;
  export default content;
}

declare module 'virtual:kq-assets' {
  /** Manifest key ('char.pan', 'scene.kitchen', 'item.rice', ...) → served URL. */
  const assets: Readonly<Record<string, string>>;
  export default assets;
}

declare module 'virtual:kq-market' {
  /** The lazy market module (M6 Step 5): only src/market/content.ts imports it, dynamically. */
  import type { MarketContent } from './content/types';
  const market: MarketContent;
  export default market;
}

declare module 'virtual:kq-settings' {
  /** The lazy Settings module (M7 Step 9): the `ui.settings.*` copy and the voice credits; only Settings imports it. */
  import type { SettingsContent } from './content/types';
  const settings: SettingsContent;
  export default settings;
}

/** M7 Step 8: the voice build switches (build/voice-provider.ts, build/hands-free-gate.ts). */
interface ImportMetaEnv {
  /** `browser` (Web Speech) only on the dev server (Ruling 1); any build refuses it. Unset or `service` otherwise. */
  readonly VITE_VOICE_PROVIDER?: string;
  /** `on` shows hands-free in cook mode; a build refuses it until the browser echo checklist passed (Ruling 7, C9). */
  readonly VITE_HANDS_FREE?: string;
}
