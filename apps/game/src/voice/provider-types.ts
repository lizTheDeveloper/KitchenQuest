// M7 Step 8: the provider seam's types (Ruling 1), apart from providers.ts so the dev-only browser adapter can name
// them without an import cycle.
import type { SpeakItem, VoiceCloseReason, VoiceMode, VoiceState } from '@kitchenquest/core/engine';

export interface Utterance {
  readonly id: number;
  push(pcm: Int16Array): void;
  end(): Promise<{ text: string; tooLong: boolean }>;
  cancel(): void;
}
export interface Speech { readonly done: Promise<void>; stop(): void }
/** What the provider learns between calls: a new allowance state, or the socket gone (and why). */
export type ProviderEvent = { kind: 'state'; state: VoiceState } | { kind: 'closed'; reason: VoiceCloseReason | 'network' };

export interface VoiceProvider {
  readonly kind: 'service' | 'browser';
  hello(conversationId: string | null, localDate: string): Promise<VoiceState>;
  listen(mode: VoiceMode): Utterance;
  /** browser: speaks `said` locally; service: sends `items` (Ruling 15: no text leaves the device). */
  speak(items: SpeakItem[], said: readonly string[]): Speech;
  onEvent(fn: (e: ProviderEvent) => void): () => void;
  close(): void;
}
