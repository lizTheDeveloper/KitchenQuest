import { content } from './index';

const VAR = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * A screen's written copy: the single line of a `ui.*` trigger in content/dialogue/pan.yaml, shown exactly as written.
 * Not a Pan turn, so no rotation and no line history. The build fails when a required id is missing; a missing id
 * here throws rather than showing nothing.
 */
export function copy(id: string, vars: Readonly<Record<string, string>> = {}): string {
  const trigger = Object.hasOwn(content.pan.triggers, id) ? content.pan.triggers[id] : undefined;
  if (trigger === undefined || trigger.lines.length === 0) throw new Error(`no screen copy "${id}" in pan.yaml`);
  return trigger.lines[0].replace(VAR, (_m, name: string) => vars[name] ?? '');
}
