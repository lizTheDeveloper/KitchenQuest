import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { AiFailure, AiMessage, AiProvider, AiRequest, AiResult, AiTool, AiToolCall } from './provider.js';

/**
 * OpenRouter chat completions (spec §7). The data policy is pinned here, not in
 * config (C-14). Built only when config.ai is set, which in production needs the
 * AI processors' DPAs signed (P-11, N-9; see ./processors.ts and config.ts).
 * C-15: nothing the model reads or writes is logged, not even an error message,
 * which can echo the prompt.
 */
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export interface AiConfig {
  apiKey: string;
  model: string;
  /** OpenRouter provider slugs: the allow-list, in routing order. */
  providers: string[];
  timeoutMs: number;
  dailyBudgetMicroUsd: number;
}

/**
 * §7.6b.6: low temperature, reasoning off. Replies are short (3-sentence limit). These shape the model's tool
 * calls as much as the prompt does, so they are part of the eval fingerprint (M4 final I-3, mentor/prompt.ts).
 */
export const REQUEST_PARAMS = Object.freeze({ temperature: 0.3, max_tokens: 200, reasoning: Object.freeze({ enabled: false }), tool_choice: 'auto' } as const);
const RETRY_DELAY_MS = 300;

function wireMessage(m: AiMessage): Record<string, unknown> {
  if (m.role !== 'assistant' || !m.toolCalls?.length) return { role: m.role, content: m.content };
  return {
    role: 'assistant',
    content: m.content,
    tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
  };
}

/**
 * The exact request body (C-14, spike §6.6). Never adds `user`, `metadata` or
 * `transforms`; the headers carry no `HTTP-Referer` or `X-Title` either.
 */
export function buildRequestBody(cfg: AiConfig, req: AiRequest): Record<string, unknown> {
  return {
    model: cfg.model,
    messages: req.messages.map(wireMessage),
    ...(req.tools.length > 0
      ? {
          tools: req.tools.map((t: AiTool) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
          tool_choice: REQUEST_PARAMS.tool_choice,
        }
      : {}),
    temperature: REQUEST_PARAMS.temperature,
    max_tokens: REQUEST_PARAMS.max_tokens,
    reasoning: { ...REQUEST_PARAMS.reasoning },
    usage: { include: true },
    stream: false,
    // VERIFY: confirm the current OpenRouter names of `data_collection`, `zdr` and
    // `only` before enabling in production (C-14); the processor review (Step 12) records the check.
    provider: {
      only: cfg.providers,
      order: cfg.providers,
      allow_fallbacks: true,
      data_collection: 'deny',
      zdr: true,
      require_parameters: true,
    },
  };
}

const Completion = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        message: z.object({
          content: z.string().nullish(),
          tool_calls: z
            .array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) }))
            .nullish(),
        }),
      }),
    )
    .min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    cost: z.number().nonnegative().nullish(),
  }),
});

function finishOf(reason: string | null | undefined): 'stop' | 'tool_calls' | 'length' | 'other' {
  return reason === 'stop' || reason === 'tool_calls' || reason === 'length' ? reason : 'other';
}

type Attempt = AiResult | { ok: false; failure: AiFailure; status?: number; retry: boolean };

export function createOpenRouterProvider(
  cfg: AiConfig,
  deps: { fetch: typeof fetch; log: Pick<FastifyBaseLogger, 'warn'> },
): AiProvider {
  async function attempt(body: string, signal: AbortSignal | undefined): Promise<Attempt> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) ctl.abort();
    try {
      let res: Response;
      try {
        res = await deps.fetch(OPENROUTER_URL, {
          method: 'POST',
          headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
          body,
          signal: ctl.signal,
          // A redirect could carry the prompt to an unvetted host (N-9): refuse it (fetch rejects, so `network`).
          redirect: 'error',
        });
      } catch {
        // The error itself is never looked at beyond this: its message can echo the request.
        return ctl.signal.aborted ? { ok: false, failure: 'timeout', retry: false } : { ok: false, failure: 'network', retry: true };
      }
      if (!res.ok) {
        // The error body is never read (it can echo the prompt); cancel it so the connection is released.
        await res.body?.cancel().catch(() => {});
        if (res.status >= 500) return { ok: false, failure: 'http_5xx', status: res.status, retry: true };
        return { ok: false, failure: 'http_4xx', status: res.status, retry: false };
      }
      let raw: unknown;
      try {
        raw = await res.json();
      } catch {
        return ctl.signal.aborted
          ? { ok: false, failure: 'timeout', retry: false }
          : { ok: false, failure: 'invalid_response', status: res.status, retry: false };
      }
      const parsed = Completion.safeParse(raw);
      if (!parsed.success) return { ok: false, failure: 'invalid_response', status: res.status, retry: false };
      const choice = parsed.data.choices[0];
      const usage = parsed.data.usage;
      const toolCalls: AiToolCall[] = (choice.message.tool_calls ?? []).map((c) => ({
        id: c.id,
        name: c.function.name,
        arguments: c.function.arguments,
      }));
      return {
        ok: true,
        text: choice.message.content ?? '',
        toolCalls,
        finish: finishOf(choice.finish_reason),
        usage: {
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
          costMicroUsd: Math.round((usage.cost ?? 0) * 1e6),
        },
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function complete(req: AiRequest): Promise<AiResult> {
    const body = JSON.stringify(buildRequestBody(cfg, req));
    let r = await attempt(body, req.signal);
    if (!r.ok && 'retry' in r && r.retry && !req.signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      r = await attempt(body, req.signal);
    }
    if (r.ok) return r;
    const failure: AiResult = { ok: false, failure: r.failure, ...(r.status === undefined ? {} : { status: r.status }) };
    // C-15: the failure kind and status only. Never a body, a prompt or an error message.
    deps.log.warn({ ai: 'openrouter', failure: r.failure, ...(r.status === undefined ? {} : { status: r.status }) }, 'ai call failed');
    return failure;
  }

  return {
    model: cfg.model,
    async complete(req) {
      try {
        return await complete(req);
      } catch {
        try {
          deps.log.warn({ ai: 'openrouter', failure: 'network' }, 'ai call failed');
        } catch {
          // A failing logger must not make complete() throw.
        }
        return { ok: false, failure: 'network' };
      }
    },
  };
}
