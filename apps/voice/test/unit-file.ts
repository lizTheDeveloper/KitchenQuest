// Reads deploy/kq-voice.service, so the deploy test and the main-process test check and run what production runs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const UNIT_FILE = fileURLToPath(new URL('../deploy/kq-voice.service', import.meta.url));

/** The unit's [Service] settings, each key with its values in order. Comments and other sections are skipped. */
export function serviceSettings(text = readFileSync(UNIT_FILE, 'utf8')): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const s = /^\[(.+)\]$/.exec(line);
    if (s) {
      section = s[1];
      continue;
    }
    if (section !== 'Service') continue;
    const i = line.indexOf('=');
    const key = line.slice(0, i);
    out.set(key, [...(out.get(key) ?? []), line.slice(i + 1)]);
  }
  return out;
}

/** Environment= lines as a map (KEY=value, one per line). */
export function unitEnvironment(settings = serviceSettings()): Record<string, string> {
  return Object.fromEntries((settings.get('Environment') ?? []).map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
}

/** ExecStart split into the Node flags before the entry point and the entry point itself. */
export function unitExecStart(settings = serviceSettings()): { node: string; flags: string[]; entry: string } {
  const exec = settings.get('ExecStart') ?? [];
  if (exec.length !== 1) throw new Error('kq-voice.service needs exactly one ExecStart');
  const [node, ...rest] = exec[0].split(/\s+/);
  return { node, flags: rest.slice(0, -1), entry: rest.at(-1)! };
}
