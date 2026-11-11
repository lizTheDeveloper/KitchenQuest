// @vitest-environment happy-dom
import { expect, test } from 'vitest';
import type { ApiClient } from '../api/client';
import { content } from '../content';
import { createStore } from '../state/store';
import { mountMentor } from './index';

const S23 = 'hi im mia im 8 and my mum let me use it. my favourite food is pasta and im allergic to eggs. can you remember that';
const flush = () => new Promise((r) => setTimeout(r, 0));

// Through the real wiring (mountMentor): a signed-in player with the AI on and both permissions granted.
test('a child turn is answered on the device, the conversation stays on the grown-up line, nothing reaches the AI backend, and the turns are posted in the background', async () => {
  const names: string[] = [];
  const turns: unknown[] = [];
  const client = new Proxy({}, {
    get: (_t, name: string) => (...args: unknown[]) => {
      names.push(name);
      if (name === 'mentorTurn') { turns.push(args[0]); return Promise.resolve({ ok: true, status: 200, data: { conversationId: 'c1', parts: [], cards: [], actions: [], route: 'deterministic', notice: null } }); }
      return Promise.resolve({ ok: false, status: 0, error: { code: 'network', message: '' } });
    },
  }) as ApiClient;
  const store = createStore(null);
  store.update((s) => ({ ...s, account: { email: 'cook@example.com' }, accountRules: [], intake: { ...s.intake, step: 'done' }, settings: { ...s.settings, aiMentor: true } }));
  const pan = mountMentor(document, store, content.pan, client);
  pan.open();
  const send = async (text: string) => {
    document.querySelector<HTMLTextAreaElement>('#pan-text')!.value = text;
    document.querySelector('form')!.requestSubmit();
    await flush();
    await flush();
  };
  await send(S23);
  await send("I'm allergic to eggs");
  const said = [...document.querySelectorAll('.bubble.pan .bubble-text')].map((b) => b.textContent).slice(-2);
  for (const line of said) expect(content.pan.triggers['child.grownup'].lines).toContain(line);
  // Not the AI backend's path: it would have asked for the consents first and shown a card or another line.
  expect(names).not.toContain('consents');
  expect(document.querySelector('.pan-card')).toBeNull();
  // Both turns went to the server in the background, in one conversation.
  expect(turns).toHaveLength(2);
  expect((turns[1] as { conversationId: string | null }).conversationId).toBe('c1');
});
