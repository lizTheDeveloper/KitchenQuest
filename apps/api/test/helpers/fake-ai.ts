import type { AiProvider, AiRequest, AiResult } from '../../src/ai/provider.js';

/** One scripted model turn: a fixed result, or one computed from the request. */
export type FakeStep = AiResult | ((req: AiRequest) => AiResult);

/**
 * An AiProvider that plays `steps` in order and records every request. Once the
 * steps run out it fails as `network`, as an unreachable provider would. Never
 * touches the network. Pass it as `deps.ai` to buildApp.
 */
export function fakeAi(steps: FakeStep[]): AiProvider & { requests: AiRequest[] } {
  const queue = [...steps];
  const requests: AiRequest[] = [];
  return {
    model: 'fake/pan',
    requests,
    complete(req) {
      requests.push(req);
      const step = queue.shift();
      if (step === undefined) return Promise.resolve({ ok: false, failure: 'network' });
      return Promise.resolve(typeof step === 'function' ? step(req) : step);
    },
  };
}

const USAGE = { inputTokens: 100, outputTokens: 10, costMicroUsd: 60 };

/** A plain text reply. */
export const reply = (text: string): AiResult => ({ ok: true, text, toolCalls: [], finish: 'stop', usage: { ...USAGE } });

let callSeq = 0;

/** One tool call (arguments as JSON text), with optional text alongside. */
export const toolCall = (name: string, args: object, text = ''): AiResult => ({
  ok: true,
  text,
  toolCalls: [{ id: `call_${++callSeq}`, name, arguments: JSON.stringify(args) }],
  finish: 'tool_calls',
  usage: { ...USAGE },
});
