// M7 Step 3: the systemd unit (C-18, C-38, B3). No core dumps, no swap, no writable filesystem, offline models, a
// private bind address; and the start command production runs: Node 22's --disable-warning (never --no-warnings) and
// no tsx compile cache in TMPDIR (Step 2 carries 1 and 2).
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { loadVoiceConfig } from '../src/config';
import { loadManifest } from '../src/models';
import { serviceSettings, UNIT_FILE, unitEnvironment, unitExecStart } from './unit-file';

describe('deploy/kq-voice.service', () => {
  const settings = serviceSettings();
  const env = unitEnvironment(settings);

  test('kq-voice.service sets LimitCORE=0 and HF_HUB_OFFLINE=1 and binds VOICE_PORT on a private address variable', () => {
    expect(settings.get('LimitCORE')).toEqual(['0']);
    expect(env.HF_HUB_OFFLINE).toBe('1');
    expect(env.NODE_ENV).toBe('production');
    // The bind address is a variable the service reads (VOICE_HOST), private by default, and config refuses anything
    // that is not loopback or private (C-38); the unit never sets the wildcard.
    expect(env.VOICE_HOST).toBe('127.0.0.1');
    expect(env.VOICE_PORT).toMatch(/^\d+$/);
    const config = loadVoiceConfig({ ...env, VOICE_SERVICE_TOKEN: 'p'.repeat(32), VOICE_ENGINE: 'worker' }, loadManifest());
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(Number(env.VOICE_PORT));
    expect(readFileSync(UNIT_FILE, 'utf8')).not.toMatch(/0\.0\.0\.0|VOICE_HOST=::/);
    // Secrets come from a root-owned file, never the unit.
    expect(settings.get('EnvironmentFile')).toEqual(['/etc/kitchenquest/voice.env']);
    expect(env.VOICE_SERVICE_TOKEN).toBeUndefined();
  });

  test('C-18 hardening: no swap, no writable filesystem, a private /tmp, no devices (no microphone), no new privileges', () => {
    expect(settings.get('MemorySwapMax')).toEqual(['0']);
    expect(settings.get('ProtectSystem')).toEqual(['strict']);
    expect(settings.get('ProtectHome')).toEqual(['yes']);
    expect(settings.get('PrivateTmp')).toEqual(['yes']);
    expect(settings.get('PrivateDevices')).toEqual(['yes']);
    expect(settings.get('NoNewPrivileges')).toEqual(['yes']);
    // Nothing is made writable again.
    expect(settings.has('ReadWritePaths')).toBe(false);
    expect(settings.has('StateDirectory')).toBe(false);
    expect(settings.has('CacheDirectory')).toBe(false);
    expect(settings.has('LogsDirectory')).toBe(false);
  });

  test('the start command: --disable-warning=ExperimentalWarning, never --no-warnings; tsx with its compile cache off (no TMPDIR cache)', () => {
    const { node, flags, entry } = unitExecStart(settings);
    expect(node).toBe('/usr/bin/node');
    expect(flags).toEqual(['--disable-warning=ExperimentalWarning', '--import', 'tsx']);
    expect(entry).toBe('src/main.ts');
    expect(readFileSync(UNIT_FILE, 'utf8')).not.toMatch(/--no-warnings/);
    expect(env.TSX_DISABLE_CACHE).toBe('1');
    expect(settings.get('WorkingDirectory')).toEqual(['/opt/kitchenquest/apps/voice']);
  });

  test('package.json start runs the same command as the unit', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
    const { flags, entry } = unitExecStart(settings);
    expect(pkg.scripts.start).toBe(`TSX_DISABLE_CACHE=1 node ${flags.join(' ')} ${entry}`);
    expect(Object.values(pkg.scripts).join('\n')).not.toMatch(/--no-warnings/);
  });
});
