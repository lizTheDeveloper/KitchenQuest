/**
 * The one interface every AI call goes through (spec §7). OpenRouter is the only
 * implementation (./openrouter.ts); tests use test/helpers/fake-ai.ts. The model
 * only suggests: callers validate every tool call and deterministic code decides.
 */
export type AiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: AiToolCall[] };

/** A tool the model may call; `parameters` is a JSON schema. */
export interface AiTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** `arguments` is the model's raw JSON text, validated by the caller. */
export interface AiToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AiRequest {
  messages: AiMessage[];
  tools: AiTool[];
  signal?: AbortSignal;
}

export type AiFailure = 'timeout' | 'network' | 'http_4xx' | 'http_5xx' | 'invalid_response';

export type AiResult =
  | {
      ok: true;
      text: string;
      toolCalls: AiToolCall[];
      finish: 'stop' | 'tool_calls' | 'length' | 'other';
      usage: { inputTokens: number; outputTokens: number; costMicroUsd: number };
    }
  | { ok: false; failure: AiFailure; status?: number };

export interface AiProvider {
  readonly model: string;
  /** Never throws: every failure is an `ok: false` result. */
  complete(req: AiRequest): Promise<AiResult>;
}
