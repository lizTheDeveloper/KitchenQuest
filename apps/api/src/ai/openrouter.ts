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

/**
 * Adjudication A: where a provider markup suffix starts on a string argument (its first `<parameter` /
 * `</parameter`, plus the whitespace just before it), or -1. A linear scan, never a backtracking regex: the
 * model controls this string.
 */
function markupSuffixStart(v: string): number {
  const a = v.indexOf('<parameter');
  const b = v.indexOf('</parameter');
  let i = a < 0 ? b : b < 0 ? a : Math.min(a, b);
  if (i < 0) return -1;
  while (i > 0 && /\s/.test(v[i - 1]!)) i--;
  return i;
}

/** The suffix may hold markup tokens only: `</parameter>`, `<parameter=name>`, a lone `<` or `>`, whitespace. Linear. */
function isMarkupOnly(tail: string): boolean {
  let i = 0;
  while (i < tail.length) {
    const c = tail[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (tail.startsWith('</parameter', i) || tail.startsWith('<parameter', i)) {
      i += tail.startsWith('</', i) ? 11 : 10;
      if (tail[i] === '=') {
        i++;
        while (i < tail.length && /[\w-]/.test(tail[i]!)) i++;
      }
      if (tail[i] === '>') i++;
    } else if (c === '<' || c === '>') {
      i++;
    } else {
      return false;
    }
  }
  return true;
}

/** The JSON types a parameter schema allows (`type`, or each branch of `anyOf` / `oneOf`). */
function schemaTypes(schema: unknown): string[] {
  if (typeof schema !== 'object' || schema === null) return [];
  const s = schema as { type?: unknown; anyOf?: unknown[]; oneOf?: unknown[] };
  return [...(typeof s.type === 'string' ? [s.type] : []), ...[...(s.anyOf ?? []), ...(s.oneOf ?? [])].flatMap(schemaTypes)];
}

/**
 * M5 Step 8 adjudication A: the provider's tool-call parser can leak its own markup into the model's last argument
 * (`"null\n</parameter>\n<"`, `"[…]\n</parameter"`). For each top-level string argument: a trailing suffix that is
 * only provider markup is cut; then, where the tool's schema says array or object, a string that is valid JSON is
 * decoded. Nothing else changes, and the caller's strict validation, R5 verbatim checks and filters run on the
 * result as before. Model tool arguments only: never the player's text or the model's text. Unchanged arguments are
 * returned as given, byte for byte.
 */
export function normaliseToolArguments(args: string, parameters: Record<string, unknown>): string {
  let value: unknown;
  try {
    value = JSON.parse(args);
  } catch {
    return args;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return args;
  const props = (parameters.properties ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  let changed = false;
  for (const [key, v] of Object.entries(out)) {
    if (typeof v !== 'string') continue;
    let next: unknown = v;
    const start = markupSuffixStart(v);
    if (start >= 0 && isMarkupOnly(v.slice(start))) next = v.slice(0, start);
    const types = schemaTypes(props[key]);
    if (typeof next === 'string' && (types.includes('array') || types.includes('object'))) {
      try {
        const decoded: unknown = JSON.parse(next);
        if (typeof decoded === 'object' && decoded !== null) next = decoded;
      } catch {
        // Not JSON: left as a string, and the validator rejects it.
      }
    }
    if (next !== v) {
      out[key] = next;
      changed = true;
    }
  }
  return changed ? JSON.stringify(out) : args;
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
    if (r.ok) {
      // Adjudication A: the request's own tool schemas say which arguments may be decoded.
      const schemas = new Map(req.tools.map((t) => [t.name, t.parameters]));
      const toolCalls = r.toolCalls.map((c) => {
        const params = schemas.get(c.name);
        return params === undefined ? c : { ...c, arguments: normaliseToolArguments(c.arguments, params) };
      });
      return { ...r, toolCalls };
    }
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
