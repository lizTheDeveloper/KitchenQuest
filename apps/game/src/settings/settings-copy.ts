// M7 Step 9 (first paint): the Settings screen's own copy (`ui.settings.*` in content/dialogue/pan.yaml) and the voice
// credits ship in the lazy `virtual:kq-settings` module, which only the (lazy) Settings screen imports.
import settings from 'virtual:kq-settings';
import { copy } from '../content/copy';
import type { SettingsContent } from '../content/types';

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- virtual module, typed in virtual.d.ts
const data: SettingsContent = settings;

/** A `ui.settings.*` line, exactly as written (see `copy`). */
export const settingsCopy = (id: string, vars: Readonly<Record<string, string>> = {}): string => copy(id, vars, data.copy);
/** Every allowed voice model's credit (data/voice-models.json). */
export const voiceCredits: SettingsContent['voiceCredits'] = data.voiceCredits;
/** The Settings copy as a trigger map (the content scan reads it). */
export const settingsTriggers: SettingsContent['copy'] = data.copy;
