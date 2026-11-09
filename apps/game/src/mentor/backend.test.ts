import { expect, test } from 'vitest';
import content from 'virtual:kq-content';
import { createScriptedBackend } from './backend';
import { createDialogue } from './dialogue';

const backend = () => createScriptedBackend(createDialogue(content.pan));

test('thanks → thanks; other text → ai_unavailable; voice → voice.not_yet', async () => {
  const b = backend();
  expect(b.kind).toBe('scripted');
  for (const text of ['thanks', 'Thank you!', 'cheers mate', 'ta']) expect((await b.reply({ kind: 'text', text })).trigger).toBe('thanks');
  for (const text of ["what's for dinner", 'data tables', '']) expect((await b.reply({ kind: 'text', text })).trigger).toBe('ai_unavailable');
  expect((await b.reply({ kind: 'voice' })).trigger).toBe('voice.not_yet');
});
