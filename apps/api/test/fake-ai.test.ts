import { describe, expect, it } from 'vitest';
import { fakeAi, reply, toolCall } from './helpers/fake-ai.js';

describe('fakeAi', () => {
  it('plays its steps in order, records requests, then fails as network', async () => {
    const ai = fakeAi([reply('Morning.'), (req) => reply(`saw ${req.messages.length}`), toolCall('propose_rule', { ingredient: 'milk' }, 'Noted.')]);
    const req = { messages: [{ role: 'user' as const, content: 'hi' }], tools: [] };
    expect(await ai.complete(req)).toEqual({ ok: true, text: 'Morning.', toolCalls: [], finish: 'stop', usage: { inputTokens: 100, outputTokens: 10, costMicroUsd: 60 } });
    expect(await ai.complete(req)).toMatchObject({ ok: true, text: 'saw 1' });
    const t = await ai.complete(req);
    expect(t).toMatchObject({ ok: true, text: 'Noted.', finish: 'tool_calls', toolCalls: [{ name: 'propose_rule', arguments: '{"ingredient":"milk"}' }] });
    expect(await ai.complete(req)).toEqual({ ok: false, failure: 'network' });
    expect(ai.requests).toHaveLength(4);
  });
});
