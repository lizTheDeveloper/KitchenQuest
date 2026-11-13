import type { Plugin } from 'vite';

/**
 * M7 Ruling 1 (C6): browser speech (Web Speech) is a development stand-in only. Chrome's recogniser sends audio to an
 * unreviewed processor that the CSP does not govern, so any `vite build` (keyed on the command, whatever the mode)
 * asking for it is refused. The module itself sits behind `import.meta.env.DEV`, so no build carries it either.
 */
export function voiceProviderProblem(command: 'build' | 'serve', env: Readonly<Record<string, string | undefined>>): string | null {
  const v = env.VITE_VOICE_PROVIDER;
  if (v === undefined || v === '' || v === 'service') return null;
  if (v !== 'browser') return `VITE_VOICE_PROVIDER must be "service" or "browser", not "${v}"`;
  return command === 'build' ? 'VITE_VOICE_PROVIDER=browser: browser speech is for the dev server only (Ruling 1); no build may ship it' : null;
}

export function kqVoiceProvider(): Plugin {
  return {
    name: 'kq-voice-provider',
    configResolved(config) {
      const problem = voiceProviderProblem(config.command, config.env as Record<string, string | undefined>);
      if (problem !== null) throw new Error(problem);
    },
  };
}
