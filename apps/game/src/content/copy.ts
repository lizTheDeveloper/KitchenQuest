import { content } from './index';
import type { LineTrigger } from './types';

const VAR = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * A screen's written copy: the single line of a `ui.*` trigger in content/dialogue/pan.yaml, shown exactly as written.
 * Not a Pan turn, so no rotation and no line history. The build fails when a required id is missing; a missing id
 * here throws rather than showing nothing. `triggers`: where to read it (Settings' own copy is lazy: settings/settings-copy.ts).
 */
export function copy(id: string, vars: Readonly<Record<string, string>> = {}, triggers: Readonly<Record<string, LineTrigger>> = content.pan.triggers): string {
  const trigger = Object.hasOwn(triggers, id) ? triggers[id] : undefined;
  if (trigger === undefined || trigger.lines.length === 0) throw new Error(`no screen copy "${id}" in pan.yaml`);
  return trigger.lines[0].replace(VAR, (_m, name: string) => vars[name] ?? '');
}
